/**
 * Every Experiment API schema the manifest declares must be in the
 * WebExtension schema format Thunderbird's loader accepts: a JSON ARRAY of
 * namespace entries, `[{ "namespace": "<name>", "functions": [...] }]`.
 *
 * trustedUaSearch shipped (through v0.2.1) as `{ "trustedUaSearch": { scopes, paths,
 * functions } }` — the manifest's experiment_apis layout, not a schema.
 * Thunderbird skipped it silently: `browser.trustedUaSearch` was undefined on
 * every version, and mail_search's full-text path quietly fell back to
 * messages.query instead of the Gloda engine. Only a live check noticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist-tests/test/ → package root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as {
  experiment_apis?: Record<string, { schema: string; parent?: { paths?: string[][] } }>;
};

const experiments = Object.entries(manifest.experiment_apis ?? {});

test("manifest declares experiment APIs", () => {
  assert.ok(experiments.length > 0);
});

for (const [name, decl] of experiments) {
  test(`experiment ${name}: schema is a namespace array whose namespace matches the manifest`, () => {
    const schema: unknown = JSON.parse(readFileSync(path.join(root, "src", decl.schema), "utf8"));
    assert.ok(Array.isArray(schema), `${decl.schema} must be a JSON array of namespace entries, not an object`);
    const entry = (schema as Array<Record<string, unknown>>).find((e) => e.namespace === name);
    assert.ok(entry, `${decl.schema} has no { "namespace": "${name}" } entry`);
    assert.ok(Array.isArray(entry.functions) && entry.functions.length > 0, `${name} declares no functions`);
    for (const fn of entry.functions as Array<Record<string, unknown>>) {
      // addon_parent implementations are reached over IPC: every call is async.
      assert.equal(fn.async, true, `${name}.${String(fn.name)} must be declared "async": true`);
      // Without a parameters array the call fails with an opaque
      // "InvalidStateError: An exception was thrown" (trustedUaSearch.status did).
      assert.ok(Array.isArray(fn.parameters), `${name}.${String(fn.name)} needs a "parameters" array (use [] for none)`);
      for (const param of (fn.parameters as Array<Record<string, unknown>>)) {
        if (param.type !== "object" || !param.properties) continue;
        for (const [key, prop] of Object.entries(param.properties as Record<string, Record<string, unknown>>)) {
          // A property with a "default" is meant to be omittable; the schema
          // loader still requires it unless it is marked optional.
          if ("default" in prop) assert.equal(prop.optional, true, `${name}.${String(fn.name)} option "${key}" has a default but is not optional`);
        }
      }
    }
    for (const p of decl.parent?.paths ?? []) {
      assert.equal(p[0], name, `manifest path ${JSON.stringify(p)} must start with the namespace`);
    }
  });
}
