/**
 * Page-world instrumentation (manifest `world: "MAIN"`, `document_start`).
 *
 * Runs in the PAGE's JavaScript world — a content-script (isolated world)
 * patch would only see the isolated world's own logs, never the page's.
 * Here it:
 *   - wraps console.* before any page script runs (document_start),
 *   - records uncaught window errors, unhandled promise rejections and
 *     failed resource loads (capture-phase `error`),
 *   - serves browser_evaluate in the page's JS world (page globals such as
 *     window.* are visible), via a postMessage request/response round-trip
 *     with the isolated-world content script,
 *   - exposes a ring buffer on window.__PI_BROWSER_CONSOLE__ that the
 *     content script reads (directly, or via the __piBrowserConsoleRead
 *     round-trip as a fallback).
 *
 * Deliberately scoped per PRODUCT.md §35: this is page-load-onwards
 * instrumentation, not the full DevTools console history.
 *
 * Security (PRODUCT.md §37): everything read back is UNTRUSTED tool data.
 * A hostile page can replace or empty this state; that only degrades the
 * DATA the agent sees (stale/empty logs, a spoofed eval result) — it can
 * never reach the control flow, bindings, or the ACP channel.
 */
import { isFunctionExpression, stringifyLogArg, toJsonSafe } from "./shared.js";

interface ConsoleEntry {
  t: number;
  level: string;
  source: string;
  text: string;
}

(() => {
  try {
    const MAX_ENTRIES = 1000;
    const messages: ConsoleEntry[] = [];
    let dropped = 0;

    function push(level: string, source: string, args: unknown[]): void {
      let text = args.map(stringifyLogArg).join(" ");
      if (text.length > 2000) text = `${text.slice(0, 2000)}…[truncated]`;
      messages.push({ t: Date.now(), level, source, text });
      if (messages.length > MAX_ENTRIES) {
        const over = messages.length - MAX_ENTRIES;
        messages.splice(0, over);
        dropped += over;
      }
    }

    // 1) console.* — wrap first (document_start), so the page's own
    //    wrappers (if it adds them later) still funnel through ours.
    const levels = ["debug", "log", "info", "warn", "error"] as const;
    type LevelKey = (typeof levels)[number];
    const consoleObj = console as Record<LevelKey, (...a: unknown[]) => void>;
    for (const level of levels) {
      const original = consoleObj[level].bind(console);
      consoleObj[level] = (...args: unknown[]) => {
        try {
          push(level, "console", args);
        } catch {
          /* never break the page */
        }
        return original(...args);
      };
    }

    // 2) window errors + failed resource loads.
    //    capture=true also delivers resource-load errors (no `error`
    //    property, `target` is the failing element).
    window.addEventListener(
      "error",
      ((e: ErrorEvent) => {
        if (e.error || e.message) {
          const file = e.filename ? e.filename.split("/").pop() : "";
          // columnNumber is a Gecko extension of ErrorEvent (not in the DOM lib).
          const col = (e as ErrorEvent & { columnNumber?: number }).columnNumber ?? 0;
          const loc = file ? ` (${file}:${e.lineno}:${col})` : "";
          push("error", "window-error", [`${e.message}${loc}`]);
        } else if (e.target instanceof Element) {
          const el = e.target;
          const what = el.tagName.toLowerCase();
          const src = el.getAttribute("src") || el.getAttribute("href") || "";
          push("error", "resource-error", [`${what} failed to load: ${src}`]);
        }
      }) as EventListener,
      true,
    );

    window.addEventListener(
      "unhandledrejection",
      ((e: PromiseRejectionEvent) => {
        const r = e.reason;
        push("error", "unhandled-rejection", [r instanceof Error ? r.stack || r.message : r]);
      }) as EventListener,
    );

    // 3) browser_evaluate in the page world (postMessage round-trip).
    window.addEventListener("message", ((e: MessageEvent) => {
      const d = e.data as
        | { __piBrowserEval?: boolean; id?: number; expression?: unknown; arg?: unknown }
        | null;
      if (!d || d.__piBrowserEval !== true || typeof d.id !== "number") return;
      void (async () => {
        let payload: { ok: true; value: unknown } | { ok: false; error: string };
        try {
          const expression = String(d.expression ?? "");
          const factory = new Function(
            "arg",
            isFunctionExpression(expression)
              ? `return (${expression})(arg);`
              : `return (${expression});`,
          );
          let result: unknown = factory(d.arg);
          if (result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
            result = await result;
          }
          payload = { ok: true, value: toJsonSafe(result) };
        } catch (err) {
          payload = { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
        }
        try {
          window.postMessage({ __piBrowserEvalResult: true, id: d.id, ...payload }, "*");
        } catch {
          /* document gone */
        }
      })();
    }));

    // 4) Console buffer access for the isolated-world content script:
    //    direct window.__PI_BROWSER_CONSOLE__ read, plus a postMessage
    //    read/clear fallback (cross-world object access is the unusual
    //    case; structured-clone messages always work).
    window.addEventListener("message", ((e: MessageEvent) => {
      const d = e.data as
        | { __piBrowserConsoleRead?: boolean; id?: number; __piBrowserConsoleClear?: boolean }
        | null;
      if (!d) return;
      if (d.__piBrowserConsoleClear === true) {
        messages.length = 0;
        dropped = 0;
      }
      if (d.__piBrowserConsoleRead === true && typeof d.id === "number") {
        try {
          window.postMessage({ __piBrowserConsoleData: true, id: d.id, messages: [...messages], dropped }, "*");
        } catch {
          /* document gone */
        }
      }
    }));

    Object.defineProperty(window, "__PI_BROWSER_CONSOLE__", {
      value: {
        get messages(): ConsoleEntry[] {
          return messages;
        },
        get dropped(): number {
          return dropped;
        },
      },
      // writable: a page replacing this only loses its own log capture
      // (untrusted data), it must not be able to crash strict-mode page
      // code by assigning to a frozen global.
      writable: true,
      configurable: true,
    });
  } catch {
    // Instrumentation must never break the page.
  }
})();
