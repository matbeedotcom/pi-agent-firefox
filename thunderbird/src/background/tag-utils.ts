/**
 * Shared tag helpers for the Thunderbird mail tools.
 *
 * Thunderbird tags have an internal lowercase `key` and a human-readable
 * `tag` (name). `messages.update` and `messages.query` operate on KEYS, but
 * agents and users think in NAMES. These helpers bridge the two: list the
 * available tags and resolve a list of names/keys to existing keys.
 *
 * Nothing here mutates state — creating a tag is the caller's decision
 * (mail_set_tags does it; search and list do not).
 */

export interface TagRef {
  /** Internal tag key (lowercase). */
  key: string;
  /** Human-readable tag name. */
  name: string;
  color?: string;
  ordinal?: number;
}

/** List every tag as { key, name, color? }. Omits undefined fields. */
export async function listTags(): Promise<TagRef[]> {
  const tags = await browser.messages.tags.list();
  return tags.map((t) => {
    const ref: TagRef = { key: t.key, name: t.tag };
    if (t.color !== undefined) ref.color = t.color;
    if (t.ordinal !== undefined) ref.ordinal = t.ordinal;
    return ref;
  });
}

export interface ResolvedTags {
  /** Keys for every requested tag that already exists. */
  keys: string[];
  /** Requested names/keys that matched no existing tag. */
  unknown: string[];
}

/**
 * Derive a tag key from a display name: lowercase, alnum/dash only. Avoids a key
 * that already exists (appends -2, -3, ...).
 */
export function keyForName(name: string, existingKeys: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
  if (!existingKeys.includes(base)) return base;
  let n = 2;
  while (existingKeys.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Create a tag by display name and return its key.
 *
 * Thunderbird's `messages.tags.create(key, tag, color)` requires a STRING key
 * (passing null is rejected by schema validation) and a hex color; the impl
 * lowercases the key and stores tag->key. We derive a key from the name so the
 * call always validates.
 */
export async function createTag(name: string, existingKeys: string[]): Promise<string> {
  const key = keyForName(name, existingKeys);
  return browser.messages.tags.create(key, name, "#888888");
}

/**
 * Resolve requested tag names or keys to existing keys. Matches case-
 * insensitively against both the key and the display name. Duplicate results
 * are de-duplicated; order follows the requested order.
 */
export function resolveTagKeys(all: TagRef[], requested: string[]): ResolvedTags {
  const keys: string[] = [];
  const unknown: string[] = [];
  for (const r of requested) {
    const match = all.find(
      (t) => t.key.toLowerCase() === r.toLowerCase() || t.name.toLowerCase() === r.toLowerCase(),
    );
    if (match) {
      if (!keys.includes(match.key)) keys.push(match.key);
    } else {
      unknown.push(r);
    }
  }
  return { keys, unknown };
}
