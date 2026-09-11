import { test } from "node:test";
import assert from "node:assert/strict";

import { BROWSER_TOOLS } from "@pi-browser/protocol";
import { BROWSER_TOOL_SCHEMAS } from "../src/browser/schemas.js";

/**
 * The TypeBox schemas (used by Pi for validation + LLM tool definitions)
 * and the protocol JSON Schemas (served by Firefox over MCP) must stay in
 * sync: same tools, same properties, same required lists, same types.
 */

function normalizeForCompare(schema: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...schema };
  // TypeBox and hand-written JSON both use standard JSON Schema shapes;
  // compare the semantically relevant keys only.
  return clone;
}

function compareSchemas(tb: Record<string, unknown>, json: Record<string, unknown>, path: string): string[] {
  const diffs: string[] = [];
  if (tb.type !== json.type) {
    diffs.push(`${path}: type ${String(tb.type)} != ${String(json.type)}`);
    return diffs;
  }
  if (tb.type === "object") {
    const tbProps = (tb.properties ?? {}) as Record<string, Record<string, unknown>>;
    const jsonProps = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
    const tbRequired = (tb.required ?? []) as string[];
    const jsonRequired = (json.required ?? []) as string[];
    if (JSON.stringify([...tbRequired].sort()) !== JSON.stringify([...jsonRequired].sort())) {
      diffs.push(`${path}.required: [${tbRequired}] != [${jsonRequired}]`);
    }
    const tbKeys = Object.keys(tbProps).sort();
    const jsonKeys = Object.keys(jsonProps).sort();
    if (JSON.stringify(tbKeys) !== JSON.stringify(jsonKeys)) {
      diffs.push(`${path}.properties keys: [${tbKeys}] != [${jsonKeys}]`);
    }
    for (const key of tbKeys) {
      if (!jsonProps[key]) continue;
      diffs.push(...compareSchemas(tbProps[key], jsonProps[key], `${path}.properties.${key}`));
    }
    const tbAddl = tb.additionalProperties;
    const jsonAddl = json.additionalProperties;
    if (tbAddl !== jsonAddl) diffs.push(`${path}.additionalProperties: ${String(tbAddl)} != ${String(jsonAddl)}`);
  }
  if (tb.description !== json.description) {
    diffs.push(`${path}.description differs`);
  }
  // enum-ish unions: compare const sets
  const tbAnyOf = (tb.anyOf ?? []) as Array<Record<string, unknown>>;
  const jsonAnyOf = (json.anyOf ?? []) as Array<Record<string, unknown>>;
  if (tbAnyOf.length !== jsonAnyOf.length) {
    diffs.push(`${path}.anyOf length ${tbAnyOf.length} != ${jsonAnyOf.length}`);
  } else {
    const tbConsts = tbAnyOf.map((s) => s.const).sort();
    const jsonConsts = jsonAnyOf.map((s) => s.const).sort();
    if (JSON.stringify(tbConsts) !== JSON.stringify(jsonConsts)) {
      diffs.push(`${path}.anyOf consts [${tbConsts}] != [${jsonConsts}]`);
    }
  }
  return diffs;
}

test("TypeBox schemas match the protocol JSON schemas", () => {
  const allDiffs: string[] = [];
  assert.equal(BROWSER_TOOL_SCHEMAS.length, BROWSER_TOOLS.length);
  for (const def of BROWSER_TOOLS) {
    const tb = BROWSER_TOOL_SCHEMAS.find((s) => s.name === def.name);
    if (!tb) {
      allDiffs.push(`${def.name}: missing TypeBox schema`);
      continue;
    }
    if (tb.description !== def.description) {
      allDiffs.push(`${def.name}: description drift`);
    }
    const diffs = compareSchemas(normalizeForCompare(tb.parameters as Record<string, unknown>), def.inputSchema, def.name);
    allDiffs.push(...diffs);
  }
  assert.deepEqual(allDiffs, [], allDiffs.join("\n"));
});
