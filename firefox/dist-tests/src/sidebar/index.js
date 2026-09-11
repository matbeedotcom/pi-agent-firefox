let blockCounter = 0;
const transcripts = new Map();
function blocksFor(sessionId) {
    let blocks = transcripts.get(sessionId);
    if (!blocks) {
        blocks = [];
        transcripts.set(sessionId, blocks);
    }
    return blocks;
}
function addBlock(sessionId, block) {
    block.id = ++blockCounter;
    blocksFor(sessionId).push(block);
}
// ---------------------------------------------------------------------------
// Background bridge
// ---------------------------------------------------------------------------
function action(name, payload) {
    return new Promise((resolve, reject) => {
        browser.runtime
            .sendMessage({ type: "pi/action", action: name, ...(payload !== undefined ? { payload } : {}) })
            .then((resp) => {
            if (resp && resp.ok === false) {
                reject(new Error(resp.error?.message ?? "action failed"));
            }
            else {
                resolve((resp?.result ?? resp));
            }
        })
            .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    });
}
// ---------------------------------------------------------------------------
// ACP session/update -> transcript
// ---------------------------------------------------------------------------
function applySessionUpdate(sessionId, update) {
    switch (update.sessionUpdate) {
        case "user_message_chunk": {
            const text = chunkText(update);
            if (!text)
                break;
            const blocks = blocksFor(sessionId);
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "user")
                last.text += text;
            else
                addBlock(sessionId, { id: 0, kind: "user", text });
            break;
        }
        case "agent_message_chunk": {
            const text = chunkText(update);
            if (!text)
                break;
            const blocks = blocksFor(sessionId);
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "assistant")
                last.text += text;
            else
                addBlock(sessionId, { id: 0, kind: "assistant", text });
            break;
        }
        case "agent_thought_chunk": {
            const text = chunkText(update);
            if (!text)
                break;
            const blocks = blocksFor(sessionId);
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "thought")
                last.text += text;
            else
                addBlock(sessionId, { id: 0, kind: "thought", text });
            break;
        }
        case "tool_call": {
            addBlock(sessionId, {
                id: 0,
                kind: "tool",
                toolCallId: update.toolCallId,
                title: update.title ?? "tool",
                status: update.status ?? "in_progress",
                text: "",
                input: update.rawInput,
            });
            break;
        }
        case "tool_call_update": {
            const blocks = blocksFor(sessionId);
            const block = blocks.find((b) => b.kind === "tool" && b.toolCallId === update.toolCallId);
            if (!block || block.kind !== "tool")
                break;
            if (update.status)
                block.status = update.status;
            if (update.title)
                block.title = update.title;
            const text = toolUpdateText(update);
            if (text)
                block.text = text;
            break;
        }
        default:
            break;
    }
    if (activeSessionId === sessionId)
        renderConversation();
}
function chunkText(update) {
    const chunk = update;
    return chunk.content?.type === "text" ? (chunk.content.text ?? "") : "";
}
function toolUpdateText(update) {
    const u = update;
    if (!Array.isArray(u.content))
        return "";
    const parts = [];
    for (const c of u.content) {
        if (c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") {
            parts.push(c.content.text);
        }
    }
    return parts.join("\n");
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let uiState = { status: { state: "connecting" }, sessions: [] };
let activeSessionId;
function renderAll() {
    renderStatus();
    renderSessions();
    renderActive();
    renderConversation();
    renderOnboarding();
}
// Onboarding screen ("no ACP server detected"). Dismissal is per sidebar
// open — it reappears the next time the sidebar opens while not_installed.
let onboardDismissed = false;
function renderOnboarding() {
    const el = $("onboard-overlay");
    const show = uiState.status.state === "not_installed" && !onboardDismissed;
    el.classList.toggle("hidden", !show);
}
function renderStatus() {
    const el = $("status");
    const s = uiState.status;
    el.classList.remove("ok", "err");
    switch (s.state) {
        case "connected": {
            el.classList.add("ok");
            const agent = s.agentInfo ? `${s.agentInfo.name ?? "agent"} ${s.agentInfo.version ?? ""}`.trim() : "connected";
            el.textContent = `Pi · ${agent}`;
            el.title = s.piBrowserMeta
                ? `integration v${s.piBrowserMeta.version}, protocol v${s.piBrowserMeta.protocolVersion}, tools v${s.piBrowserMeta.browserToolVersion}`
                : "";
            break;
        }
        case "connecting":
            el.textContent = "connecting to native host…";
            break;
        case "not_installed":
            el.classList.add("err");
            el.textContent = "native host not detected — run /pi-browser install";
            el.title =
                "Auto-detecting: the add-on connects on its own as soon as the host " +
                    "is installed (no reload needed).\n\n" + (s.detail ?? "");
            break;
        default:
            el.classList.add("err");
            el.textContent = "disconnected — reconnecting…";
            el.title = s.detail ?? "";
    }
}
function renderSessions() {
    const ul = $("sessions");
    ul.textContent = "";
    for (const s of uiState.sessions) {
        const li = document.createElement("li");
        if (s.sessionId === activeSessionId)
            li.classList.add("active");
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = s.title || s.sessionId.slice(0, 8);
        const cwd = document.createElement("span");
        cwd.className = "cwd";
        cwd.textContent = s.cwd;
        li.append(title, cwd);
        if (s.streaming) {
            const dot = document.createElement("span");
            dot.className = "streaming";
            dot.textContent = "●";
            li.append(dot);
        }
        li.addEventListener("click", () => {
            void action("select_session", { sessionId: s.sessionId }).catch((err) => flash(`select failed: ${err.message}`));
        });
        ul.append(li);
    }
}
function renderActive() {
    const session = uiState.sessions.find((s) => s.sessionId === activeSessionId);
    const pane = $("active-pane");
    const empty = $("empty");
    if (!session) {
        pane.classList.add("hidden");
        empty.classList.remove("hidden");
        return;
    }
    empty.classList.add("hidden");
    pane.classList.remove("hidden");
    const meta = $("meta-row");
    meta.textContent = `cwd: ${session.cwd}${session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleString()}` : ""}`;
    renderConfigRow(session);
    renderBindingRow(session);
    updateComposerState(session);
}
function renderConfigRow(session) {
    const row = $("config-row");
    row.textContent = "";
    const options = session.configOptions ?? [];
    if (options.length === 0) {
        row.classList.add("hidden");
        return;
    }
    row.classList.remove("hidden");
    for (const opt of options) {
        if (opt.type !== "select")
            continue;
        const selectOpt = opt;
        const label = document.createElement("label");
        label.textContent = `${selectOpt.name}: `;
        const select = document.createElement("select");
        const values = flattenOptions(selectOpt.options);
        for (const v of values) {
            const optEl = document.createElement("option");
            optEl.value = v.value;
            optEl.textContent = v.name;
            select.append(optEl);
        }
        select.value = String(selectOpt.currentValue ?? "");
        select.addEventListener("change", () => {
            void action("set_config", { sessionId: session.sessionId, configId: selectOpt.id, value: select.value }).catch((err) => flash(`config change failed: ${err.message}`));
        });
        row.append(label, select);
    }
}
function flattenOptions(options) {
    const out = [];
    for (const o of options) {
        if ("options" in o) {
            out.push(...o.options);
        }
        else {
            out.push(o);
        }
    }
    return out;
}
function renderBindingRow(session) {
    const row = $("binding-row");
    row.textContent = "";
    const title = document.createElement("span");
    title.className = "binding-title";
    if (session.binding) {
        title.textContent = `Bound tab: ${session.binding.tabTitle || `#${session.binding.tabId}`}`;
    }
    else {
        title.textContent = "No tab bound";
    }
    row.append(title);
    if (session.binding) {
        const open = document.createElement("button");
        open.textContent = "Open tab";
        open.className = "secondary";
        open.addEventListener("click", () => {
            void action("open_bound_tab", { sessionId: session.sessionId }).catch(() => { });
        });
        row.append(open);
        const unbind = document.createElement("button");
        unbind.textContent = "Unbind";
        unbind.className = "secondary";
        unbind.addEventListener("click", () => {
            void action("unbind", { sessionId: session.sessionId }).catch(() => { });
        });
        row.append(unbind);
    }
    else {
        const bind = document.createElement("button");
        bind.textContent = "Bind current tab";
        bind.addEventListener("click", () => {
            void action("bind_current_tab", { sessionId: session.sessionId }).catch((err) => flash(`bind failed: ${err.message}`));
        });
        row.append(bind);
    }
}
function updateComposerState(session) {
    $("stop").classList.toggle("hidden", !session.streaming);
    $("send").disabled = session.streaming || uiState.status.state !== "connected";
}
let flashTimer;
function flash(text) {
    const status = $("status");
    const prev = status.textContent;
    status.textContent = text;
    status.classList.add("err");
    if (flashTimer)
        clearTimeout(flashTimer);
    flashTimer = setTimeout(() => renderStatus(), 4000);
    void prev;
}
// ---------------------------------------------------------------------------
// Conversation rendering (markdown-lite)
// ---------------------------------------------------------------------------
function renderConversation() {
    const conv = $("conversation");
    const blocks = activeSessionId ? blocksFor(activeSessionId) : [];
    conv.textContent = "";
    for (const block of blocks) {
        const div = document.createElement("div");
        if (block.kind === "tool") {
            div.className = "msg tool";
            const head = document.createElement("div");
            head.className = "tool-head";
            const name = document.createElement("span");
            name.textContent = block.title;
            const status = document.createElement("span");
            status.className = `tool-status ${block.status === "completed" ? "done" : block.status === "failed" ? "failed" : ""}`;
            status.textContent = block.status;
            head.append(name, status);
            div.append(head);
            const body = renderMarkdown(block.text);
            body.classList.add("muted");
            div.append(body);
        }
        else {
            div.className = `msg ${block.kind}`;
            div.append(renderMarkdown(block.text));
        }
        conv.append(div);
    }
    conv.scrollTop = conv.scrollHeight;
}
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Minimal markdown: fenced code blocks, inline code, bold, headings. */
function renderMarkdown(text) {
    const wrapper = document.createElement("div");
    const parts = text.split(/```/);
    parts.forEach((part, i) => {
        if (i % 2 === 1) {
            // code block; first line may be a language tag
            const nl = part.indexOf("\n");
            const code = nl >= 0 ? part.slice(nl + 1) : part;
            const pre = document.createElement("pre");
            const codeEl = document.createElement("code");
            codeEl.textContent = code.replace(/\n$/, "");
            pre.append(codeEl);
            wrapper.append(pre);
            return;
        }
        wrapper.append(renderInline(part));
    });
    return wrapper;
}
function renderInline(text) {
    const span = document.createElement("span");
    const lines = escapeHtml(text).split("\n");
    lines.forEach((line, idx) => {
        if (idx > 0)
            span.append(document.createElement("br"));
        // headings
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            const h = document.createElement(`h${Math.min(heading[1].length + 1, 5)}`);
            h.append(fragmentFromInline(heading[2]));
            span.append(h);
            return;
        }
        span.append(fragmentFromInline(line));
    });
    return span;
}
function fragmentFromInline(line) {
    const frag = document.createDocumentFragment();
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
        if (m.index > last)
            frag.append(line.slice(last, m.index));
        if (m[1]) {
            const code = document.createElement("code");
            code.className = "code";
            code.textContent = m[1].slice(1, -1);
            frag.append(code);
        }
        else if (m[2]) {
            const b = document.createElement("b");
            b.append(m[2].slice(2, -2));
            frag.append(b);
        }
        last = m.index + m[0].length;
    }
    if (last < line.length)
        frag.append(line.slice(last));
    return frag;
}
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((message) => {
    if (typeof message !== "object" || message === null)
        return;
    const msg = message;
    if (msg.type === "pi/state" && msg.state) {
        uiState = msg.state;
        activeSessionId = msg.state.activeSessionId;
        renderAll();
    }
    else if (msg.type === "pi/session_update" && msg.sessionId && msg.update) {
        applySessionUpdate(msg.sessionId, msg.update);
    }
    else if (msg.type === "pi/permission_request" && msg.request) {
        showPermissionPrompt(msg.request);
    }
});
function showPermissionPrompt(request) {
    const overlay = $("perm-overlay");
    const desc = $("perm-desc");
    const optionsWrap = $("perm-options");
    const permId = request.toolCall.toolCallId;
    // Guard against a stale sidebar (no modal markup): answer "cancelled" so the
    // host never hangs, rather than crashing the message handler.
    if (!overlay || !desc || !optionsWrap) {
        browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId: "cancelled" }).catch(() => { });
        return;
    }
    const tool = request._meta?.piBrowser?.tool ?? request.toolCall.title ?? "an action";
    // Friendly per-tool description.
    desc.textContent =
        tool === "browser_screenshot"
            ? "Pi wants to take a screenshot of the bound tab. Approving brings the tab to the front and captures what is visible."
            : `Pi wants to run: ${tool}.`;
    optionsWrap.textContent = "";
    // Order: Allow once (primary), Always allow, Deny.
    const order = ["allow_once", "allow_always", "reject_once"];
    const sorted = [...request.options].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const opt of sorted) {
        const btn = document.createElement("button");
        btn.textContent = opt.name;
        if (opt.kind === "allow_once")
            btn.className = "perm-primary";
        else if (opt.kind === "reject_once")
            btn.className = "perm-reject";
        else
            btn.className = "perm-always";
        btn.addEventListener("click", () => {
            browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId: opt.optionId }).catch(() => { });
            hidePermissionPrompt();
        });
        optionsWrap.append(btn);
    }
    overlay.classList.remove("hidden");
}
function hidePermissionPrompt() {
    const overlay = $("perm-overlay");
    if (overlay)
        overlay.classList.add("hidden");
}
$("new-session").addEventListener("click", () => {
    $("new-panel").classList.toggle("hidden");
    if (!$("new-panel").classList.contains("hidden")) {
        const input = $("cwd-input");
        input.value = activeSessionId ? uiState.sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? "" : "";
        input.focus();
    }
});
$("cwd-cancel").addEventListener("click", () => {
    $("new-panel").classList.add("hidden");
});
$("cwd-create").addEventListener("click", () => {
    const cwd = $("cwd-input").value.trim();
    void action("new_session", { cwd })
        .then(() => {
        $("new-panel").classList.add("hidden");
    })
        .catch((err) => flash(`create failed: ${err.message}`));
});
$("cwd-create").addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        $("cwd-create").click();
});
$("cwd-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        $("cwd-create").click();
    if (e.key === "Escape")
        $("cwd-cancel").click();
});
$("refresh").addEventListener("click", () => {
    void action("refresh_sessions").catch(() => { });
});
// Onboarding: "Check again now" asks the background for an immediate
// (idempotent) connect attempt; a status push then hides the screen if the
// host appeared. "Dismiss" hides it for this sidebar open.
$("onboard-check").addEventListener("click", () => {
    browser.runtime
        .sendMessage({ type: "pi/ensure_connected" })
        .then((res) => {
        if (res?.connected) {
            // Fast path: refresh so the UI flips before the next status push.
            void action("get_state").then((s) => {
                uiState = s;
                renderAll();
            }).catch(() => { });
        }
    })
        .catch(() => { });
});
$("onboard-dismiss").addEventListener("click", () => {
    onboardDismissed = true;
    renderOnboarding();
});
$("send").addEventListener("click", () => {
    void sendPrompt();
});
$("stop").addEventListener("click", () => {
    if (!activeSessionId)
        return;
    void action("cancel", { sessionId: activeSessionId }).catch(() => { });
});
$("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendPrompt();
    }
});
async function sendPrompt() {
    const input = $("prompt");
    const text = input.value.trim();
    if (!text || !activeSessionId)
        return;
    const session = uiState.sessions.find((s) => s.sessionId === activeSessionId);
    if (session?.streaming)
        return;
    input.value = "";
    addBlock(activeSessionId, { id: 0, kind: "user", text });
    renderConversation();
    await action("prompt", { sessionId: activeSessionId, text }).catch((err) => flash(`send failed: ${err.message}`));
}
// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
void (async () => {
    renderAll();
    try {
        const state = (await action("get_state"));
        uiState = state;
        activeSessionId = state.activeSessionId;
        renderAll();
        // Rehydrate the transcript of the active session if needed.
        const active = state.sessions.find((s) => s.sessionId === activeSessionId);
        if (active && !active.loaded) {
            // Background will load it; nothing to do here.
        }
    }
    catch {
        // background not ready yet; state will arrive via push
    }
})();
export {};
