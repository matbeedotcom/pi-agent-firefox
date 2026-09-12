/**
 * Thunderbird draft-first compose tool dispatcher (THUNDERBIRD-PLAN.md §15–17, T3).
 *
 * Maps the five protocol compose tools onto Thunderbird's `browser.compose`
 * WebExtension API. The tools OPEN a populated compose window and read/edit its
 * fields so the user can review it and press Send.
 *
 * Safety (plan §15, §21) — DRAFT-FIRST:
 *  - There is NO send tool. `browser.compose.sendMessage` and `saveMessage` are
 *    never called; the user reviews the window and sends manually.
 *  - Recipients are mailbox strings; the body is HTML. Compose fields are the
 *    user's own content (not untrusted email), so they are safe to fill in.
 */
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";

export type ComposeToolResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a number`);
  }
  return v;
}

/** Build the `browser.compose` details object from the flat tool arguments. */
function buildDetails(args: Record<string, unknown>): browser.compose.ComposeDetails {
  const details: browser.compose.ComposeDetails = {};
  const to = optStr(args, "to");
  if (to) details.to = to;
  const cc = optStr(args, "cc");
  if (cc) details.cc = cc;
  const bcc = optStr(args, "bcc");
  if (bcc) details.bcc = bcc;
  const subject = optStr(args, "subject");
  if (subject) details.subject = subject;
  const body = optStr(args, "body");
  if (body) details.body = body;
  const contentType = optStr(args, "contentType");
  if (contentType) details.contentType = contentType;
  return details;
}

/** Normalize a recipient list (string | {name,email} | array) to a readable string. */
function normRecipientList(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (Array.isArray(v)) {
    const out = v.map(normRecipient).filter((s): s is string => Boolean(s));
    return out.length > 0 ? out.join(", ") : undefined;
  }
  return normRecipient(v);
}

function normRecipient(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (v && typeof v === "object") {
    const r = v as { name?: string; email?: string };
    if (r.email) return r.name ? `${r.name} <${r.email}>` : r.email;
    if (r.name) return r.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function composePrepareNew(args: Record<string, unknown>): Promise<ComposeToolResult> {
  const details = buildDetails(args);
  const tab = await browser.compose.beginNew(null, details);
  return {
    composeTabId: tab.id,
    note: "A new-message compose window is open. Review it and press Send — this tool does not send.",
  };
}

async function composePrepareReply(args: Record<string, unknown>): Promise<ComposeToolResult> {
  const messageId = reqInt(args, "messageId");
  const replyType = optStr(args, "replyType") as "replyToSender" | "replyToList" | "replyToAll" | undefined;
  const details = buildDetails(args);
  const tab = await browser.compose.beginReply(messageId, replyType, details);
  return {
    composeTabId: tab.id,
    note: "A reply compose window is open (recipient derived from the message). Review it and press Send — this tool does not send.",
  };
}

async function composePrepareForward(args: Record<string, unknown>): Promise<ComposeToolResult> {
  const messageId = reqInt(args, "messageId");
  const forwardType = optStr(args, "forwardType") as
    | "forwardInline"
    | "forwardAsAttachment"
    | undefined;
  const details = buildDetails(args);
  const tab = await browser.compose.beginForward(messageId, forwardType, details);
  return {
    composeTabId: tab.id,
    note: "A forward compose window is open. Review it and press Send — this tool does not send.",
  };
}

async function composeGet(args: Record<string, unknown>): Promise<ComposeToolResult> {
  const tabId = reqInt(args, "tabId");
  const d = await browser.compose.getComposeDetails(tabId);
  const result: ComposeToolResult = { composeTabId: tabId };
  const to = normRecipientList(d.to);
  if (to) result.to = to;
  const cc = normRecipientList(d.cc);
  if (cc) result.cc = cc;
  const bcc = normRecipientList(d.bcc);
  if (bcc) result.bcc = bcc;
  if (d.subject !== undefined) result.subject = d.subject;
  result.body = typeof d.body === "string" ? d.body : "";
  if (d.contentType) result.contentType = d.contentType;
  if (d.type) result.composeType = d.type;
  if (d.relatedMessageId !== undefined && d.relatedMessageId !== null) {
    result.relatedMessageId = d.relatedMessageId;
  }
  return result;
}

async function composeUpdate(args: Record<string, unknown>): Promise<ComposeToolResult> {
  const tabId = reqInt(args, "tabId");
  const details = buildDetails(args);
  await browser.compose.setComposeDetails(tabId, details);
  return {
    composeTabId: tabId,
    note: "The compose window was updated. Review it and press Send — this tool does not send.",
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchComposeTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ComposeToolResult> {
  switch (tool) {
    case "compose_prepare_new":
      return composePrepareNew(args);
    case "compose_prepare_reply":
      return composePrepareReply(args);
    case "compose_prepare_forward":
      return composePrepareForward(args);
    case "compose_get":
      return composeGet(args);
    case "compose_update":
      return composeUpdate(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown compose tool: ${tool}`);
  }
}
