/**
 * Packaged, versioned page adapters (skills-runtime-design.md §6).
 *
 * An adapter declares how ONE site expresses a comment composer: composer
 * and submit selectors, the optional keyboard submit gesture, the bounded
 * capture fields, and the adapter-owned chain ID the submission gate uses
 * for gesture deduplication. Declarative selector data only — no page
 * code, no arbitrary downloaded handlers. The page runtime resolves a
 * semantic target from the bounded event path; it never scans the whole
 * document.
 *
 * Only adapters with OBSERVED, tested coverage belong in the built-in
 * catalog. A generic adapter may provide advisory observations without
 * claiming reliable interruption.
 */

export interface PageAdapter {
  /** Versioned adapter identity (matches SkillPlanRule.adapterId). */
  adapterId: string;
  /** Selector set: the active composer (textarea / input / contenteditable). */
  composer: string[];
  /** Selector set: the submit control (the click chain). */
  submit: string[];
  /** Keyboard submit gesture, when the site supports one. */
  submitKey?: { key: string; modifiers: Array<"ctrl" | "meta" | "alt" | "shift"> };
  /**
   * Adapter-owned ID for the tested click/keyboard-to-submit chain.
   * Never page-supplied (gate contract).
   */
  chainId: string;
  /** Bounded capture. */
  capture: {
    /** Drafts above this are truncated for the bounded identity. */
    maxDraftChars: number;
    /** Selector set for the reply target (bounded text). */
    replyTarget?: string[];
  };
}

/**
 * Built-in adapter catalog (V1).
 *
 * "fixture/*" adapters are the controlled test fixtures from delivery
 * step 2 (tests/fixtures/skills/): plain comment pages (textarea + named
 * target + submit button) used by the E2E scenarios. They claim no
 * real-site coverage. Real-site adapters join only with observed, tested
 * coverage (design §6: "Only adapters with observed, tested coverage may
 * appear here").
 */
export const BUILTIN_ADAPTERS: Record<string, PageAdapter> = {
  "fixture/comment-page": {
    adapterId: "fixture/comment-page",
    composer: ["textarea[data-skill-fixture]"],
    submit: ["button[data-skill-fixture=submit]"],
    chainId: "fixture-comment-submit",
    capture: {
      maxDraftChars: 262_144,
      replyTarget: ["[data-skill-fixture=target]"],
    },
  },
  "fixture/keyboard-page": {
    adapterId: "fixture/keyboard-page",
    composer: ["textarea[data-skill-fixture=composer]"],
    submit: ["button[data-skill-fixture=submit]"],
    // Enter with NO modifiers is the tested submit gesture; modifier+
    // Enter must not enter the chain (page-runtime checks exactness).
    submitKey: { key: "Enter", modifiers: [] },
    chainId: "fixture-keyboard-submit",
    capture: {
      maxDraftChars: 262_144,
      replyTarget: ["[data-skill-fixture=target]"],
    },
  },
  "fixture/contenteditable-page": {
    adapterId: "fixture/contenteditable-page",
    composer: ["div[data-skill-fixture=composer][contenteditable]"],
    submit: ["button[data-skill-fixture=submit]"],
    chainId: "fixture-contenteditable-submit",
    capture: {
      maxDraftChars: 262_144,
      replyTarget: ["[data-skill-fixture=target]"],
    },
  },
};

/** Look up a packaged adapter by the plan's adapterId. */
export function adapterById(adapterId: string): PageAdapter | undefined {
  return BUILTIN_ADAPTERS[adapterId];
}
