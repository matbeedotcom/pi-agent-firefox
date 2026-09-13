/**
 * Unit tests for the Thunderbird contacts (T6) dispatcher (plan §41).
 *
 * A fake `browser.addressBooks.contacts` supplies query/get results. These prove the contract:
 * search passes the query through, results are normalized (name / emails /
 * organization) across the varying vCard key styles, the raw-properties fallback
 * kicks in when nothing resolves, and there is no contacts mutation path.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { dispatchContactsTool } from "../src/background/contacts-dispatcher.js";

interface Store {
  lastQuery: Record<string, unknown>;
  queryResults: Array<Record<string, unknown>>;
  byId: Record<string, Record<string, unknown>>;
  books: Array<{ id: string; name?: string }>;
  byBook: Record<string, Array<Record<string, unknown>>>;
}

let store: Store;
function freshStore(): Store {
  return { lastQuery: {}, queryResults: [], byId: {}, books: [], byBook: {} };
}

function installStub(): void {
  const g = globalThis as { browser?: unknown };
  g.browser = {
    // MV3 path: browser.addressBooks.contacts (top-level browser.contacts is MV2-only).
    addressBooks: {
      async list() {
        return store.books;
      },
      contacts: {
        async query(queryInfo: Record<string, unknown>) {
          store.lastQuery = queryInfo;
          return store.queryResults;
        },
        async get(id: string) {
          const c = store.byId[id];
          if (!c) throw new Error(`Contact not found: ${id}`);
          return c;
        },
        async list(bookId: string) {
          return store.byBook[bookId] ?? [];
        },
      },
    },
  };
}

before(installStub);
after(() => {
  delete (globalThis as { browser?: unknown }).browser;
});
beforeEach(() => {
  store = freshStore();
});

test("contacts_search passes the query through and normalizes displayName + emailAddresses[]", async () => {
  store.queryResults = [
    {
      id: "card-1",
      properties: {
        displayName: "Sarah Doe",
        emailAddresses: [{ type: "work", value: "sarah@acme.com" }, { value: "s@x.io" }],
        organization: "Acme",
      },
    },
  ];
  const r = (await dispatchContactsTool("contacts_search", { query: "sarah acme" })) as Record<string, unknown>;
  assert.equal(store.lastQuery.searchString, "sarah acme");
  // include* flags must be set, or query() skips local read-write books (the
  // Personal book) entirely and the contact is never found.
  assert.equal(store.lastQuery.includeLocal, true);
  assert.equal(store.lastQuery.includeRemote, true);
  assert.equal(store.lastQuery.includeReadOnly, true);
  assert.equal(store.lastQuery.includeReadWrite, true);
  assert.equal(r.count, 1);
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.id, "card-1");
  assert.equal(c.name, "Sarah Doe");
  assert.deepEqual(c.emails, ["sarah@acme.com", "s@x.io"]);
  assert.equal(c.organization, "Acme");
});

test("contacts_search falls back to firstName+lastName + a plain email string", async () => {
  store.queryResults = [{ id: "card-2", properties: { firstName: "Jane", lastName: "Roe", email: "jane@x.com" } }];
  const r = (await dispatchContactsTool("contacts_search", { query: "jane" })) as Record<string, unknown>;
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.name, "Jane Roe");
  assert.deepEqual(c.emails, ["jane@x.com"]);
});

test("contacts_search: an email-only card (no name) still surfaces the email", async () => {
  // The user's real case: a card that is just an email (no displayName/name fields).
  store.queryResults = [{ id: "card-email", properties: { email: "solo@example.com" } }];
  const r = (await dispatchContactsTool("contacts_search", { query: "solo@example.com" })) as Record<string, unknown>;
  assert.equal(r.count, 1);
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.id, "card-email");
  assert.equal(c.name, undefined); // no name on the card — not an error
  assert.deepEqual(c.emails, ["solo@example.com"]);
});

test("contacts_search always surfaces the raw properties (incl. unrecognized keys)", async () => {
  store.queryResults = [{ id: "card-3", properties: { customOnly: "value" } }];
  const r = (await dispatchContactsTool("contacts_search", { query: "x" })) as Record<string, unknown>;
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.id, "card-3");
  assert.equal(c.name, undefined);
  const props = c.properties as Record<string, unknown>;
  assert.equal(props.customOnly, "value", "raw properties are always surfaced");
});

test("contacts_get returns the raw properties alongside the extracted fields", async () => {
  store.byId["card-raw"] = {
    id: "card-raw",
    properties: { DisplayName: "Ann", PrimaryEmail: "ann@x.com", Company: "X", SomeCustom: "raw-data" },
  };
  const r = (await dispatchContactsTool("contacts_get", { contactId: "card-raw" })) as Record<string, unknown>;
  assert.equal(r.name, "Ann");
  assert.deepEqual(r.emails, ["ann@x.com"]);
  const props = r.properties as Record<string, unknown>;
  assert.equal(props.SomeCustom, "raw-data", "custom/raw keys are preserved verbatim");
  assert.equal(props.DisplayName, "Ann");
});

test("contacts_search respects limit", async () => {
  store.queryResults = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, properties: { displayName: `N${i}` } }));
  const r = (await dispatchContactsTool("contacts_search", { query: "n", limit: 5 })) as Record<string, unknown>;
  assert.equal(r.count, 5);
});

test("contacts_search: normalizes the REAL MV3 abCard keys (DisplayName/PrimaryEmail/Company)", async () => {
  // The installed build keys `properties` by CamelCase abCard names, not lowercase.
  store.queryResults = [
    { id: "c-real", properties: { DisplayName: "Valerie Presti", PrimaryEmail: "valerie@dorsayco.com", SecondEmail: "vp@other.com", Company: "Dorsay Co" } },
  ];
  const r = (await dispatchContactsTool("contacts_search", { query: "valerie" })) as Record<string, unknown>;
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.name, "Valerie Presti");
  assert.deepEqual(c.emails, ["valerie@dorsayco.com", "vp@other.com"]);
  assert.equal(c.organization, "Dorsay Co");
});

test("contacts_list enumerates all books and dedupes by id", async () => {
  store.books = [{ id: "b1" }, { id: "b2" }];
  store.byBook = {
    b1: [
      { id: "c1", properties: { DisplayName: "A", PrimaryEmail: "a@x" } },
      { id: "c2", properties: { PrimaryEmail: "b@x" } },
    ],
    b2: [
      { id: "c2", properties: { PrimaryEmail: "b@x" } }, // duplicate of b1's c2
      { id: "c3", properties: { PrimaryEmail: "c@x" } },
    ],
  };
  const r = (await dispatchContactsTool("contacts_list", {})) as Record<string, unknown>;
  assert.equal(r.total, 3);
  assert.equal(r.count, 3);
  assert.deepEqual((r.contacts as Record<string, unknown>[]).map((c) => c.id), ["c1", "c2", "c3"]);
});

test("contacts_list filters case-insensitively across name/email/org", async () => {
  store.books = [{ id: "b1" }];
  store.byBook = {
    b1: [
      { id: "c1", properties: { DisplayName: "Valerie", PrimaryEmail: "v@acme.com" } },
      { id: "c2", properties: { PrimaryEmail: "other@x.com" } },
    ],
  };
  const r = (await dispatchContactsTool("contacts_list", { filter: "ACME" })) as Record<string, unknown>;
  assert.equal(r.total, 1);
  assert.equal((r.contacts as Record<string, unknown>[])[0].id, "c1");
});

test("contacts_list paginates with cursor/limit and nextCursor", async () => {
  store.books = [{ id: "b1" }];
  store.byBook = { b1: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, properties: { PrimaryEmail: `${n}@x` } })) };
  const p1 = (await dispatchContactsTool("contacts_list", { limit: 2, cursor: 0 })) as Record<string, unknown>;
  assert.equal(p1.count, 2);
  assert.equal(p1.total, 5);
  assert.equal(p1.nextCursor, 2);
  const p2 = (await dispatchContactsTool("contacts_list", { limit: 2, cursor: 2 })) as Record<string, unknown>;
  assert.equal(p2.nextCursor, 4);
  const p3 = (await dispatchContactsTool("contacts_list", { limit: 2, cursor: 4 })) as Record<string, unknown>;
  assert.equal(p3.count, 1);
  assert.equal(p3.nextCursor, null);
});

test("contacts_get returns one normalized contact (org key alias)", async () => {
  store.byId["card-9"] = {
    id: "card-9",
    properties: { displayName: "Bob", org: "Widget Co", email: ["bob@w.com"] },
  };
  const r = (await dispatchContactsTool("contacts_get", { contactId: "card-9" })) as Record<string, unknown>;
  assert.equal(r.id, "card-9");
  assert.equal(r.name, "Bob");
  assert.equal(r.organization, "Widget Co");
  assert.deepEqual(r.emails, ["bob@w.com"]);
});

test("contacts_get on an unknown id surfaces a structured error", async () => {
  await assert.rejects(dispatchContactsTool("contacts_get", { contactId: "nope" }), /not found/i);
});

test("no contacts mutation path exists", async () => {
  // contacts_create / contacts_update / contacts_delete are not tools.
  for (const name of ["contacts_create", "contacts_update", "contacts_delete"]) {
    await assert.rejects(
      dispatchContactsTool(name, {}),
      (e: unknown) => e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
    );
  }
});
