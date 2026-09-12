/**
 * Thunderbird mail-ORGANIZATION tool definitions (THUNDERBIRD-PLAN.md §39, T4).
 *
 * These are the mutation surface: mark read/unread, apply tags, archive, and move
 * selected messages. They are deliberately NON-deleting: there is no delete, no
 * permanent-delete, no messagesModifyPermanent. Archive and move are reversible.
 *
 * Safety model (plan §39 + goal constraints):
 *  - Every tool acts ONLY on explicitly-selected message ids (from the current
 *    context / selection), never bulk or global.
 *  - Numeric messageIds are transient (valid within the session).
 *  - Gated on the `mailModify` capability (distinct from read-only `mail`); the
 *    add-on declares messagesUpdate / messagesMove / messagesTags (NOT messagesDelete).
 */

export interface MailMutationToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** All mutation tools are non-read-only. */
  readOnly: boolean;
}

const OBJECT_SCHEMA_BASE = {
  type: "object" as const,
  additionalProperties: false,
};

const messageIdsProp = {
  type: "array" as const,
  items: { type: "number" },
  description:
    "The Thunderbird numeric message ids to act on (from the current context or selection). Transient: valid only within the current session.",
};

export const MAIL_MUTATION_TOOLS: readonly MailMutationToolDef[] = [
  {
    name: "mail_mark_read",
    description:
      "Mark explicitly-selected messages as read or unread (default read).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        messageIds: messageIdsProp,
        read: { type: "boolean", description: "Set read (true, default) or unread (false)." },
      },
      required: ["messageIds"],
    },
    readOnly: false,
  },
  {
    name: "mail_set_tags",
    description:
      "Apply tags to explicitly-selected messages (e.g. Finance, Work). Additive by default: new tags are added to each message's existing tags; pass additive=false to replace them.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        messageIds: messageIdsProp,
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Tag names to apply, e.g. ["Finance"].',
        },
        additive: { type: "boolean", description: "Add to existing tags (true, default) or replace them (false)." },
      },
      required: ["messageIds", "tags"],
    },
    readOnly: false,
  },
  {
    name: "mail_archive",
    description:
      "Archive the explicitly-selected messages (moves them to the account's Archive folder). Reversible — not permanent deletion.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { messageIds: messageIdsProp },
      required: ["messageIds"],
    },
    readOnly: false,
  },
  {
    name: "mail_move",
    description:
      "Move the explicitly-selected messages to a folder (by folder id from mail_list_folders). Reversible — not permanent deletion.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        messageIds: messageIdsProp,
        folderId: { type: "string", description: "Destination folder id (from mail_list_folders)." },
      },
      required: ["messageIds", "folderId"],
    },
    readOnly: false,
  },
];

export function getMailMutationTool(name: string): MailMutationToolDef | undefined {
  return MAIL_MUTATION_TOOLS.find((t) => t.name === name);
}

export function isMailMutationTool(name: string): boolean {
  return MAIL_MUTATION_TOOLS.some((t) => t.name === name);
}

export const MAIL_MUTATION_TOOL_NAMES: readonly string[] = MAIL_MUTATION_TOOLS.map((t) => t.name);

export const MAIL_MUTATION_TOOL_TIMEOUT_MS = 30_000;
