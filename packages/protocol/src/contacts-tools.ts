/**
 * Thunderbird contacts (address book) tool definitions (THUNDERBIRD-PLAN.md §41, T6).
 *
 * Read-only. Lets the agent resolve a recipient from the address book, e.g.
 * "Draft a message to Sarah from Acme." Contact data is untrusted external data
 * (plan §31–32): it is tool output only and never merged into the user prompt.
 *
 * Gated on the `contacts` capability; the add-on declares the `addressBooks`
 * permission (read). There are no contacts mutation tools (create/update/delete).
 */

export interface ContactsToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Both contacts tools are read-only. */
  readOnly: boolean;
}

const OBJECT_SCHEMA_BASE = {
  type: "object" as const,
  additionalProperties: false,
};

export const CONTACTS_TOOLS: readonly ContactsToolDef[] = [
  {
    name: "contacts_search",
    description:
      "Search the address book by name, email, or organization (e.g. \"Sarah Acme\"). Returns normalized contacts (id, name, emails, organization).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        query: { type: "string", description: "One or more space-separated search terms." },
        limit: { type: "number", description: "Maximum number of results to return (default 10)." },
      },
      required: ["query"],
    },
    readOnly: true,
  },
  {
    name: "contacts_get",
    description:
      "Get a single contact by its id (from a contacts_search result). Returns the normalized contact (name, emails, organization, phone).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        contactId: { type: "string", description: "The contact id (cardKey) from a contacts_search result." },
      },
      required: ["contactId"],
    },
    readOnly: true,
  },
];

export function getContactsTool(name: string): ContactsToolDef | undefined {
  return CONTACTS_TOOLS.find((t) => t.name === name);
}

export function isContactsTool(name: string): boolean {
  return CONTACTS_TOOLS.some((t) => t.name === name);
}

export const CONTACTS_TOOL_NAMES: readonly string[] = CONTACTS_TOOLS.map((t) => t.name);

export const CONTACTS_TOOL_TIMEOUT_MS = 30_000;
