/**
 * Thunderbird contacts (address book, T6) tool dispatcher (THUNDERBIRD-PLAN.md §41).
 *
 * Read-only. Maps `contacts_search` / `contacts_get` onto `browser.addressBooks.contacts`
 * (the MV3 path; top-level `browser.contacts` is MV2-only and undefined in MV3).
 * Contact data is untrusted external data (plan §31–32): it is returned as
 * normalized tool output and never merged into the user prompt.
 *
 * MV3 contacts do not expose a flat `properties` map — `list/get/query` return
 * a `vCard` string only (ext-addressBook.js `convert()`). We parse that vCard
 * into an abCard-style flat map; a populated MV2 `properties` map is used
 * directly when present. Every result also surfaces the raw vCard string + the
 * flat map so the full card is visible. Contact data is untrusted; the
 * extraction is defensive over vCard field names (FN/N, EMAIL, ORG, ...).
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

/**
 * vCard parsing (MV3 source of truth).
 *
 * In MV3, `browser.addressBooks.contacts.list/get/query` do NOT return a flat
 * `properties` map — they return a `vCard` string only (see ext-addressBook.js
 * `convert()`: `if (manifest_version < 3) copy.properties = ...; else copy.vCard = ...`).
 * So we parse the vCard into an abCard-style flat map, reusing contactName /
 * contactEmails / contactOrg. MV2-style `properties` maps (when present and
 * populated) are used directly instead.
 */

function unescapeVCard(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse a vCard string (2.1/3.0/4.0) into field-name → values (uppercase keys). */
function parseVCard(vcard: string): Record<string, string[]> {
  const lines = vcard.replace(/\r\n/g, "\n").split("\n");
  const logical: string[] = [];
  for (const line of lines) {
    // Continuation lines start with a single space or tab and append to the
    // previous logical line.
    if (line.length > 0 && (line[0] === " " || line[0] === "\t") && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  const fields: Record<string, string[]> = {};
  for (const line of logical) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const base = line.slice(0, colon).split(";")[0].trim().toUpperCase();
    if (!base) continue;
    const value = unescapeVCard(line.slice(colon + 1));
    (fields[base] ??= []).push(value);
  }
  return fields;
}

/** Build an abCard-style flat property map from a vCard string. */
function propsFromVCard(vcard: string): Record<string, unknown> {
  const f = parseVCard(vcard);
  const one = (k: string): string | undefined => f[k]?.find((s) => s.length > 0);
  const props: Record<string, unknown> = {};
  const fn = one("FN");
  if (fn) props.DisplayName = fn;
  const n = one("N"); // "Surname;Given;Additional;Prefix;Suffix"
  if (n) {
    const parts = n.split(";");
    if (parts[1]) props.FirstName = parts[1];
    if (parts[0]) props.LastName = parts[0];
  }
  const emails = (f.EMAIL ?? []).filter((e) => e.length > 0);
  if (emails.length > 0) {
    emails.forEach((e, i) => {
      if (i === 0) props.PrimaryEmail = e;
      else if (i === 1) props.SecondEmail = e;
    });
    props.emailAddresses = emails.map((e) => ({ type: "INTERNET", value: e }));
  }
  const org = one("ORG"); // "Org Name;Org Unit;..."
  if (org) props.Company = org.split(";")[0];
  (f.TEL ?? []).filter((t) => t.length > 0).forEach((t, i) => {
    props[i === 0 ? "PrimaryPhone" : `Phone${i + 1}`] = t;
  });
  const title = one("TITLE");
  if (title) props.JobTitle = title;
  const note = one("NOTE");
  if (note) props.Notes = note;
  const adr = (f.ADR ?? []).filter((a) => a.length > 0);
  if (adr.length > 0) props.streetAddress = adr[0];
  // Preserve any other vCard fields verbatim (raw visibility).
  for (const [k, vals] of Object.entries(f)) {
    if (!(k in props)) props[k] = vals.length === 1 ? vals[0] : vals;
  }
  return props;
}

function normalizeContact(c: browser.addressBooks.contacts.Contact): Record<string, unknown> {
  const vcard = typeof c.vCard === "string" && c.vCard.length > 0 ? c.vCard : "";
  const mv2 =
    c.properties && typeof c.properties === "object"
      ? (c.properties as Record<string, unknown>)
      : null;
  // Prefer a populated MV2 `properties` map; otherwise parse the MV3 vCard.
  const flat: Record<string, unknown> =
    mv2 && Object.keys(mv2).length > 0 ? { ...mv2 } : vcard ? propsFromVCard(vcard) : {};
  const out: Record<string, unknown> = { id: c.cardKey ?? c.id };
  const name = contactName(flat);
  const emails = contactEmails(flat);
  const org = contactOrg(flat);
  if (name) out.name = name;
  if (emails.length > 0) out.emails = emails;
  if (org) out.organization = org;
  // Raw details: the vCard string (MV3 source of truth) plus the flat map.
  if (vcard) out.vCard = vcard;
  out.properties = flat;
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
