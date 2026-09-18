/**
 * Serialization and expression helpers for page evaluation and console capture.
 * toJsonSafe is also serialized into injected source: keep it self-contained.
 */

/** True when the expression looks like a function (used by browser_evaluate). */
export function isFunctionExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!/^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed)) return false;
  // An IIFE (a top-level function immediately applied) evaluates to a VALUE,
  // not a function — the tool must evaluate it, not re-apply it with `arg`.
  // Without this guard `(() => …)()` is misread as a function and the tool
  // builds `((() => …)())(arg)`, calling the already-returned result.
  if (isTopLevelInvocation(trimmed)) return false;
  return true;
}

/**
 * True when the expression's first top-level parenthesized group is followed
 * by `(` — i.e. the function is already being invoked (an IIFE).
 */
function isTopLevelInvocation(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        return s[j] === "(";
      }
    }
  }
  return false;
}

/**
 * Make an evaluated value safe to ship over extension messaging:
 * JSON round-trip (functions become readable placeholders, undefined -> null),
 * with a hard cap so a huge page object cannot blow up a tool result.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  let s: string;
  try {
    s = JSON.stringify(value, (_k, v) =>
      typeof v === "function" ? `[fn ${(v as { name?: string }).name || "anon"}]` : v,
    );
  } catch {
    // Circular or otherwise unstringifiable: best-effort string preview.
    return `[unserializable value: ${String(value).slice(0, 200)}]`;
  }
  if (s.length > 20000) return `${s.slice(0, 20000)}…[truncated]`;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Render one console argument for the ring buffer (never throws). */
export function stringifyLogArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === "function") return `[function ${(value as { name?: string }).name || "anonymous"}]`;
  try {
    const s = JSON.stringify(value, (_k, v) => (typeof v === "function" ? `[fn]` : v));
    return s === undefined ? String(value) : s;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}
