/**
 * Thunderbird mail-organization (T4) tool dispatcher (THUNDERBIRD-PLAN.md §39).
 *
 * Maps the four protocol mutation tools onto Thunderbird's `browser.messages`
 * API. Every tool acts only on the explicitly-selected message ids passed in.
 *
 * Safety (goal constraints) — NON-DELETING:
 *  - mark read/unread, apply tags, archive, and move are all reversible.
 *  - There is NO delete, no permanent-delete, no messagesModifyPermanent — those
 *    APIs are never called and the permission is never declared.
 *  - Additive tagging reads each message's current tags first (via messages.get)
 *    so it does not clobber existing tags.
 */
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { listTags, resolveTagKeys } from "./tag-utils.js";

export type MutationToolResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function reqIntArr(args: Record<string, unknown>, key: string): number[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a non-empty array of message ids`);
  }
  return v;
}

function reqStrArr(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === "string" && s.length > 0)) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a non-empty array of strings`);
  }
  return v;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a non-empty string`);
  }
  return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function mailMarkRead(args: Record<string, unknown>): Promise<MutationToolResult> {
  const ids = reqIntArr(args, "messageIds");
  const read = optBool(args, "read") ?? true;
  for (const id of ids) {
    await browser.messages.update(id, { read });
  }
  return { count: ids.length, read, note: `${ids.length} message(s) marked ${read ? "read" : "unread"}.` };
}

async function mailSetTags(args: Record<string, unknown>): Promise<MutationToolResult> {
  const ids = reqIntArr(args, "messageIds");
  const requested = reqStrArr(args, "tags");
  const additive = optBool(args, "additive") ?? true;

  // Thunderbird applies tags by KEY, but the caller passes names/keys. Resolve
  // each to an existing key; create any that don't exist so the tag the user
  // asked for is present after this call.
  const all = await listTags();
  const { keys, unknown } = resolveTagKeys(all, requested);
  const created: string[] = [];
  for (const name of unknown) {
    const key = await browser.messages.tags.create(null, name);
    created.push(name);
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "no tags could be resolved");
  }

  for (const id of ids) {
    let next = keys;
    if (additive) {
      const cur = await browser.messages.get(id);
      const existing = Array.isArray(cur.tags) ? cur.tags : [];
      next = Array.from(new Set([...existing, ...keys]));
    }
    await browser.messages.update(id, { tags: next });
  }
  return {
    count: ids.length,
    tags: requested,
    keys,
    created,
    additive,
    note: `Tagged ${ids.length} message(s) with ${requested.join(", ")}${additive ? " (added to existing tags)" : " (replaced tags)"}${created.length ? `; created tag(s): ${created.join(", ")}` : ""}.`,
  };
}

async function mailArchive(args: Record<string, unknown>): Promise<MutationToolResult> {
  const ids = reqIntArr(args, "messageIds");
  await browser.messages.archive(ids);
  return { count: ids.length, note: `Archived ${ids.length} message(s). This is reversible (not deletion).` };
}

async function mailMove(args: Record<string, unknown>): Promise<MutationToolResult> {
  const ids = reqIntArr(args, "messageIds");
  const folderId = reqStr(args, "folderId");
  await browser.messages.move(ids, folderId);
  return {
    count: ids.length,
    folderId,
    note: `Moved ${ids.length} message(s) to folder ${folderId}. This is reversible (not deletion).`,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchMutationTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<MutationToolResult> {
  switch (tool) {
    case "mail_mark_read":
      return mailMarkRead(args);
    case "mail_set_tags":
      return mailSetTags(args);
    case "mail_archive":
      return mailArchive(args);
    case "mail_move":
      return mailMove(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown mutation tool: ${tool}`);
  }
}
