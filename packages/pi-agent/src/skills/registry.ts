import { createHash } from "node:crypto";
import { open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { parseSkillManifest, type RegisteredSkill } from "@pi-browser/protocol";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTRUCTION_BYTES = 32 * 1024;
const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGES = 4096;

/** Resolve real paths before reading, including symlinks in intermediate directories. */
async function packageFile(root: string, relative: string, maxBytes: number): Promise<string> {
  const file = await realpath(path.resolve(root, relative));
  const within = path.relative(root, file);
  if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) throw new Error("Package path escapes root");
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Package file exceeds limit or is not a file");
    // Read a bounded buffer even if the file grows after stat.
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("Package file exceeds limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

/** Host-owned registry. Reload publishes all definitions together or preserves the old snapshot. */
export class SkillsRegistry {
  private entries = new Map<string, RegisteredSkill>();
  private generation = 0;
  private reloadTail: Promise<void> = Promise.resolve();

  get version(): number { return this.generation; }
  snapshot(): RegisteredSkill[] { return structuredClone([...this.entries.values()]); }
  get(key: string): RegisteredSkill | undefined {
    const skill = this.entries.get(key);
    return skill && structuredClone(skill);
  }

  /** Explicit external paths are allowed; nested instruction paths remain confined to each root. */
  reload(packageRoots: readonly string[]): Promise<void> {
    const roots = [...packageRoots];
    const next = this.reloadTail.then(() => this.load(roots));
    // Only the internal queue recovers; the returned promise still rejects for the caller.
    this.reloadTail = next.catch(() => {});
    return next;
  }

  private async load(packageRoots: readonly string[]): Promise<void> {
    if (packageRoots.length > MAX_PACKAGES) throw new Error("Too many skill packages");
    const next = new Map<string, RegisteredSkill>();
    const packageIds = new Set<string>();
    let totalBytes = 0;
    for (const packageRoot of packageRoots) {
      const root = await realpath(packageRoot);
      const raw = await packageFile(root, "activation.json", MAX_MANIFEST_BYTES);
      const manifest = parseSkillManifest(JSON.parse(raw));
      if (packageIds.has(manifest.packageId)) throw new Error(`Duplicate package ID: ${manifest.packageId}`);
      packageIds.add(manifest.packageId);
      totalBytes += Buffer.byteLength(raw);
      for (const definition of manifest.skills) {
        const instructions = await packageFile(root, definition.instructions, MAX_INSTRUCTION_BYTES);
        if (!instructions.trim()) throw new Error("Skill instructions are empty");
        totalBytes += Buffer.byteLength(instructions);
        if (totalBytes > MAX_REGISTRY_BYTES || next.size >= 16_384) throw new Error("Skill registry exceeds limit");
        const key = `${manifest.packageId}/${definition.id}`;
        const revision = createHash("sha256").update(JSON.stringify(definition)).update("\0").update(instructions).digest("hex");
        next.set(key, { key, revision, definition, instructions });
      }
      if (totalBytes > MAX_REGISTRY_BYTES) throw new Error("Skill registry exceeds limit");
    }
    this.entries = next;
    this.generation += 1;
  }
}

/** Discover direct package directories without loading package.json or executing entry points. */
export async function discoverSkillPackages(packagesRoot: string): Promise<string[]> {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  if (entries.length > MAX_PACKAGES) throw new Error("Too many package directory entries");
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(packagesRoot, entry.name)).sort();
}
