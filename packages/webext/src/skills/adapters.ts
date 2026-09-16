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
 * "fixture/comment-page" is the controlled test fixture from delivery
 * step 2 — a plain comment page (textarea + named target + submit button)
 * used by the test suites. It claims no real-site coverage.
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
};

/** Look up a packaged adapter by the plan's adapterId. */
export function adapterById(adapterId: string): PageAdapter | undefined {
  return BUILTIN_ADAPTERS[adapterId];
}
