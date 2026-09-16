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
import { PI_BROWSER_META } from "@pi-browser/protocol";
import { createLogger } from "../logger.js";
import { createStdioTransport, type Dispatcher } from "./transport.js";
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
import { runRelay } from "./relay.js";

const require = createRequire(import.meta.url);

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
  const agents = new Map<string, AcpAgent>();
  // A peer app connected/disconnected: tell every client so its UI can
  // update the "capabilities:" line (display-only, plan §29).
  registry.onChange = (caps) => {
    for (const agent of agents.values()) agent.notifyCapabilitiesChanged(caps);
  };
  const clients = new Set<string>();
  let relaySeq = 0;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down: ${reason}`);
    // Hard-exit backstop: a half-open socket must never keep the host alive
    // (e.g. a relay that was SIGKILLed instead of closing its pipe).
    const backstop = setTimeout(() => {
      log.warn("shutdown timed out; forcing exit");
      process.exit(0);
    }, 5_000);
    backstop.unref?.();
    try {
      for (const agent of agents.values()) agent.shutdown();
      agents.clear();
      try {
        await provider.shutdown();
      } catch (err) {
        log.warn("provider shutdown error", err);
      }
      if (brokerServer) {
        try {
          await brokerServer.close();
        } catch (err) {
          log.warn("broker close error", err);
        }
      }
      backend.dispose();
    } finally {
      clearTimeout(backstop);
      process.exit(0);
    }
  };

  const wireClient = (clientId: string, dispatcher: Dispatcher) => {
    clients.add(clientId);
    const agent = new AcpAgent({
      backend,
      provider,
      transport: dispatcher.transport,
      log,
      agentInfo: { name: "pi-coding-agent", version: piVersion() },
      clientId,
      registry,
    });
    agents.set(clientId, agent);
    dispatcher.transport.onEof = () => {
      clients.delete(clientId);
      agents.delete(clientId);
      registry.remove(clientId);
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
