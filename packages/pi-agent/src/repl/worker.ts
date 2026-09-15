/**
 * ReplWorker — the persistent V8 REPL child behind the `javascript` tool.
 *
 * Ported and adapted from browser-use-pi
 * (https://github.com/browser-use/browser-use-pi, package `@browser_use/pi`
 * v0.1.0, MIT license): realm creation via node:inspector, cell evaluation
 * semantics (replMode, object groups, last-expression capture), bounded
 * output capture with secret redaction, and the artifact/checkpoint helpers.
 *
 * Differences from the SDK worker:
 *  - the CDP layer is replaced by a tool channel: `page`/`tabs` are IPC
 *    proxies whose methods execute browser tools on the session's current
 *    tab (the host routes them through the add-on; the DOM is in Firefox);
 *  - `require` is NOT exposed (v1) — the realm gets curated globals only;
 *  - no domain policy / highlight / recording / sensitiveData.
 *
 * Why node:inspector: it is a V8 handle to THIS process's own engine, used
 * to run each cell in one persistent named context with REPL semantics
 * (top-level await, last-expression capture, per-cell object-group cleanup).
 * It does not connect to the browser.
 */
import { Writable } from "node:stream";
import { Session } from "node:inspector";
import { createContext } from "node:vm";
import { inspect } from "node:util";
import { appendFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ReplImage,
  ReplRequest,
  ReplResponse,
  ReplToolResponse,
  ReplWorkerConfig,
} from "./types.js";

// IPC initialization keeps configuration out of argv and environment.
process.on("disconnect", () => process.exit(0));
const config = (await new Promise<ReplWorkerConfig>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("worker config timeout")), 10_000);
  process.once("message", (message: ReplWorkerConfig) => {
    clearTimeout(timer);
    resolve(message);
  });
})) as ReplWorkerConfig;

process.chdir(config.workspace);
const clean = <T>(value: T): T => {
  // Redaction is applied to text in the sink; this guards tool-originated
  // values that are serialized into output.
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  let out = json;
  for (const secret of config.redact) if (secret) out = out.split(secret).join("[REDACTED]");
  return JSON.parse(out) as T;
};
const send = (message: ReplResponse | ReplToolResponse): void => {
  try {
    process.send!(message);
  } catch {
    /* channel gone; the runtime treats exit as state loss */
  }
};

// ---------------------------------------------------------------------------
// Output capture: bounded, redacted across chunk boundaries, spilled to file
// ---------------------------------------------------------------------------

let outputFile: string | undefined;
let output = "";
let images: ReplImage[] = [];
let overflow = false;
/** Bound memory even when generated code writes an unbounded amount of output. */
const hardLimit = 1_000_000;
let pendingText = "";
const tailLength = Math.max(0, ...config.redact.map((value) => value.length));

function captureText(text: string): void {
  if (output.length + text.length > hardLimit) overflow = true;
  const captured = text.slice(0, Math.max(0, hardLimit - output.length));
  output += captured;
  if (outputFile && captured) appendFileSync(outputFile, captured);
}

const sink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    pendingText += chunk.toString();
    // Redact before splitting, and retain the raw suffix across chunk boundaries.
    const cut = Math.max(0, pendingText.length - tailLength);
    let safeCut = cut;
    for (const secret of config.redact) {
      if (!secret) continue;
      let at = pendingText.indexOf(secret);
      while (at >= 0 && at < cut) {
        if (at + secret.length > cut) safeCut = Math.min(safeCut, at);
        at = pendingText.indexOf(secret, at + 1);
      }
    }
    captureText(cleanText(pendingText.slice(0, safeCut)));
    pendingText = pendingText.slice(safeCut);
    callback();
  },
});

function cleanText(text: string): string {
  let out = text;
  for (const secret of config.redact) if (secret) out = out.split(secret).join("[REDACTED]");
  return out;
}

// ---------------------------------------------------------------------------
// Tool channel: page/tabs primitives execute browser tools on the session's
// current tab. The host owns routing, permissions and the add-on.
// ---------------------------------------------------------------------------

let nextToolId = 0;
const toolPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const id = ++nextToolId;
  return new Promise<unknown>((resolve, reject) => {
    toolPending.set(id, { resolve, reject });
    let sent = false;
    try {
      sent = process.send!({ type: "tool", id, tool, args } as never);
    } catch {
      sent = false;
    }
    if (!sent) {
      toolPending.delete(id);
      reject(new Error("Repl channel closed; the cell was interrupted."));
    }
  });
}

process.on("message", (message: ReplToolResponse) => {
  if (message.type === "tool-result") {
    const pending = toolPending.get(message.id);
    if (!pending) return;
    toolPending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(clean(message.result));
  }
});

/** The REPL's active tab. Undefined = the session's bound tab (the default). */
let activeTabId: number | undefined;
/** Targets the REPL opened itself (closed by the add-on at session end). */
const ownedTabIds = new Set<number>();

function requireFiniteCoordinates(x: unknown, y: unknown): void {
  if (![x, y].every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new Error("Coordinates must be finite numbers.");
}

const page = {
  /** Navigate the current tab. Resolves after the document stops loading. */
  async goto(url: string) {
    const result = (await callTool("browser_navigate", { url })) as { errorText?: string } | undefined;
    if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    // Runs IN THE PAGE (serialized as source, never executed here).
    await this.waitFor("() => document.readyState !== 'loading'");
    return this.info();
  },
  /** { url, title } of the current tab. */
  async info() {
    const result = (await callTool("browser_get_page", {})) as { url?: string; title?: string } | undefined;
    return { url: result?.url ?? "", title: result?.title ?? "" };
  },
  /**
   * Run a function or expression in the page and return its JSON result.
   * `fn` may be a function (arg is passed as its single argument) or an
   * expression string. Cannot capture Node variables; pass data via `arg`.
   */
  async evaluate(
    fn: string | ((...args: never[]) => unknown),
    arg?: unknown,
    options: { frame?: string | number } = {},
  ): Promise<unknown> {
    if (typeof fn !== "string" && typeof fn !== "function")
      throw new Error("page.evaluate requires a function or an expression string.");
    const expression = typeof fn === "string" ? fn : fn.toString();
    const result = (await callTool("browser_evaluate", {
      expression,
      ...(arg !== undefined ? { arg } : {}),
      ...(options.frame !== undefined ? { frame: options.frame } : {}),
    })) as { value?: unknown; error?: string; world?: string } | undefined;
    if (result?.error) throw new Error(result.error);
    return result?.value;
  },
  /**
   * Poll `fn` (in the page) until truthy. Survives navigations (a destroyed
   * execution context is retried, like the SDK's page.waitFor).
   */
  async waitFor(
    fn: string | ((...args: never[]) => unknown),
    arg?: unknown,
    options: { timeoutMs?: number; frame?: string | number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("waitFor timeoutMs must be a positive integer.");
    const expression = typeof fn === "string" ? fn : fn.toString();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const value = await this.evaluate(expression, arg, options);
        if (value) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Tolerate only navigation-flavored errors (the document is being
        // replaced; the next poll may already see the new one). Permanent
        // failures (permissions, bad args) throw immediately.
        if (
          !/Execution context was destroyed|context (was )?(destroyed|invalid)|BROWSER_TOOL_TIMEOUT|BROWSER_TAB_CLOSED|BROWSER_NOT_BOUND|BROWSER_FRAME_NOT_FOUND|navigated away|receiving end does not exist/i.test(
            message,
          )
        )
          throw error;
      }
      if (Date.now() >= deadline)
        throw new Error(`Page condition exceeded ${timeoutMs} ms.`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
  },
  /**
   * Structured accessibility snapshot: { url, title, nodes } where each node
   * carries a stable `ref` (valid until the page navigates) usable with
   * page.click/page.type, plus role, name, and state/geometry fields.
   */
  async snapshot(options: { maxNodes?: number; maxDepth?: number; frame?: string | number } = {}) {
    const tree = (await callTool("browser_get_accessibility_tree", {
      format: "nodes",
      ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.frame !== undefined ? { frame: options.frame } : {}),
    })) as { nodes?: unknown[]; truncated?: boolean; note?: string } | undefined;
    const info = await this.info();
    return {
      ...info,
      nodes: tree?.nodes ?? [],
      ...(tree?.truncated ? { truncated: true } : {}),
      ...(tree?.note ? { note: tree.note } : {}),
    };
  },
  /** Click an element by ref (from snapshot()/browser_get_dom). */
  async click(ref: string, options: { frame?: string | number } = {}) {
    return callTool("browser_click", { ref, ...(options.frame !== undefined ? { frame: options.frame } : {}) });
  },
  /** Real (content-script) click at viewport coordinates. Returns what was hit. */
  async clickAt(x: number, y: number, options: { frame?: string | number } = {}) {
    requireFiniteCoordinates(x, y);
    return callTool("browser_click_at", { x, y, ...(options.frame !== undefined ? { frame: options.frame } : {}) });
  },
  /** Type text into an element by ref (optionally submitting its form). */
  async type(ref: string, text: string, options: { submit?: boolean; frame?: string | number } = {}) {
    return callTool("browser_type", {
      ref,
      text,
      ...(options.submit !== undefined ? { submit: options.submit } : {}),
      ...(options.frame !== undefined ? { frame: options.frame } : {}),
    });
  },
  /** Insert text into the currently focused element (no ref needed). */
  async typeFocused(text: string) {
    return callTool("browser_type_focused", { text });
  },
  /** Focus an element by ref. */
  async focus(ref: string, options: { frame?: string | number } = {}) {
    return callTool("browser_focus", { ref, ...(options.frame !== undefined ? { frame: options.frame } : {}) });
  },
  /** Scroll an element by ref into view. */
  async scroll(ref: string, options: { frame?: string | number } = {}) {
    return callTool("browser_scroll", { ref, ...(options.frame !== undefined ? { frame: options.frame } : {}) });
  },
  /**
   * Capture the viewport as an image. The image is attached to the cell
   * result automatically (at most 4 per cell); do not print image bytes.
   */
  async screenshot(options: { quality?: number } = {}) {
    const count = images.length;
    if (count >= 4) throw new Error("At most four screenshots per cell.");
    const quality = options.quality ?? 70;
    const result = (await callTool("browser_screenshot", { format: "jpeg", quality })) as {
      data?: string;
      mimeType?: string;
    } | undefined;
    const data = result?.data;
    if (typeof data !== "string" || data.length === 0)
      throw new Error("Screenshot returned no image data.");
    if (Buffer.byteLength(data, "base64") > 8_000_000) {
      sink.write("[Screenshot omitted: 8 MB limit.]\n");
      return "Screenshot omitted; see note.";
    }
    images.push({ type: "image", data, mimeType: result?.mimeType ?? "image/jpeg" });
    return images.length > count ? "Screenshot captured." : "Screenshot omitted; see warning.";
  },
  /** Close the active REPL-opened tab and return to the bound tab. */
  async close() {
    if (activeTabId === undefined)
      throw new Error("No REPL-opened tab to close; the bound tab belongs to the session (unbind in the UI).");
    const tabId = activeTabId;
    ownedTabIds.delete(tabId);
    await callTool("browser_close_tab", { tabId });
    activeTabId = undefined;
  },
};

const tabs = {
  /** All open tabs of the browser: { targetId, id, url, title, bound }[]. */
  async list() {
    const result = (await callTool("browser_list_tabs", {})) as {
      tabs?: Array<{ id: number; url?: string; title?: string; bound?: boolean }>;
    } | undefined;
    return (result?.tabs ?? []).map((t) => ({
      targetId: `tab:${t.id}`,
      id: t.id,
      url: t.url ?? "",
      title: t.title ?? "",
      bound: t.bound === true,
    }));
  },
  /**
   * Open a new tab (owned by the REPL: closed at session end) and make it
   * the current page. The session binding follows the new tab; the previous
   * tab stays open and can be returned to via tabs.get().
   */
  async open(url = "about:blank") {
    const result = (await callTool("browser_open_tab", { url })) as { tabId?: number } | undefined;
    if (typeof result?.tabId !== "number") throw new Error("browser_open_tab returned no tabId.");
    activeTabId = result.tabId;
    ownedTabIds.add(result.tabId);
    const info = await page.info();
    return { targetId: `tab:${result.tabId}`, ...info };
  },
  /** Switch the current page to an existing tab (targetId "tab:<id>" or id). */
  async get(targetId: string | number) {
    const id = typeof targetId === "number" ? targetId : Number(/^tab:(\d+)$/.exec(targetId)?.[1]);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`Unknown target: ${String(targetId)} (use tabs.list()).`);
    activeTabId = id;
    const info = await page.info();
    return { targetId: `tab:${id}`, ...info };
  },
};

// ---------------------------------------------------------------------------
// The V8 realm: one persistent named context, cells run via the inspector
// ---------------------------------------------------------------------------

const evaluator: Session & { realm?: ReturnType<typeof createContext> } = new Session();
evaluator.connect();
let executionContextId: number | undefined;
evaluator.on("Runtime.executionContextCreated", (event) => {
  const params = (event as { params: { context: { id: number; name?: string } } }).params;
  if (params.context.name === "pi-repl") executionContextId = params.context.id;
});
evaluator.post("Runtime.enable");
const realm = createContext(
  {},
  {
    name: "pi-repl",
    importModuleDynamically: undefined,
  },
);
// Inspector context IDs are weak handles. The live evaluator must also own
// the realm, or V8 can collect it between cells despite persistent variables.
evaluator.realm = realm;
if (executionContextId === undefined)
  throw new Error("Could not initialize the JavaScript context.");

let pendingPreamble = config.preamble ? `[javascript tool]\n${config.preamble}\n` : "";

Object.assign(realm, {
  global: realm, // Node's global alias refers to this REPL realm, not the worker host.
  process: undefined, // deliberately NOT exposed (v1)
  Buffer,
  URL,
  URLSearchParams,
  fetch,
  AbortController,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  TextEncoder,
  TextDecoder,
  console: new (await import("node:console")).Console(sink, sink),
  workspace: config.workspace,
  page,
  tabs,
  async screenshot(options?: { quality?: number }) {
    return page.screenshot(options);
  },
  async snapshot(options?: { maxNodes?: number; maxDepth?: number; frame?: string | number }) {
    return page.snapshot(options);
  },
  async artifact(name: string, data: string | Uint8Array) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name))
      throw new Error("Use a plain filename, max 120 characters.");
    const path = join(config.workspace, name);
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
    return path;
  },
  async checkpoint(name: string, value: unknown) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name))
      throw new Error("Use a plain checkpoint filename.");
    const valueJson = JSON.stringify(clean(value));
    if (typeof valueJson !== "string") throw new Error("Checkpoint must be JSON serializable.");
    const path = join(config.workspace, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, valueJson, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    return path;
  },
  /**
   * Reset the REPL's browser view (active tab handle). Node variables and
   * files are preserved. Inspect the page before acting.
   */
  async reconnect() {
    activeTabId = undefined;
    return "Page handles reset. Inspect the page before acting; no browser action was replayed.";
  },
});

async function post<T>(method: string, parameters: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    evaluator.post(method, parameters as never, (error, response) => {
      if (error) reject(error);
      else resolve(response as T);
    });
  });
}

interface EvaluateOutcome {
  result: { type: string; value?: unknown; objectId?: string; unserializableValue?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

async function evaluateCell(code: string): Promise<void> {
  try {
    // V8 supports replMode; Node's generated protocol types omit the field.
    const { result, exceptionDetails } = await post<EvaluateOutcome>("Runtime.evaluate", {
      expression: code,
      contextId: executionContextId,
      awaitPromise: true,
      replMode: true,
      objectGroup: "cell",
    } as never);
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    if (result.objectId) {
      // Print objects through the realm's console (inspect-style output).
      await post("Runtime.callFunctionOn", {
        objectId: result.objectId,
        functionDeclaration: "function() { console.log(this); }",
        returnByValue: true,
      });
    } else if (result.type !== "undefined") {
      sink.write(result.unserializableValue ?? inspect(result.value, { maxStringLength: 20_000 }));
    }
  } finally {
    evaluator.post("Runtime.releaseObjectGroup", { objectGroup: "cell" });
  }
}

process.on("message", async (message: ReplRequest) => {
  if (message.type === "close") {
    evaluator.disconnect();
    send({ type: "closed" });
    return;
  }
  if (message.type !== "execute") return;
  output = "";
  pendingText = "";
  images = [];
  overflow = false;
  outputFile = message.outputFile;
  let failure: string | undefined;
  if (pendingPreamble) {
    sink.write(pendingPreamble);
    pendingPreamble = "";
  }
  for (const note of message.notes ?? []) sink.write(`[repl] ${note}\n`);
  try {
    await evaluateCell(message.code);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  // Flush any redaction tail held back across chunk boundaries.
  captureText(cleanText(pendingText));
  pendingText = "";
  if (overflow) output += "\n[Output exceeded the 1 MB capture limit.]";
  let text = output;
  if (text.length > config.maxOutputChars)
    text = `${text.slice(0, config.maxOutputChars)}\n[Truncated. Full captured output: ${outputFile}]`;
  const cellResult = {
    text: text || (failure ? "" : "(no output)"),
    images,
    ...(outputFile ? { outputFile } : {}),
  };
  if (failure) send({ type: "result", result: cellResult, error: failure });
  else send({ type: "result", result: cellResult });
});

send({ type: "ready" });
