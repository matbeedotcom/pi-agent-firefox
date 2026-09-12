/**
 * ACP agent: implements the ACP agent-side methods over the transport
 * (PRODUCT.md §5, §17–24).
 *
 * ACP owns agent session semantics: one Native Messaging connection carries
 * one ACP connection with many independent sessions. The agent maps each
 * ACP session to one Pi backend session and streams `session/update`
 * notifications back to the client.
 */
import { AGENT_METHODS, CLIENT_METHODS, PI_AGENT_META, PI_BROWSER_ERROR, PiBrowserProtocolError, PI_BROWSER_META, X_PI_BROWSER, JSONRPC_ERROR, PROTOCOL_VERSION, toErrorObject, parseAgentHello, } from "@pi-browser/protocol";
import { buildConfigOptions, CONFIG_ID_MODEL, CONFIG_ID_THINKING } from "./config-options.js";
import { touchClientHeartbeat } from "../client-heartbeat.js";
function toolKindFor(toolName) {
    if (toolName.startsWith("browser_get") || toolName === "browser_wait_for" || toolName === "browser_screenshot") {
        return "fetch";
    }
    if (toolName.startsWith("browser_"))
        return "other";
    if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls")
        return "read";
    if (toolName === "edit" || toolName === "write")
        return "edit";
    if (toolName === "bash" || toolName === "powershell")
        return "execute";
    return "other";
}
/** Map a Pi tool result content array into a single ACP Content block. */
function toToolCallContent(result) {
    const r = result;
    let block;
    if (r && Array.isArray(r.content)) {
        for (const c of r.content) {
            if (c?.type === "text" && typeof c.text === "string") {
                block = { type: "text", text: c.text };
                break;
            }
            if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
                block = { type: "image", data: c.data, mimeType: c.mimeType };
                break;
            }
        }
    }
    if (!block) {
        block = { type: "text", text: result === undefined ? "" : JSON.stringify(result) };
    }
    return { type: "content", content: block };
}
export class AcpAgent {
    opts;
    sessions = new Map();
    /** Name of the connected client (set on initialize) — for the add-on heartbeat. */
    clientIdentityName;
    /**
     * Application + capabilities from the pi.agent.hello handshake (THUNDERBIRD-PLAN.md
     * §24). Legacy clients that never send a hello default to a browser-only
     * Firefox so existing installations keep working unchanged.
     */
    clientApplication = "firefox";
    clientCapabilities = ["browser"];
    hasCapability(cap) {
        return this.clientCapabilities.includes(cap);
    }
    constructor(opts) {
        this.opts = opts;
        opts.transport.onRequest = (method, params, id) => {
            void this.handleRequest(method, params, id);
        };
        opts.transport.onNotification = (method, params) => {
            void this.handleNotification(method, params);
        };
    }
    transport() {
        return this.opts.transport;
    }
    // ------------------------------------------------------------------
    // Wire handlers
    // ------------------------------------------------------------------
    async handleRequest(method, params, id) {
        try {
            switch (method) {
                case AGENT_METHODS.initialize:
                    this.transport().respond(id, this.initialize(params));
                    return;
                case AGENT_METHODS.session_new:
                    this.transport().respond(id, await this.sessionNew(params));
                    return;
                case AGENT_METHODS.session_list:
                    this.transport().respond(id, await this.sessionList(params));
                    return;
                case AGENT_METHODS.session_resume:
                    this.transport().respond(id, await this.sessionResume(params));
                    return;
                case AGENT_METHODS.session_load:
                    this.transport().respond(id, await this.sessionLoad(params));
                    return;
                case AGENT_METHODS.session_prompt:
                    this.transport().respond(id, await this.sessionPrompt(params));
                    return;
                case AGENT_METHODS.session_cancel:
                    this.sessionCancel(params);
                    this.transport().respond(id, {});
                    return;
                case AGENT_METHODS.session_close:
                    this.sessionClose(params);
                    this.transport().respond(id, {});
                    return;
                case AGENT_METHODS.session_set_config_option:
                    this.transport().respond(id, await this.sessionSetConfigOption(params));
                    return;
                case X_PI_BROWSER.ping: {
                    const backendReady = await this.opts.backend.ready.then(() => true, () => false);
                    // Refresh the add-on heartbeat (no-op for non-add-on clients), so
                    // /pi-browser status|doctor can report add-on presence.
                    touchClientHeartbeat(this.clientIdentityName);
                    this.transport().respond(id, { pong: true, meta: PI_BROWSER_META, backendReady });
                    return;
                }
                default:
                    this.transport().respondError(id, {
                        code: JSONRPC_ERROR.METHOD_NOT_FOUND,
                        message: `unknown method: ${method}`,
                    });
            }
        }
        catch (err) {
            this.respondFailure(id, err);
        }
    }
    async handleNotification(method, params) {
        if (method === X_PI_BROWSER.notify) {
            this.opts.provider.handleNotify(params);
            return;
        }
        // ACP notifications the agent does not use are ignored by design.
        this.opts.log.debug(`ignoring notification ${method}`);
    }
    respondFailure(id, err) {
        if (err instanceof PiBrowserProtocolError) {
            this.opts.log.warn(`request failed [${err.code}] ${err.message}`);
            this.transport().respondError(id, err.toErrorObject());
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.opts.log.error(`request failed: ${message}`, err);
        this.transport().respondError(id, toErrorObject(PI_BROWSER_ERROR.INTERNAL, message));
    }
    // ------------------------------------------------------------------
    // ACP methods
    // ------------------------------------------------------------------
    initialize(req) {
        if (req.protocolVersion !== PROTOCOL_VERSION) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH, `unsupported ACP protocol version: ${req.protocolVersion} (agent supports ${PROTOCOL_VERSION})`);
        }
        const hello = parseAgentHello(req);
        this.clientApplication = hello?.client.application ?? "firefox";
        this.clientCapabilities = hello ? hello.capabilities : ["browser"];
        this.opts.log.info(`initialize: client=${req.clientInfo?.name ?? "?"} v${req.clientInfo?.version ?? "?"} ` +
            `application=${this.clientApplication} capabilities=[${this.clientCapabilities.join(",")}] ` +
            `proto=${req.protocolVersion}`);
        // Record add-on presence (no-op for non-add-on clients like test harnesses).
        this.clientIdentityName = req.clientInfo?.name;
        touchClientHeartbeat(req.clientInfo?.name, req.clientInfo?.version);
        const piAgentMeta = {
            ...PI_AGENT_META,
            application: this.clientApplication,
            capabilities: this.clientCapabilities,
        };
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true },
                sessionCapabilities: { list: {}, resume: {}, close: {} },
                mcpCapabilities: { acp: true },
            },
            agentInfo: this.opts.agentInfo,
            _meta: { piBrowser: PI_BROWSER_META, piAgent: piAgentMeta },
        };
    }
    async sessionNew(req) {
        const { state } = await this.openBackendSession((tools) => this.opts.backend.createSession({ cwd: req.cwd, customTools: tools }), req.mcpServers);
        this.opts.log.info(`session/new -> ${state.id} cwd=${state.cwd}`);
        return { sessionId: state.id, configOptions: state.configOptions };
    }
    async sessionResume(req) {
        const { state } = await this.openBackendSession(() => this.opts.backend.openSession({ sessionId: req.sessionId }), req.mcpServers, req.cwd);
        this.opts.log.info(`session/resume -> ${state.id}`);
        return { configOptions: state.configOptions };
    }
    async sessionLoad(req) {
        const { state } = await this.openBackendSession(() => this.opts.backend.openSession({ sessionId: req.sessionId }), req.mcpServers, req.cwd);
        // Replay history as session/update notifications (ACP session/load).
        for (const update of await this.replayHistory(state)) {
            this.sendSessionUpdate(state.id, update);
        }
        this.opts.log.info(`session/load -> ${state.id}`);
        return { configOptions: state.configOptions };
    }
    async sessionList(req) {
        const sessions = await this.opts.backend.listSessions(req.cwd ?? undefined);
        return {
            sessions: sessions.map(toSessionInfo),
            nextCursor: null,
        };
    }
    async sessionPrompt(req) {
        const st = this.sessions.get(req.sessionId);
        if (!st)
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${req.sessionId}`);
        if (st.session.isStreaming) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${req.sessionId} is busy`);
        }
        const { text, images } = extractPromptContent(req.prompt);
        if (!text && images.length === 0) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "empty prompt");
        }
        this.opts.log.info(`session/prompt ${req.sessionId} (${text.length} chars, ${images.length} images)`);
        const result = await st.session.prompt(text, images.length > 0 ? images : undefined);
        return { stopReason: result.aborted ? "cancelled" : "end_turn" };
    }
    sessionCancel(req) {
        const st = this.sessions.get(req.sessionId);
        if (!st) {
            this.opts.log.warn(`cancel for unknown session ${req.sessionId}`);
            return;
        }
        this.opts.log.info(`session/cancel ${req.sessionId}`);
        void st.session.abort();
    }
    sessionClose(req) {
        this.disposeSession(req.sessionId);
        this.opts.log.info(`session/close ${req.sessionId}`);
    }
    async sessionSetConfigOption(req) {
        const st = this.sessions.get(req.sessionId);
        if (!st)
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${req.sessionId}`);
        const value = req.value;
        if (req.configId === CONFIG_ID_MODEL) {
            if (typeof value !== "string" || !value) {
                throw new PiBrowserProtocolError("INTERNAL", "model option requires a non-empty value id");
            }
            await st.session.setModel(value);
        }
        else if (req.configId === CONFIG_ID_THINKING) {
            if (typeof value !== "string") {
                throw new PiBrowserProtocolError("INTERNAL", "thinking option requires a string value");
            }
            st.session.setThinkingLevel(value);
        }
        else {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED, `unknown config option: ${req.configId}`);
        }
        st.configOptions = await this.currentConfigOptions(st);
        return { configOptions: st.configOptions };
    }
    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    /**
     * Open a backend session and register all ACP-side state. Browser tools
     * are created with a lazily-bound session id because the backend assigns
     * the Pi session id at creation time.
     */
    async openBackendSession(open, mcpServers, explicitCwd) {
        const browserMode = this.opts.provider.selectMode(mcpServers);
        const mcpServer = mcpServers?.find((s) => s.type === "acp");
        const mcpServerId = mcpServer?.serverId;
        // Tools bind to the session id at execute time (id assigned below).
        const idRef = {};
        // Browser tools are only registered for clients that declared the
        // `browser` capability (legacy clients default to it, THUNDERBIRD-PLAN.md §24).
        const tools = this.hasCapability("browser")
            ? this.opts.provider.createTools(idRef, browserMode, mcpServerId)
            : [];
        const session = await open(tools);
        idRef.id = session.sessionId;
        if (this.sessions.has(session.sessionId)) {
            session.dispose();
            this.opts.provider.disposeSession(session.sessionId);
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${session.sessionId} is already open`);
        }
        let state = {
            id: session.sessionId,
            cwd: explicitCwd ?? session.cwd,
            session,
            unsubscribe: () => undefined,
            configOptions: [],
            browserMode,
            ...(mcpServerId ? { mcpServerId } : {}),
        };
        // Stream backend events to the client as session/update notifications.
        state.unsubscribe = session.subscribe((event) => {
            for (const update of this.mapEvent(state.id, event)) {
                this.sendSessionUpdate(state.id, update);
            }
        });
        const models = await this.opts.backend.listModels().catch(() => []);
        state.configOptions = buildConfigOptions({
            models,
            currentModel: session.modelValueId,
            currentThinking: session.thinkingLevel,
        });
        this.sessions.set(session.sessionId, state);
        return { session, state };
    }
    async currentConfigOptions(st) {
        const models = await this.opts.backend.listModels().catch(() => []);
        return buildConfigOptions({
            models,
            currentModel: st.session.modelValueId,
            currentThinking: st.session.thinkingLevel,
        });
    }
    sendSessionUpdate(sessionId, update) {
        const notification = { sessionId, update };
        this.opts.transport.notify(CLIENT_METHODS.session_update, notification);
    }
    mapEvent(sessionId, event) {
        void sessionId;
        switch (event.type) {
            case "text_delta":
                return [
                    {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: event.delta },
                    },
                ];
            case "thinking_delta":
                return [
                    {
                        sessionUpdate: "agent_thought_chunk",
                        content: { type: "text", text: event.delta },
                    },
                ];
            case "tool_start":
                return [
                    {
                        sessionUpdate: "tool_call",
                        toolCallId: event.toolCallId,
                        title: event.toolName,
                        kind: toolKindFor(event.toolName),
                        status: "in_progress",
                        rawInput: event.args ?? {},
                    },
                ];
            case "tool_update": {
                const updates = [];
                const partial = event.partial;
                const text = partial?.content
                    ?.filter((c) => c?.type === "text" && typeof c.text === "string")
                    .map((c) => c.text)
                    .join("");
                if (text) {
                    updates.push({
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.toolCallId,
                        content: [{ type: "content", content: { type: "text", text } }],
                    });
                }
                return updates;
            }
            case "tool_end":
                return [
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.toolCallId,
                        status: event.isError ? "failed" : "completed",
                        content: [toToolCallContent(event.result)],
                        rawOutput: event.result,
                    },
                ];
            default:
                return [];
        }
    }
    async replayHistory(st) {
        const messages = await st.session.getHistory?.().catch(() => []);
        if (!messages)
            return [];
        const updates = [];
        for (const msg of messages) {
            if (!msg.text)
                continue;
            updates.push(msg.role === "user"
                ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: msg.text } }
                : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: msg.text } });
        }
        return updates;
    }
    disposeSession(sessionId) {
        const st = this.sessions.get(sessionId);
        if (!st)
            return;
        st.unsubscribe();
        this.sessions.delete(sessionId);
        this.opts.provider.disposeSession(sessionId);
        st.session.dispose();
    }
    /** Tear down every session (host shutdown). */
    shutdown() {
        for (const id of [...this.sessions.keys()])
            this.disposeSession(id);
    }
}
function toSessionInfo(s) {
    return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        title: s.title ?? null,
    };
}
/** Split ACP prompt content blocks into text and image attachments. */
export function extractPromptContent(prompt) {
    const texts = [];
    const images = [];
    for (const block of prompt) {
        if (block.type === "text")
            texts.push(block.text);
        else if (block.type === "image") {
            const img = block;
            images.push({ data: img.data, mimeType: img.mimeType });
        }
        // resource/resource_link blocks: accepted but not forwarded (MVP).
    }
    return { text: texts.join("\n"), images };
}
//# sourceMappingURL=agent.js.map