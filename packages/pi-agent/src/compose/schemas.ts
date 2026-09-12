/**
 * TypeBox parameter schemas for the draft-first Thunderbird compose tools.
 *
 * These MUST stay in sync with the JSON Schemas in @pi-browser/protocol
 * (compose-tools.ts) — the JSON is the transport-neutral contract, the TypeBox
 * schemas are what Pi validates against and hands to the model.
 * test/tool-schemas.test.ts enforces the sync.
 */
import { Type, type TSchema } from "typebox";
import { COMPOSE_TOOLS } from "@pi-browser/protocol";

const composeTabId = Type.Number({
  description:
    "Compose window tab id, returned by the compose_prepare_* tools; identifies the window to read or update.",
});
const messageId = Type.Number({
  description:
    "Thunderbird numeric message id of the message to reply/forward (from the current context or a search result). Transient: valid only within the current session.",
});
const to = Type.String({
  description:
    'Recipients in mailbox format ("Name <a@example.com>" or just "a@example.com"); separate several with commas.',
});
const cc = Type.String({
  description: 'CC recipients in mailbox format ("Name <a@example.com>"), comma-separated.',
});
const bcc = Type.String({
  description: 'BCC recipients in mailbox format ("Name <a@example.com>"), comma-separated.',
});
const subject = Type.String({ description: "The message subject line." });
const body = Type.String({ description: "The message body (HTML)." });
const contentType = Type.Union(
  [Type.Literal("text/html"), Type.Literal("text/plain")],
  { description: "Body MIME type (default text/html)." },
);
const replyType = Type.Union(
  [Type.Literal("replyToSender"), Type.Literal("replyToList"), Type.Literal("replyToAll")],
  { description: "Who the reply is addressed to (default replyToSender)." },
);
const forwardType = Type.Union(
  [Type.Literal("forwardInline"), Type.Literal("forwardAsAttachment")],
  { description: "How the message is forwarded (default forwardInline)." },
);
const attachmentName = Type.String({
  description: 'The attachment filename, e.g. "report.pdf".',
});
const attachmentContent = Type.String({
  description: "The file content, base64-encoded.",
});
const attachmentContentType = Type.String({
  description: 'The MIME type, e.g. "application/pdf" (default application/octet-stream).',
});

const SCHEMAS: Record<string, TSchema> = {
  compose_prepare_new: Type.Object(
    {
      to: Type.Optional(to),
      cc: Type.Optional(cc),
      bcc: Type.Optional(bcc),
      subject: Type.Optional(subject),
      body: Type.Optional(body),
      contentType: Type.Optional(contentType),
    },
    { additionalProperties: false },
  ),

  compose_prepare_reply: Type.Object(
    {
      messageId,
      replyType: Type.Optional(replyType),
      cc: Type.Optional(cc),
      bcc: Type.Optional(bcc),
      subject: Type.Optional(subject),
      body: Type.Optional(body),
    },
    { additionalProperties: false, required: ["messageId"] },
  ),

  compose_prepare_forward: Type.Object(
    {
      messageId,
      forwardType: Type.Optional(forwardType),
      to: Type.Optional(to),
      cc: Type.Optional(cc),
      bcc: Type.Optional(bcc),
      subject: Type.Optional(subject),
      body: Type.Optional(body),
    },
    { additionalProperties: false, required: ["messageId"] },
  ),

  compose_get: Type.Object(
    { tabId: composeTabId },
    { additionalProperties: false, required: ["tabId"] },
  ),

  compose_update: Type.Object(
    {
      tabId: composeTabId,
      to: Type.Optional(to),
      cc: Type.Optional(cc),
      bcc: Type.Optional(bcc),
      subject: Type.Optional(subject),
      body: Type.Optional(body),
      contentType: Type.Optional(contentType),
    },
    { additionalProperties: false, required: ["tabId"] },
  ),

  compose_add_attachment: Type.Object(
    {
      tabId: composeTabId,
      name: attachmentName,
      content: attachmentContent,
      contentType: Type.Optional(attachmentContentType),
    },
    { additionalProperties: false, required: ["tabId", "name", "content"] },
  ),
};

export interface ComposeToolSchema {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
}

/** One entry per protocol compose tool, with its TypeBox parameter schema. */
export const COMPOSE_TOOL_SCHEMAS: readonly ComposeToolSchema[] = COMPOSE_TOOLS.map((def) => {
  const parameters = SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
