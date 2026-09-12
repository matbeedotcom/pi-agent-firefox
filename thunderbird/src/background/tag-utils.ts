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
