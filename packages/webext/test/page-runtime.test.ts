import test from "node:test";
import assert from "node:assert/strict";

import { PageRuntime, type ArmTimer, type PageRuntimeTarget, type SkillEventLike } from "../src/skills/page-runtime.js";
import type { PageAdapter } from "../src/skills/adapters.js";
import type { GateView, GateState } from "../src/skills/submission-gate.js";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

type El = Element & { value?: string; textContent?: string | null };

interface FakeElOpts {
  /** Single selectors this element matches (compared after comma-split). */
  matches?: string[];
  value?: string;
  textContent?: string;
}

function makeEl(opts: FakeElOpts = {}): El {
  const single = opts.matches ?? [];
  return {
    matches(sel: string): boolean {
      return sel.split(",").some((s) => single.includes(s.trim()));
    },
    value: opts.value,
    textContent: opts.textContent,
  } as unknown as El;
}

class FakeTarget implements PageRuntimeTarget {
  private listeners = new Map<string, Set<(e: SkillEventLike) => void>>();
  queries: Record<string, Element | null> = {};

  addEventListener(type: string, fn: (e: SkillEventLike) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: SkillEventLike) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  query(selector: string): Element | null {
    return this.queries[selector] ?? null;
  }

  dispatch(type: string, event: SkillEventLike): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
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
}): SkillEventLike & { prevented: boolean } {
  const event: SkillEventLike & { prevented: boolean } = {
    prevented: false,
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
  };
  return event;
}

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

interface Harness {
  target: FakeTarget;
  runtime: PageRuntime;
  arms: Array<{ draft: string; replyTarget: string; contextRevision: number }>;
  setArmedView(view: GateView | undefined, error?: Error): void;
  flushTimers(): void;
}

function makeHarness(overrides?: {
  mode?: "advisory" | "review-before-submit";
  adapter?: PageAdapter;
}): Harness {
  const adapter: PageAdapter =
    overrides?.adapter ?? {
      adapterId: "fixture/comment-page",
      composer: ["textarea[data-skill-fixture]"],
      submit: ["button[data-skill-fixture=submit]"],
      chainId: "fixture-comment-submit",
      capture: { maxDraftChars: 32, replyTarget: ["[data-skill-fixture=target]"] },
    };
  const mode = overrides?.mode ?? "review-before-submit";
  const target = new FakeTarget();
  const arms: Harness["arms"] = [];
  let pendingView: GateView | undefined;
  let armReject: Error | undefined;
  const clock = { at: 0 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  const handleToId = new Map<ArmTimer, number>();
  let nextId = 1;

  const runtime = new PageRuntime({
    adapter,
    mode,
    target,
    interactionId: "int-1",
    armDelayMs: 500,
    arm: (input) => {
      arms.push(input);
      if (armReject) return Promise.reject(armReject);
      return Promise.resolve(pendingView);
    },
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
  assert.equal(h.arms[0].draft, "hi");
  assert.equal(h.arms[0].contextRevision, 1);
  h.runtime.stop();
});

test("page-runtime holds unreviewed submits and allows after clear", async () => {
  const h = makeHarness();
  const el = composerEl({ value: "hello" });
  h.setArmedView(view("clear"));
  const e1 = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e1);
  assert.equal(e1.prevented, true, "unreviewed click is held");
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  await tick();
  const e2 = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e2);
  assert.equal(e2.prevented, false, "reviewed clear click proceeds");
  h.runtime.stop();
});

test("page-runtime re-holds immediately when the draft changes after a clear", async () => {
  const h = makeHarness();
  const el = composerEl({ value: "hello" });
  h.setArmedView(view("clear"));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  await tick();
  assert.equal(h.runtime.currentView?.state, "clear");
  el.value = "hello edited";
  h.target.dispatch("input", makeEvent({ path: [el] }));
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, true, "edited draft re-holds without waiting for the arm round-trip");
  assert.equal(h.runtime.currentView?.state, "dirty");
  h.flushTimers();
  await tick();
  assert.equal(h.arms.length, 2, "re-arm fired with the edited draft");
  assert.equal(h.arms[1].draft, "hello edited");
  h.runtime.stop();
});

test("page-runtime suspends arming during IME composition", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.setArmedView(view("clear"));
  h.target.dispatch("compositionstart", makeEvent({ path: [el] }));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  assert.equal(h.arms.length, 0, "no arm during IME composition");
  h.target.dispatch("compositionend", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1, "arm once after compositionend");
  assert.equal(h.arms[0].draft, "hi");
  h.runtime.stop();
});

test("page-runtime stop() detaches listeners and releases references", () => {
  const h = makeHarness();
  const el = composerEl({ value: "hi" });
  h.setArmedView(view("clear"));
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

test("page-runtime bounds draft and normalizes the reply target", () => {
  const h = makeHarness();
  const el = composerEl({ value: "x".repeat(1000) });
  h.setArmedView(view("clear"));
  h.target.queries["[data-skill-fixture=target]"] = makeEl({ textContent: "  Reply   to  Alice " });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms[0].draft.length, 32, "draft bounded to maxDraftChars");
  assert.equal(h.arms[0].replyTarget, "Reply to Alice", "reply target normalized + bounded");
  h.runtime.stop();
});

test("page-runtime skips empty drafts", () => {
  const h = makeHarness();
  const el = composerEl({ value: "   " });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 0, "empty draft does not arm");
  h.runtime.stop();
});

test("page-runtime advisory mode observes without blocking or arming", () => {
  const h = makeHarness({ mode: "advisory" });
  const el = composerEl({ value: "hi" });
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 0, "advisory mode never arms the gate");
  const e = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", e);
  assert.equal(e.prevented, false, "advisory mode never blocks");
  h.runtime.stop();
});

test("page-runtime keyboard chain requires the exact submit key", async () => {
  const h = makeHarness({
    adapter: {
      adapterId: "fixture/kbd",
      composer: ["textarea[data-skill-fixture]"],
      submit: ["button[data-skill-fixture=submit]"],
      submitKey: { key: "Enter", modifiers: [] },
      chainId: "fixture-kbd",
      capture: { maxDraftChars: 32 },
    },
  });
  const el = composerEl({ value: "hi" });
  h.setArmedView(view("clear"));
  const e1 = makeEvent({ path: [el], key: "Enter" });
  h.target.dispatch("keydown", e1);
  assert.equal(e1.prevented, true, "unreviewed Enter is held");
  const e2 = makeEvent({ path: [el], key: "Enter", ctrlKey: true });
  h.target.dispatch("keydown", e2);
  assert.equal(e2.prevented, false, "Ctrl+Enter is not this adapter's submit key");
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  await tick();
  const e3 = makeEvent({ path: [el], key: "Enter" });
  h.target.dispatch("keydown", e3);
  assert.equal(e3.prevented, false, "reviewed Enter proceeds");
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
  const el = composerEl({ value: "hi" });
  h.setArmedView(view("reviewing"));
  h.target.dispatch("input", makeEvent({ path: [el] }));
  h.flushTimers();
  assert.equal(h.arms.length, 1);
  const a = makeEvent({ path: [submitEl()] });
  const b = makeEvent({ path: [submitEl()] });
  h.target.dispatch("click", a);
  h.target.dispatch("click", b);
  assert.equal(a.prevented, true, "reviewing holds");
  assert.equal(b.prevented, true, "reviewing holds");
  assert.equal(h.arms.length, 1, "repeated submits do not re-arm");
  h.runtime.stop();
});
