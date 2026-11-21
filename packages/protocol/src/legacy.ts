/**
 * The v0.4.0 ("pi-browser") dialect of the add-on ⇄ host protocol
 * (openspec rename-trusted-user-agent D2).
 *
 * Every component uses the new names internally: `x-trusted-ua/*` methods,
 * `_meta.trustedUa`, `_meta.trustedUaAgent`, hello type `trusted-ua.hello`.
 * Each end translates at its transport:
 * - incoming messages are always normalized to the new names
 *   (`normalizeIncoming`), so an old peer's messages read like new ones;
 * - outgoing messages are encoded in the old names (`toLegacy`) only for a
 *   peer that speaks the old dialect, which each side learns from the
 *   `initialize` exchange (`initializeIsLegacy`, `initializeResultIsLegacy`).
 *
 * Structured error codes are not translated: errors carry both
 * `data.trustedUaError` and `data.piBrowserError` (errors.ts).
 */

export const METHOD_PREFIX = "x-trusted-ua/";
export const LEGACY_METHOD_PREFIX = "x-pi-browser/";
export const HELLO_TYPE = "trusted-ua.hello";
export const LEGACY_HELLO_TYPE = "pi.agent.hello";
/** The v0.4.0 MCP caller notification (the bridge sends it after the new one). */
export const LEGACY_MCP_CALLER_NOTIFICATION = "pi-browser/caller";
/** The v0.4.0 MCP server name (installers replace entries with this name). */
export const LEGACY_MCP_SERVER_NAME = "pi-browser";

/** New `_meta` key → old `_meta` key. */
const META_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["trustedUa", "piBrowser"],
  ["trustedUaAgent", "piAgent"],
];

type Json = unknown;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rename keys of one `_meta` object; returns the same object when nothing changes. */
function renameMeta(meta: Record<string, unknown>, toLegacyNames: boolean, seen: { legacy: boolean }): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [fresh, old] of META_KEYS) {
    const from = toLegacyNames ? fresh : old;
    const to = toLegacyNames ? old : fresh;
    if (!(from in meta)) continue;
    if (!toLegacyNames) seen.legacy = true;
    out ??= { ...meta };
    // When both names are present, the new one wins (incoming) / is kept
    // alongside (outgoing never has the old one).
    if (!(to in out)) out[to] = meta[from];
    delete out[from];
  }
  const agentKey = toLegacyNames ? "piAgent" : "trustedUaAgent";
  const target = (out ?? meta)[agentKey];
  if (isRecord(target) && typeof target.type === "string") {
    const want = toLegacyNames ? LEGACY_HELLO_TYPE : HELLO_TYPE;
    const other = toLegacyNames ? HELLO_TYPE : LEGACY_HELLO_TYPE;
    if (target.type === other) {
      out ??= { ...meta };
      out[agentKey] = { ...target, type: want };
    }
  }
  return out ?? meta;
}

/** Walk a value, renaming the keys of every `_meta` object. Copies only along changed paths. */
function walk(value: Json, toLegacyNames: boolean, seen: { legacy: boolean }, depth = 0): Json {
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v === null || typeof v !== "object") continue;
      const w = walk(v, toLegacyNames, seen, depth + 1);
      if (w !== v) {
        out ??= value.slice();
        out[i] = w;
      }
    }
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v !== "object") continue;
    let w = walk(v, toLegacyNames, seen, depth + 1);
    if (k === "_meta" && isRecord(w)) w = renameMeta(w, toLegacyNames, seen);
    if (w !== v) {
      out ??= { ...(value as Record<string, unknown>) };
      out[k] = w;
    }
  }
  return out ?? value;
}

function renameMethod(method: unknown, toLegacyNames: boolean): unknown {
  if (typeof method !== "string") return method;
  const [from, to] = toLegacyNames ? [METHOD_PREFIX, LEGACY_METHOD_PREFIX] : [LEGACY_METHOD_PREFIX, METHOD_PREFIX];
  return method.startsWith(from) ? to + method.slice(from.length) : method;
}

/**
 * Normalize an incoming JSON-RPC message to the new names. `legacy` is true
 * when the message used any old name (method or `_meta` key).
 */
export function normalizeIncoming<T>(msg: T): { message: T; legacy: boolean } {
  if (!isRecord(msg)) return { message: msg, legacy: false };
  const seen = { legacy: false };
  let out: Record<string, unknown> | undefined;
  const method = renameMethod(msg.method, false);
  if (method !== msg.method) {
    seen.legacy = true;
    out = { ...msg, method };
  }
  for (const key of ["params", "result"] as const) {
    const v = msg[key];
    if (v === null || typeof v !== "object") continue;
    // walk() renames every `_meta` object below params/result, including
    // params._meta / result._meta themselves.
    const w = walk(v, false, seen);
    if (w !== v) {
      out ??= { ...msg };
      out[key] = w;
    }
  }
  return { message: (out ?? msg) as T, legacy: seen.legacy };
}

/** Encode an outgoing JSON-RPC message in the old names, for a v0.4.0 peer. */
export function toLegacy<T>(msg: T): T {
  if (!isRecord(msg)) return msg;
  const seen = { legacy: false };
  let out: Record<string, unknown> | undefined;
  const method = renameMethod(msg.method, true);
  if (method !== msg.method) out = { ...msg, method };
  for (const key of ["params", "result"] as const) {
    const v = msg[key];
    if (v === null || typeof v !== "object") continue;
    const w = walk(v, true, seen);
    if (w !== v) {
      out ??= { ...msg };
      out[key] = w;
    }
  }
  return (out ?? msg) as T;
}

/**
 * Host side: does this (raw, not yet normalized) `initialize` request come
 * from a v0.4.0 client? True when its `_meta` has only the old keys.
 */
export function initializeIsLegacy(params: unknown): boolean {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  if (!meta) return false;
  const hasNew = "trustedUa" in meta || "trustedUaAgent" in meta;
  const hasOld = "piBrowser" in meta || "piAgent" in meta;
  return hasOld && !hasNew;
}

/**
 * Add-on side: does this (raw) `initialize` result come from a v0.4.0 host?
 * True when its `_meta` has only the old keys.
 */
export function initializeResultIsLegacy(result: unknown): boolean {
  return initializeIsLegacy(result);
}

/**
 * Add the old names next to the new ones in an `initialize` `_meta` (the
 * add-on doesn't know the host's dialect yet): an old host reads `piAgent`,
 * a new one `trustedUaAgent`.
 */
export function withLegacyAliases(meta: Record<string, unknown>): Record<string, unknown> {
  const legacy = renameMeta(meta, true, { legacy: false });
  return { ...legacy, ...meta };
}
