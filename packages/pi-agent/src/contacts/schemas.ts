/**
 * TypeBox parameter schemas for the Thunderbird contacts (T6) tools.
 * MUST stay in sync with the JSON Schemas in @pi-browser/protocol
 * (contacts-tools.ts) — enforced by test/tool-schemas.test.ts.
 */
import { Type, type TSchema } from "typebox";
import { CONTACTS_TOOLS } from "@pi-browser/protocol";

const query = Type.String({ description: "One or more space-separated search terms." });
const limit = Type.Number({ description: "Maximum number of results to return (default 10)." });
const contactId = Type.String({ description: "The contact id (cardKey) from a contacts_search result." });

const SCHEMAS: Record<string, TSchema> = {
  contacts_search: Type.Object(
    { query, limit: Type.Optional(limit) },
    { additionalProperties: false, required: ["query"] },
  ),
  contacts_list: Type.Object(
    {
      filter: Type.Optional(
        Type.String({ description: "Only contacts whose name, email, or organization contains this (case-insensitive)." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum contacts per page (default 10, max 50)." }),
      ),
      cursor: Type.Optional(
        Type.Number({ description: "Offset into the full (filtered) list for pagination; pass the previous nextCursor." }),
      ),
    },
    { additionalProperties: false },
  ),
  contacts_get: Type.Object(
    { contactId },
    { additionalProperties: false, required: ["contactId"] },
  ),
};

export interface ContactsToolSchema {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
}

export const CONTACTS_TOOL_SCHEMAS: readonly ContactsToolSchema[] = CONTACTS_TOOLS.map((def) => {
  const parameters = SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
