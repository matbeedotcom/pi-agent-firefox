/**
 * Installer command entry point used by /pi-browser (install | status |
 * doctor | uninstall) and by tests.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PI_BROWSER, PI_BROWSER_META } from "@pi-browser/protocol";
import { ADDON_HEARTBEAT_FRESH_MS, readClientHeartbeat } from "../client-heartbeat.js";
import type { ExecFn, InstallerEnv } from "./common.js";
import {
  detectTargets,
  defaultExec,
  installHost,
  statusHost,
  uninstallHost,
  type InstallTargets,
} from "./platforms.js";

export type InstallerCommand = "install" | "status" | "doctor" | "uninstall";

export type PlatformName = NodeJS.Platform | "linux" | "macos" | "windows";

export function normalizePlatform(p: PlatformName): "linux" | "darwin" | "win32" {
  if (p === "macos") return "darwin";
  if (p === "windows") return "win32";
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  return "linux";
}

export interface InstallerContext {
  /** Root of the installed @pi-browser/agent package (defaults to this package's root). */
  pkgRoot?: string;
  /** Override the native platform (tests). */
  platform?: PlatformName;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Injectable exec (tests). */
  exec?: ExecFn;
  /** Injectable log sink. */
  log?: (line: string) => void;
  /** Override the built host entrypoint (defaults to <pkgRoot>/dist/native-host/main.js). */
  mainJs?: string;
}

export interface CommandResult {
  ok: boolean;
  lines: string[];
}

export function defaultPkgRoot(): string {
  // When loaded from dist, the package root is two levels up (dist/installer -> package).
  // From src (jiti), also two levels up (src/installer -> package).
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

export function buildEnv(ctx: InstallerContext = {}): { env: InstallerEnv; targets: InstallTargets; pkgRoot: string; mainJs: string } {
  const pkgRoot = ctx.pkgRoot ?? defaultPkgRoot();
  const platform = normalizePlatform(ctx.platform ?? process.platform);
  const env: InstallerEnv = {
    homeDir: ctx.homeDir ?? os.homedir(),
    exec: ctx.exec ?? defaultExec(),
    platform,
  };
  const targets = detectTargets(platform);
  const mainJs = ctx.mainJs ?? path.join(pkgRoot, "dist", "native-host", "main.js");
  return { env, targets, pkgRoot, mainJs };
}

  /**
   * Add-on side of onboarding (auto-detection). The host records a heartbeat
   * when the add-on connects and on every keepalive ping; a fresh heartbeat
   * means the add-on is loaded and connected.
   */
  function addonLines(homeDir: string): { lines: string[]; detected: boolean; fresh: boolean } {
    const hb = readClientHeartbeat(homeDir);
    if (!hb) {
      return {
        lines: [
          "add-on: not detected — to finish setup:",
          "  1. build the add-on (from source): npm run build -w @pi-browser/firefox  →  firefox/dist/",
          "  2. Firefox → about:debugging#aboutThisFirefoxBrowser → “Load Temporary Add-on…” → pick firefox/dist/manifest.json (id " + PI_BROWSER.extensionId + ")",
          "  3. wait ~10s — the add-on auto-connects (no reload needed); run /pi-browser status again",
        ],
        detected: false,
        fresh: false,
      };
    }
    const ageS = Math.round(hb.ageMs / 1000);
    if (hb.ageMs <= ADDON_HEARTBEAT_FRESH_MS) {
      return { lines: [`add-on: detected (heartbeat ${ageS}s ago)`], detected: true, fresh: true };
    }
    return {
      lines: [`add-on: last heartbeat ${ageS}s ago (stale — the add-on may be disconnected or awaiting reload)`],
      detected: true,
      fresh: false,
    };
  }

export async function runCommand(command: InstallerCommand, ctx: InstallerContext = {}): Promise<CommandResult> {
  const { env, targets, pkgRoot, mainJs } = buildEnv(ctx);
  const lines: string[] = [];
  const note = (l: string) => {
    lines.push(l);
    ctx.log?.(l);
  };
  note(`platform: ${env.platform} (targets: ${targets.id})`);

  switch (command) {
    case "install": {
      if (!existsSync(mainJs)) {
        throw new Error(`host entrypoint missing: ${mainJs} (run the package build first)`);
      }
      const report = await installHost({ env, pkgRoot, mainJs }, targets);
      for (const l of report.lines) note(l);
      note(`installed ${PI_BROWSER.nativeHost} (integration v${PI_BROWSER_META.version}, protocol v${PI_BROWSER_META.protocolVersion})`);
      note("next: load the Firefox add-on (firefox/dist/manifest.json, id " + PI_BROWSER.extensionId + ")");
      note("  Firefox → about:debugging#aboutThisFirefoxBrowser → “Load Temporary Add-on…” → pick firefox/dist/manifest.json");
      note("if the add-on is already loaded, no reload is needed — it auto-detects the host within ~10s");
      return { ok: true, lines };
    }
    case "status": {
      const report = await statusHost(env, pkgRoot, targets);
      for (const l of report.lines) note(l);
      if (report.installed) {
        const addon = addonLines(env.homeDir);
        for (const l of addon.lines) note(l);
        if (addon.fresh) note("status: OK (host + add-on connected)");
        else note(addon.detected ? "status: HOST OK — add-on heartbeat stale (reload the add-on or check Firefox)" : "status: HOST OK — add-on not detected yet (see steps above)");
      } else {
        for (const issue of report.issues) note(`issue: ${issue}`);
        note("status: PROBLEMS FOUND (run /pi-browser install to repair)");
      }
      return { ok: report.installed, lines };
    }
    case "doctor": {
      const status = await statusHost(env, pkgRoot, targets);
      for (const l of status.lines) note(l);
      if (!status.installed) {
        for (const issue of status.issues) note(`issue: ${issue}`);
        note("doctor: NOT INSTALLED — run /pi-browser install");
        return { ok: false, lines };
      }
      const probe = await probeHost(env, status);
      for (const l of probe.lines) note(l);
      if (!probe.ok) {
        note("doctor: HOST PROBE FAILED");
        return { ok: false, lines };
      }
      const addon = addonLines(env.homeDir);
      for (const l of addon.lines) note(l);
      if (addon.fresh) note("doctor: OK (host + add-on connected)");
      else note(addon.detected ? "doctor: HOST OK — add-on heartbeat stale (reload the add-on or check Firefox)" : "doctor: HOST OK — next: load the add-on (see steps above; it auto-connects within ~10s)");
      return { ok: true, lines };
    }
    case "uninstall": {
      const removed = await uninstallHost(env, pkgRoot, targets);
      for (const l of removed) note(l);
      note(`uninstalled ${PI_BROWSER.nativeHost} (package files kept; pi remove to drop the package)`);
      return { ok: true, lines };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/**
 * Spawn the installed launcher and exchange one framed x-pi-browser/ping.
 * This verifies: manifest path is executable, the host boots, and framing
 * + JSON-RPC work end-to-end.
 */
export async function probeHost(
  env: InstallerEnv,
  status: { manifestPath?: string; launcherPath?: string },
  timeoutMs = 20_000,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const launcher = status.launcherPath;
  if (!launcher || !existsSync(launcher)) {
    lines.push(`probe: launcher missing (${launcher ?? "unknown"})`);
    return { ok: false, lines };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolve({ ok, lines });
    };

    const child = spawn(launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      lines.push("probe: timed out waiting for x-pi-browser/ping");
      finish(false);
    }, timeoutMs);

    let stderrTail = "";
    let buffer = Buffer.alloc(0);
    let gotPong = false;

    const send = (obj: unknown) => {
      const payload = Buffer.from(JSON.stringify(obj), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      child.stdin.write(Buffer.concat([header, payload]));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const msgText = buffer.subarray(4, 4 + len).toString("utf8");
        buffer = buffer.subarray(4 + len);
        try {
          const msg = JSON.parse(msgText) as { id?: number; result?: { pong?: boolean; meta?: unknown } };
          if (msg.id === 1 && msg.result?.pong === true) {
            gotPong = true;
            const meta = msg.result.meta as { version?: string; protocolVersion?: number } | undefined;
            lines.push(`probe: pong (integration v${meta?.version ?? "?"}, protocol v${meta?.protocolVersion ?? "?"})`);
            finish(true);
            return;
          }
        } catch {
          // ignore unparseable frames during probe
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      lines.push(`probe: failed to spawn: ${err.message}`);
      finish(false);
    });
    child.on("close", (code) => {
      if (!gotPong) {
        lines.push(`probe: host exited early (code ${code})`);
        if (stderrTail) lines.push(`probe stderr: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}`);
        finish(false);
      }
    });

    // Give the process a moment to boot, then ping.
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: 1, method: "x-pi-browser/ping", params: { clientVersion: PI_BROWSER_META.version } });
    }, 1500);
  });
}

export { PI_BROWSER_META };

/** Read the package version (for version-mismatch diagnostics). */
export function packageVersion(pkgRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
