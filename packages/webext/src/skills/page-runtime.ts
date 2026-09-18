/**
 * Page runtime — per-rule site-event interpreter (skills v2).
 *
 * One instance per armed plan RULE, started only when the background has a
 * compiled plan for this document (inactive pages attach nothing). A rule
 * carries its own site definition — `targets` (CSS selectors matched with
 * el.matches, or the JS dialect compiled at arm time; JS-dialect rules are
 * placed in the main world by the planner) and `events` (debounced
 * sequences and gates) — so there is no separate adapter catalog.
 *
 * It:
 * - observes the DOM types any rule matcher needs (capture phase, document
 *   level — the consult/hold must run BEFORE the page's own handlers);
 * - walks the bounded event path (target + ≤ 16 ancestors) and tests the
 *   rule's target predicates against it — never a whole-document scan;
 * - advances each event's sequence machine (order, identity, IME
 *   suspension); a debounced event fires after its pause and arms the
 *   background with a fresh bounded payload snapshot;
 * - on a gate event, the LAST matcher of a completed alternative IS the
 *   gesture: the synchronous consult happens inside the capture listener,
 *   and a held gesture is stopped with preventDefault AND
 *   stopImmediatePropagation so cooperative AND non-cooperative page
 *   handlers alike never see it;
 * - releases every held reference on stop() (removal, navigation, disable,
 *   teardown).
 *
 * Pure: no browser APIs, no DOM globals — the document is injected as an
 * event target, which keeps the policy testable in Node.
 */
import type { SkillEventDefinition, SkillDomMatcher, SkillPlanRule, SkillTarget } from "@pi-browser/protocol";
import type { GateView } from "./submission-gate.js";

/** Minimal event surface the interpreter reads (composedPath + key state). */
export interface SkillEventLike {
  composedPath?: () => EventTarget[];
  target?: Element;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
}

/** The document (or a scoped subtree) the interpreter delegates on. */
export interface PageRuntimeTarget {
  addEventListener(type: string, fn: (event: SkillEventLike) => void): void;
  removeEventListener(type: string, fn: (event: SkillEventLike) => void): void;
}

/** Timer handle: number in the browser, Node's Timeout under tests. */
export type ArmTimer = ReturnType<typeof setTimeout>;

export interface PageRuntimeArmInput {
  /** Qualified event identity `<packageId>:<local event name>`. */
  event: string;
  interactionId: string;
  contextRevision: number;
  draftRevision: number;
  /** Bounded payload snapshot (payload field name → bounded string). */
  snapshot: Record<string, string>;
}

export interface PageRuntimeOptions {
  /** The armed plan rule (carries targets/events definitions). */
  rule: SkillPlanRule;
  target: PageRuntimeTarget;
  /** Stable interaction id for this document (background-issued). */
  interactionId: string;
  /**
   * Arm the background for one fired event (fresh bounded snapshot).
   * Resolves when the background accepted the arm (gate view pushes come
   * back as setView calls).
   */
  arm: (input: PageRuntimeArmInput) => Promise<unknown>;
  /** Bookkeeping for an allowed gesture (the background gate enforces). */
  onGesture?: (event: string, chainId: string, phase: "click" | "keyboard") => void;
  /** One held gesture (content beacons it / the card reacts). */
  onHold?: (event: string, phase: "click" | "keyboard") => void;
  /**
   * Bounded document scan for payload fields with `resolve: "document"`
   * (the content script implements it with a node-budgeted walk). Only
   * invoked at event FIRE time, never per DOM event.
   */
  scan?: (targetName: string) => Element | undefined;
  onArm?: (state: "started" | "done" | "failed") => void;
  log?: (message: string) => void;
  /** Injectable timers (tests). */
  setTimeoutImpl?: (fn: () => void, ms: number) => ArmTimer;
  clearTimeoutImpl?: (id: ArmTimer) => void;
}

/** Bounded event path: the target plus at most this many ancestors. */
const MAX_PATH_ANCESTORS = 16;
/** Default bound for payload text fields (package payloads may override). */
const DEFAULT_FIELD_CHARS = 2_048;
const HARD_FIELD_CHARS = 262_144;

type TargetFn = (el: Element) => boolean;

/**
 * Compile one target selector. CSS dialect: el.matches, legal in both worlds,
 * no eval — invalid selectors are invalidated lazily (first SyntaxError) so
 * the constructor needs no document access. JS dialect: new Function, legal
 * ONLY in the main world; the content script passes JS targets exclusively
 * to main-world instances (an isolated-world compile fails safe: no coverage).
 * `text`/`maxTextLength` side-fields apply after the selector match.
 */
function compileTarget(name: string, target: SkillTarget, log: (m: string) => void): TargetFn | undefined {
  let base: TargetFn;
  if (target.kind === "css") {
    let invalid = false;
    base = (el) => {
      if (invalid) return false;
      try {
        return el.matches(target.selector);
      } catch (err) {
        // A SyntaxError means the selector string itself is invalid; other
        // throws (detached element quirks) must not kill the target.
        if (err instanceof SyntaxError) {
          invalid = true;
          log(`target ${name} has an invalid selector; no coverage from it`);
        }
        return false;
      }
    };
  } else {
    try {
      // eslint-disable-next-line no-new-func
      const probe = new Function("el", `return (${jsExpr(target.selector)});`) as (el: Element) => unknown;
      base = (el) => {
        try {
          return probe(el) === true;
        } catch {
          return false;
        }
      };
    } catch (err) {
      log(`target ${name} failed to compile; no coverage from it: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
  if (target.text === undefined && target.maxTextLength === undefined) return base;
  const re = target.text === undefined ? undefined : new RegExp(target.text, target.textFlags ?? "");
  return (el) => {
    if (!base(el)) return false;
    const textContent = el.textContent ?? "";
    if (target.maxTextLength !== undefined && textContent.length > target.maxTextLength) return false;
    if (re && !re.test(textContent.replace(/\s+/g, " ").trim())) return false;
    return true;
  };
}

/** Extract the expression after the `el =>` prefix (protocol-validated shape). */
function jsExpr(selector: string): string {
  const match = /^el\s*=>\s*([\s\S]*)$/.exec(selector);
  return match ? match[1] : "false";
}

function readField(el: Element, field: "value" | "text", max: number): string {
  const anyEl = el as Element & { value?: unknown };
  const raw = field === "value"
    ? (typeof anyEl.value === "string" ? anyEl.value : (el.textContent ?? ""))
    : (el.textContent ?? "");
  const text = field === "text" ? raw.replace(/\s+/g, " ").trim() : raw;
  return text.length > max ? text.slice(0, max) : text;
}

interface SequenceState {
  progress: number;
  matched: Map<string, Element>;
}

export class PageRuntime {
  readonly interactionId: string;
  /** The armed plan rule (content script routes views/actions through it). */
  readonly rule: SkillPlanRule;
  private readonly targets = new Map<string, TargetFn>();
  private readonly events: string[];
  private readonly listened = new Set<string>();
  private readonly debounce = new Map<string, SequenceState>();
  private readonly debounceTimers = new Map<string, ArmTimer>();
  private readonly gateAlts = new Map<string, SequenceState[]>();
  /** Target name → last matched element, persisted across fires (see lastElement). */
  private readonly lastMatched = new Map<string, Element>();
  private views = new Map<string, GateView>();
  private composing = false;
  private contextRevision = 0;
  private draftRevision = 0;
  private stopped = false;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ArmTimer;
  private readonly clearTimeoutImpl: (id: ArmTimer) => void;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: PageRuntimeOptions) {
    this.rule = opts.rule;
    this.interactionId = opts.interactionId;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((id) => clearTimeout(id));
    this.log = opts.log ?? (() => {});
    for (const [name, target] of Object.entries(opts.rule.targets)) {
      const fn = compileTarget(name, target, this.log);
      if (fn) this.targets.set(name, fn);
    }
    this.events = opts.rule.subscriptions.map((sub) => sub.event).filter((name) => opts.rule.events[name] !== undefined);
    for (const name of this.events) {
      const def = opts.rule.events[name];
      const matchers: SkillDomMatcher[] = def.kind === "debounced" ? (def.sequence ?? []) : def.alternatives?.flat() ?? [];
      for (const m of matchers) this.listened.add(m.dom);
    }
  }

  /** First armed gate event (local name) — the rule's review chain. */
  get gateEvent(): string | undefined {
    for (const name of this.events) {
      if (this.opts.rule.events[name]?.kind === "gate") return name;
    }
    return undefined;
  }

  /** The rule's chain id (gate event definitions own it). */
  get chainId(): string | undefined {
    const name = this.gateEvent;
    return name ? this.opts.rule.events[name]?.chainId : undefined;
  }

  /** Gate view mirror for the rule's gate event (card rendering). */
  get currentView(): GateView | undefined {
    const name = this.gateEvent;
    return name ? this.views.get(name) : undefined;
  }

  /** The compiled predicate for one target (content-side bounded scans use it). */
  targetTest(targetName: string): ((el: Element) => boolean) | undefined {
    return this.targets.get(targetName);
  }

  /** Last element seen matching a target (suggestion apply uses it).
   *  Persisted across event fires: the per-sequence `matched` maps are reset
   *  to empty when a debounced/gate instance fires, so by the time the user
   *  acts on a suggestion they are always empty — this map survives. */
  lastElement(targetName: string): Element | undefined {
    return this.lastMatched.get(targetName);
  }

  /** Attach delegated capture listeners (one per needed DOM type). */
  start(): void {
    if (this.stopped) return;
    const t = this.opts.target;
    for (const type of this.listened) t.addEventListener(type, this.onDom);
    t.addEventListener("compositionstart", this.onCompositionStart);
    t.addEventListener("compositionend", this.onCompositionEnd);
  }

  /** Detach everything and release held references. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) this.clearTimeoutImpl(timer);
    this.debounceTimers.clear();
    const t = this.opts.target;
    for (const type of this.listened) t.removeEventListener(type, this.onDom);
    t.removeEventListener("compositionstart", this.onCompositionStart);
    t.removeEventListener("compositionend", this.onCompositionEnd);
    this.debounce.clear();
    this.gateAlts.clear();
    this.lastMatched.clear();
    this.views.clear();
  }

  /** Gate-view push from the background (per gate event, every transition). */
  setView(event: string, view: GateView): void {
    if (!this.stopped) this.views.set(event, view);
  }

  // -------------------------------------------------------------------
  // Event interpretation
  // -------------------------------------------------------------------

  private pathOf(event: SkillEventLike): Element[] {
    const path: Element[] = [];
    if (event.composedPath) {
      try {
        for (const item of event.composedPath()) {
          if (path.length >= MAX_PATH_ANCESTORS) break;
          if (typeof Element !== "undefined" && item instanceof Element) path.push(item);
          else if (typeof item === "object" && item !== null && typeof (item as { matches?: unknown }).matches === "function") {
            path.push(item as Element);
          }
        }
      } catch {
        return [];
      }
    } else if (event.target) {
      path.push(event.target);
    }
    return path;
  }

  /** First path element the named target accepts. */
  private matchTarget(name: string, path: Element[]): Element | undefined {
    const fn = this.targets.get(name);
    if (!fn) return undefined;
    for (const el of path) {
      if (fn(el)) return el;
    }
    return undefined;
  }

  private matcherMatches(m: SkillDomMatcher, type: string, path: Element[], event: SkillEventLike): Element | undefined {
    if (m.dom !== type) return undefined;
    if (type === "keydown") {
      if (m.key !== undefined && event.key !== m.key) return undefined;
      const wants: Record<string, boolean> = {
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        alt: event.altKey === true,
        shift: event.shiftKey === true,
      };
      const declared = m.modifiers ?? [];
      const exact = declared.every((mod) => wants[mod] === true) &&
        (["ctrl", "meta", "alt", "shift"] as const).every((mod) => declared.includes(mod) ? true : wants[mod] === false);
      if (!exact) return undefined;
    }
    return this.matchTarget(m.target, path);
  }

  private readonly onDom = (event: SkillEventLike): void => {
    if (this.stopped) return;
    const type = String(event.constructor?.name === "Event" ? "" : ""); // no-op: type is read per listener below
    void type;
    const path = this.pathOf(event);
    if (path.length === 0) return;
    for (const name of this.events) {
      const def = this.opts.rule.events[name];
      if (def.kind === "debounced") this.stepDebounced(name, def, event, path);
      else this.stepGate(name, def, event, path);
    }
  };

  private stepDebounced(name: string, def: SkillEventDefinition, event: SkillEventLike, path: Element[]): void {
    const seq = def.sequence ?? [];
    if (seq.length === 0) return;
    if (this.composing && def.suspendDuringComposition !== false && this.typeOf(event) === "input") return;
    let state = this.debounce.get(name);
    if (!state) {
      state = { progress: 0, matched: new Map() };
      this.debounce.set(name, state);
    }
    // In the pause window: a further final-matcher input extends the quiet
    // period (debounce semantics: fire after the LAST input).
    if (state.progress >= seq.length) {
      const last = seq[seq.length - 1];
      const el = this.matcherMatches(last, this.typeOf(event), path, event);
      if (el) {
        state.matched.set(last.target, el);
        this.lastMatched.set(last.target, el);
        this.armDebouncePause(name, def);
      }
      return;
    }
    // Out-of-order: an early matcher re-opens the sequence.
    if (state.progress > 0) {
      const first = this.matcherMatches(seq[0], this.typeOf(event), path, event);
      if (first) {
        state = { progress: 1, matched: new Map([[seq[0].target, first]]) };
        this.lastMatched.set(seq[0].target, first);
        this.debounce.set(name, state);
        return;
      }
    }
    const m = seq[state.progress];
    const el = this.matcherMatches(m, this.typeOf(event), path, event);
    if (!el) return;
    state.matched.set(m.target, el);
    this.lastMatched.set(m.target, el);
    state.progress += 1;
    if (state.progress === seq.length) {
      // The draft changed: any previous clear is stale from this instant
      // (mirrors the gate's own dirty transition), so immediate submits
      // hold while the fresh arm round-trips.
      this.markGateDirty();
      this.armDebouncePause(name, def);
    }
  }

  private markGateDirty(): void {
    const gate = this.gateEvent;
    if (!gate) return;
    const view = this.views.get(gate);
    if (view && view.state !== "dirty" && view.state !== "closed") {
      this.views.set(gate, { ...view, state: "dirty" });
    }
  }

  private armDebouncePause(name: string, def: SkillEventDefinition): void {
    const existing = this.debounceTimers.get(name);
    if (existing !== undefined) this.clearTimeoutImpl(existing);
    this.debounceTimers.set(name, this.setTimeoutImpl(() => {
      this.debounceTimers.delete(name);
      this.fireDebounced(name, def);
    }, def.debounceMs ?? 0));
  }

  private fireDebounced(name: string, def: SkillEventDefinition): void {
    if (this.stopped) return;
    const state = this.debounce.get(name);
    if (!state) return;
    const snapshot = this.buildSnapshot(def, state.matched);
    if (!this.conditionsMet(name, snapshot)) return;
    // The fired instance is spent: the next match starts a fresh one.
    this.debounce.set(name, { progress: 0, matched: new Map() });
    this.submitEvent(name, snapshot);
  }

  private stepGate(name: string, def: SkillEventDefinition, event: SkillEventLike, path: Element[]): void {
    const alts = def.alternatives ?? [];
    if (alts.length === 0) return;
    let altsState = this.gateAlts.get(name);
    if (!altsState) {
      altsState = alts.map(() => ({ progress: 0, matched: new Map() }));
      this.gateAlts.set(name, altsState);
    }
    for (let i = 0; i < alts.length; i++) {
      const alt = alts[i];
      const state = altsState[i];
      if (state.progress > 0) {
        // A completed sequence is one-shot: it resets after the consult.
        if (state.progress === alt.length) continue;
        const first = this.matcherMatches(alt[0], this.typeOf(event), path, event);
        if (first) {
          altsState[i] = { progress: 1, matched: new Map([[alt[0].target, first]]) };
          this.lastMatched.set(alt[0].target, first);
          continue;
        }
      }
      if (state.progress >= alt.length) continue;
      const m = alt[state.progress];
      const el = this.matcherMatches(m, this.typeOf(event), path, event);
      if (!el) continue;
      state.matched.set(m.target, el);
      this.lastMatched.set(m.target, el);
      state.progress += 1;
      if (state.progress === alt.length) {
        // The LAST matcher IS the gesture: consult synchronously, then
        // reset the chain (one gesture per completed alternative).
        altsState[i] = { progress: 0, matched: new Map() };
        this.consultGesture(name, def, m.dom, event);
        return; // a held gesture stops propagation for ALL rules
      }
    }
  }

  /**
   * Synchronous gate consult for one completed gesture. "hold" stops the
   * event for the page (preventDefault for default actions +
   * stopImmediatePropagation for the page's own listeners — the
   * non-cooperative-handler case the fixtures verify).
   */
  private consultGesture(name: string, def: SkillEventDefinition, dom: string, event: SkillEventLike): void {
    if (dom !== "click" && dom !== "keydown") return; // v1: click/Enter chains only
    const phase = dom === "click" ? "click" : "keyboard";
    // Advisory — observe, never hold — when the grant's mode is advisory
    // OR the skill declared the gesture advisory (stopDefaultAction: false).
    if (this.opts.rule.mode === "advisory" || def.stopDefaultAction === false) {
      this.opts.onGesture?.(name, def.chainId ?? name, phase);
      return;
    }
    const view = this.views.get(name);
    if (view && (view.state === "clear" || view.state === "authorized")) {
      this.opts.onGesture?.(name, def.chainId ?? name, phase);
      return;
    }
    // Not armed yet, the draft changed after the last review, or a
    // suggestion is pending: arm now (from the elements already matched)
    // and hold this gesture. The card tells the user what is happening.
    this.opts.onHold?.(name, phase);
    if (!view || view.state === "dirty") this.gestureArm(name);
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  /**
   * A gesture arrived before a view exists (or the draft went dirty): arm
   * from the elements we have already matched (no DOM scan) and hold this
   * gesture. If nothing has been typed, the snapshot is empty — the next
   * input re-arms with the real draft.
   */
  private gestureArm(name: string): void {
    const def = this.opts.rule.events[name];
    const matched = new Map<string, Element>();
    const states = [...this.debounce.values(), ...[...this.gateAlts.values()].flat()];
    for (const targetName of this.targets.keys()) {
      for (const state of states) {
        const el = state.matched.get(targetName);
        if (el) {
          matched.set(targetName, el);
          break;
        }
      }
    }
    const snapshot = this.buildSnapshot(def, matched);
    this.submitEvent(name, snapshot);
  }

  // -------------------------------------------------------------------
  // Payload + arming
  // -------------------------------------------------------------------

  private buildSnapshot(def: SkillEventDefinition, matched: Map<string, Element>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [field, spec] of Object.entries(def.payload ?? {})) {
      // `resolve: "document"` fields resolve at FIRE time with a bounded
      // document scan (the content script budgets it); everything else
      // resolves against the elements the sequence matched.
      const el = spec.resolve === "document"
        ? (this.opts.scan ? this.opts.scan(spec.from) : undefined)
        : matched.get(spec.from);
      const max = Math.min(spec.maxChars ?? DEFAULT_FIELD_CHARS, HARD_FIELD_CHARS);
      out[field] = el ? readField(el, spec.field, max) : "";
    }
    return out;
  }

  private conditionsMet(name: string, snapshot: Record<string, string>): boolean {
    const sub = this.opts.rule.subscriptions.find((s) => s.event === name);
    const min = sub?.conditions?.minCharacters;
    if (min === undefined) return true;
    const draft = snapshot.draft ?? Object.values(snapshot).join("");
    return draft.trim().length >= min;
  }

  private submitEvent(name: string, snapshot: Record<string, string>): void {
    if (this.stopped) return;
    this.contextRevision += 1;
    this.draftRevision += 1;
    this.opts.onArm?.("started");
    void this.opts.arm({
      event: `${this.opts.rule.packageId}:${name}`,
      interactionId: this.interactionId,
      contextRevision: this.contextRevision,
      draftRevision: this.draftRevision,
      snapshot,
    }).then(
      () => { if (!this.stopped) this.opts.onArm?.("done"); },
      (err: unknown) => {
        // Arm failure must NOT weaken protection: the gate keeps its last
        // trusted view (or holds when there is none).
        this.log(`arm failed for ${this.opts.rule.packageId}:${name}: ${err instanceof Error ? err.message : String(err)}`);
        if (!this.stopped) this.opts.onArm?.("failed");
      },
    );
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private typeOf(event: SkillEventLike): string {
    // Duck-typed: real DOM events have a type; Node fakes carry one too.
    const type = (event as unknown as { type?: unknown }).type;
    return typeof type === "string" ? type : "";
  }

  private isInputEvent(event: SkillEventLike, seq: SkillDomMatcher[]): boolean {
    return seq.some((m) => m.dom === "input") && this.typeOf(event) === "input";
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: SkillEventLike): void => {
    this.composing = false;
    if (this.stopped) return;
    // Several browser/IME orderings commit the text WITHOUT a trailing
    // input (compositionstart → input(preedit) → compositionend). The
    // preedit input was suspended, so step the debounced sequences again
    // with a synthetic final input on the composition's path — the review
    // must see the FINAL draft (design §6), and the card must be able to
    // arm before the first submit.
    const path = this.pathOf(event);
    if (path.length === 0) return;
    for (const name of this.events) {
      const def = this.opts.rule.events[name];
      if (def.kind !== "debounced") continue;
      this.stepDebounced(name, def, { type: "input" } as SkillEventLike, path);
    }
  };
}
