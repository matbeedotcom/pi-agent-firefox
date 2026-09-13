/**
 * Thunderbird contacts (address book, T6) tool dispatcher (THUNDERBIRD-PLAN.md §41).
 *
 * Read-only. Maps `contacts_search` / `contacts_get` onto `browser.addressBooks.contacts`
 * (the MV3 path; top-level `browser.contacts` is MV2-only and undefined in MV3).
 * Contact data is untrusted external data (plan §31–32): it is returned as
 * normalized tool output and never merged into the user prompt.
 *
 * Normalization is defensive: vCard-style property keys vary, so it tries the
 * common candidates (displayName/firstName+lastName, email/emailAddresses,
 * organization/org/company) and, if nothing resolves, falls back to the raw
 * `properties` so the agent still has the data.
 */
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";

export type ContactsToolResult = Record<string, unknown>;

const DEFAULT_CONTACT_LIMIT = 10;
const MAX_CONTACT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a non-empty string`);
  }
  return v;
}

function clampInt(args: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function firstStr(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstStr(x);
      if (s) return s;
    }
  }
  return undefined;
}

function emailValues(v: unknown): string[] {
  if (typeof v === "string" && v.length > 0) return [v];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) {
      if (typeof x === "string" && x.length > 0) out.push(x);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const e = firstStr(o.value) ?? firstStr(o.email) ?? firstStr(o.address);
        if (e) out.push(e);
      }
    }
    return out;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const e = firstStr(o.value) ?? firstStr(o.email) ?? firstStr(o.address);
    return e ? [e] : [];
  }
  return [];
}

function contactName(p: Record<string, unknown>): string | undefined {
  const display = firstStr(p.displayName) ?? firstStr(p.fn);
  if (display) return display;
  const first = firstStr(p.firstName) ?? firstStr(p.givenName);
  const last = firstStr(p.lastName) ?? firstStr(p.familyName);
  if (first || last) return `${first ?? ""} ${last ?? ""}`.trim();
  return firstStr(p.name);
}

function normalizeContact(c: browser.addressBooks.contacts.Contact): Record<string, unknown> {
  const p = (c.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { id: c.cardKey ?? c.id };
  const name = contactName(p);
  const emails = Array.from(
    new Set([...emailValues(p.emailAddresses), ...emailValues(p.email), ...emailValues(p.emails)]),
  );
  const org = firstStr(p.organization) ?? firstStr(p.org) ?? firstStr(p.company) ?? firstStr(p.organizationName);
  if (name) out.name = name;
  if (emails.length > 0) out.emails = emails;
  if (org) out.organization = org;
  // Fallback: if none of the known keys resolved, surface the raw properties so
  // the agent still has the data (field names are a live-verify detail).
  if (!name && emails.length === 0 && !org) out.properties = p;
  return out;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function contactsSearch(args: Record<string, unknown>): Promise<ContactsToolResult> {
  const query = reqStr(args, "query");
  const limit = clampInt(args, "limit", 1, MAX_CONTACT_LIMIT, DEFAULT_CONTACT_LIMIT);
  const results = await browser.addressBooks.contacts.query({ searchString: query });
  const contacts = results.slice(0, limit).map(normalizeContact);
  return { query, count: contacts.length, contacts };
}

async function contactsGet(args: Record<string, unknown>): Promise<ContactsToolResult> {
  const contactId = reqStr(args, "contactId");
  const c = await browser.addressBooks.contacts.get(contactId);
  return normalizeContact(c);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchContactsTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ContactsToolResult> {
  switch (tool) {
    case "contacts_search":
      return contactsSearch(args);
    case "contacts_get":
      return contactsGet(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown contacts tool: ${tool}`);
  }
}
