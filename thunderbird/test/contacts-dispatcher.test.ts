/**
 * Unit tests for the Thunderbird contacts (T6) dispatcher (plan §41).
 *
 * A fake `browser.contacts` supplies query/get results. These prove the contract:
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
}

let store: Store;
function freshStore(): Store {
  return { lastQuery: {}, queryResults: [], byId: {} };
}

function installStub(): void {
  const g = globalThis as { browser?: unknown };
  g.browser = {
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

test("contacts_search with unrecognized keys falls back to raw properties", async () => {
  store.queryResults = [{ id: "card-3", properties: { customOnly: "value" } }];
  const r = (await dispatchContactsTool("contacts_search", { query: "x" })) as Record<string, unknown>;
  const c = (r.contacts as Record<string, unknown>[])[0];
  assert.equal(c.id, "card-3");
  assert.equal(c.name, undefined);
  assert.ok(c.properties, "raw properties are surfaced as a fallback");
});

test("contacts_search respects limit", async () => {
  store.queryResults = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, properties: { displayName: `N${i}` } }));
  const r = (await dispatchContactsTool("contacts_search", { query: "n", limit: 5 })) as Record<string, unknown>;
  assert.equal(r.count, 5);
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
