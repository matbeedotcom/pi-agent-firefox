/**
 * Pi Browser native host entry point (PRODUCT.md §7, §42, §43).
 *
 * Launched by Firefox via connectNative("dev.pi.browser"). Owns:
 *  - Firefox framing on stdin/stdout (stdout: protocol data ONLY)
 *  - ACP agent over the Pi SDK backend
 *  - Browser tool provider (x-pi-browser/* + MCP-over-ACP)
 *
 * Lifetime: lives while Firefox keeps the port; exits when stdin closes.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PI_BROWSER_META } from "@pi-browser/protocol";
import { createLogger } from "../logger.js";
import { createStdioTransport } from "./transport.js";
import { AcpAgent } from "../acp/agent.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import { BrowserToolProvider } from "../browser/provider.js";
const require = createRequire(import.meta.url);
function piVersion() {
    try {
        const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
async function main() {
    const log = createLogger({
        ...(process.env.PI_BROWSER_LOG_FILE ? { filePath: process.env.PI_BROWSER_LOG_FILE } : {}),
    });
    log.info(`host starting pid=${process.pid} node=${process.version}`);
    const backend = new PiSdkBackend({
        log,
        ...(process.env.PI_BROWSER_AGENT_DIR ? { agentDir: process.env.PI_BROWSER_AGENT_DIR } : {}),
    });
    const dispatcher = createStdioTransport(process.stdin, process.stdout, log);
    const provider = new BrowserToolProvider(dispatcher.transport, log);
    const agent = new AcpAgent({
        backend,
        provider,
        transport: dispatcher.transport,
        log,
        agentInfo: { name: "pi-coding-agent", version: piVersion() },
    });
    let shuttingDown = false;
    const shutdown = async (reason) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.info(`shutting down: ${reason}`);
        agent.shutdown();
        try {
            await provider.shutdown();
        }
        catch (err) {
            log.warn("provider shutdown error", err);
        }
        backend.dispose();
        dispatcher.dispose();
        process.exit(0);
    };
    dispatcher.transport.onEof = () => {
        void shutdown("firefox disconnected (stdin closed)");
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
        log.error("uncaught exception", err);
        void shutdown("uncaught exception");
    });
    process.on("unhandledRejection", (err) => {
        log.error("unhandled rejection", err);
    });
    log.info(`host ready (pi ${piVersion()}, integration v${PI_BROWSER_META.version} proto=${PI_BROWSER_META.protocolVersion})`);
}
main().catch((err) => {
    // stderr only — stdout is protocol data.
    process.stderr.write(`[pi-browser-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
//# sourceMappingURL=main.js.map