import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { isFunctionExpression, toJsonSafe } from "../content/shared.js";

export interface EvaluateResult {
  value: unknown;
  error?: string;
  world: "page";
}

// @types/firefox-webext-browser 143 predates execute (Firefox 153).
export interface UserScriptExecutor {
  execute(injection: {
    target: { tabId: number; frameIds: number[] };
    world: "MAIN";
    injectImmediately: boolean;
    js: Array<{ code: string }>;
  }): Promise<Array<{ frameId: number; result?: EvaluateResult; error?: unknown }>>;
}

/** Browser-compiled source avoids eval/Function in both CSP-restricted worlds. */
export async function evaluateInPage(
  tabId: number,
  frameId: number,
  expression: unknown,
  arg: unknown,
  timeoutMs: number,
): Promise<EvaluateResult> {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "evaluate requires a non-empty expression string");
  }
  const api = browser.userScripts as unknown as UserScriptExecutor | undefined;
  if (!api?.execute) {
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
      'Page evaluation requires Firefox 153+ and the user scripts permission. Approve the page evaluation permission request in the Pi sidebar.',
    );
  }
  const source = `(${expression}\n)${isFunctionExpression(expression) ? "(arg)" : ""}`;
  // Parse JSON instead of embedding an object literal (preserves __proto__ keys).
  const argument = arg === undefined ? "undefined" : `JSON.parse(${JSON.stringify(JSON.stringify(arg))})`;
  const code = `(async (arg) => {
    try {
      const value = await ${source};
      return { value: (${toJsonSafe.toString()})(value), world: "page" };
    } catch (err) {
      return { value: null, error: String(err), world: "page" };
    }
  })(${argument})`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      api.execute({ target: { tabId, frameIds: [frameId] }, world: "MAIN", injectImmediately: true, js: [{ code }] }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PiBrowserProtocolError(
          PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT,
          "Page evaluation timed out; execution may still be running. Inspect the page before retrying side effects.",
        )), timeoutMs);
      }),
    ]);
    const result = results.find((entry) => entry.frameId === frameId);
    if (!result) throw new Error("The target frame disappeared before evaluation returned");
    if (result.error !== undefined) return { value: null, error: String(result.error), world: "page" };
    if (!result.result) throw new Error("Page evaluation returned no result");
    return result.result;
  } finally {
    clearTimeout(timer);
  }
}
