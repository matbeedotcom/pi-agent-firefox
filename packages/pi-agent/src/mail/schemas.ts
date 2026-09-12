/**
 * TypeBox parameter schemas for the read-only Thunderbird mail tools.
 *
 * These MUST stay in sync with the JSON Schemas in
 * @pi-browser/protocol (mail-tools.ts) — the JSON is the transport-neutral
 * contract, the TypeBox schemas are what Pi validates against and hands to
 * the model. test/tool-schemas.test.ts enforces the sync.
 */
import { Type, type TSchema } from "typebox";
import { MAIL_TOOLS } from "@pi-browser/protocol";

const empty = () => Type.Object({}, { additionalProperties: false });

const messageId = Type.Number({
  description:
    "Thunderbird numeric message id. Transient: valid only within the current session; take it from the current context or a list/search result.",
});

const isoDate = (what: string) =>
  Type.String({
    description: `ISO 8601 date/time. Only messages ${what} this instant are returned.`,
  });

const SCHEMAS: Record<string, TSchema> = {
  mail_get_context: empty(),

  mail_get_selected_messages: Type.Object(
    {
      tabId: Type.Optional(Type.Number({ description: "Mail tab id (default: the current mail tab)." })),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of messages to return (default 50, hard cap 200)." }),
      ),
    },
    { additionalProperties: false },
  ),

  mail_get_displayed_messages: Type.Object(
    {
      tabId: Type.Optional(Type.Number({ description: "Mail tab id (default: the current mail tab)." })),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of messages to return (default 50, hard cap 200)." }),
      ),
    },
    { additionalProperties: false },
  ),

  mail_get_message: Type.Object(
    { messageId },
    { additionalProperties: false, required: ["messageId"] },
  ),

  mail_get_message_body: Type.Object(
    {
      messageId,
      prefer: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("html"), Type.Literal("auto")], {
          description: "Which MIME part to prefer (default auto: text if present, else html).",
        }),
      ),
      maxChars: Type.Optional(Type.Number({ description: "Truncate the body to this many characters (default 50000)." })),
    },
    { additionalProperties: false, required: ["messageId"] },
  ),

  mail_search: Type.Object(
    {
      text: Type.Optional(Type.String({ description: "Full-text search across the message." })),
      from: Type.Optional(Type.String({ description: "Match the author/sender." })),
      to: Type.Optional(Type.String({ description: "Match the recipients." })),
      subject: Type.Optional(Type.String({ description: "Match the subject line." })),
      accountId: Type.Optional(Type.String({ description: "Limit the search to one account." })),
      folderId: Type.Optional(Type.String({ description: "Limit the search to one folder." })),
      after: Type.Optional(isoDate("sent after")),
      before: Type.Optional(isoDate("sent before")),
      hasAttachments: Type.Optional(
        Type.Boolean({ description: "Only messages with (true) or without (false) attachments." }),
      ),
      unread: Type.Optional(Type.Boolean({ description: "Only unread (true) or read (false) messages." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results per page (default 25, max 100)." })),
      cursor: Type.Optional(Type.String({ description: "Pagination cursor from a previous search result." })),
    },
    { additionalProperties: false },
  ),

  mail_list_attachments: Type.Object(
    { messageId },
    { additionalProperties: false, required: ["messageId"] },
  ),

  mail_get_attachment: Type.Object(
    {
      messageId,
      partName: Type.String({ description: "Attachment part name (from mail_list_attachments)." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return (default 1048576, max 5242880)." })),
    },
    { additionalProperties: false, required: ["messageId", "partName"] },
  ),

  mail_list_accounts: empty(),

  mail_list_folders: Type.Object(
    {
      accountId: Type.Optional(Type.String({ description: "Limit to one account (default: all accounts)." })),
    },
    { additionalProperties: false },
  ),
};

export interface MailToolSchema {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
}

/** One entry per protocol mail tool, with its TypeBox parameter schema. */
export const MAIL_TOOL_SCHEMAS: readonly MailToolSchema[] = MAIL_TOOLS.map((def) => {
  const parameters = SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
