/**
 * ACP client over the Firefox Native Messaging port (PRODUCT.md §15–18).
 *
 * Owns exactly one persistent port. `browser.runtime.connectNative()`
 * handles Firefox's framing; this class implements the JSON-RPC/ACP layer:
 * outgoing requests, incoming session/update notifications, and incoming
 * host requests (x-pi-browser/tool, mcp/*) routed to registered handlers.
 */
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PI_AGENT,
  PI_BROWSER,
  PROTOCOL_VERSION,
  X_PI_BROWSER,
  buildAgentHelloMeta,
  codeFromErrorObject,
  toErrorObject,
  type BrowserNotifyParams,
  type BrowserToolCallParams,
  type ConnectMcpRequest,
  type ConnectMcpResponse,
  type DisconnectMcpRequest,
  type Implementation,
  type InitializeResponse,
  type JsonRpcErrorObject,
  type MessageMcpRequest,
  type MessageMcpResponse,
  type PiBrowserMeta,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@pi-browser/protocol";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";

export type HostStatus =
  | { state: "connecting" }
  | { state: "connected"; agentInfo?: Implementation; piBrowserMeta?: PiBrowserMeta }
  | { state: "not_installed"; detail: string }
  | { state: "disconnected"; detail: string };

export interface AcpClientHandlers {
  onSessionUpdate(params: SessionNotification): void;
  onToolCall(params: BrowserToolCallParams): Promise<unknown>;
  onMcpConnect(params: ConnectMcpRequest): Promise<ConnectMcpResponse>;
  onMcpMessage(params: MessageMcpRequest): Promise<MessageMcpResponse>;
  onMcpDisconnect(params: DisconnectMcpRequest): Promise<void>;
  onStatus(status: HostStatus): void;
  /** Ask the user to approve/deny a sensitive tool call. Returns their choice. */
  onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;

export class AcpClient {
  private port: browser.runtime.Port | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private connecting = false;
  /** True once any message has been received on the current port. */
  private heardFromHost = false;
  private status: HostStatus = { state: "connecting" };

  constructor(private readonly handlers: AcpClientHandlers) {}

  get connected(): boolean {
    return this.port !== undefined;
  }

  /**
   * Idempotent connect: no-op when a port already exists or a connect is in
   * flight; otherwise (re)connects now. The background keepalive calls this
   * while disconnected so that a host installed AFTER the add-on loaded is
   * auto-detected within one keepalive tick — even if the event page was
   * unloaded and the 3s reconnect timer was lost (MV3 idle unload).
   */
  ensureConnected(): void {
    this.connect();
  }

  get currentStatus(): HostStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.port?.disconnect();
    this.port = undefined;
  }

  private connect(): void {
    if (this.stopped || this.port || this.connecting) return;
    this.connecting = true;
    let port: browser.runtime.Port;
    try {
      port = browser.runtime.connectNative(PI_AGENT.nativeHost);
    } catch (err) {
      this.connecting = false;
      this.failConnection("not_installed", err instanceof Error ? err.message : String(err));
      return;
    }
    this.connecting = false;
    this.heardFromHost = false;
    // Assign the port BEFORE emitting the "connecting" status: status
    // listeners may immediately issue requests (initialize) against it.
    this.port = port;
    this.setStatus({ state: "connecting" });
    port.onMessage.addListener((msg: unknown) => this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      const message = browser.runtime.lastError?.message ?? "native port disconnected";
      // Lifecycle detection (robust across Firefox builds): some builds
      // return a port that dies immediately WITHOUT a lastError when the
      // host manifest is missing, so the message text is not a reliable
      // signal. A port that dies before we ever heard from the host means
      // the host never spoke -> missing/broken host (not_installed). A port
      // that dies after a successful exchange is a mid-session drop.
      const notInstalled =
        !this.heardFromHost ||
        /could not connect|not be found|no such file|failed to load|application was not found/i.test(message);
      this.heardFromHost = false;
      this.port = undefined;
      this.rejectAll(new Error(message));
      this.setStatus(
        notInstalled ? { state: "not_installed", detail: message } : { state: "disconnected", detail: message },
      );
      this.scheduleReconnect();
    });
  }

  private failConnection(kind: "not_installed" | "disconnected", detail: string): void {
    this.rejectAll(new Error(detail));
    this.setStatus(kind === "not_installed" ? { state: "not_installed", detail } : { state: "disconnected", detail });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private setStatus(status: HostStatus): void {
    this.status = status;
    try {
      this.handlers.onStatus(status);
    } catch {
      // handler errors must never kill the client
    }
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    this.heardFromHost = true;
    const m = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown };
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(m.error as JsonRpcErrorObject);
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method === "string") {
      if (typeof m.id === "number") {
        void this.handleIncomingRequest(m.id, m.method, m.params as never);
      } else {
        this.handleNotification(m.method, m.params as never);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === CLIENT_METHODS.session_update) {
      try {
        this.handlers.onSessionUpdate(params as SessionNotification);
      } catch (err) {
        console.error("[pi-browser] session_update handler failed", err);
      }
      return;
    }
    // Other ACP notifications are not used by the add-on.
  }

  private async handleIncomingRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      let result: unknown;
      if (method === X_PI_BROWSER.tool) {
        result = await this.handlers.onToolCall(params as BrowserToolCallParams);
      } else if (method === CLIENT_METHODS.mcp_connect) {
        result = await this.handlers.onMcpConnect(params as ConnectMcpRequest);
      } else if (method === CLIENT_METHODS.mcp_message) {
        result = await this.handlers.onMcpMessage(params as MessageMcpRequest);
      } else if (method === CLIENT_METHODS.mcp_disconnect) {
        result = await this.handlers.onMcpDisconnect(params as DisconnectMcpRequest);
      } else if (method === CLIENT_METHODS.session_request_permission) {
        result = await this.handlers.onRequestPermission(params as RequestPermissionRequest);
      } else {
        this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
        return;
      }
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      const errorObject: JsonRpcErrorObject =
        err instanceof PiBrowserProtocolError
          ? err.toErrorObject()
          : {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
              data: { piBrowserError: PI_BROWSER_ERROR.INTERNAL },
            };
      this.send({ jsonrpc: "2.0", id, error: errorObject });
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.port) return Promise.reject(new PiBrowserProtocolError(PI_BROWSER_ERROR.NATIVE_HOST_NOT_INSTALLED, "not connected to native host"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      const port = this.port;
      if (!port) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error("port closed while sending"));
        return;
      }
      try {
        port.postMessage({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  private send(msg: unknown): void {
    try {
      this.port?.postMessage(msg);
    } catch (err) {
      console.error("[pi-browser] postMessage failed", err);
    }
  }

  private rejectAll(err: unknown): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** ACP initialize; feature-detects capabilities and Pi Browser metadata. */
  async initialize(): Promise<InitializeResponse> {
    const res = await this.request<InitializeResponse>(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "pi-browser-firefox", version: browser.runtime.getManifest().version },
      // pi.agent.hello: declare application + capabilities (THUNDERBIRD-PLAN.md §24).
      _meta: buildAgentHelloMeta({
        client: {
          application: "firefox",
          // runtime.id is the resolved add-on ID (temporary installs get a
          // generated ID); fall back to the declared gecko.id.
          extensionId:
            browser.runtime.id ??
            (browser.runtime.getManifest().browser_specific_settings?.gecko?.id as string | undefined) ??
            PI_BROWSER.extensionId,
          version: browser.runtime.getManifest().version,
        },
        capabilities: ["browser"],
      }),
    }, INITIALIZE_TIMEOUT_MS);
    if (res.protocolVersion !== PROTOCOL_VERSION) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH,
        `agent speaks ACP ${res.protocolVersion}, add-on supports ${PROTOCOL_VERSION}`,
      );
    }
    const meta = (res._meta as { piBrowser?: PiBrowserMeta } | undefined)?.piBrowser;
    if (meta && meta.protocolVersion !== PI_BROWSER.protocolVersion) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH,
        `piBrowser protocol ${meta.protocolVersion} != supported ${PI_BROWSER.protocolVersion}`,
      );
    }
    this.setStatus({ state: "connected", agentInfo: res.agentInfo ?? undefined, piBrowserMeta: meta });
    return res;
  }
}

/** Notify the host about browser-side events (tab closed/navigated). */
export function notifyHost(client: AcpClient, params: BrowserNotifyParams): void {
  try {
    client
      .request(X_PI_BROWSER.notify, params, 5_000)
      .catch(() => {
        /* notifications are best-effort */
      });
  } catch {
    // not connected
  }
}

export { codeFromErrorObject, toErrorObject };
