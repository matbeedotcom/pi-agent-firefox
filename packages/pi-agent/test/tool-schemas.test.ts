import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_TOOLS,
  CONTROL_TOOLS,
  MAIL_TOOLS,
  COMPOSE_TOOLS,
  MAIL_MUTATION_TOOLS,
  CONTACTS_TOOLS,
} from "@pi-browser/protocol";
import { BROWSER_TOOL_SCHEMAS, CONTROL_TOOL_SCHEMAS } from "../src/browser/schemas.js";
import { MAIL_TOOL_SCHEMAS } from "../src/mail/schemas.js";
import { COMPOSE_TOOL_SCHEMAS } from "../src/compose/schemas.js";
import { MAIL_MUTATION_TOOL_SCHEMAS } from "../src/mutation/schemas.js";
import { CONTACTS_TOOL_SCHEMAS } from "../src/contacts/schemas.js";

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

function checkSync(
  defs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  tbSchemas: ReadonlyArray<{ name: string; description: string; parameters: unknown }>,
  label: string,
): string[] {
  const allDiffs: string[] = [];
  if (tbSchemas.length !== defs.length) {
    return [`${label}: ${tbSchemas.length} TypeBox schemas != ${defs.length} protocol tools`];
  }
  for (const def of defs) {
    const tb = tbSchemas.find((s) => s.name === def.name);
    if (!tb) {
      allDiffs.push(`${def.name}: missing TypeBox schema`);
      continue;
    }
    if (tb.description !== def.description) {
      allDiffs.push(`${def.name}: description drift`);
    }
    allDiffs.push(
      ...compareSchemas(normalizeForCompare(tb.parameters as Record<string, unknown>), def.inputSchema, def.name),
    );
  }
  return allDiffs;
}

test("TypeBox schemas match the protocol JSON schemas", () => {
  const allDiffs: string[] = [];
  allDiffs.push(...checkSync(BROWSER_TOOLS, BROWSER_TOOL_SCHEMAS, "browser tools"));
  allDiffs.push(...checkSync(CONTROL_TOOLS, CONTROL_TOOL_SCHEMAS, "control tools"));
  allDiffs.push(...checkSync(MAIL_TOOLS, MAIL_TOOL_SCHEMAS, "mail tools"));
  allDiffs.push(...checkSync(COMPOSE_TOOLS, COMPOSE_TOOL_SCHEMAS, "compose tools"));
  allDiffs.push(...checkSync(MAIL_MUTATION_TOOLS, MAIL_MUTATION_TOOL_SCHEMAS, "mail mutation tools"));
  allDiffs.push(...checkSync(CONTACTS_TOOLS, CONTACTS_TOOL_SCHEMAS, "contacts tools"));
  assert.deepEqual(allDiffs, [], allDiffs.join("\n"));
});
