/**
 * ACP client over the Firefox Native Messaging port (PRODUCT.md §15–18).
 *
 * Owns exactly one persistent port. `browser.runtime.connectNative()`
 * handles Firefox's framing; this class implements the JSON-RPC/ACP layer:
 * outgoing requests, incoming session/update notifications, and incoming
 * host requests (x-pi-browser/tool, mcp/*) routed to registered handlers.
 */
import { AGENT_METHODS, CLIENT_METHODS, PI_BROWSER, PROTOCOL_VERSION, X_PI_BROWSER, codeFromErrorObject, toErrorObject, } from "@pi-browser/protocol";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
const DEFAULT_TIMEOUT_MS = 10_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;
export class AcpClient {
    handlers;
    port;
    nextId = 0;
    pending = new Map();
    reconnectTimer;
    stopped = false;
    connecting = false;
    status = { state: "connecting" };
    constructor(handlers) {
        this.handlers = handlers;
    }
    get connected() {
        return this.port !== undefined;
    }
    /**
     * Idempotent connect: no-op when a port already exists or a connect is in
     * flight; otherwise (re)connects now. The background keepalive calls this
     * while disconnected so that a host installed AFTER the add-on loaded is
     * auto-detected within one keepalive tick — even if the event page was
     * unloaded and the 3s reconnect timer was lost (MV3 idle unload).
     */
    ensureConnected() {
        this.connect();
    }
    get currentStatus() {
        return this.status;
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.port?.disconnect();
        this.port = undefined;
    }
    connect() {
        if (this.stopped || this.port || this.connecting)
            return;
        this.connecting = true;
        let port;
        try {
            port = browser.runtime.connectNative(PI_BROWSER.nativeHost);
        }
        catch (err) {
            this.connecting = false;
            this.failConnection("not_installed", err instanceof Error ? err.message : String(err));
            return;
        }
        this.connecting = false;
        // Assign the port BEFORE emitting the "connecting" status: status
        // listeners may immediately issue requests (initialize) against it.
        this.port = port;
        this.setStatus({ state: "connecting" });
        port.onMessage.addListener((msg) => this.onMessage(msg));
        port.onDisconnect.addListener(() => {
            const message = browser.runtime.lastError?.message ?? "native port disconnected";
            const notInstalled = /could not connect|not be found|no such file|failed to load|application was not found/i.test(message);
            this.port = undefined;
            this.rejectAll(new Error(message));
            this.setStatus(notInstalled ? { state: "not_installed", detail: message } : { state: "disconnected", detail: message });
            this.scheduleReconnect();
        });
    }
    failConnection(kind, detail) {
        this.rejectAll(new Error(detail));
        this.setStatus(kind === "not_installed" ? { state: "not_installed", detail } : { state: "disconnected", detail });
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, RECONNECT_DELAY_MS);
    }
    setStatus(status) {
        this.status = status;
        try {
            this.handlers.onStatus(status);
        }
        catch {
            // handler errors must never kill the client
        }
    }
    onMessage(msg) {
        if (typeof msg !== "object" || msg === null)
            return;
        const m = msg;
        if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
            const p = this.pending.get(m.id);
            if (!p)
                return;
            this.pending.delete(m.id);
            if (p.timer)
                clearTimeout(p.timer);
            if (m.error)
                p.reject(m.error);
            else
                p.resolve(m.result);
            return;
        }
        if (typeof m.method === "string") {
            if (typeof m.id === "number") {
                void this.handleIncomingRequest(m.id, m.method, m.params);
            }
            else {
                this.handleNotification(m.method, m.params);
            }
        }
    }
    handleNotification(method, params) {
        if (method === CLIENT_METHODS.session_update) {
            try {
                this.handlers.onSessionUpdate(params);
            }
            catch (err) {
                console.error("[pi-browser] session_update handler failed", err);
            }
            return;
        }
        // Other ACP notifications are not used by the add-on.
    }
    async handleIncomingRequest(id, method, params) {
        try {
            let result;
            if (method === X_PI_BROWSER.tool) {
                result = await this.handlers.onToolCall(params);
            }
            else if (method === CLIENT_METHODS.mcp_connect) {
                result = await this.handlers.onMcpConnect(params);
            }
            else if (method === CLIENT_METHODS.mcp_message) {
                result = await this.handlers.onMcpMessage(params);
            }
            else if (method === CLIENT_METHODS.mcp_disconnect) {
                result = await this.handlers.onMcpDisconnect(params);
            }
            else if (method === CLIENT_METHODS.session_request_permission) {
                result = await this.handlers.onRequestPermission(params);
            }
            else {
                this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
                return;
            }
            this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
        }
        catch (err) {
            const errorObject = err instanceof PiBrowserProtocolError
                ? err.toErrorObject()
                : {
                    code: -32603,
                    message: err instanceof Error ? err.message : String(err),
                    data: { piBrowserError: PI_BROWSER_ERROR.INTERNAL },
                };
            this.send({ jsonrpc: "2.0", id, error: errorObject });
        }
    }
    request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (!this.port)
            return Promise.reject(new PiBrowserProtocolError(PI_BROWSER_ERROR.NATIVE_HOST_NOT_INSTALLED, "not connected to native host"));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            let timer;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`request timed out: ${method}`));
                }, timeoutMs);
            }
            this.pending.set(id, {
                method,
                resolve: (v) => {
                    if (timer)
                        clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    if (timer)
                        clearTimeout(timer);
                    reject(e);
                },
            });
            const port = this.port;
            if (!port) {
                this.pending.delete(id);
                if (timer)
                    clearTimeout(timer);
                reject(new Error("port closed while sending"));
                return;
            }
            try {
                port.postMessage({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
            }
            catch (err) {
                this.pending.delete(id);
                if (timer)
                    clearTimeout(timer);
                reject(err);
            }
        });
    }
    send(msg) {
        try {
            this.port?.postMessage(msg);
        }
        catch (err) {
            console.error("[pi-browser] postMessage failed", err);
        }
    }
    rejectAll(err) {
        for (const p of this.pending.values()) {
            if (p.timer)
                clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }
    /** ACP initialize; feature-detects capabilities and Pi Browser metadata. */
    async initialize() {
        const res = await this.request(AGENT_METHODS.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "pi-browser-firefox", version: browser.runtime.getManifest().version },
        }, INITIALIZE_TIMEOUT_MS);
        if (res.protocolVersion !== PROTOCOL_VERSION) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH, `agent speaks ACP ${res.protocolVersion}, add-on supports ${PROTOCOL_VERSION}`);
        }
        const meta = res._meta?.piBrowser;
        if (meta && meta.protocolVersion !== PI_BROWSER.protocolVersion) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH, `piBrowser protocol ${meta.protocolVersion} != supported ${PI_BROWSER.protocolVersion}`);
        }
        this.setStatus({ state: "connected", agentInfo: res.agentInfo ?? undefined, piBrowserMeta: meta });
        return res;
    }
}
/** Notify the host about browser-side events (tab closed/navigated). */
export function notifyHost(client, params) {
    try {
        client
            .request(X_PI_BROWSER.notify, params, 5_000)
            .catch(() => {
            /* notifications are best-effort */
        });
    }
    catch {
        // not connected
    }
}
export { codeFromErrorObject, toErrorObject };
