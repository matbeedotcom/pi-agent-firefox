/**
 * Real-user skill grants (skills-runtime-design.md §12 seam).
 *
 * The mock backend gets grants from TRUSTED_UA_SKILLS_CONFIG (test seam,
 * main.ts). Real users get grants from ONE file in the data root:
 *
 *   <TRUSTED_UA_DATA_ROOT || ~/.pi/browser>/skills-grants.json
 *
 *   {
 *     "grants": [{
 *       "skillKey": "tone-rewrite/tone",
 *       "revision": "<registry sha256>",
 *       "capabilities": ["context.read", "suggestion.present", "draft.replace-on-accept"],
 *       "mode": "advisory"                    // optional: advisory | review-before-submit
 *     }]
 *   }
 *
 * Real grants are revision-bound BY DESIGN (no "*" rebinding, unlike the
 * mock seam): a package change re-revisions its skills and the grant stops
 * matching until the file is updated.
 *
 * The loader is a plan-time GETTER (the createClientSkillsProtocol seam):
 * the file is re-read on every plan compile, so granting or re-granting a
 * skill needs no host restart — the next navigation re-plans from the
 * fresh file. Fail-closed: a missing file means "nothing granted"; an
 * invalid file is warned once and treated as empty. A grant file can never
 * take down plan compilation.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SKILL_CAPABILITIES, type SkillCapability } from "@trusted-ua/protocol";
import type { Logger } from "../logger.js";
import type { SkillGrant } from "./planner.js";
import { readableDataFile } from "../paths.js";

const MAX_GRANTS_FILE_BYTES = 64 * 1024;
const MAX_GRANTS = 256;

export function skillsGrantsPath(): string {
  return readableDataFile("skills-grants.json");
}

function parseCapabilities(value: unknown): SkillCapability[] {
  if (!Array.isArray(value) || value.length > SKILL_CAPABILITIES.length) throw new Error("Invalid capabilities");
  const result: SkillCapability[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SKILL_CAPABILITIES.includes(item as SkillCapability)) throw new Error("Unknown capability");
    if (!result.includes(item as SkillCapability)) result.push(item as SkillCapability);
  }
  if (!result.length) throw new Error("Grant has no capabilities");
  return result;
}

function parseGrant(value: unknown): SkillGrant {
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!["skillKey", "revision", "capabilities", "mode", "accounts", "learningEnabled"].includes(key)) throw new Error(`Unknown grant field: ${key}`);
  }
  const revision = entry.revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Grant revision must be a 64-char sha256 (real grants are revision-bound)");
  const grant: SkillGrant = { enabled: true, revision, capabilities: parseCapabilities(entry.capabilities) };
  if (entry.mode !== undefined) {
    if (entry.mode !== "advisory" && entry.mode !== "review-before-submit") throw new Error("Invalid mode");
    grant.mode = entry.mode;
  }
  if (entry.accounts !== undefined) {
    if (!Array.isArray(entry.accounts) || entry.accounts.length > 64 || !entry.accounts.every((a) => typeof a === "string")) throw new Error("Invalid accounts");
    grant.accounts = entry.accounts;
  }
  if (entry.learningEnabled !== undefined) {
    if (typeof entry.learningEnabled !== "boolean") throw new Error("Invalid learningEnabled");
    grant.learningEnabled = entry.learningEnabled;
  }
  return grant;
}

function parseFile(raw: string): Map<string, SkillGrant> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Root must be an object");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (key !== "grants") throw new Error(`Unknown field: ${key}`);
  }
  if (!Array.isArray(entry.grants) || entry.grants.length > MAX_GRANTS) throw new Error("Invalid grants array");
  const map = new Map<string, SkillGrant>();
  for (const value of entry.grants) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grant must be an object");
    const skillKey = (value as Record<string, unknown>).skillKey;
    if (typeof skillKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillKey)) throw new Error("Invalid skillKey");
    map.set(skillKey, parseGrant(value));
  }
  return map;
}

/**
 * Plan-time grant source: re-reads the grants file on every call. Synchronous
 * and bounded (≤ 64 KiB) — plan compiles are rare (navigation / 60 s plan
 * expiry), so the read is negligible; invalid state degrades to "nothing
 * granted" and never throws out of the getter.
 */
export function loadSkillsGrantFile(log: Logger): () => ReadonlyMap<string, SkillGrant> {
  let lastSignature = "";
  let lastMap: ReadonlyMap<string, SkillGrant> = new Map();
  let lastWarning = "";
  return () => {
    try {
      const file = skillsGrantsPath();
      const stat = statSync(file);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (signature === lastSignature) return lastMap;
      const raw = readFileSync(file, "utf8");
      if (Buffer.byteLength(raw) > MAX_GRANTS_FILE_BYTES) throw new Error("Grants file exceeds limit");
      lastMap = parseFile(raw);
      lastSignature = signature;
      lastWarning = "";
      return lastMap;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastWarning) {
        lastWarning = message;
        log.warn(`skills grants file unavailable (${skillsGrantsPath()}); nothing granted: ${message}`);
      }
      lastMap = new Map();
      lastSignature = "";
      return lastMap;
    }
  };
}
