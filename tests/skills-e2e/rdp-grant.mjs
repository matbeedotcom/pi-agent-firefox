/**
 * Grant an add-on's OPTIONAL permission over Firefox's remote debugging
 * protocol (RDP) — the e2e harness's replacement for the enterprise-policy
 * pre-grant.
 *
 * Why: the page-evaluation path (browser.userScripts.execute) needs the
 * optional "userScripts" permission, which normally only a user click on the
 * browser's permission prompt can grant. The harness used to pre-grant it via
 * a profile-scope policies.json (`ExtensionSettings.<id>.permissions`), but
 * Firefox 160's policy schema has no such key — only `blocked_permissions`
 * and `allowed_permissions`, and the latter merely un-blocks; it never
 * grants. Unknown keys are ignored silently, so every page-evaluation step
 * failed with BROWSER_PERMISSION_DENIED.
 *
 * How: web-ext starts Firefox with `-start-debugger-server <port>`, which
 * sets DevToolsServer.allowChromeProcess = true. Over that socket we attach
 * to the parent-process target and evaluate privileged JS that performs the
 * EXACT call `permissions.request` makes once the user clicks Allow
 * (toolkit ext-permissions.js): ExtensionPermissions.add(id, perms, extension).
 * Passing the live Extension as the emitter fires "add-permissions", so the
 * running add-on sees the grant immediately (permissions.contains → true,
 * userScripts API available) — identical to a real user grant.
 *
 * Test-only: this needs the debugger server web-ext opens for its own
 * add-on install; nothing here is reachable from a normal browser.
 *
 * Wire format: RDP packets are `<byteLength>:<JSON>` over TCP.
 */
import net from "node:net";

class RdpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    for (;;) {
      const colon = this.buffer.indexOf(0x3a); // ':'
      if (colon < 0) return;
      const header = this.buffer.subarray(0, colon).toString("utf8");
      if (!/^\d+$/.test(header)) throw new Error(`rdp: unexpected packet header ${JSON.stringify(header.slice(0, 40))}`);
      const len = Number(header);
      if (this.buffer.length < colon + 1 + len) return;
      const packet = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + len).toString("utf8"));
      this.buffer = this.buffer.subarray(colon + 1 + len);
      this.deliver(packet);
    }
  }

  deliver(packet) {
    const i = this.waiters.findIndex((w) => w.match(packet));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(packet);
    } else {
      this.queue.push(packet);
    }
  }

  /** Next packet satisfying `match` (already-queued packets count). */
  wait(match, timeoutMs, what) {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`rdp: timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  send(packet) {
    const body = Buffer.from(JSON.stringify(packet), "utf8");
    this.socket.write(`${body.length}:`);
    this.socket.write(body);
  }

  /** Request to an actor; resolves with its (non-event) reply. */
  async request(to, type, extra = {}, timeoutMs = 10_000) {
    this.send({ to, type, ...extra });
    const reply = await this.wait((p) => p.from === to && (p.type === undefined || p.error !== undefined), timeoutMs, `${type} reply from ${to}`);
    if (reply.error) throw new Error(`rdp: ${type} failed: ${reply.error}: ${reply.message ?? ""}`);
    return reply;
  }

  /** Evaluate in a console actor; returns the primitive result (or throws). */
  async evaluate(consoleActor, text, timeoutMs = 10_000) {
    const ack = await this.request(consoleActor, "evaluateJSAsync", { text }, timeoutMs);
    const result = await this.wait(
      (p) => p.from === consoleActor && p.type === "evaluationResult" && p.resultID === ack.resultID,
      timeoutMs,
      "evaluationResult",
    );
    if (result.exceptionMessage || result.hasException) throw new Error(`rdp: evaluation threw: ${result.exceptionMessage ?? "exception"}`);
    return result.result;
  }

  close() {
    this.socket.destroy();
  }
}

async function connect(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port });
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      return socket;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`rdp: could not connect to 127.0.0.1:${port} (${lastErr?.message ?? "timeout"})`);
}

/**
 * Grant `permission` (an optional permission declared by the add-on) to the
 * running add-on `addonId`. Resolves once the add-on reports hasPermission.
 */
export async function grantOptionalPermission({ port, addonId, permission, timeoutMs = 20_000 }) {
  const client = new RdpClient(await connect(port, timeoutMs));
  try {
    await client.wait((p) => p.from === "root" && p.applicationType !== undefined, timeoutMs, "root greeting");
    const { processDescriptor } = await client.request("root", "getProcess", { id: 0 });
    const { process: target } = await client.request(processDescriptor.actor, "getTarget");
    const consoleActor = target.consoleActor;
    const slot = `__piE2eGrant_${Date.now()}`;
    const payload = JSON.stringify({ addonId, permission });
    // Kick off the async grant and park its outcome in a global, then poll:
    // works whether or not the console actor awaits returned promises.
    await client.evaluate(
      consoleActor,
      `(() => {
        const { addonId, permission } = ${payload};
        globalThis[${JSON.stringify(slot)}] = "pending";
        (async () => {
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
          const ext = ExtensionParent.GlobalManager.getExtension(addonId);
          if (!ext) return JSON.stringify({ ok: false, error: "extension not running: " + addonId });
          if (!ext.optionalPermissions.includes(permission)) return JSON.stringify({ ok: false, error: permission + " is not an optional permission of " + addonId });
          await ExtensionPermissions.add(addonId, { permissions: [permission], origins: [] }, ext);
          return JSON.stringify({ ok: ext.hasPermission(permission) });
        })().then(
          (v) => { globalThis[${JSON.stringify(slot)}] = v; },
          (e) => { globalThis[${JSON.stringify(slot)}] = JSON.stringify({ ok: false, error: String(e) }); },
        );
        return "started";
      })()`,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await client.evaluate(consoleActor, `globalThis[${JSON.stringify(slot)}]`);
      if (typeof value === "string" && value !== "pending") {
        const outcome = JSON.parse(value);
        if (!outcome.ok) throw new Error(`grant ${permission} to ${addonId} failed: ${outcome.error ?? "hasPermission false after add"}`);
        return outcome;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`grant ${permission} to ${addonId}: timed out`);
  } finally {
    client.close();
  }
}
