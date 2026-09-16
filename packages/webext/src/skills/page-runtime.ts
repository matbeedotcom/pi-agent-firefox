/**
 * Page runtime — the content-script side of the skills submission gate
 * (skills-runtime-design.md §6, §8, §13 "browser-runtime").
 *
 * One instance per document, started only when the background has a
 * matching compiled plan (inactive pages attach nothing). It:
 * - tracks the ACTIVE composer (focus or first relevant input) — not
 *   every comment in the feed;
 * - arms the gate in the background on debounced draft changes, with a
 *   FRESH bounded draft + reply target (final gate validation never trusts
 *   input-event revisions alone);
 * - consults the local GateView mirror SYNCHRONOUSLY on the submit
 *   gesture (click chain / submit key) BEFORE the event proceeds — the
 *   caller preventDefaults on "hold";
 * - suspends arming during IME composition;
 * - releases every held reference on stop() (removal, navigation, disable,
 *   teardown).
 *
 * Pure: no browser APIs, no DOM globals — the document is injected as an
 * event target, which keeps the policy testable in Node.
 */
import type { PageAdapter } from "./adapters.js";
import type { GateView } from "./submission-gate.js";

/** Minimal event surface the runtime reads (composedPath + key state). */
export interface SkillEventLike {
  composedPath?: () => EventTarget[];
  target?: Element;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault?: () => void;
}

/** The document (or a scoped subtree) the runtime delegates on. */
export interface PageRuntimeTarget {
  addEventListener(type: string, fn: (event: SkillEventLike) => void): void;
  removeEventListener(type: string, fn: (event: SkillEventLike) => void): void;
  /** First element matching a selector, when a capture field needs one. */
  query?: (selector: string) => Element | null;
}

/** Timer handle: number in the browser, Node's Timeout under tests. */
export type ArmTimer = ReturnType<typeof setTimeout>;

export interface PageRuntimeOptions {
  adapter: PageAdapter;
  mode: "advisory" | "review-before-submit";
  target: PageRuntimeTarget;
  /** Stable interaction id for this composer session (background-issued). */
  interactionId: string;
  /**
   * Arm the background gate with a fresh bounded draft + target. Returns
   * the resulting gate view when the background includes it.
   */
  arm: (input: { draft: string; replyTarget: string; contextRevision: number }) => Promise<GateView | undefined>;
  /** Bookkeeping for an allowed gesture (the background gate enforces). */
  onGesture?: (phase: "click" | "keyboard") => void;
  onArm?: (state: "started" | "done" | "failed") => void;
  log?: (message: string) => void;
  /** Draft-change debounce before arming. */
  armDelayMs?: number;
  /** Injectable timers (tests). */
  setTimeoutImpl?: (fn: () => void, ms: number) => ArmTimer;
  clearTimeoutImpl?: (id: ArmTimer) => void;
}

/** Duck-typed bounded draft read (value for form fields, text for contenteditable). */
function readDraft(el: Element, max: number): string {
  const anyEl = el as Element & { value?: unknown; textContent?: string | null };
  const raw = typeof anyEl.value === "string" ? anyEl.value : (anyEl.textContent ?? "");
  return raw.length > max ? raw.slice(0, max) : raw;
}

const BOUNDED_TARGET_CHARS = 2048;

export class PageRuntime {
  readonly interactionId: string;
  private view: GateView | undefined;
  private activeComposer: Element | undefined;
  private composing = false;
  private armTimer: ArmTimer | undefined;
  private contextRevision = 0;
  private stopped = false;
  private readonly armDelayMs: number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ArmTimer;
  private readonly clearTimeoutImpl: (id: ArmTimer) => void;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: PageRuntimeOptions) {
    this.interactionId = opts.interactionId;
    this.armDelayMs = opts.armDelayMs ?? 600;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((id) => clearTimeout(id));
    this.log = opts.log ?? (() => {});
  }

  get currentView(): GateView | undefined {
    return this.view;
  }

  /** Attach delegated listeners (one per event type). */
  start(): void {
    if (this.stopped) return;
    const t = this.opts.target;
    t.addEventListener("focusin", this.onFocusIn);
    t.addEventListener("input", this.onInput);
    t.addEventListener("compositionstart", this.onCompositionStart);
    t.addEventListener("compositionend", this.onCompositionEnd);
    t.addEventListener("click", this.onClick);
    t.addEventListener("keydown", this.onKeyDown);
  }

  /** Detach everything and release held references. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.armTimer !== undefined) {
      this.clearTimeoutImpl(this.armTimer);
      this.armTimer = undefined;
    }
    const t = this.opts.target;
    t.removeEventListener("focusin", this.onFocusIn);
    t.removeEventListener("input", this.onInput);
    t.removeEventListener("compositionstart", this.onCompositionStart);
    t.removeEventListener("compositionend", this.onCompositionEnd);
    t.removeEventListener("click", this.onClick);
    t.removeEventListener("keydown", this.onKeyDown);
    this.activeComposer = undefined;
    this.view = undefined;
  }

  /** A gate-view push from the background (every transition). */
  setView(view: GateView): void {
    if (!this.stopped) this.view = view;
  }

  /**
   * Synchronous gate consult, called by the caller INSIDE the submit
   * listener before the event proceeds. "hold" → preventDefault + let the
   * card explain; "allow" → the background gate re-validates the chain.
   */
  consult(phase: "click" | "keyboard"): "allow" | "hold" {
    if (this.stopped) return "hold";
    if (this.opts.mode === "advisory") {
      this.opts.onGesture?.(phase);
      return "allow";
    }
    const view = this.view;
    if (view && (view.state === "clear" || view.state === "authorized")) {
      this.opts.onGesture?.(phase);
      return "allow";
    }
    // Not armed yet, or the draft changed after the last review: arm now
    // and hold this gesture. The card tells the user the review is coming.
    if (!view || view.state === "dirty") this.scheduleArm();
    return "hold";
  }

  // -------------------------------------------------------------------
  // Delegated listeners
  // -------------------------------------------------------------------

  private pathOf(event: SkillEventLike): Element[] {
    if (event.composedPath) {
      try {
        // composedPath() is EventTarget[] in real pages; keep only elements.
        // Duck-typed for Node test fakes (no DOM globals there).
        return Array.from(event.composedPath()).filter(
          (item): item is Element =>
            (typeof Element !== "undefined" && item instanceof Element) ||
            (typeof item === "object" && item !== null && typeof (item as { matches?: unknown }).matches === "function"),
        );
      } catch {
        return [];
      }
    }
    return event.target ? [event.target] : [];
  }

  private matchAny(selectors: readonly string[], path: Element[]): Element | undefined {
    const joined = selectors.join(",");
    for (const el of path) {
      const matches = (el as { matches?: (s: string) => boolean }).matches;
      if (typeof matches !== "function") continue;
      try {
        if (matches.call(el, joined)) return el;
      } catch {
        // Malformed selector set: this adapter declares no coverage.
      }
    }
    return undefined;
  }

  private readonly onFocusIn = (event: SkillEventLike): void => {
    const composer = this.matchAny(this.opts.adapter.composer, this.pathOf(event));
    if (composer) this.activeComposer = composer;
  };

  private readonly onInput = (event: SkillEventLike): void => {
    const composer = this.matchAny(this.opts.adapter.composer, this.pathOf(event));
    if (!composer) return;
    if (composer !== this.activeComposer) this.activeComposer = composer;
    if (this.composing) return; // IME: suspend speculative review
    if (this.opts.mode === "advisory") return; // observation only: no gate, no arm
    // The draft changed: any previous clear is stale from this instant on
    // (mirrors the gate's own dirty transition), so immediate submits hold.
    if (this.view && this.view.state !== "dirty") this.view = { ...this.view, state: "dirty" };
    this.scheduleArm();
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    // The composition's final text is already in the value: arm once.
    if (this.activeComposer) this.scheduleArm();
  };

  private readonly onClick = (event: SkillEventLike): void => {
    if (!this.matchAny(this.opts.adapter.submit, this.pathOf(event))) return;
    const verdict = this.consult("click");
    if (verdict === "hold" && event.preventDefault) event.preventDefault();
  };

  private readonly onKeyDown = (event: SkillEventLike): void => {
    const spec = this.opts.adapter.submitKey;
    if (!spec) return;
    if (!this.matchAny(this.opts.adapter.composer, this.pathOf(event))) return;
    if (event.key !== spec.key) return;
    const wants: Record<string, boolean> = {
      ctrl: event.ctrlKey === true,
      meta: event.metaKey === true,
      alt: event.altKey === true,
      shift: event.shiftKey === true,
    };
    const present = new Set(spec.modifiers);
    const exact = spec.modifiers.every((m) => wants[m] === true) &&
      (["ctrl", "meta", "alt", "shift"] as const).every((m) => (present.has(m) ? true : wants[m] === false));
    if (!exact) return;
    const verdict = this.consult("keyboard");
    if (verdict === "hold" && event.preventDefault) event.preventDefault();
  };

  // -------------------------------------------------------------------
  // Arming
  // -------------------------------------------------------------------

  private scheduleArm(): void {
    if (this.stopped) return;
    if (this.armTimer !== undefined) this.clearTimeoutImpl(this.armTimer);
    this.armTimer = this.setTimeoutImpl(() => {
      this.armTimer = undefined;
      void this.performArm();
    }, this.armDelayMs);
  }

  private readReplyTarget(): string {
    const selectors = this.opts.adapter.capture.replyTarget;
    if (!selectors || !this.opts.target.query) return "";
    const el = this.opts.target.query(selectors.join(","));
    if (!el) return "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.length > BOUNDED_TARGET_CHARS ? text.slice(0, BOUNDED_TARGET_CHARS) : text;
  }

  private async performArm(): Promise<void> {
    const composer = this.activeComposer;
    if (this.stopped || !composer || this.composing) return;
    const draft = readDraft(composer, this.opts.adapter.capture.maxDraftChars);
    if (!draft.trim()) return; // empty draft: nothing to review
    this.contextRevision++;
    this.opts.onArm?.("started");
    try {
      const view = await this.opts.arm({ draft, replyTarget: this.readReplyTarget(), contextRevision: this.contextRevision });
      if (view && !this.stopped) this.view = view;
      this.opts.onArm?.("done");
    } catch (err) {
      // Arm failure must NOT weaken protection: the next consult stays on
      // the last trusted view (or holds when there is none).
      this.log(`skills arm failed: ${err instanceof Error ? err.message : String(err)}`);
      this.opts.onArm?.("failed");
    }
  }
}
