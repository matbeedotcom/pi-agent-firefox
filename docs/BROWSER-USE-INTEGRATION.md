# Browser Use Pi ↔ Pi Browser: research & design

Date: 2026-09-14. Status: research complete, not started.
Upstream: https://github.com/browser-use/browser-use-pi (package `@browser_use/pi` v0.1.0, MIT).
Research copy for this doc: `/tmp/browser-use-pi` (shallow clone; re-clone if gone).

Goal: run the `@browser_use/pi` agent (Pi model loop + persistent V8 JavaScript
REPL + browser primitives) so that its "browser" is **our** Firefox — controlled
through our add-on (browser tools, content scripts, bindings) and our native
host (the pi instance: ACP agent + tool transports). No Chrome, no Cloud.

---

## 1. How `@browser_use/pi` actually works

Read: `src/index.ts`, `src/browser.ts`, `src/cdp.ts`, `src/runtime.ts`,
`src/worker.ts`, `src/page.ts`, `src/prompt.ts`, `src/policy.ts`,
`src/highlight.ts`.

### 1.1 The browser seam is a CDP endpoint, nothing else

```text
BrowserUse.create(options)
  └─ openBrowser(options.browser)          # src/browser.ts:180
       ├─ kind:'cloud'    → Browser Use Cloud API → cdpUrl
       ├─ kind:'chromium' → spawn Chrome, read DevToolsActivePort → ws://…
       ├─ kind:'chrome'   → discover running Chrome's CDP → ws://…
       └─ {cdpUrl}        → use as-is (ws/wss/http/https)
       → { endpoint: string, close(): Promise<void> }
```

`Browser.cloud / .chromium / .chrome` are **data factories** (they return a
plain `BrowserOptions` object). There is no `Browser` interface/class to
implement, and `openBrowser` is not injectable — `BrowserUse.create` calls it
directly (`src/index.ts:140`). Unknown `kind` values throw.

The **only** seam is the `endpoint`: a CDP WebSocket (or HTTP URL for
`/json/version` discovery). Passing `browser: { cdpUrl: 'ws://127.0.0.1:PORT/…' }`
runs the unmodified SDK against any CDP-compatible endpoint. `targetId` is
also accepted on the `cdpUrl` variant and pre-attaches the first page.

### 1.2 Where things run

```text
host process (your app)                  worker (forked Node ≥22.19)
├─ model loop: pi-agent-core/pi-ai       ├─ V8 REPL realm via node:inspector
│  (same packages & version 0.85.1 as    │  (name 'browser-use'), per-cell
│   our native host)                     │  Runtime.evaluate in that realm
├─ BrowserRuntime: cell queue, IPC,      ├─ CDP.lazy(endpoint)  ← the only
│  timeouts, owned-target cleanup        │  browser connection in the worker
└─ CDP.connect(endpoint) only at close   ├─ Page/Tabs wrapping CDP
   (to close SDK-owned tabs)             └─ realm globals: page, tabs, browser,
                                            artifact, checkpoint, reconnect, …
```

Cells are the unit of work: one code string per cell, one active cell at a
time; worker death / cell timeout = state loss; `reconnect()` re-creates
`CDP.lazy(endpoint)`. The SDK's model loop is plain Pi — so "our pi instance"
means: the same model registry, same provider env keys (e.g.
`OPENROUTER_API_KEY`), and the same pi 0.85.1 our host already uses. `streamFn`
and a custom `models` collection are injectable if we ever need our routing.

### 1.3 CDP wire contract the client expects

One WebSocket, JSON:

```text
request  { id, method, params, sessionId? }
response { id, result }  |  { id, error: { code, message } }
event    { method, params, sessionId? }          # no id
```

`sessionId` present = scoped to an attached target (flattened sessions). The
client (`src/cdp.ts`) tracks `Target.attachToTarget`/`detachFromTarget`/
`closeTarget`/`getTargets` results itself for session→target bookkeeping and
`Page.getFrameTree` for frame parents. It rejects on `error`, times out
per-command at `operationTimeoutMs` (default 15 s), and caps 256 pending.

### 1.4 The CDP surface that actually gets exercised

Enumerated from all call sites + the system prompt the model receives
(`src/prompt.ts`) + policy/highlight/recording modules:

**Core (always used by `Page`/`Tabs`/worker):**

| CDP command | params | result shape consumed |
|---|---|---|
| `Target.getTargets` | – | `{ targetInfos: [{ targetId, type, url, title, attached, openerId?, parentFrameId? }] }` |
| `Target.createTarget` | `{ url }` | `{ targetId }` |
| `Target.attachToTarget` | `{ targetId, flatten: true }` | `{ sessionId }` |
| `Target.detachFromTarget` | `{ sessionId }` | – |
| `Target.closeTarget` | `{ targetId }` | `{ success: true }` |
| `Page.enable` / `Runtime.enable` | – (session) | `{}` |
| `Page.navigate` | `{ url }` | `{ frameId?, loaderId?, errorText? }` |
| `Runtime.evaluate` | `{ expression, awaitPromise, returnByValue, timeout?, userGesture?, contextId? }` | `{ result: { type, value?, objectId? }, exceptionDetails? }` |
| `Accessibility.getFullAXTree` | – (session) | `{ nodes: AXNode[] }` — `ignored`, `backendDOMNodeId`, `role:{value}`, `name:{value}`, `value:{value}`, `properties:[{name, value:{value}}]` (checked/pressed/selected/expanded/disabled) |
| `Input.dispatchMouseEvent` | `{ type: 'mouseMoved'|'mousePressed'|'mouseReleased', x, y, button, clickCount }` | – |
| `Input.insertText` | `{ text }` (session) | – |
| `Page.captureScreenshot` | `{ format, quality }` | `{ data: base64 }` |
| `Page.getFrameTree` | – (session) | `{ frameTree }` |

`page.goto` = `Page.navigate` + poll `Runtime.evaluate(() => document.readyState !== 'loading')` + `info()`; `page.waitFor(fn)` = poll `Runtime.evaluate` every 100 ms, **tolerating errors whose message matches** `/Execution context was destroyed|Cannot find context/`; `page.snapshot()` = `Accessibility.getFullAXTree` filtered to `!ignored && backendDOMNodeId`, mapping `id = backendDOMNodeId`.

**Prompt-taught recipes (the model is instructed to use exactly these):**

| recipe | CDP commands |
|---|---|
| AX → coordinates → click | `DOM.scrollIntoViewIfNeeded {backendNodeId}`, `DOM.getBoxModel {backendNodeId}` → `model.content[8]`, then `page.clickAt(x, y)` = 3× `Input.dispatchMouseEvent` |
| typing | `DOM.focus {backendNodeId}`, `Input.dispatchKeyEvent {type:'rawKeyDown', key:'a', code:'KeyA', commands:['selectAll']}`, `Input.insertText {text}`, `Input.dispatchKeyEvent {type:'keyUp', key:'a'}` (Backspace for empty replacement) |
| element at point | `DOM.getNodeForLocation {x, y}` → `{ backendNodeId }` |
| uploads | `DOM.setFileInputFiles {backendNodeId, files}` |
| in-process frames | `Page.getFrameTree`, `Page.createIsolatedWorld {frameId, worldName}` → `{ executionContextId }`, then `Runtime.evaluate { contextId }` |
| cross-origin iframes | `Target.getTargets` (type `'iframe'`, `parentFrameId`), attach with `flatten: true`, scoped commands on that sessionId |
| events | `browser.waitFor('Domain.event', { sessionId, timeoutMs, predicate })` — one-shot; register before triggering |

**Opt-in modules (only if the app opts in):**

| module | CDP used |
|---|---|
| domain policy (`allowedDomains`/`prohibitedDomains`) | `Fetch.enable/disable/continueRequest/failRequest/fulfillRequest`, events `Fetch.requestPaused`, `Target.attachedToTarget`, `Target.setAutoAttach`, `Target.autoAttachRelated`, `Target.sendMessageToTarget`, `Target.getTargetInfo`, `Runtime.runIfWaitingForDebugger` |
| `highlightActions` | `DOM.getNodeForLocation`, `DOM.resolveNode {backendNodeId}` → objectId, `Runtime.callFunctionOn {objectId, functionDeclaration}`, `Runtime.releaseObject(Group)`, `DOM.focus` |
| `recording` | separate CDP connection, screencast + `Page.captureScreenshot` taps (fails gracefully with a `warning` event if unavailable) |
| worker close cleanup (host) | `Target.getTargets` + `Target.closeTarget` for SDK-owned targets |

Everything else the model could send via `page.cdp(…)` is long tail; a clear
CDP error (`-32601`) is a first-class outcome the model can react to.

---

## 2. What our stack already provides (and the gap)

Our add-on already implements, as browser tools (see `packages/protocol/src/
browser-tools.ts`, content scripts in `firefox/src/content/`):

| need (CDP) | we have today |
|---|---|
| `Page.navigate` | `browser_navigate {url}` (absolute URL validated; `tab_navigated` host notification invalidates refs) |
| `Runtime.evaluate` (page world) | `browser_evaluate {expression, arg, frame}` — page world via MAIN-world helper, isolated-world fallback, 15 s deadline, JSON-safe result (20 KB cap), `{value, error, world}` |
| `Accessibility.getFullAXTree` | `browser_get_accessibility_tree {maxNodes, maxDepth, frame}` — structured walker (roles, accessible names, refs, pruning, shadow-DOM traversal) — **but today it serializes to an indented text outline**; the bridge needs the structured node list |
| `DOM.getBoxModel` / coords | `browser_get_dom` summaries (ref, role, name, rect-less) + `browser_element_at {x,y}` → ref — **no rect-per-ref, no scrollIntoView/focus-by-ref yet** |
| `Input.dispatchMouseEvent` | `browser_click {ref}` (content-script `focus() + click()`) — **no atomic coordinate click** |
| `Input.insertText` | `browser_type {ref, text, submit}` (value-setter + input/change, or `execCommand('insertText')`/InputEvent fallback) — **no focus-targeted insert** |
| `Page.captureScreenshot` | `browser_screenshot {format: png|jpeg, quality}` via `captureVisibleTab` (viewport) — matches CDP semantics |
| `Page.getFrameTree` | `webNavigation.getAllFrames` (already used for the `frame` param) + `browser_get_dom` `frames` list — bridge-side synthesis |
| `Target.getTargets`/`createTarget`/`closeTarget` | bindings exist (sessionId→tabId) — **no "open new tab" / "close tab" tools** |
| events | `tab_closed` / `tab_navigated` / `binding_changed` / `binding_removed` host notifications — **no `load` notification** (bridge can poll `readyState` instead) |

The gap is small and mechanical: a handful of content-script commands and two
tab tools. The *large* gap is the protocol: the SDK speaks CDP, we speak
`browser_*` tools. The bridge's job is CDP ⇄ tool translation plus the CDP
object model (numeric node ids ↔ our string refs, session ids, context ids).

---

## 3. Options considered

### Option A — CDP bridge inside the native host; SDK unmodified ✅ recommended

A new module in `packages/pi-agent` (`src/browser-use/`) starts an opt-in
WebSocket server on **127.0.0.1** with a per-startup random token
(`ws://127.0.0.1:<port>/cdp/<token>`), writes `~/.pi/run/cdp-bridge.json`
(0600: `{ port, token, pid, startedAt }`), and translates CDP commands into
`x-pi-browser/tool` calls for a **bridge-owned ACP session** (created with the
existing session/binding machinery; a tab bound to it, or a new tab opened by
the bridge). The app then uses the SDK stock:

```ts
import { BrowserUse } from '@browser_use/pi';
import { piBrowser } from '@pi-browser/client'; // new small package in this repo

const agent = await BrowserUse.create({
  model: 'openrouter/…',            // our pi model config / env keys
  browser: await piBrowser(),       // → { cdpUrl: 'ws://127.0.0.1:PORT/cdp/TOKEN', targetId?: 'pi:bound' }
  workspace: './work',
  log: 'pretty',
});
```

Pros:
- Zero SDK modification; we track upstream releases as normal dependencies.
- Reuses our entire existing pipeline per tool call: binding (sessionId→tabId),
  timeouts, structured error codes, screenshot permission prompts (the bridge
  session is a normal session — §38/§49 rules apply unchanged).
- The bridge is a reusable asset: any CDP client (Playwright, Chrome-based
  tooling, future `Browser.custom` upstream API) can target our Firefox later.
- Fits "our addon and our pi instance": the model loop is the same Pi
  (0.85.1, same registry/credentials as our host), the browser is ours.

Cons:
- Implements a CDP subset (~25–30 commands + ~6 events) with exact result
  shapes; long tail returns `-32601` (the model copes — the prompt teaches
  only the recipes we do support).
- Deviation from security invariant 9 ("no localhost TCP port required"):
  mitigated — opt-in (off by default; `PI_BROWSER_CDP_BRIDGE=1`), loopback
  only, random token in the URL path, 0600 state file, same user. Needs an
  explicit §49/§50 amendment (proposed wording below).
- Node ≥ 22.19 requirement for the SDK worker (`BROWSER_USE_NODE` or PATH —
  our env has 23.10.0; our host already requires it via undici 8.9.0).

### Option B — fork `@browser_use/pi`, add a non-CDP transport

Fork the SDK (MIT, ~4.5k lines), replace `CDP` with a `PiConnection` speaking
our protocol over the broker UDS socket, add `kind: 'pi'` to `BrowserOptions`,
extend `WorkerConfig` with a transport descriptor. No TCP anywhere (invariant 9
stays intact). The worker would get our native primitives (refs, console,
network) directly.

Pros: no TCP, richest primitive surface, first-class errors.
Cons: permanent fork maintenance (upstream is at 0.1.0 and moving fast —
prompt/worker/policy churn); the worker is a forked child that only receives
`WorkerConfig` — plumbing a UDS socket path there is a real patch; we re-derive
upstream behavior tests against our fork; two codebases to keep in sync with
the pi 0.85.x line.

Verdict: only if (a) the TCP deviation is unacceptable even opt-in, or
(b) we decide our product should *replace* the SDK rather than host it.

### Option C — port the primitive layer into our own pi agent (no SDK)

Skip `@browser_use/pi` entirely: add the persistent JS-REPL `javascript` tool
(page/tabs/browser primitives over `browser_*` tools) to our ACP agent in the
native host, porting the worker/realm/prompt design from the SDK (MIT) with
attribution. "Our pi instance" then *is* the Browser Use-style agent.

Pros: no CDP emulation, no fork, no TCP, full control of prompt/tools;
deepens the existing product instead of adding an external driver.
Cons: it is a port + permanent re-implementation of ~1k lines of
deliberately-evolving upstream design (cells, compaction, finish/finish_from_js,
checkpoint/partial, images pipeline); the user-facing deliverable of *this*
task ("implement our own Browser **for** browser-use-pi") is not served; we
lose upstream compatibility for free.

Verdict: strong follow-up / possible end-state if the SDK integration
proves constraining; note it here to decide once, not by drift.

### Recommendation

**Option A now.** It is the smallest surface that delivers the stated goal
("use Browser Use to control our Firefox using our addon and our pi instance"),
keeps the SDK stock, and concentrates all new logic in one testable module in
our repo. Option C stays in the backlog; Option B only if the invariant 9
amendment is rejected.

---

## 4. Bridge design (Option A)

### 4.1 Components

```text
packages/pi-agent/src/browser-use/
  cdp-bridge.ts     WS server (127.0.0.1, token path), JSON CDP dispatch,
                    id/timeout bookkeeping, event emitter
  commands.ts       CDP command → tool call mapper (pure, table-driven, unit-testable)
  id-registry.ts    backendNodeId ⇄ ref map, sessionId map, executionContextId map
  events.ts         tab_navigated/tab_closed/readyState-poll → CDP events
  session-owner.ts  bridge session: session/new + bind (or open new tab),
                    tool calls via the existing transport, teardown
packages/pi-agent/src/native-host/main.ts   start bridge when PI_BROWSER_CDP_BRIDGE=1
packages/pi-browser-client/                 new workspace: piBrowser() discovery helper
firefox/…                                     new content commands + 2 tab tools (4.3)
```

Discovery: host writes `~/.pi/run/cdp-bridge.json` (same 0700 run dir as the
broker state; 0600). `piBrowser()` reads it and returns
`{ cdpUrl, targetId }`; missing file → actionable error ("add-on host not
running or bridge disabled").

Session ownership: the bridge acts exactly like our e2e harness's client —
it creates an ACP session and binds a tab via the existing control flow, then
issues `x-pi-browser/tool` calls with that sessionId. It never prompts that
session; teardown unbinds/closes bridge-opened tabs. (Design detail to nail in
Phase 0: whether binding uses `pi_bind_current_tab` semantics or a new
explicit `pi_bind_tab { tabId }` — the bridge must not hijack the user's
active-tab binding.)

### 4.2 Command mapping (v1)

| CDP (session) | bridge implementation |
|---|---|
| `Target.getTargets` | bound target `{ targetId: 'pi:<tabId>', type:'page', url, title, attached:true }` (+ `openerId` chain for SDK-owned cleanup) |
| `Target.createTarget {url}` | **new tool `browser_open_tab {url}`** → `{ targetId: 'pi:<tabId>' }`; bridge marks it owned (SDK closes owned targets at close — maps to `browser_close_tab`) |
| `Target.attachToTarget {targetId, flatten}` | registry: `{ sessionId: 'sess-<n>' }`; emit `Target.attachedToTarget` |
| `Target.detachFromTarget` / `closeTarget` | session cleanup / **new tool `browser_close_tab {tabId}`** → `{ success: true }` |
| `Page.enable` / `Runtime.enable` | no-op `{}` |
| `Page.navigate {url}` | `browser_navigate`; on success: start readyState poll (see events), return `{ frameId: targetId, loaderId: uuid }`; invalid URL → `{ errorText: '…' }` (SDK throws on errorText) |
| `Runtime.evaluate {expression, …}` | `browser_evaluate {expression, frame? (via contextId)}` — the SDK already inlines function+JSON arg into the expression string, so it maps 1:1. Result → `{ result: { type, value } }`; `error` → `exceptionDetails: { text, exception: { description } }`. If the tab just navigated (context destroyed) the error text MUST contain `Execution context was destroyed` (feeds `page.waitFor`'s tolerance path). 20 KB result cap → CDP error `-32000 'result exceeded 20 KB; chunk the extraction'` (model self-corrects; large data belongs in workspace files) |
| `Accessibility.getFullAXTree` | **new structured mode of the a11y walker** (today text-only): nodes → `{ ignored:false, backendDOMNodeId: idFor(ref), role:{value}, name:{value}, value?, properties:[…checked/pressed/selected/expanded/disabled] }`; `idFor(ref)` = stable numeric from registry (e.g. 1000+seq) |
| `DOM.getBoxModel {backendNodeId}` | registry → ref → **new content cmd `pi:rect`** (getBoundingClientRect) → `{ model: { content: [x1,y1,…,x4,y4] } }` |
| `DOM.scrollIntoViewIfNeeded` | **new content cmd `pi:scroll`** (scrollIntoView({block:'center'})) |
| `DOM.focus` | **new content cmd `pi:focus`** |
| `DOM.getNodeForLocation {x,y}` | `browser_element_at` → ref → `{ backendNodeId: idFor(ref) }` |
| `DOM.setFileInputFiles {backendNodeId, files}` | **new content cmd `pi:setFiles`** (DataTransfer + File from base64 + change event; works in Firefox) |
| `Input.dispatchMouseEvent` | coalesce moved+pressed+released (left) → **new content cmd `pi:clickAt {x,y}`** (elementFromPoint + focus + click, atomic in one content-script run — better than an element_at→click round trip); wheel/hover → best-effort `browser_evaluate` scroll/no-op |
| `Input.insertText {text}` | **new content cmd `pi:typeFocused`** (reuse the proven `browser_type` typing path on `document.activeElement`) |
| `Input.dispatchKeyEvent` (selectAll/backspace/copy/paste/cut) | **new content cmd `pi:key`** against `document.activeElement` (select()/deleteContent/backwards etc.) |
| `Page.captureScreenshot {format, quality}` | `browser_screenshot` → `{ data }` (permission prompt applies — user sees it, by design) |
| `Page.getFrameTree` | synthesize from `webNavigation.getAllFrames` (bridge owns the frame registry; frame ids = numeric frameIds as strings) |
| `Page.createIsolatedWorld {frameId, worldName}` | registry: fake `executionContextId` ↔ frameId; then `Runtime.evaluate {contextId}` → `browser_evaluate {frame: frameId}` (our content-script world *is* the isolated world) |
| `Emulation.setDeviceMetricsOverride` | no-op ack + one-time warning (desktop Firefox window not resized) |
| `Browser.*`, `Fetch.*`, `Network.*`, anything else | CDP `-32601 { message: 'not implemented by pi-browser bridge: <method>' }` — except when `allowedDomains`/`prohibitedDomains` were configured: then **fail fast at create** ("domain policy needs Fetch interception, unsupported on pi-browser; run without domain policy") |

### 4.3 Add-on deltas (small, all content-script-level unless noted)

1. `pi:rect {ref}` → bounding box (or add `rect` to `browser_get_dom`/a11y nodes — prefer the dedicated cmd, keeps tool payloads lean).
2. `pi:scroll {ref}`, `pi:focus {ref}`.
3. `pi:typeFocused {text}` — refactor the existing `type()` body to accept a resolved element.
4. `pi:clickAt {x,y}` — atomic hit-test + click (overlay behavior matches `browser_element_at` semantics; result says what was hit).
5. `pi:key {key, commands?}` — selectAll/cut/copy/paste/backspace on `document.activeElement`.
6. `pi:setFiles {ref, files:[{name, type, base64}]}`.
7. a11y walker: structured node output mode (shared with the text outline; same walk, two serializers).
8. (background, new protocol tools) `browser_open_tab {url}` → `{ tabId }`, `browser_close_tab {tabId}`.
9. `browserToolVersion` 3 → 4; new tools into `BROWSER_TOOLS` + TypeBox schemas (sync test enforced).

No new permissions: everything is in-page scripting on the bound tab plus
`tabs.create/close` (covered by existing `tabs` permission).

### 4.4 Events the bridge emits

| CDP event | source |
|---|---|
| `Page.frameNavigated { frame: { id, url } }` | `tab_navigated` host notification (status 'loading'/url change) |
| `Page.loadEventFired` | bridge-side poll after navigate: `browser_evaluate` until `document.readyState === 'complete'` (no add-on change needed) |
| `Runtime.executionContextDestroyed` | on `tab_navigated` (so `page.waitFor` across navigation keeps working) |
| `Target.attachedToTarget` / `detachedFromTarget` | bridge attach/detach |
| `Target.targetDestroyed` | `tab_closed` |

### 4.5 Fidelity notes (to document in the bridge README + PRODUCT.md)

- Input is **untrusted** (content-script dispatch), not CDP's trusted input:
  equivalent for ~all web content; sites inspecting `event.isTrusted`
  (some CAPTCHAs/payments) will differ — same class of limitation our
  existing `browser_click` has.
- `Runtime.evaluate` runs in the page world via the MAIN-world helper (real
  page globals) with isolated-world fallback; 20 KB result cap (see 4.2).
- AX tree is our walker's approximation (roles/names/properties), not Chrome's
  AX pipeline; `backendDOMNodeId` values are bridge-assigned, valid until
  navigation (same invalidation as our refs; `tab_navigated` clears the
  registry).
- Screenshots are viewport (`captureVisibleTab`) — matches CDP default.
- Cross-origin iframe *targets* (attach on `type:'iframe'`) are v2; in-process
  and cross-origin *frames* via `frame`-param commands are v1 (the content
  scripts already run in all frames).
- v1 non-goals: `Fetch` domain policy, recording/screencast, downloads
  (`Browser.setDownloadBehavior` — check `browser.downloads` availability in
  FF MV3 first), `Page.createIsolatedWorld` for main frame beyond 4.2's shim.

---

## 5. Security analysis vs PRODUCT.md §49

| invariant | impact |
|---|---|
| 1. allowed_extensions = production id | unchanged (no new native host) |
| 2. native stdout = protocol data only | unchanged |
| 3. page content untrusted | unchanged — bridge never executes page code outside the content scripts; CDP errors/results pass through our normal sanitization paths |
| 4. page cannot initiate ACP prompt | unchanged |
| 5. tools target explicit session-bound tabs | unchanged — bridge session is bound like any other; no active-tab fallback |
| 6–8. Pi owns execution; schemas; bounded inputs | unchanged — every CDP command lands as a schema-validated tool call |
| **9. no localhost TCP port required** | **deviation, opt-in**: loopback-only listener, random token in URL path, 0600 state file, enabled only via `PI_BROWSER_CDP_BRIDGE=1`. Core product path (native messaging) still needs no TCP. Proposed amendment wording: *"9. No localhost TCP port is required for the core path. The opt-in Browser Use CDP bridge listens on 127.0.0.1 only, with a per-startup random token and a 0600 state file; it is disabled by default."* |
| 10. no separately downloaded bridge | unchanged (bridge ships in the existing host package) |

Additional risk: the SDK's JS worker is by design **not** a sandbox (agent
code can `require`/`fetch`/write its workspace; `researchTools` adds read/
write/edit/bash). That is the SDK's stated contract, and our invariant 6
(Firefox cannot invoke shell commands) is not touched — the worker runs in
the user's app process, outside the add-on. Document for users enabling this.

---

## 6. Implementation plan

### Phase 0 — spike (0.5–1 day)
Hand-rolled CDP WS stub (~150 lines) implementing just: getTargets,
attachToTarget, Page.enable, Runtime.enable, Page.navigate, Runtime.evaluate,
Accessibility.getFullAXTree, Input.dispatchMouseEvent, Page.captureScreenshot —
backed by the **existing e2e FakeTabs + real McpServer** from `tests/`.
Install `@browser_use/pi` as a devDependency of `tests/`; supply a fake
`models` collection whose `streamSimple` emits scripted `javascript` cells
(`await page.goto('…'); page.info(); page.snapshot()`) then `finish`.
**Exit criteria**: unmodified SDK completes a run end-to-end against the stub;
worker cells, screenshots-as-images and finish delivery all observable.
This de-risks everything (WS contract, worker bootstrap on Node 23,
`BROWSER_USE_NODE`, model injection) before writing the real bridge.

### Phase 1 — bridge core (3–5 days)
`cdp-bridge.ts` + `commands.ts` + `id-registry.ts` + session-owner; full
4.2 core rows (navigate/evaluate/a11y-structured/boxmodel+rect/scroll/focus/
clickAt/typeFocused/key/screenshot/getFrameTree); tab tools `browser_open_tab`
/ `browser_close_tab`; a11y structured mode; state file + `piBrowser()`
helper package. Unit tests for the command mapper (pure table); e2e extended
to drive the **real SDK** (scripted model) against the **real host + bridge**
over the fake add-on.

### Phase 2 — prompt-recipe surface (2–3 days)
`pi:setFiles`, cross-origin frame param paths, `createIsolatedWorld`/
contextId shim, `Emulation` no-op, event set (4.4), error-shape fidelity
(`Execution context was destroyed`), 20 KB cap error, policy fail-fast.
Live-Firefox pass on the SDK's own quickstart task ("Find the top story on
Hacker News") — recorded in `docs/VERIFICATION.md` per our usual table.

### Phase 3 — hardening + docs (2–3 days)
`reconnect()` semantics (registry reset, re-attach), owned-target cleanup at
SDK close, multi-cell concurrency is already serialized by the SDK (verify),
timeout matrix (operationTimeoutMs vs our tool timeouts), PRODUCT.md section
(§50 amendment + new §"Browser Use CDP bridge"), README quickstart,
VERIFICATION.md live table, e2e stability (flaky-timer audit).

**Total: ~2 weeks to a solid v1** (one engineer, parallelizing with live
Firefox verification as the long pole — the usual pattern).

### Tests (mirrors docs/VERIFICATION.md structure)

| layer | evidence |
|---|---|
| command mapper (pure) | unit: each CDP row → exact tool call + result/error shape |
| id/session registries | unit: ref⇄id stability across navigations, contextId⇄frame, detach cleanup |
| host e2e (fake add-on, real host+bridge, **real SDK + scripted model**) | run/followUp/finish, screenshot image in agent_event, owned-target cleanup, policy fail-fast |
| live Firefox | quickstart task + typing/upload/iframe/console follow-ups; VERIFICATION.md session ids |

---

## 7. Open questions

1. **Binding UX**: does the bridge bind the *current* tab (user intent:
   "control what I'm looking at") or always open its own tab (clean
   isolation)? Recommendation: bind current tab by default, `browser_open_tab`
   for SDK `tabs.open` calls; make it a `piBrowser({ tab: 'current' | 'new' })`
   option. Needs one control-tool addition (`pi_bind_tab {tabId}`) if we
   don't want to touch the active-tab concept.
2. **Bridge enablement**: default-on while host runs vs env-flag. Flag wins
   for invariant 9 optics; default-on is friendlier. Decide at Phase 1.
3. **20 KB evaluate cap**: raise the cap on bridge-scoped calls (param) or
   keep + chunk. Leaning: keep, error message teaches chunking.
4. **Upstream**: propose (or wait for) an official `Browser.custom({ connect })`
   / `kind:'cdp-proxy'` seam in browser-use-pi — if accepted, the bridge
   plugs in unchanged and the state-file helper can move upstream-adjacent.
   The `cdpUrl` path works today regardless; this is hygiene, not a blocker.
5. **Node pinning**: SDK worker needs ≥22.19 (undici 8.9.0). Our test env
   already runs 23.10.0; document `BROWSER_USE_NODE` in the quickstart.
6. **`targetId` pre-attach**: pass the bound tab's id from `piBrowser()` so
   the worker's first `page.*` hits the bound tab without a `tabs.open`
   round trip (verify against worker's `deferredPage` behavior in Phase 0).
