/**
 * Pi Agent native host entry point (PRODUCT.md §7, §42, §43;
 * THUNDERBIRD-PLAN.md §2–31 — application-neutral `com.matbee.agent`).
 *
 * Launched by Firefox or Thunderbird via connectNative("com.matbee.agent")
 * (legacy Firefox registrations still use "dev.pi.browser").
 *
 * Topology (plan §26–27): the FIRST process to start becomes the broker —
 * it owns the ACP agent, Pi sessions, and the capability provider registry,
 * and listens on private OS IPC (~/.pi/run/agent-broker.sock) for peers.
 * Later processes attach to it as relays (byte passthrough over the same
 * framing). Native Messaging remains the only externally visible Mozilla
 * boundary; no localhost TCP. Windows: broker IPC is not yet supported —
 * each process is standalone (single-app mode).
 *
 * Which provider capabilities (browser / mail / ...) a tool call is routed
 * to is negotiated by each client's pi.agent.hello handshake and resolved
 * per tool (plan §29) — one session can use both apps' tools.
 *
 * stdout invariant: only the host/relay transport writes to stdout;
 * everything else logs to stderr.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PI_BROWSER_ERROR, PI_BROWSER_META, PiBrowserProtocolError } from "@pi-browser/protocol";
import { createLogger } from "../logger.js";
import {
  setBrowserToolBridge,
  type BridgeSessionContext,
  type BrowserToolBridge,
} from "../tool-bridge.js";
import { createStdioTransport, type Dispatcher } from "./transport.js";
import { createClientSkillsProtocol, startSkillsRuntime } from "./skills-startup.js";
import type { SkillsHost } from "../skills/pi-integration.js";
import type { IsolatedSessionFactory } from "../skills/isolated-runner.js";
import type { SkillAdapterCoverage, SkillGrant } from "../skills/planner.js";
import { createScriptedSessionFactory, type ScriptedJob } from "../skills/mock-session-factory.js";
import { AcpAgent } from "../acp/agent.js";
import { MockBackend } from "../acp/mock-backend.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import { CapabilityToolProvider } from "../browser/provider.js";
import { CapabilityRegistry } from "../capability-registry.js";
import {
  isBrokerIpcSupported,
  startBrokerServer,
  tryRelayAttach,
  type BrokerServerHandle,
} from "./broker-ipc.js";
import { startMcpBrowserServer, type McpBrowserServerHandle } from "./mcp-server.js";
import { runRelay } from "./relay.js";
import type { Logger } from "../logger.js";

const require = createRequire(import.meta.url);

/**
 * Mock-mode skills config (test seam; PI_BROWSER_BACKEND=mock only).
 *
 * PI_BROWSER_SKILLS_CONFIG is a JSON file path (or inline JSON):
 * {
 *   "grants":   [{ "skillKey": "pkg/skill", "revision": "*", "capabilities": ["context.read"],
 *                  "mode": "review-before-submit" }],  // optional; defaults to advisory
 *   "adapters": [{ "id": "a", "version": "1.0.0", "hosts": ["127.0.0.1"],
 *                  "events": ["comment.before-submit"], "gates": ["comment.before-submit"] }],
 *   "job":      { "report": { "decision": "suggest", "explanation": "...", "replacementText": "..." } }
 * }
 * Grants + adapters arm the plan compiler; the scripted job factory makes
 * isolated job runs deterministic. The production (Pi SDK) host never reads
 * this variable.
 */
function loadMockSkillsConfig(
  log: Logger,
): { grants: { skillKey: string; revision: string; capabilities: SkillGrant["capabilities"]; mode?: "advisory" | "review-before-submit" }[]; adapters: SkillAdapterCoverage[]; job: ScriptedJob } | undefined {
  const raw = process.env.PI_BROWSER_SKILLS_CONFIG?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
  } catch (err) {
    log.warn(`PI_BROWSER_SKILLS_CONFIG unreadable; continuing without mock skills config: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("PI_BROWSER_SKILLS_CONFIG must be a JSON object; ignoring");
    return undefined;
  }
  const entry = parsed as Record<string, unknown>;
  if (!Array.isArray(entry.grants) || !Array.isArray(entry.adapters) || (entry.job !== undefined && (typeof entry.job !== "object" || entry.job === null))) {
    log.warn("PI_BROWSER_SKILLS_CONFIG shape invalid (needs grants[], adapters[], optional job{}); ignoring");
    return undefined;
  }
  return { grants: entry.grants, adapters: entry.adapters, job: (entry.job as ScriptedJob | undefined) ?? {} };
}

/**
 * Persistent host log (PRODUCT.md §43): defaults to
 * ~/.pi/browser/logs/host-<pid>.log. Native-host stderr only survives in the
 * about:debugging runtime log, so a file is what makes mid-session drops
 * (e.g. a tool call stuck at in_progress) diagnosable after the fact.
 * PI_BROWSER_LOG_FILE overrides the path; "off" (or empty) disables logging
 * to file (stderr stays on).
 */
function resolveLogPath(): string | undefined {
  const env = process.env.PI_BROWSER_LOG_FILE;
  if (env === "off" || env === "none") return undefined;
  if (env === undefined || env === "") {
    return join(homedir(), ".pi", "browser", "logs", `host-${process.pid}.log`);
  }
  return env;
}

/** Best-effort cleanup of old per-pid host logs (broker startup only). */
function pruneOldLogs(dir: string): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir may not exist yet — createLogger mkdirs it on first write
  }
  for (const name of names) {
    if (!name.startsWith("host-") || !name.endsWith(".log")) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name));
    } catch {
      // concurrent removal — ignore
    }
  }
}

/**
 * The host's graceful shutdown sequence.
 *
 * Hard-exit backstop: a half-open socket must never keep the host alive
 * (e.g. a relay that was SIGKILLed instead of closing its pipe).
 */
function createShutdownSequence(deps: {
  log: Logger;
  agents: Map<string, AcpAgent>;
  provider: CapabilityToolProvider;
  backend: PiSdkBackend | MockBackend;
  skillsHost: SkillsHost | undefined;
  brokerServer: () => BrokerServerHandle | undefined;
  mcpServer: () => McpBrowserServerHandle | undefined;
}): (reason: string) => Promise<void> {
  let shuttingDown = false;
  return async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info(`shutting down: ${reason}`);
    const backstop = setTimeout(() => {
      deps.log.warn("shutdown timed out; forcing exit");
      process.exit(0);
    }, 5_000);
    backstop.unref?.();
    try {
      for (const agent of deps.agents.values()) agent.shutdown();
      deps.agents.clear();
      // Drain/abort skill jobs before the provider goes down — a running job
      // may still be routing browser tool calls through it.
      if (deps.skillsHost) {
        try {
          await deps.skillsHost.close();
        } catch (err) {
          deps.log.warn("skills host close error", err);
        }
      }
      try {
        await deps.provider.shutdown();
      } catch (err) {
        deps.log.warn("provider shutdown error", err);
      }
      const broker = deps.brokerServer();
      if (broker) {
        try {
          await broker.close();
        } catch (err) {
          deps.log.warn("broker close error", err);
        }
      }
      const mcp = deps.mcpServer();
      if (mcp) {
        try {
          await mcp.close();
        } catch (err) {
          deps.log.warn("mcp server close error", err);
        }
      }
      deps.backend.dispose();
    } finally {
      clearTimeout(backstop);
      process.exit(0);
    }
  };
}

function piVersion(): string {
  try {
    const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const logPath = resolveLogPath();
  const log = createLogger(logPath ? { filePath: logPath } : {});
  log.info(
    `host starting pid=${process.pid} node=${process.version}${logPath ? ` log=${logPath}` : " log=off"}`,
  );

  // --- Relay mode: a broker is already running (plan §26) ----------------
  if (isBrokerIpcSupported()) {
    const attachment = await tryRelayAttach(log);
    if (attachment) {
      log.info("attaching to running broker as relay");
      await runRelay(attachment.channel, attachment.initial, process.stdin, process.stdout, log);
      log.info("relay finished; exiting");
      process.exit(0);
    }
  } else {
    log.info("broker IPC not supported on this platform (Windows) — standalone single-app mode");
  }

  // --- Broker mode: own the ACP agent, sessions, and provider registry ---
  const backendKind = process.env.PI_BROWSER_BACKEND ?? "pi";
  const backend =
    backendKind === "mock" ? new MockBackend(process.env.PI_BROWSER_MOCK_SCRIPT) : new PiSdkBackend({
      log,
      ...(process.env.PI_BROWSER_AGENT_DIR ? { agentDir: process.env.PI_BROWSER_AGENT_DIR } : {}),
    });
  log.info(`backend: ${backendKind}`);
  // Only the broker prunes: relays exit within milliseconds of startup.
  if (logPath) pruneOldLogs(dirname(logPath));

  const registry = new CapabilityRegistry(log);
  const provider = new CapabilityToolProvider(undefined, log, registry);

  // In-process tool bridge: Pi sessions created by other code in this
  // process (e.g. pi-subagents children of a sidebar session) can register
  // the browser tools via a Pi extension and route calls back through the
  // provider with the owning ACP session's routing context. Calls without
  // an explicit session id fall back to the most recently prompted one —
  // the session the user is driving in the add-on UI.
  const bridgeSessions = new Map<string, BridgeSessionContext>();
  let lastActiveBridgeSession: string | undefined;
  const toolBridge: BrowserToolBridge = {
    registerSession: (id, ctx) => {
      bridgeSessions.set(id, ctx);
    },
    touchSession: (id) => {
      lastActiveBridgeSession = id;
    },
    closeSession: (id) => {
      bridgeSessions.delete(id);
      if (lastActiveBridgeSession === id) {
        lastActiveBridgeSession = [...bridgeSessions.keys()].pop();
      }
    },
    call: (o) => {
      const sid = o.sessionId ?? lastActiveBridgeSession;
      const ctx = sid ? bridgeSessions.get(sid) : undefined;
      if (!sid || !ctx) {
        throw new PiBrowserProtocolError(
          PI_BROWSER_ERROR.SESSION_NOT_FOUND,
          "no active ACP session to route the bridge tool call to",
        );
      }
      return provider.bridgeCall({
        tool: o.tool,
        args: o.args,
        sessionId: sid,
        ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
        ctx,
      });
    },
  };
  setBrowserToolBridge(toolBridge);

  // Skills runtime (skills-runtime-design.md §10, §13): the broker owns the
  // registry, the bounded SkillsService, and the isolated job runner.
  // Best-effort: degrades to "no skills" without blocking startup.
  const mockSkills = backend instanceof MockBackend ? loadMockSkillsConfig(log) : undefined;
  const skillsRuntime = await startSkillsRuntime({
    log, backend, toolBridge,
    ...(mockSkills ? { sessionFactory: createScriptedSessionFactory(mockSkills.job) } : {}),
  });
  // Grants/adapters are read at plan time; "*" revisions resolve against the
  // registry snapshot (content-hashed, stable within one run).
  let mockGrants: (() => ReadonlyMap<string, SkillGrant>) | undefined;
  let mockAdapters: (() => readonly SkillAdapterCoverage[]) | undefined;
  if (mockSkills && skillsRuntime) {
    const snapshot = skillsRuntime.registry.snapshot();
    const revision = (key: string) => snapshot.find((s) => s.key === key)?.revision ?? "";
    mockGrants = () => new Map(
      mockSkills.grants.map((g) => [
        g.skillKey,
        {
          enabled: true,
          revision: g.revision === "*" ? revision(g.skillKey) : g.revision,
          capabilities: g.capabilities,
          ...(g.mode ? { mode: g.mode } : {}),
        },
      ]),
    );
    mockAdapters = () => mockSkills.adapters;
  }

  // Browser-tools MCP server: lets pi-subagent children (separate node
  // processes with no ACP channel) reach the browser tools over MCP on a
  // private unix socket. Unix sockets only — skipped in standalone Windows
  // mode, same as the relay socket.
  let mcpServer: McpBrowserServerHandle | undefined;
  if (isBrokerIpcSupported()) {
    try {
      mcpServer = await startMcpBrowserServer({ log, bridge: toolBridge });
    } catch (err) {
      // Non-fatal: the in-process bridge (extensions/pi-browser-tools.ts)
      // keeps working for foreground children; only subagent MCP access is
      // unavailable until the socket is free again.
      log.warn("could not start mcp browser server", err);
    }
  }

  const agents = new Map<string, AcpAgent>();
  // A peer app connected/disconnected: tell every client so its UI can
  // update the "capabilities:" line (display-only, plan §29).
  registry.onChange = (caps) => {
    for (const agent of agents.values()) agent.notifyCapabilitiesChanged(caps);
  };
  const clients = new Set<string>();
  let relaySeq = 0;

  // Getters defer to the brokerServer/mcpServer bindings, which initialize
  // later in startup; shutdown only ever runs after they have.
  const shutdown = createShutdownSequence({
    log,
    agents,
    provider,
    backend,
    skillsHost: skillsRuntime?.host,
    brokerServer: () => brokerServer,
    mcpServer: () => mcpServer,
  });

  const wireClient = (clientId: string, dispatcher: Dispatcher) => {
    clients.add(clientId);
    // One skills protocol surface per client connection (design §7):
    // verified source identity is per-connection, results route back on
    // the same transport.
    const clientSkills = skillsRuntime
      ? createClientSkillsProtocol({
          log, runtime: skillsRuntime, transport: dispatcher.transport,
          ...(mockGrants ? { grants: mockGrants, adapters: mockAdapters } : {}),
        })
      : undefined;
    const agent = new AcpAgent({
      backend,
      provider,
      transport: dispatcher.transport,
      log,
      agentInfo: { name: "pi-coding-agent", version: piVersion() },
      clientId,
      registry,
      bridge: toolBridge,
      extendedRequest: clientSkills?.extendedRequest,
    });
    agents.set(clientId, agent);
    dispatcher.transport.onEof = () => {
      clients.delete(clientId);
      agents.delete(clientId);
      registry.remove(clientId);
      clientSkills?.dispose();
      agent.shutdown();
      log.info(`client ${clientId} disconnected (${clients.size} connected)`);
      if (clients.size === 0) void shutdown("last client disconnected");
    };
  };

  let brokerServer: BrokerServerHandle | undefined;
  if (isBrokerIpcSupported()) {
    try {
      brokerServer = await startBrokerServer({
        log,
        onClient: (channel) => {
          const id = `relay-${++relaySeq}`;
          log.info(`broker: client ${id} connected`);
          wireClient(id, createStdioTransport(channel, channel, log));
        },
      });
      log.info(`broker: listening on ${brokerServer.socketPath}`);
    } catch (err) {
      // Lost the race: another process became broker between our probe and
      // listen. Attach as a relay instead.
      log.warn("could not start broker; retrying relay attach", err);
      const attachment = await tryRelayAttach(log);
      if (attachment) {
        log.info("attaching to running broker as relay (race fallback)");
        await runRelay(attachment.channel, attachment.initial, process.stdin, process.stdout, log);
        process.exit(0);
      }
      // Let the add-on reconnect after an election failure instead of keeping
      // an isolated host alive with cross-app routing permanently disabled.
      throw new Error("broker election failed; reconnect to retry", { cause: err });
    }
  }

  // Elect the broker before consuming stdin: a race loser must relay the
  // original initialize request, with no competing dispatcher on its pipes.
  const stdioDispatcher = createStdioTransport(process.stdin, process.stdout, log);
  wireClient("stdio", stdioDispatcher);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", err);
    void shutdown("uncaught exception");
  });
  process.on("unhandledRejection", (err) => {
    log.error("unhandled rejection", err);
  });

  log.info(
    `host ready (pi ${piVersion()}, integration v${PI_BROWSER_META.version} proto=${PI_BROWSER_META.protocolVersion}, mode=broker)`,
  );
}

main().catch((err) => {
  // stderr only — stdout is protocol data.
  process.stderr.write(`[pi-browser-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
