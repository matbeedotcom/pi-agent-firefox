import test from "node:test";
import assert from "node:assert/strict";

import { PageRuntime, type ArmTimer, type PageRuntimeTarget, type SkillEventLike } from "../src/skills/page-runtime.js";
import type { SkillPlanRule } from "@trusted-ua/protocol";
import type { GateView, GateState } from "../src/skills/submission-gate.js";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

type El = Element & { value?: string; textContent?: string | null };

interface FakeElOpts {
  /** Single selector this element matches (compared after comma-split). */
  matches?: string[];
  value?: string;
  textContent?: string;
}

function makeEl(opts: FakeElOpts = {}): El {
  const single = opts.matches ?? [];
  return {
    matches(sel: string): boolean {
      // Mirror the browser: a selector the DOM parser rejects throws a
      // SyntaxError (the fake reserves the exact string "div[" for that).
      if (sel === "div[") throw new SyntaxError("Invalid selector");
      return sel.split(",").some((s) => single.includes(s.trim()));
    },
    value: opts.value,
    textContent: opts.textContent,
  } as unknown as El;
}

class FakeTarget implements PageRuntimeTarget {
  private listeners = new Map<string, Set<(e: SkillEventLike) => void>>();

  addEventListener(type: string, fn: (e: SkillEventLike) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: SkillEventLike) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type: string, event: SkillEventLike): void {
    // Real DOM events carry their own `type`; stamp it like the platform.
    const stamped = { ...event, type };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(stamped);
  }

  total(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

function makeEvent(opts: {
  path?: Element[];
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): SkillEventLike & { prevented: boolean; stopped: boolean } {
  const event: SkillEventLike & { prevented: boolean; stopped: boolean } = {
    prevented: false,
    stopped: false,
    target: opts.path?.[0],
    composedPath: () => opts.path ?? [],
    key: opts.key,
    ctrlKey: opts.ctrlKey,
    metaKey: opts.metaKey,
    altKey: opts.altKey,
    shiftKey: opts.shiftKey,
    preventDefault: () => {
      event.prevented = true;
    },
    stopImmediatePropagation: () => {
      event.stopped = true;
    },
  };
  return event;
}

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

const PACKAGE_ID = "fixture-reply";

function makeRule(overrides?: {
  mode?: "advisory" | "review-before-submit";
  keyboard?: boolean;
  multiSequence?: boolean;
  /** Skill-declared advisory gesture: stopDefaultAction: false on the gate. */
  advisoryGesture?: boolean;
}): SkillPlanRule {
  // Plan rules carry the NORMALIZED target form (parseSkillPackage accepts
  // bare CSS strings and upgrades them to { selector, kind } at load).
  const targets: SkillPlanRule["targets"] = {
    // CSS dialect: el.matches in the runtime's world; the fake's exact-match
    // `matches` stands in for the browser (comma groups resolve identically).
    composer: { selector: "textarea[data-skill-fixture]", kind: "css" },
    submit: { selector: "button[data-skill-fixture=submit]", kind: "css" },
    targetEl: { selector: "[data-skill-fixture=target]", kind: "css" },
  };
  if (overrides?.multiSequence) {
    // x -> y -> z: focus-ish input on composer, then a second input, then
    // the final input (all on the composer; order is what is tested).
    targets.other = { selector: "div[data-skill-fixture=other]", kind: "css" };
  }
  const events: SkillPlanRule["events"] = {
    "draft.paused": {
      kind: "debounced",
      debounceMs: 250,
      suspendDuringComposition: true,
      sequence: overrides?.multiSequence
        ? [
            { dom: "input", target: "other" },
            { dom: "input", target: "composer" },
          ]
        : [{ dom: "input", target: "composer" }],
      payload: {
        draft: { from: "composer", field: "value", maxChars: 32 },
        replyTarget: { from: "targetEl", field: "text", resolve: "document" },
      },
    },
    "before-submit": {
      kind: "gate",
      ...(overrides?.advisoryGesture ? { stopDefaultAction: false } : {}),
      chainId: "fixture-comment-submit",
      alternatives: [
        [{ dom: "click", target: "submit" }],
        ...(overrides?.keyboard ? [[{ dom: "keydown" as const, target: "composer", key: "Enter", modifiers: [] }]] : []),
      ],
      payload: {
        draft: { from: "composer", field: "value", maxChars: 32 },
        replyTarget: { from: "targetEl", field: "text", resolve: "document" },
      },
    },
  };
  return {
    skillKey: `${PACKAGE_ID}/reply`,
    skillRevision: "rev-1",
    packageId: PACKAGE_ID,
    world: "isolated",
    targets,
    events,
    subscriptions: [{ event: "draft.paused", conditions: { minCharacters: 1 } }, { event: "before-submit" }],
    mode: overrides?.mode ?? "review-before-submit",
    capabilities: ["context.read"],
  };
}

interface Harness {
  target: FakeTarget;
  runtime: PageRuntime;
  arms: Array<{ event: string; contextRevision: number; snapshot: Record<string, string> }>;
  setArmedView(view: GateView | undefined, error?: Error): void;
  flushTimers(): void;
}

function makeHarness(ruleOverrides?: {
  mode?: "advisory" | "review-before-submit";
  keyboard?: boolean;
  multiSequence?: boolean;
  advisoryGesture?: boolean;
  scannedTargetEl?: El;
}): Harness {
  const rule = makeRule(ruleOverrides);
  const target = new FakeTarget();
  const arms: Harness["arms"] = [];
  let pendingView: GateView | undefined;
  let armReject: Error | undefined;
  const clock = { at: 0 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  const handleToId = new Map<ArmTimer, number>();
  let nextId = 1;

  const runtime = new PageRuntime({
    rule,
    target,
    interactionId: "int-1",
    arm: (input) => {
      arms.push(input);
      if (armReject) return Promise.reject(armReject);
      return Promise.resolve(pendingView);
    },
    // Bounded document scan fake: returns the fixture target element.
    scan: (targetName: string) =>
      targetName === "targetEl" ? (ruleOverrides?.scannedTargetEl ?? makeEl({ textContent: "  Reply   to  Alice " })) : undefined,
    setTimeoutImpl: (fn, ms) => {
      const id = nextId++;
      const handle = id as unknown as ArmTimer; // opaque handle for the runtime
      handleToId.set(handle, id);
      timers.set(id, { at: clock.at + ms, fn });
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      const id = handleToId.get(handle);
      const t = id !== undefined ? timers.get(id) : undefined;
      if (t) t.at = -1;
    },
    log: () => {},
  });
  runtime.start();

  return {
    target,
    runtime,
    arms,
    setArmedView(view, error) {
      pendingView = view;
      armReject = error;
    },
    flushTimers() {
      let guard = 0;
      for (;;) {
        let min = Infinity;
        for (const t of timers.values()) if (t.at >= 0 && t.at < min) min = t.at;
        if (min === Infinity) return;
        if (min > clock.at) clock.at = min;
        let fired = false;
        for (const [id, t] of [...timers]) {
          if (t.at === min) {
            timers.delete(id);
            fired = true;
            t.fn();
          }
        }
        if (!fired) return;
        if (++guard > 1000) throw new Error("timer loop guard");
      }
    },
  };
}

function composerEl(opts: FakeElOpts = {}): El {
  return makeEl({ matches: ["textarea[data-skill-fixture]"], ...opts });
}
function submitEl(): Element {
  return makeEl({ matches: ["button[data-skill-fixture=submit]"] });
}
const GATE = "before-submit";
const view = (state: GateState): GateView => ({ state, suggestions: [] });
// performArm() awaits the arm() promise: give its microtask a turn.
const tick = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test("page-runtime debounces arming to one arm with the final draft", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.setArmedView(view("clear"));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "one arm for rapid inputs");
  assert.equal(h.arms[0].event, `${PACKAGE_ID}:draft.paused`);
  assert.equal(h.arms[0].snapshot.draft, "hi");
  assert.equal(h.arms[0].contextRevision, 1);
  h.runtime.stop();
});

test("page-runtime holds unreviewed submits and allows after clear", async () => {
  const h = makeHarness();
  const e1 = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e1);
  assert.equal(e1.prevented, true, "unreviewed click is held");
  assert.equal(e1.stopped, true, "held gesture is stopped for non-cooperative handlers");
  h.runtime.setView(GATE, view("clear"));
  const e2 = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e2);
  assert.equal(e2.prevented, false, "reviewed clear click proceeds");
  h.runtime.stop();
});

test("page-runtime re-holds immediately when the draft changes after a clear", async () => {
  const h = makeHarness();
  const el = composerEl({ value: "hello" });
  h.runtime.setView(GATE, view("clear"));
  el.value = "hello edited";
  h.target.dispatch("input", makeEvent({ path: [el] }));
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, true, "edited draft re-holds without waiting for the arm round-trip");
  assert.equal(h.runtime.currentView?.state, "dirty");
  h.flushTimers();
  await tick();
  // The gesture arms the gate event; the pending debounce also fires.
  assert.equal(h.arms.length, 2, "gesture arm + debounce arm");
  assert.equal(h.arms[0].event, `${PACKAGE_ID}:before-submit`);
  assert.equal(h.arms[0].snapshot.draft, "hello edited", "gesture arm carries the edited draft");
  assert.equal(h.arms[1].event, `${PACKAGE_ID}:draft.paused`);
  h.runtime.stop();
});

test("page-runtime suspends arming during IME composition", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.target.dispatch("compositionstart", makeEvent({ path: [el] }));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  assert.equal(h.arms.length, 0, "no arm during IME composition");
  h.target.dispatch("compositionend", makeEvent({ path: [el] }));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "arm once after compositionend");
  assert.equal(h.arms[0].snapshot.draft, "hi");
  h.runtime.stop();
});

test("page-runtime stop() detaches listeners and releases references", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  h.runtime.stop();
  assert.equal(h.target.total(), 0, "all listeners detached");
  assert.equal(h.runtime.currentView, undefined, "held references released");
  const after = h.arms.length;
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, after, "stopped runtime does not arm");
});

test("page-runtime bounds the draft and normalizes the document-scanned target", () => {
  const h = makeHarness();
  const el = composerEl({ value: "x".repeat(1000) });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms[0].snapshot.draft.length, 32, "draft bounded to maxChars");
  assert.equal(h.arms[0].snapshot.replyTarget, "Reply to Alice", "reply target normalized + bounded");
  h.runtime.stop();
});

test("page-runtime skips drafts below minCharacters", () => {
  const h = makeHarness();
  const el = composerEl({ value: "   " });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 0, "empty draft does not arm");
  h.runtime.stop();
});

test("page-runtime advisory mode observes without blocking", () => {
  const h = makeHarness({ mode: "advisory" });
  const el = composerEl({ value: "hi" });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "advisory mode arms the review (no gate)");
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, false, "advisory mode never blocks");
  h.runtime.stop();
});

test("page-runtime keyboard chain requires the exact submit key", () => {
  const h = makeHarness({ keyboard: true });
  const el = composerEl({ value: "hi" });
  const e1 = makeEvent({ path: [el], key: "Enter" });
  h.target.dispatch("keydown", e1);
  assert.equal(e1.prevented, true, "unreviewed Enter is held");
  assert.equal(e1.stopped, true, "held Enter stops non-cooperative page handlers");
  h.runtime.setView(GATE, view("clear"));
  const e2 = makeEvent({ path: [el], key: "Enter", ctrlKey: true });
  h.target.dispatch("keydown", e2);
  assert.equal(e2.prevented, false, "Ctrl+Enter is not this rule's submit key");
  const e3 = makeEvent({ path: [el], key: "Enter" });
  h.target.dispatch("keydown", e3);
  assert.equal(e3.prevented, false, "reviewed clear Enter proceeds");
  h.runtime.stop();
});

test("page-runtime skill-declared advisory gesture observes without blocking", () => {
  // review-before-submit mode, but the skill marked the gesture advisory
  // (stopDefaultAction: false): the page's own action always proceeds.
  const h = makeHarness({ keyboard: true, advisoryGesture: true });
  const el = composerEl({ value: "hi" });
  const e1 = makeEvent({ path: [el], key: "Enter" });
  h.target.dispatch("keydown", e1);
  assert.equal(e1.prevented, false, "advisory gesture never blocks the default action");
  assert.equal(e1.stopped, false, "advisory gesture never stops page handlers");
  // The gesture is still recorded (onGesture), so the card flow stays informed.
  const e2 = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e2);
  assert.equal(e2.prevented, false, "click alternative is advisory too");
  h.runtime.stop();
});

test("page-runtime fails closed when arming rejects", async () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.setArmedView(undefined, new Error("boom"));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  await Promise.resolve(); // let the rejection settle
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, true, "arm failure keeps protection (fail closed)");
  h.runtime.stop();
});

test("page-runtime reviewing state holds without re-arming on repeated submits", () => {
  const h = makeHarness();
  h.runtime.setView(GATE, view("reviewing"));
  const a = makeEvent({ path: [submitEl()] });
  const b = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", a);
  h.target.dispatch("click", b);
  assert.equal(a.prevented, true, "reviewing holds");
  assert.equal(b.prevented, true, "reviewing holds");
  assert.equal(h.arms.length, 0, "repeated submits do not re-arm");
  h.runtime.stop();
});

test("page-runtime multi-matcher sequences fire in order and reset out-of-order", () => {
  const h = makeHarness({ multiSequence: true });
  const other = makeEl({ matches: ["div[data-skill-fixture=other]"], value: "o" });
  const el = composerEl({ value: "hi" });
  // Out of order: composer before other -> no fire, sequence restarts.
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 0, "out-of-order prefix does not fire");
  // In order: other -> composer, then the pause fires.
  h.target.dispatch("input", makeEvent({ path: [other] }));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "ordered sequence fires once");
  assert.equal(h.arms[0].snapshot.draft, "hi");
  h.runtime.stop();
});

test("page-runtime arms from matched elements when a gesture precedes any review", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  // An input that never completed its pause (stopped before the timer).
  h.target.dispatch("input", makeEvent({ path: [el] }));
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, true, "pre-arm gesture is held");
  assert.equal(h.arms.length, 1, "the hold arms the review from matched elements");
  assert.equal(h.arms[0].event, `${PACKAGE_ID}:before-submit`);
  assert.equal(h.arms[0].snapshot.draft, "hi");
  h.runtime.stop();
});

// ---------------------------------------------------------------------
// Dual-dialect targets: CSS (el.matches) + JS (el => ...) + side fields
// ---------------------------------------------------------------------

test("CSS dialect matches via el.matches and invalid selectors invalidate lazily", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "CSS-dialect target matched the element");
  const fn = h.runtime.targetTest("composer")!;
  assert.ok(fn(el));
  // A selector the fake cannot parse throws like a browser SyntaxError;
  // the target must invalidate itself once and stay dead, not throw.
  const rule = makeRule();
  rule.targets.composer = { selector: "div[", kind: "css" };
  const target = new FakeTarget();
  const logs: string[] = [];
  const runtime = new PageRuntime({
    rule, target, interactionId: "int-invalid",
    arm: () => Promise.resolve(undefined), log: (m) => logs.push(m),
  });
  runtime.start();
  assert.throws(() => (el as unknown as { matches(s: string): boolean }).matches("div["), SyntaxError);
  const fn2 = runtime.targetTest("composer")!;
  assert.equal(fn2(el), false, "invalid selector never matches");
  assert.equal(fn2(el), false, "and stays dead without repeating logs");
  assert.equal(logs.filter((m) => m.includes("invalid selector")).length, 1);
  runtime.stop();
});

test("JS dialect compiles the el => expression and evaluates per element", () => {
  const rule = makeRule();
  // The real-world migration shape: the exact predicate the old `test` form
  // wrapped, now a first-class JS-dialect selector.
  rule.targets.composer = { selector: "el => !!(el.matches && el.matches('textarea[data-skill-fixture]'))", kind: "js" };
  const target = new FakeTarget();
  const runtime = new PageRuntime({
    rule, target, interactionId: "int-js",
    arm: () => Promise.resolve(undefined), log: () => {},
  });
  runtime.start();
  const fn = runtime.targetTest("composer")!;
  assert.ok(fn(composerEl({ value: "hi" })), "JS predicate true for the composer");
  assert.ok(!fn(makeEl({ matches: ["button[x]"] })), "false for other elements");
  // A throwing predicate fails safe (no coverage loss beyond the element).
  // The JS dialect is an EXPRESSION (wrapped in return(...)), so a throw is
  // expressed with an IIFE, not a statement block.
  rule.targets.other = { selector: "el => ((() => { throw new Error('boom'); })())", kind: "js" };
  const runtime2 = new PageRuntime({
    rule, target, interactionId: "int-js2",
    arm: () => Promise.resolve(undefined), log: () => {},
  });
  runtime2.start();
  assert.equal(runtime2.targetTest("other")!(composerEl({ value: "x" })), false);
  runtime.stop();
  runtime2.stop();
});

test("text and maxTextLength side-fields filter after the selector match", () => {
  const rule = makeRule();
  // Targets compile in the constructor: both side-field targets are set BEFORE.
  rule.targets.submit = { selector: "button[data-skill-fixture=submit]", kind: "css", text: "^send$", textFlags: "i" };
  rule.targets.targetEl = { selector: "[data-skill-fixture=target]", kind: "css", maxTextLength: 3 };
  const target = new FakeTarget();
  const runtime = new PageRuntime({
    rule, target, interactionId: "int-text",
    arm: () => Promise.resolve(undefined), log: () => {},
  });
  runtime.start();
  const fn = runtime.targetTest("submit")!;
  assert.ok(fn(makeEl({ matches: ["button[data-skill-fixture=submit]"], textContent: "Send" })), "label regex (i flag) accepts 'Send'");
  assert.ok(!fn(makeEl({ matches: ["button[data-skill-fixture=submit]"], textContent: "Delete" })), "label regex rejects 'Delete'");
  const fn2 = runtime.targetTest("targetEl")!;
  assert.ok(fn2(makeEl({ matches: ["[data-skill-fixture=target]"], textContent: "abc" })), "within the length bound");
  assert.ok(!fn2(makeEl({ matches: ["[data-skill-fixture=target]"], textContent: "abcd" })), "over the length bound is rejected");
  runtime.stop();
});
