/**
 * Serialization and expression helpers for page evaluation and console capture.
 * toJsonSafe is also serialized into injected source: keep it self-contained.
 */

/** True when the expression looks like a function (used by browser_evaluate). */
export function isFunctionExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return /^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed);
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
