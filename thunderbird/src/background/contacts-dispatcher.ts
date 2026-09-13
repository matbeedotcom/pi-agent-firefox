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

/**
 * The MV3 `properties` map is keyed by abCard property names, which are
 * CamelCase — e.g. `DisplayName`, `FirstName`/`LastName`, `PrimaryEmail`/
 * `SecondEmail`, `Company`, `NickName`, `Notes` — NOT the lowercase vCard names.
 * We match case-insensitively and try the real abCard names first, then the
 * legacy/lowercase variants, so both shapes resolve.
 */
function ciMap(p: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(p)) {
    const lk = k.toLowerCase();
    if (!m.has(lk)) m.set(lk, v);
  }
  return m;
}

function pick(m: Map<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = m.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function contactName(p: Record<string, unknown>): string | undefined {
  const m = ciMap(p);
  const display = firstStr(pick(m, "DisplayName", "fn", "displayName"));
  if (display) return display;
  const first = firstStr(pick(m, "FirstName", "firstName", "givenName", "given"));
  const last = firstStr(pick(m, "LastName", "lastName", "familyName", "family"));
  if (first || last) return `${first ?? ""} ${last ?? ""}`.trim();
  return firstStr(pick(m, "name"));
}

function contactEmails(p: Record<string, unknown>): string[] {
  const m = ciMap(p);
  const out = new Set<string>();
  // Primary + secondary (the real abCard keys), then legacy list shapes.
  for (const v of [pick(m, "PrimaryEmail", "email"), pick(m, "SecondEmail")]) {
    emailValues(v).forEach((e) => out.add(e));
  }
  for (const v of [pick(m, "emailAddresses"), pick(m, "emails"), pick(m, "emailAddress")]) {
    emailValues(v).forEach((e) => out.add(e));
  }
  return [...out];
}

function contactOrg(p: Record<string, unknown>): string | undefined {
  const m = ciMap(p);
  return firstStr(pick(m, "Company", "organization", "organizationName", "org", "company", "Department"));
}

function normalizeContact(c: browser.addressBooks.contacts.Contact): Record<string, unknown> {
  const p = (c.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { id: c.cardKey ?? c.id };
  const name = contactName(p);
  const emails = contactEmails(p);
  const org = contactOrg(p);
  if (name) out.name = name;
  if (emails.length > 0) out.emails = emails;
  if (org) out.organization = org;
  // Always expose the raw properties (incl. the vCard string) so the full card is
  // visible, not just the extracted fields.
  out.properties = p;
  return out;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function contactsSearch(args: Record<string, unknown>): Promise<ContactsToolResult> {
  const query = reqStr(args, "query");
  const limit = clampInt(args, "limit", 1, MAX_CONTACT_LIMIT, DEFAULT_CONTACT_LIMIT);
  // include* flags are REQUIRED: without them, query() skips local read-write
  // address books (e.g. the Personal book) entirely, so a real contact would never
  // be found. Set all four so every book (local+remote, read-only+read-write) is searched.
  const results = await browser.addressBooks.contacts.query({
    searchString: query,
    includeLocal: true,
    includeRemote: true,
    includeReadOnly: true,
    includeReadWrite: true,
  });
  const contacts = results.slice(0, limit).map(normalizeContact);
  return { query, count: contacts.length, contacts };
}

async function contactsGet(args: Record<string, unknown>): Promise<ContactsToolResult> {
  const contactId = reqStr(args, "contactId");
  const c = await browser.addressBooks.contacts.get(contactId);
  return normalizeContact(c);
}

async function contactsList(args: Record<string, unknown>): Promise<ContactsToolResult> {
  const filterRaw = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
  const limit = clampInt(args, "limit", 1, MAX_CONTACT_LIMIT, DEFAULT_CONTACT_LIMIT);
  const cursor =
    typeof args.cursor === "number" && Number.isFinite(args.cursor) && args.cursor >= 0
      ? Math.trunc(args.cursor)
      : 0;

  // Enumerate every address book, then every contact in it. (query() requires a
  // non-empty search term, so listing-all goes through the book/card APIs.)
  const books = await browser.addressBooks.list();
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const book of books) {
    let cards: browser.addressBooks.contacts.Contact[] = [];
    try {
      cards = await browser.addressBooks.contacts.list(book.id);
    } catch {
      continue;
    }
    for (const c of cards) {
      const norm = normalizeContact(c);
      const id = String(norm.id);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(norm);
    }
  }

  const filtered = filterRaw
    ? all.filter((c) =>
        `${c.name ?? ""} ${(c.emails as string[] ?? []).join(" ")} ${c.organization ?? ""}`
          .toLowerCase()
          .includes(filterRaw),
      )
    : all;

  const total = filtered.length;
  const page = filtered.slice(cursor, cursor + limit);
  return {
    count: page.length,
    total,
    cursor,
    limit,
    nextCursor: cursor + limit < total ? cursor + limit : null,
    contacts: page,
  };
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
    case "contacts_list":
      return contactsList(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown contacts tool: ${tool}`);
  }
}
