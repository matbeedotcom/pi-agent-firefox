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
 * boundary; no localhost TCP. Windows: the same broker/relay protocol over
 * per-user named pipes (broker-ipc.ts ipcEndpoint).
 *
 * Which provider capabilities (browser / mail / ...) a tool call is routed
 * to is negotiated by each client's pi.agent.hello handshake and resolved
 * per tool (plan §29) — one session can use both apps' tools.
 *
 * stdout invariant: only the host/relay transport writes to stdout;
 * everything else logs to stderr.
 */
import { lstatSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HOST_CHILD_ENV,
  TRUSTED_UA_ERROR,
  TRUSTED_UA_META,
  TrustedUaProtocolError,
  SESSION_ENDED_METHOD,
  isCallerSessionId,
  type SessionEndedParams,
} from "@trusted-ua/protocol";
import { createLogger } from "../logger.js";
import {
  setBrowserToolBridge,
  type BridgeSessionContext,
  type BrowserToolBridge,
} from "../tool-bridge.js";
import { createStdioTransport, type Dispatcher } from "./transport.js";
import {
  createClientSkillsProtocol,
  createSkillsEventLog,
  startSkillsCatalogReloader,
  startSkillsRuntime,
  type SkillsCatalogReloader,
  type SkillsEventLog,
} from "./skills-startup.js";
import { loadSkillsGrantFile } from "../skills/grants-file.js";
import type { SkillsHost } from "../skills/pi-integration.js";
import type { IsolatedSessionFactory } from "../skills/isolated-runner.js";
import type { SkillGrant } from "../skills/planner.js";
import { createScriptedSessionFactory, type ScriptedJob } from "../skills/mock-session-factory.js";
import { AcpAgent } from "../acp/agent.js";
import { ExternalAgents } from "../acp/agents/manager.js";
import { MockBackend } from "../acp/mock-backend.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import { CapabilityToolProvider } from "../browser/provider.js";
import { CapabilityRegistry } from "../capability-registry.js";
import {
  startBrokerServer,
  tryRelayAttach,
  waitForRelayAttach,
  type BrokerServerHandle,
} from "./broker-ipc.js";
import { startMcpBrowserServer, type McpBrowserServerHandle } from "./mcp-server.js";
import { runRelay } from "./relay.js";
import type { Logger } from "../logger.js";
import { logsDir, runDir as brokerRunDir } from "../paths.js";
import { setEnvBoth, piAgentDir, envValue } from "../env.js";

const require = createRequire(import.meta.url);

/**
 * Mock-mode skills config (test seam; TRUSTED_UA_BACKEND=mock only).
 *
 * TRUSTED_UA_SKILLS_CONFIG is a JSON file path (or inline JSON):
 * {
 *   "grants":   [{ "skillKey": "pkg/skill", "revision": "*", "capabilities": ["context.read"],
 *                  "mode": "review-before-submit" }],  // optional; defaults to advisory
 *   "job":      { "report": { "decision": "suggest", "explanation": "...", "replacementText": "..." } }
 * }
 * Grants arm the plan compiler (packages are their own adapters — coverage
 * derives from each package manifest); the scripted job factory makes
 * isolated job runs deterministic. The production (Pi SDK) host never reads
 * this variable.
 */
function loadMockSkillsConfig(
  log: Logger,
): { grants: { skillKey: string; revision: string; capabilities: SkillGrant["capabilities"]; mode?: "advisory" | "review-before-submit" }[]; job: ScriptedJob } | undefined {
  const raw = envValue("SKILLS_CONFIG")?.trim();
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
  if (!Array.isArray(entry.grants) || (entry.job !== undefined && (typeof entry.job !== "object" || entry.job === null))) {
    log.warn("PI_BROWSER_SKILLS_CONFIG shape invalid (needs grants[], optional job{}); ignoring");
    return undefined;
  }
  // Mock grants are explicit test-arm declarations: they are enabled by
  // construction (SkillGrant.enabled is required and the config has no
  // per-grant enable field).
  const grants = (entry.grants as { skillKey: string; revision: string; capabilities: SkillGrant["capabilities"]; mode?: "advisory" | "review-before-submit" }[]).map((g) => ({ enabled: true, ...g }));
  return { grants, job: (entry.job as ScriptedJob | undefined) ?? {} };
}

/**
 * Persistent host log (PRODUCT.md §43): defaults to
 * ~/.pi/browser/logs/host-<pid>.log. Native-host stderr only survives in the
 * about:debugging runtime log, so a file is what makes mid-session drops
 * (e.g. a tool call stuck at in_progress) diagnosable after the fact.
 * TRUSTED_UA_LOG_FILE overrides the path; "off" (or empty) disables logging
 * to file (stderr stays on).
 */
function resolveLogPath(): string | undefined {
  const env = envValue("LOG_FILE");
  if (env === "off" || env === "none") return undefined;
  if (env === undefined || env === "") {
    return join(logsDir(), `host-${process.pid}.log`);
  }
  return env;
}

/**
 * Best-effort stable log handle: host-current.log -> host-<pid>.log, so the
 * agent (and humans) can tail the current host without resolving the pid.
 */
function linkCurrentHostLog(logPath: string): void {
  try {
    const link = join(dirname(logPath), "host-current.log");
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      /* no link yet */
    }
    symlinkSync(basename(logPath), link);
  } catch {
    /* best-effort */
  }
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
  catalogReloader: () => SkillsCatalogReloader | undefined;
  skillsEventLog: () => SkillsEventLog | undefined;
  externalAgents: ExternalAgents;
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
      // External ACP agent processes (Claude Code, Codex, ...) go with the host.
      try {
        await deps.externalAgents.shutdown();
      } catch (err) {
        deps.log.warn("external agents shutdown error", err);
      }
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
      const reloader = deps.catalogReloader();
      if (reloader) {
        try {
          await reloader.close();
        } catch (err) {
          deps.log.warn("catalog reloader close error", err);
        }
      }
      const eventLog = deps.skillsEventLog();
      if (eventLog) {
        try {
          await eventLog.close();
        } catch (err) {
          deps.log.warn("skills event log close error", err);
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

/** How long a broker-race loser keeps retrying the relay attach. */
const RELAY_ATTACH_RETRY_MS = 3_000;

async function main(): Promise<void> {
  const logPath = resolveLogPath();
  const log = createLogger(logPath ? { filePath: logPath } : {});
  if (logPath) linkCurrentHostLog(logPath);
  log.info(
    `host starting pid=${process.pid} node=${process.version}${logPath ? ` log=${logPath}` : " log=off"}`,
  );

  // --- Relay mode: a broker is already running (plan §26) ----------------
  const attachment = await tryRelayAttach(log);
  if (attachment) {
    log.info("attaching to running broker as relay");
    await runRelay(attachment.channel, attachment.initial, process.stdin, process.stdout, log);
    log.info("relay finished; exiting");
    process.exit(0);
  }

  // --- Broker mode: own the ACP agent, sessions, and provider registry ---
  // Every process this broker spawns (pi subagents, the MCP servers their
  // clients start) inherits this marker; the MCP server compares it with the
  // value the stdio bridge reports to tell host children from external
  // callers (openspec external-mcp-callers D3). A stale id never matches.
  const instanceId = randomUUID();
  setEnvBoth("HOST_CHILD", instanceId);
  const backendKind = envValue("BACKEND") ?? "pi";
  const backend =
    backendKind === "mock" ? new MockBackend(envValue("MOCK_SCRIPT")) : new PiSdkBackend({
      log,
      ...(piAgentDir() ? { agentDir: piAgentDir() } : {}),
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
  // Caller sessions (external MCP clients, one per MCP connection): no ACP
  // session, no owner app; routed through the registry and the caller gate.
  const callerSessions = new Set<string>();
  // External ACP agents for sidebar sessions (openspec sidebar-acp-agents):
  // one process per agent, shared by every client's sessions.
  const externalAgents = new ExternalAgents({
    log,
    instanceId,
    permissionTimeoutMs: () => provider.promptTimeoutMs,
    // Test seam (e2e): check idle agents more often than once a minute.
    ...(Number(envValue("AGENT_IDLE_CHECK_MS")) > 0
      ? { idleCheckMs: Number(envValue("AGENT_IDLE_CHECK_MS")) }
      : {}),
  });
  const toolBridge: BrowserToolBridge = {
    registerSession: (id, ctx) => {
      bridgeSessions.set(id, ctx);
    },
    touchSession: (id) => {
      lastActiveBridgeSession = id;
    },
    resolveParentSession: (token) => {
      const id = externalAgents.resolveParentToken(token);
      return id && bridgeSessions.has(id) ? id : undefined;
    },
    closeSession: (id) => {
      if (callerSessions.delete(id)) {
        // Grants, pending prompts and the REPL worker go with the session;
        // the apps drop its tab binding and REPL tabs.
        void provider.disposeSession(id).catch((err) => log.warn(`dispose caller session ${id} failed`, err));
        const params: SessionEndedParams = { sessionId: id };
        for (const client of registry.list()) {
          try {
            client.transport.notify(SESSION_ENDED_METHOD, params);
          } catch {
            /* client going away */
          }
        }
        log.info(`caller session ${id} ended`);
        return;
      }
      bridgeSessions.delete(id);
      if (lastActiveBridgeSession === id) {
        lastActiveBridgeSession = [...bridgeSessions.keys()].pop();
      }
    },
    call: (o) => {
      if (o.caller) {
        if (!o.sessionId || !isCallerSessionId(o.sessionId)) {
          throw new TrustedUaProtocolError(TRUSTED_UA_ERROR.INTERNAL, "caller calls need a caller session id (mcp:<uuid>)");
        }
        if (!callerSessions.has(o.sessionId)) {
          callerSessions.add(o.sessionId);
          log.info(`caller session ${o.sessionId} started for "${o.caller.name}"`);
        }
        return provider.bridgeCall({
          tool: o.tool,
          args: o.args,
          sessionId: o.sessionId,
          ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
          ctx: { ownerApplication: "firefox", mode: "legacy", caller: o.caller },
        });
      }
      const sid = o.sessionId ?? lastActiveBridgeSession;
      const ctx = sid ? bridgeSessions.get(sid) : undefined;
      if (!sid || !ctx) {
        throw new TrustedUaProtocolError(
          TRUSTED_UA_ERROR.SESSION_NOT_FOUND,
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
  // Grants are read at plan time; "*" rebinds against the LIVE registry
  // snapshot, so a catalog reload picks up the new package revision
  // without a host restart (mock/dev grants only — real user grants stay
  // revision-bound and report "Package changed" until re-granted).
  let mockGrants: (() => ReadonlyMap<string, SkillGrant>) | undefined;
  if (mockSkills && skillsRuntime) {
    mockGrants = () => new Map(
      mockSkills.grants.map((g) => [
        g.skillKey,
        {
          enabled: true,
          revision: g.revision === "*" ? skillsRuntime.registry.revisionOf(g.skillKey) : g.revision,
          capabilities: g.capabilities,
          ...(g.mode ? { mode: g.mode } : {}),
        },
      ]),
    );
  }
  // Real-user grants (design §12 seam): <data root>/skills-grants.json,
  // re-read at every plan compile (no host restart to grant), revision-bound.
  const fileGrants = loadSkillsGrantFile(log);

  // Browser-tools MCP server: lets pi-subagent children (separate node
  // processes with no ACP channel) reach the browser tools over MCP on a
  // private IPC endpoint (unix socket; named pipe on Windows).
  let mcpServer: McpBrowserServerHandle | undefined;
  // Dev-loop catalog reloader: the agent touches the trigger file in the
  // broker run dir to re-read skill packages without a host restart.
  let catalogReloader: SkillsCatalogReloader | undefined;
  // JSONL skills lifecycle log (agent observation channel): one line per
  // plan/event/result/reload in the broker run dir.
  let skillsEventLog: SkillsEventLog | undefined;
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
    catalogReloader: () => catalogReloader,
    skillsEventLog: () => skillsEventLog,
    externalAgents,
  });

  const wireClient = (clientId: string, dispatcher: Dispatcher) => {
    clients.add(clientId);
    // One skills protocol surface per client connection (design §7):
    // verified source identity is per-connection, results route back on
    // the same transport.
    const clientSkills = skillsRuntime
      ? createClientSkillsProtocol({
          log, runtime: skillsRuntime, transport: dispatcher.transport,
          ...(mockGrants ? { grants: mockGrants } : { grants: fileGrants }),
          ...(skillsEventLog ? { record: skillsEventLog.record } : {}),
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
      externalAgents,
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
    // The winner publishes its state file (pid + token) just AFTER listen
    // succeeds, so a simultaneous loser can land in that window: poll
    // briefly instead of failing the election outright.
    const attachment = await waitForRelayAttach(log, RELAY_ATTACH_RETRY_MS);
    if (attachment) {
      log.info("attaching to running broker as relay (race fallback)");
      await runRelay(attachment.channel, attachment.initial, process.stdin, process.stdout, log);
      process.exit(0);
    }
    // Let the add-on reconnect after an election failure instead of keeping
    // an isolated host alive with cross-app routing permanently disabled.
    throw new Error("broker election failed; reconnect to retry", { cause: err });
  }

  // Browser-tools MCP server: broker-only, started AFTER winning the
  // election — a race loser that grabbed the endpoint first would serve MCP
  // from a relay process whose tool bridge has no clients.
  try {
    mcpServer = await startMcpBrowserServer({ log, bridge: toolBridge, instanceId });
  } catch (err) {
    // Non-fatal: the in-process bridge (extensions/trusted-ua-tools.ts)
    // keeps working for foreground children; only subagent MCP access is
    // unavailable until the socket is free again.
    log.warn("could not start mcp browser server", err);
  }

  // Skills dev-loop observation (skills-events.jsonl) + catalog reloader:
  // broker-only (a relay never reaches this point), one writer per run dir.
  if (skillsRuntime && brokerServer) {
    try {
      const runDir = brokerRunDir();
      skillsEventLog = createSkillsEventLog(log, join(runDir, "skills-events.jsonl"));
    } catch (err) {
      // Non-fatal: live runs stay observable through the host log only.
      log.warn("skills event log unavailable", err);
    }
    try {
      catalogReloader = startSkillsCatalogReloader({
        log, runtime: skillsRuntime,
        ...(skillsEventLog ? { record: skillsEventLog.record } : {}),
      });
    } catch (err) {
      // Non-fatal: the catalog stays at its startup snapshot; the
      // dev loop falls back to a host restart.
      log.warn("skills catalog reloader unavailable; catalog fixed for this host run", err);
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
    `host ready (pi ${piVersion()}, integration v${TRUSTED_UA_META.version} proto=${TRUSTED_UA_META.protocolVersion}, mode=broker)`,
  );
}

main().catch((err) => {
  // stderr only — stdout is protocol data.
  process.stderr.write(`[trusted-ua-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
