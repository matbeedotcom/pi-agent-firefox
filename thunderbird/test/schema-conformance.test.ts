/**
 * Schema-conformance test (goal mtymz4tm).
 *
 * Two live bugs slipped through unit tests because the unit stubs define
 * whatever `browser.*` surface the code expects, so they can never catch an API
 * that doesn't exist in the REAL build:
 *   1. `browser.contacts` is MV2-only (max_manifest_version: 2) and is
 *      `undefined` in an MV3 add-on -> the MV3 path is `browser.addressBooks.contacts`.
 *   2. `browser.messages.tags.list` requires the `messagesTagsList` permission,
 *      which the manifest was missing.
 *
 * This test verifies, against the INSTALLED Thunderbird's actual WebExtension
 * schemas (omni.ja), that every `browser.<ns>.<fn>` the add-on source calls is
 * (a) present, (b) available in Manifest V3, and (c) permitted by the manifest.
 *
 * It SKIPS (green) when no Thunderbird build is present, so it is CI-safe; run
 * it locally with a build at the default path or via $THUNDERBIRD_OMNI_JA.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "../../src");
const MANIFEST_PATH = path.resolve(here, "../../manifest.json");
const SCHEMA_PREFIX = "chrome/messenger/content/messenger/schemas/";

/** Core / non-messenger namespaces that live outside the messenger schemas. */
const EXEMPT_ROOTS = new Set(["runtime", "storage", "action", "tabs", "piPane"]);

interface FnSpec {
  name: string;
  permissions: string[];
  max?: number;
  min?: number;
}
interface NsSpec {
  permissions: string[];
  max?: number;
  min?: number;
  imp?: string;
  functions: FnSpec[];
}

function findOmniJa(): string | null {
  const candidates = [
    process.env.THUNDERBIRD_OMNI_JA,
    "/home/acidhax/thunderbird/omni.ja",
    path.join(os.homedir(), "thunderbird", "omni.ja"),
    "/usr/lib/thunderbird/omni.ja",
    "/opt/thunderbird/omni.ja",
    "/snap/thunderbird/current/usr/lib/thunderbird/omni.ja",
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function unzipRead(omniJa: string, entry: string): string {
  return execFileSync("unzip", ["-p", omniJa, entry], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}
function unzipEntries(omniJa: string): string[] {
  return execFileSync("unzip", ["-Z1", omniJa], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function loadMessengerNamespaces(omniJa: string): Map<string, NsSpec> {
  const entries = unzipEntries(omniJa).filter(
    (e) => e.startsWith(SCHEMA_PREFIX) && e.endsWith(".json"),
  );
  const ns = new Map<string, NsSpec>();
  for (const entry of entries) {
    // Some schema files carry a leading "// Copyright" block before the JSON.
    const raw = unzipRead(omniJa, entry).replace(/^\s*(?:\/\/[^\n]*\n)+/, "");
    let doc: Array<Record<string, unknown>>;
    try {
      doc = JSON.parse(raw) as Array<Record<string, unknown>>;
    } catch {
      continue; // not a parseable namespace schema (e.g. a JS-flavored schema); skip
    }
    if (!Array.isArray(doc)) continue;
    for (const n of doc) {
      const name = n.namespace as string | undefined;
      if (!name || name === "manifest") continue;
      // Events (browser.<ns>.onX.addListener) resolve like functions for
      // conformance purposes; include them so namespace+event usage is checked.
    const functions = [...((n.functions ?? []) as Array<Record<string, unknown>>),
      ...((n.events ?? []) as Array<Record<string, unknown>>)].map((f) => ({
        name: f.name as string,
        permissions: ((f.permissions ?? []) as string[]),
        max: f.max_manifest_version as number | undefined,
        min: f.min_manifest_version as number | undefined,
      }));
      ns.set(name, {
        permissions: ((n.permissions ?? []) as string[]),
        max: n.max_manifest_version as number | undefined,
        min: n.min_manifest_version as number | undefined,
        imp: n.$import as string | undefined,
        functions,
      });
    }
  }
  // Resolve $import namespaces (e.g. addressBooks.contacts -> contacts).
  for (const [name, spec] of ns) {
    if (spec.imp && spec.functions.length === 0) {
      const imported = ns.get(spec.imp);
      if (imported) spec.functions = imported.functions;
    }
  }
  return ns;
}

/** An entity (namespace or function) is MV3-available if its version bounds allow v3. */
function mv3Available(max: number | undefined, min: number | undefined): boolean {
  if (max !== undefined && max < 3) return false;
  if (min !== undefined && min > 3) return false;
  return true;
}

/** Longest namespace prefix of `dottedPath` that declares `fn`; returns {ns, fn} or null. */
function resolveApi(dottedPath: string, ns: Map<string, NsSpec>): { ns: string; fn: string } | null {
  const parts = dottedPath.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const nsName = parts.slice(0, i).join(".");
    const fnName = parts[i];
    const spec = ns.get(nsName);
    if (spec && spec.functions.some((f) => f.name === fnName)) return { ns: nsName, fn: fnName };
  }
  return null;
}

/** Permissions required by an API: the overloads' own, plus every ancestor namespace's. */
function requiredPerms(
  nsName: string,
  spec: NsSpec,
  overloads: FnSpec[],
  all: Map<string, NsSpec>,
): Set<string> {
  const perms = new Set<string>(spec.permissions);
  for (const f of overloads) f.permissions.forEach((p) => perms.add(p));
  const parts = nsName.split(".");
  for (let i = 1; i <= parts.length; i++) {
    const anc = all.get(parts.slice(0, i).join("."));
    if (anc) anc.permissions.forEach((p) => perms.add(p));
  }
  return perms;
}

/** Collect every `browser.<dotted.path>(` call in the add-on source. */
function collectBrowserCalls(): Set<string> {
  const calls = new Set<string>();
  const stack = [SRC_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/browser\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/g)) {
          calls.add(m[1]);
        }
      }
    }
  }
  return calls;
}

test("every browser.* API the add-on calls exists, is MV3, and is permitted", (t) => {
  const omniJa = findOmniJa();
  if (!omniJa || !existsSync(MANIFEST_PATH)) {
    t.skip("no Thunderbird build found (set THUNDERBIRD_OMNI_JA); skipping schema conformance");
    return;
  }

  const namespaces = loadMessengerNamespaces(omniJa);
  const manifestPerms = new Set(
    (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { permissions?: string[] }).permissions ?? [],
  );
  const calls = [...collectBrowserCalls()].sort();

  const problems: string[] = [];
  const verified: string[] = [];
  for (const dotted of calls) {
    const root = dotted.split(".")[0];
    if (EXEMPT_ROOTS.has(root)) continue;
    const api = resolveApi(dotted, namespaces);
    if (!api) {
      problems.push(`${dotted}: not found in the messenger schemas (wrong namespace? MV2-only?)`);
      continue;
    }
    const spec = namespaces.get(api.ns)!;
    const overloads = spec.functions.filter((f) => f.name === api.fn);
    if (!mv3Available(spec.max, spec.min)) {
      problems.push(
        `${api.ns}.${api.fn}: namespace '${api.ns}' is not MV3-available (max=${spec.max ?? "-"}, min=${spec.min ?? "-"})`,
      );
    }
    // A function may have several overloads (duplicate names) with different MV
    // bounds; the API is usable if ANY overload is MV3-available.
    const mv3Overloads = overloads.filter((f) => mv3Available(f.max, f.min));
    if (mv3Overloads.length === 0) {
      problems.push(
        `${api.ns}.${api.fn}: no MV3-available overload (overloads max=[${overloads.map((o) => o.max ?? "-").join(",")}])`,
      );
    }
    const used = mv3Overloads.length > 0 ? mv3Overloads : overloads;
    for (const p of requiredPerms(api.ns, spec, used, namespaces)) {
      if (!manifestPerms.has(p)) {
        problems.push(`${api.ns}.${api.fn}: requires permission '${p}' not declared in manifest`);
      }
    }
    verified.push(`${api.ns}.${api.fn}`);
  }

  // Prove the test actually exercised the messenger surface (not a silent no-op).
  assert.ok(
    verified.some((a) => a.startsWith("messages.")),
    "test found no browser.messages.* calls — source scan is broken",
  );
  assert.ok(verified.some((a) => a.startsWith("addressBooks.")), "test found no addressBooks.* calls");

  assert.deepEqual(problems, [], problems.join("\n"));
});
