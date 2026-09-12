/**
 * TypeBox parameter schemas for the Thunderbird mail-organization (T4) tools.
 * MUST stay in sync with the JSON Schemas in @pi-browser/protocol
 * (mail-mutation-tools.ts) — enforced by test/tool-schemas.test.ts.
 */
import { Type, type TSchema } from "typebox";
import { MAIL_MUTATION_TOOLS } from "@pi-browser/protocol";

const messageIds = Type.Array(Type.Number(), {
  description:
    "The Thunderbird numeric message ids to act on (from the current context or selection). Transient: valid only within the current session.",
});
const read = Type.Boolean({ description: "Set read (true, default) or unread (false)." });
const tags = Type.Array(Type.String(), {
  description: 'Tag names to apply, e.g. ["Finance"].',
});
const additive = Type.Boolean({
  description: "Add to existing tags (true, default) or replace them (false).",
});
const folderId = Type.String({ description: "Destination folder id (from mail_list_folders)." });

const SCHEMAS: Record<string, TSchema> = {
  mail_mark_read: Type.Object(
    { messageIds, read: Type.Optional(read) },
    { additionalProperties: false, required: ["messageIds"] },
  ),
  mail_set_tags: Type.Object(
    { messageIds, tags, additive: Type.Optional(additive) },
    { additionalProperties: false, required: ["messageIds", "tags"] },
  ),
  mail_archive: Type.Object(
    { messageIds },
    { additionalProperties: false, required: ["messageIds"] },
  ),
  mail_move: Type.Object(
    { messageIds, folderId },
    { additionalProperties: false, required: ["messageIds", "folderId"] },
  ),
};

export interface MailMutationToolSchema {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
}

export const MAIL_MUTATION_TOOL_SCHEMAS: readonly MailMutationToolSchema[] = MAIL_MUTATION_TOOLS.map(
  (def) => {
    const parameters = SCHEMAS[def.name];
    if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
    return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
  },
);
