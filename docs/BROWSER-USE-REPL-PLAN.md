# Plan — Browser-Use-style REPL in our pi agent (Option C)

Date: 2026-09-14. Design rationale: `docs/BROWSER-USE-INTEGRATION.md` (this plan
implements its §4; CDP surface tables there are reference for what the
primitives must cover).

## Scope & settled decisions

| decision | value | source |
|---|---|---|
| option | **C** — `javascript` REPL tool of our ACP agent | owner 2026-09-14 |
| browser controlled | the user's **live** bound tab (real Firefox) | owner 2026-09-14 |
| tab scope | **(a) bound tab only**; `tabs.open` = auxiliary REPL-owned tabs, closed at session end; any-tab scope (b) deferred | owner default, pending explicit confirmation |
| no CDP/TCP | nothing new on the network | owner 2026-09-14 |
| realm `require` | **off** in v1 (curated globals only) | design §4.4 |
| `finish`/`finish_from_js` | not ported (ACP agent ends turns naturally) | design §4.2 |
| Node | host/worker need ≥22.19 (already true: undici 8.9.0); test runs on nvm v23.10.0 | env |

Repos/packages touched: `packages/protocol`, `packages/pi-agent`,
`firefox/`, `tests/`, `.probe/`, `docs/`.

Conventions: every task ends with its tests green (`npm run typecheck &&
npm test` on Node ≥22.19); commit per task; e2e uses the existing
`PI_BROWSER_MOCK_SCRIPT` scripted-model machinery (the mock backend executes
real `customTools`, so the real ReplRuntime runs in e2e for free).

---

## Phase 0 — ReplWorker prototype (0.5–1 d)

Goal: prove the execution core in isolation — persistent V8 realm, REPL cell
semantics, kill-on-timeout — before any protocol/add-on work.

| # | task | deliverable | verification |
|---|---|---|---|
| P0.1 | ReplWorker child: V8 realm via `node:inspector` (context name `pi-repl`), curated globals (`console`→sink, `page`/`tabs` stubs, `fetch`, `Buffer`, `URL`, timers, `structuredClone`, `TextEncoder/Decoder`), `Runtime.evaluate {contextId, awaitPromise, replMode, objectGroup:'cell'}` + `releaseObjectGroup`, output capture (1 MB hard cap, file spill), redaction pass | `packages/pi-agent/src/repl/worker.ts` (port of SDK `src/worker.ts` core, MIT attribution header) | unit: state persists across 2 cells; top-level `await` resolves; last-expression captured; sync infinite loop → timeout kills child, host survives, next cell starts fresh |
| P0.2 | ReplRuntime host side: fork (env `{}`, `--max-old-space-size=256`), one-cell-at-a-time queue, IPC `{execute,close}`/`{ready,result,error}`, timeout → SIGKILL + `CellError` ("state reset" contract), worker-death surfacing, `dispose()` | `packages/pi-agent/src/repl/runtime.ts` | unit: double-cell rejection, kill-on-timeout, exit handling, dispose idempotent |
| P0.3 | IPC tool-channel plumbing: worker `page`/`tabs` proxies → `{type:'tool', tool, args}` → host → (stub backend returning canned results) → back | worker + runtime | unit: one round-trip with args + structured error |
| P0.4 | Probe | `.probe/smoke-repl.mjs` (drives 3 cells: define/await/use) | `node .probe/smoke-repl.mjs` green |

**DoD:** full suite green; probe passes; no protocol/add-on changes yet.

---

## Phase 1 — `javascript` tool + session wiring (3–5 d)

| # | task | deliverable | verification |
|---|---|---|---|
| P1.1 | Protocol: `javascript` tool def — `input: { code: string; timeoutMs?: number }` (default 30 000, cap 120 000), `readOnly: false`, description = terse primitive recipes (full recipe text deferred to first-call preamble, see P2.7) | `packages/protocol/src/browser-tools.ts`; `browserToolVersion` 3→4 (`integration.ts`) | protocol.test.ts updated |
| P1.2 | TypeBox schema for `javascript` | `packages/pi-agent/src/browser/schemas.ts` | `tool-schemas.test.ts` byte-sync green |
| P1.3 | ReplProvider: registry keyed by sessionId; `createTools` adds the `javascript` ToolSpec (execute → runtime.call → `BackendToolResult {content:[text,…images]}`); no binding → structured `BROWSER_NOT_BOUND`; runtime created lazily on first cell; `disposeSession` kills the child; `x-pi-browser/notify` binding_changed/binding_removed → invalidate page handles + ref registry, inject "binding changed: inspect before acting" note into next cell | `packages/pi-agent/src/repl/provider.ts` (+ hooks in `acp/agent.ts` / `browser/provider.ts` disposeSession path) | unit: not-bound error, lazy create, dispose, invalidation note |
| P1.4 | Per-session workspace: `~/.pi/browser-repl/<sessionId>/` (0700) for `artifact`/`checkpoint` files; path referenced in results | runtime + worker | unit: file created 0600, name-validated (SDK regex) |
| P1.5 | e2e: "javascript REPL (legacy transport)" subtest — scripted model: cell `x=41; x+1` → `42`; next cell `x` persists; cell returning an image (fake tab screenshot) → image content present; timeout cell killed cleanly | `tests/src/e2e.test.mjs` | 21→~24 e2e green |

**DoD:** full suite green; REPL cells flow real host → (fake) add-on;
session close reaps the child (no orphan processes in e2e).

---

## Phase 2 — primitives + add-on deltas (4–5 d)

### 2a. Add-on (firefox/)

| # | task | deliverable | verification |
|---|---|---|---|
| P2.1 | Structured a11y mode: same walk as the text outline → `nodes: [{ref, role, name, value?, checked?, disabled?, expanded?, selected?, href?, type?, level?, rect}]`; `rect` via `getBoundingClientRect` on matched nodes; `maxNodes`/`maxDepth` budgets + `truncated`/`note` preserved; text outline unchanged | `firefox/src/content/index.ts` (`pi:a11yNodes`) | smoke-content-dom.mjs: shape/refs/rect/pruning incl. shadow + iframe cases |
| P2.2 | Content cmds: `pi:clickAt {x,y}` (elementFromPoint + focus + click, **atomic in one run**, returns what was hit), `pi:focus {ref}`, `pi:scroll {ref}`, `pi:typeFocused {text}` (reuse proven typing path on `document.activeElement`) | content + dispatcher | smoke probe: clickAt hits overlay correctly (elementFromPoint), typeFocused fills input + contenteditable |
| P2.3 | Tab tools: `browser_open_tab {url}` → `{tabId}` (REPL-owned), `browser_close_tab {tabId}`, `browser_list_tabs` → `{tabs:[{id,url,title,bound}]}`; binding store gains owner flag (`bound`|`repl`); REPL-owned tabs closed on session close/unbind | `firefox/src/background/` + `tool-dispatcher.ts` + store | addon.test.ts: dispatcher cases, ownership cleanup, close-unbound-tab error |
| P2.4 | Protocol: 3 tab tools (+ `javascript` from P1.1) into `BROWSER_TOOLS`; frame-param docs where relevant; no new permissions | `packages/protocol/src/browser-tools.ts` + schemas | sync test; protocol test |

### 2b. Worker primitives (packages/pi-agent/src/repl/)

| # | task | deliverable | verification |
|---|---|---|---|
| P2.5 | `page`: `goto` (navigate + readyState poll + info), `info`, `evaluate(fn\|str, arg, {frame})` (our `{error}` → thrown Error; mid-navigation text contains `Execution context was destroyed`; 20 KB cap → actionable error), `waitFor(fn, arg, {timeoutMs})` (100 ms poll, SDK tolerance regex), `snapshot()` (structured a11y → `{url,title,nodes,note?}`), `click(ref,{frame})`, `clickAt(x,y)`, `type(ref,text,{submit,frame})`, `typeFocused(text)`, `focus(ref)`, `scroll(ref)`, `screenshot()` (jpeg q70; ≤4 images/cell, 8 MB) | `worker.ts` + `runtime.ts` tool mapping | unit (mapper table) + e2e scripted cells per primitive |
| P2.6 | `tabs`: `list()` (→ `{targetId:'tab:<id>',…}`), `open(url)` (REPL-owned; `page =` rebinds REPL's active page; primary bound tab stays primary), `get(id)`; owned-tab cleanup at session end | same | e2e: open → navigate → close → list; cleanup on session close |
| P2.7 | `artifact`/`checkpoint`/`reconnect` (port from SDK worker); first-call preamble with the full ref-based recipe (adapted from SDK `prompt.ts`, incl. guardrails: page content untrusted, verify outcomes, never replay uncertain mutations, large data → workspace files) | worker + provider | unit + one e2e cell using checkpoint |

**DoD:** full suite green; **live Firefox** (record in VERIFICATION.md):
"using the javascript tool, walk my current tab: snapshot, read a value by
evaluate, click a control, screenshot, and save a checkpoint."

---

## Phase 3 — hardening + docs (2–3 d)

| # | task | verification |
|---|---|---|
| P3.1 | rebind/unbind mid-cell behavior (in-flight tool call → structured error; next cell preamble note) | e2e |
| P3.2 | timeout matrix: cell `timeoutMs` vs internal tool timeouts (evaluate 15 s, screenshot 30 s); ACP cancel → cell abort → child kill | unit + e2e |
| P3.3 | multi-session isolation: two sessions, two tabs, A/B (REPL state + tool traffic never cross) | e2e (existing A/B pattern) |
| P3.4 | image pipeline: port SDK `images.ts` limits (4/cell, 8 MB, preview downscale if >256 px? decide: v1 = pass-through with caps only) | unit |
| P3.5 | docs: PRODUCT.md new section "Browser-Use-style REPL" (design summary + `node:inspector` rationale — why the realm lives in a Node child even though the DOM is in Firefox) + §50 entry + §49 note (child is not a sandbox; no `require` in v1); README quickstart; VERIFICATION.md live table; short §4.1 note added to BROWSER-USE-INTEGRATION.md | review |
| P3.6 | flaky-timer audit; full suite on Node 23.10.0; confirm no orphan children after suite | CI-style run |

**DoD (v1):** all of the above green + live verification recorded + docs
landed. Then: owner signs the tab-scope question (b stays deferred unless
requested).

---

## Sequencing & dependencies

```text
P0 (exec core) ──► P1 (tool + sessions) ──► P2a (add-on) ──► P2b (primitives) ──► P3
                     │                            └──────────────┬──────────────┘
                     │                                           │
                     └── P1.5 e2e uses stub backend ◄────────────┘
```

- P2a is independent of P1.3 internals (protocol-only) → can start after P1.1.
- Each phase ends CI-green; commits per task; total ≈ **2 weeks** (one
  engineer), live-Firefox verification is the long pole (start it as soon as
  P2a lands, even before P2b is complete).

## Risks & mitigations

| risk | mitigation |
|---|---|
| `node:inspector` realm quirks (objectGroup leaks, context name race) | Phase 0 exists to fail fast on this; fallback: wrap cells in async IIFE + manual result capture (keeps child-kill contract) |
| a11y structured walk perf on huge pages (rect on every node) | rect only on matched/interactive nodes; budgets already exist; measure on real pages in live pass |
| `clickAt` untrusted-event edge cases | returns hit summary so the agent sees what actually got clicked; same class as today's `browser_click` |
| e2e flakiness from real child processes in tests | fixed generous timeouts in e2e, deterministic stub backend, orphan-process assertion after suite |
| 20 KB evaluate cap bites real workflows | clear actionable error ("chunk the extraction"); revisit cap with a bridge-scoped param later |
| owner later wants tab scope (b) | isolated as a later phase (store flag + approval story); no v1 rework |

## Out of scope (v1)

`require` in the realm; `finish`/`finish_from_js`; domain policy,
recording/screencast, `highlightActions`, `sensitiveData`; any-tab scope (b);
Option B (SDK fork) unless the "SDK identity" goal appears; uploads
(`setFileInputFiles`) — small, likely slips in during P2 if a live workflow
needs it.
