/**
 * Shared integration-test harness: a framed client that drives the REAL
 * built native host (packages/pi-agent/dist/native-host/main.js) over
 * Firefox Native Messaging framing, exactly like the add-ons do.
 *
 * Used by e2e.test.mjs and broker.test.mjs (cross-app broker tests).
 */
import {
  PI_BROWSER_ERROR,
  isStructuredErrorObject,
} from "@pi-browser/protocol";

// ---------------------------------------------------------------------------

class HostClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.handlers = new Map();
    this.incomingRequests = []; // host -> client requests we chose not to handle
    this.buffer = Buffer.alloc(0);
    this.alive = true;

    child.stdout.on("data", (chunk) => this.onData(chunk));
    // stderr is diagnostics only; optionally mirror it to a file for debugging.
    child.stderr.on("data", (chunk) => {
      if (process.env.PI_BROWSER_E2E_STDERR) {
        import("node:fs").then((fs) => fs.appendFileSync(process.env.PI_BROWSER_E2E_STDERR, chunk));
      }
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.alive = false;
      for (const [, p] of this.pending) p.reject(new Error(`host exited (code=${code} signal=${signal})`));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + len) return;
      const payload = this.buffer.subarray(4, 4 + len).toString("utf8");
      this.buffer = this.buffer.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    // JSON-RPC: requests carry a method; responses never do. Host and
    // client id spaces are independent, so NEVER dispatch on id alone.
    if (typeof msg.method === "string" && typeof msg.id === "number") {
      // Request from the host: the fake Firefox answers.
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.incomingRequests.push(msg);
        this.sendRaw({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no handler for ${msg.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params))
        .then((result) => this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: result ?? null }))
        .catch((err) => {
          // Mirror the add-on's AcpClient error serialization exactly:
          // structured errors become reserved numeric codes + data.piBrowserError.
          const error = isStructuredErrorObject(err)
            ? { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) }
            : {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
                data: { piBrowserError: PI_BROWSER_ERROR.INTERNAL },
              };
          this.sendRaw({ jsonrpc: "2.0", id: msg.id, error });
        });
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      // Notification (method, no id): record, no response.
      this.notifications.push(msg);
      return;
    }
    if (msg.id !== undefined || msg.method !== undefined) this.notifications.push(msg);
  }

  sendRaw(obj) {
    // Safe against shutdown: a test's finally block may end the child's stdin
    // (or the child may exit) while an async response write from dispatch()
    // is still in the microtask queue. Writing a late frame to a closed stdin
    // would throw an uncaught ERR_STREAM_WRITE_AFTER_END and fail the test.
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) return;
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    const frame = Buffer.alloc(4 + json.length);
    frame.writeUInt32LE(json.length, 0);
    json.copy(frame, 4);
    try {
      stdin.write(frame);
    } catch {
      /* stdin closed between the check and the write — harmless */
    }
  }

  request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    this.sendRaw({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  /** Collect session/update notifications for a session. */
  sessionUpdates(sessionId) {
    return this.notifications.filter(
      (m) => m.method === "session/update" && m.params?.sessionId === sessionId,
    );
  }
}

export { HostClient };
