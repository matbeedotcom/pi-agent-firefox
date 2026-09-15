# Browser Use Pi ↔ Pi Browser: research & design

Date: 2026-09-14 (updated same day after owner decision). Status: research
complete; **Option C implemented (v1)** — see the §4.1 and §8 status notes.
Upstream: https://github.com/browser-use/browser-use-pi (package `@browser_use/pi` v0.1.0, MIT).
Research copy for this doc: `/tmp/browser-use-pi` (shallow clone; re-clone if gone).

**Product intent: Pi Browser is a browser-use runtime over our Firefox
MCP/ACP stack.** The browser-use paradigm — an LLM agent driving a *real*
browser through a persistent JavaScript interface (`page`/`tabs` primitives,
AX snapshots, screenshots, workspace artifacts/checkpoints) — is what we
support natively: over our own transport (add-on + native messaging + broker
UDS/ACP), on the user's live Firefox, under our security model (explicit
session→tab binding, permission gates, no CDP/TCP). Concretely, the
`javascript` REPL tool of our ACP agent (§4) **is** the browser-use surface —
the API any agent that speaks our ACP/MCP protocol can drive, plus the
one-shot `browser_*` tools for single actions. This doc is the research +
design record for that support; the implementation plan is
`BROWSER-USE-REPL-PLAN.md`.

Goal: get that Browser-Use-style agent (Pi model loop + persistent V8
JavaScript REPL + browser primitives: `page`/`tabs`/`browser`, AX snapshots,
screenshots, workspace artifacts) driving **our** Firefox — through our
add-on (browser tools, content scripts, bindings) and our pi instance (the
ACP agent in the native host).

**Owner constraints (2026-09-14):**
1. **No CDP-over-TCP server, whatsoever.** That eliminates the "unmodified SDK
   against a local CDP endpoint" path (Option A below).
2. **The agent must control the user's real browser** — their live Firefox
   (real tabs, real profile, logged-in state), not a launched/cloud/headless
   instance (which is `@browser_use/pi`'s default). Both surviving options do
   this through the add-on; the constraint is what settles the B-vs-C call.

Two viable shapes remain: **B — fork the SDK, transport over our broker
socket** and **C — port the REPL primitive layer into our own pi agent**. This
doc designs both and **decides C** (constraint 2 makes the controller our pi
instance, already bound to the user's tab via the existing sidebar UX; see §6).

---

## 1. How `@browser_use/pi` actually works

Read: `src/index.ts`, `src/browser.ts`, `src/cdp.ts`, `src/runtime.ts`,
`src/worker.ts`, `src/page.ts`, `src/prompt.ts`, `src/policy.ts`,
`src/highlight.ts`, `src/protocol.ts`.

### 1.1 Architecture

```text
host process (your app)                  worker (forked Node ≥22.19, env {})
├─ model loop: pi-agent-core/pi-ai       ├─ V8 REPL realm via node:inspector
│  (pi 0.85.1 — same version as our host)│  (context name 'browser-use'); each
├─ BrowserRuntime: cell queue, IPC,      │  cell = one Runtime.evaluate in it
│  timeouts, owned-target cleanup        ├─ realm globals: page, tabs, browser,
└─ at close: CDP connect to close        │  screenshot/snapshot, artifact,
   SDK-owned tabs                        │  checkpoint, reconnect, require, …
```

Cells are the unit of work: one code string, one active cell at a time,
top-level `await`/variables persist across cells. Worker death, cancellation
or cell timeout **loses JS state** (that is the contract: a timeout can kill a
synchronous infinite loop only because the REPL runs in a child process).
`reconnect()` resets the browser connection while keeping Node state.

The `page`/`tabs`/`browser` primitives are thin wrappers over **one CDP
WebSocket** (`CDP.lazy(endpoint)`). `Browser.{cloud,chromium,chrome}` are data
factories; `openBrowser(options.browser)` returns `{ endpoint, close }`; the
endpoint is the only browser seam in the unmodified SDK.

### 1.2 The CDP surface that actually gets exercised

Enumerated from all call sites, the system prompt (`src/prompt.ts`) the model
receives, and the opt-in modules:

**Core (always used by `Page`/`Tabs`/worker):**

| capability | CDP commands |
|---|---|
| tab list / open / close / attach | `Target.getTargets`, `Target.createTarget`, `Target.attachToTarget{flatten:true}`, `Target.detachFromTarget`, `Target.closeTarget` |
| enable | `Page.enable`, `Runtime.enable` (per session) |
| navigate | `Page.navigate {url}` → `{errorText?}`; then poll `Runtime.evaluate(() => document.readyState !== 'loading')` |
| evaluate | `Runtime.evaluate {expression, awaitPromise, returnByValue, timeout, userGesture, contextId?}` — functions are stringified with the JSON arg inlined |
| AX snapshot | `Accessibility.getFullAXTree` → nodes with `backendDOMNodeId`, `role/name/value:{value}`, `properties[]` (checked/pressed/selected/expanded/disabled) |
| coords click | 3× `Input.dispatchMouseEvent` (moved/pressed/released, left) |
| typing | `DOM.focus{backendNodeId}`, `Input.dispatchKeyEvent` (selectAll / backspace), `Input.insertText{text}` |
| screenshot | `Page.captureScreenshot {format:'jpeg',quality}` → `{data:base64}` |
| box model / scroll / hit-test | `DOM.getBoxModel{backendNodeId}` → `model.content[8]`, `DOM.scrollIntoViewIfNeeded`, `DOM.getNodeForLocation{x,y}` |
| frames | `Page.getFrameTree`, `Page.createIsolatedWorld{frameId,worldName}` → `executionContextId`, scoped `Runtime.evaluate{contextId}` |
| uploads | `DOM.setFileInputFiles{backendNodeId,files}` |
| events | one-shot `waitFor('Domain.event',{sessionId,predicate})` (e.g. `Page.frameNavigated`) |
| misc | `Emulation.setDeviceMetricsOverride`, `DOM.resolveNode`/`Runtime.callFunctionOn`/`releaseObject(Group)` (highlight), `Fetch.*` + `Target.setAutoAttach/autoAttachRelated/sendMessageToTarget` (domain policy), screencast (recording) |

Everything else the model could send via `page.cdp(…)` is long tail; a clear
error is a first-class outcome. `page.waitFor(fn)` polls evaluate every 100 ms
and **tolerates errors matching** `/Execution context was destroyed|Cannot find
context/` — across navigations.

### 1.3 Why this matters for our options

The SDK's value is the **agent design**: persistent JS cells as the agent's
main tool, AX-first discovery, screenshot evidence, workspace artifacts,
checkpoint/partial delivery, and a prompt tuned for that loop — all on the pi
model stack we already run. The CDP transport is incidental to that value,
which is exactly why we can replace it (B) or stop using it (C).

---

## 2. What our stack already provides (and the gap)

Add-on tools today (`packages/protocol/src/browser-tools.ts`, content scripts
in `firefox/src/content/`):

| capability (Browser-Use primitive) | we have today |
|---|---|
| `page.goto` | `browser_navigate {url}` (absolute URL validated; `tab_navigated` host notification invalidates refs) |
| `page.info` | `browser_get_page` |
| `page.evaluate` (page world) | `browser_evaluate {expression, arg, frame}` — `userScripts.execute` in MAIN (Firefox 153+, optional user-scripts permission), direct source compilation works under strict page CSP; JSON-safe `{value,error,world}`, 20 KB cap, tool timeout without retries |
| `page.snapshot` (AX) | `browser_get_accessibility_tree {maxNodes,maxDepth,frame}` — structured walker (roles, accessible names, **refs**, pruning, shadow-DOM traversal) — **serializes to a text outline today; we need the structured node list** |
| `page.clickAt(x,y)` | `browser_click {ref}` (content `focus()+click()`), `browser_element_at {x,y}` → ref — **no atomic coordinate click** |
| typing | `browser_type {ref,text,submit}` (value-setter + input/change; `execCommand('insertText')`/InputEvent fallback) — solid, ref-based |
| `page.screenshot` | `browser_screenshot {format,quality}` via `captureVisibleTab` (viewport) — matches CDP semantics |
| `page.waitFor` | `browser_wait_for {selector,state,timeoutMs}` (selector-based; predicate waiting is just an evaluate poll) |
| `tabs.*` | bindings (sessionId→tabId) — **no open/close/list-tabs tools** |
| frames | `frame` param (frameId or URL) on nine tools; `webNavigation.getAllFrames`; all-frames content scripts — strong |
| events | `tab_closed`/`tab_navigated`/`binding_changed`/`binding_removed` host notifications — no load-event notification (readyState poll suffices) |
| diagnostics | `browser_get_dom` (refs + stats/frames/note), `browser_get_console`, `browser_get_network`, `browser_get_selection` — beyond anything the SDK offers |

Gap: **tab lifecycle tools** (open/close/list) + **structured a11y nodes**
(+ optionally `rect`) + an **atomic coordinate click**. Small and mechanical.
No new permissions needed.

---

## 3. Option A — CDP bridge over a local TCP WebSocket — REJECTED

Design was completed in the first revision of this doc (bridge in the native
host, loopback + random token + 0600 state file, SDK stock via `{cdpUrl}`).
Rejected 2026-09-14: **no CDP/TCP server at all.** It is also the only option
that deviates from security invariant 9 (§49 "no localhost TCP port required"),
which is now a non-issue: both surviving options stay entirely inside the
existing UDS/native-messaging trust boundary.

---

## 4. Option C — the REPL becomes a tool of OUR pi agent (DECISION)

The controller is our pi instance, and it drives the user's **live** tab: the
primary target of `page.*` is the session's bound tab — the one the user bound
in the sidebar — so `page.goto`, `page.click`, `page.screenshot` act on the
tab the user is actually looking at (they watch it happen). Agent-owned tabs
(`tabs.open`) are auxiliary (see §4.2). Tab scope (bound-only vs any tab) is
open question §9.1.

Port the SDK's worker/realm design into the native host so that **our ACP
agent** gets a `javascript` tool: a persistent V8 REPL whose `page`/`tabs`
primitives run through our existing browser-tool transport. "Our pi instance"
then *is* the Browser-Use-style agent — model loop, session, sidebar,
permissions, all ours; no fork, no network, no CDP.

### 4.1 Shape

```text
Firefox add-on  ◄── native messaging ──►  native host
                                              ├─ ACP agent (pi 0.85.1, as today)
                                              │    tools: browser_* , control, mail, …
                                              │    + javascript { code, timeoutMs? }   ← new ToolSpec
                                              └─ ReplRuntime (per ACP session)
                                                   └─ forked ReplWorker child (Node, env {})
                                                        ├─ V8 realm via node:inspector (same trick as the SDK)
                                                        ├─ cells: one Runtime.evaluate per cell, output capture,
                                                        │  redaction, image collection, 1 MB/16 KB limits
                                                        ├─ realm globals: page, tabs, workspace, screenshot(),
                                                        │  snapshot(), artifact(), checkpoint(), reconnect()
                                                        └─ tool calls over IPC to the host
                                                             host → existing transport → add-on → content scripts
```

The ReplWorker is a **dumb JS sandbox** (exactly the SDK's own split): it
cannot reach the network-protocol layer itself; every primitive becomes an
IPC request `{type:'tool', tool, args}` answered by the host through the
*existing* `BrowserToolTransport.call(sessionId, tool, args)`. Consequences:

- the host stays the only ACP client (no new broker client category);
- screenshot permission prompts flow through the existing
  `request_permission` → add-on UI path, unmodified;
- binding rules (sessionId→tabId, no active-tab fallback) hold by construction;
- cell timeout/cancellation = SIGKILL the child (same state-loss contract as
  the SDK — a synchronous infinite loop dies, host survives).

**Why `node:inspector` at all — the DOM is in Firefox.** `node:inspector`
never touches the browser or the DOM. All DOM/AX/input work happens in the
add-on's content scripts. The *agent's code* (the cells the model writes —
`await page.goto(url)`, persistent variables, `checkpoint(...)`) runs in the
Node ReplWorker child, where `page`/`tabs` are **proxies**: each method goes
back over IPC → host → tool transport → add-on → content script → real DOM.
`node:inspector.Session` is simply a V8 handle to that child's **own** JS
engine, used to run each cell as `Runtime.evaluate { contextId, awaitPromise,
replMode: true, objectGroup: 'cell' }` against one persistent named context
(`vm.createContext({}, { name: 'pi-repl' })`). That buys: top-level `await` +
last-expression result capture (REPL semantics), one context that survives
across cells so state persists, per-cell object-group cleanup (no cross-cell
leaks), and real stack traces via `exceptionDetails`. It is the same
mechanism Node's own REPL uses. A bare `vm.runInContext`/`eval` would force us
to re-implement all four by hand. (The child process itself — not the
inspector — is what makes a hung cell killable without killing the host.)

> **Status: IMPLEMENTED** (v1). Shipped as PRODUCT.md §53: `javascript`
> tool (REPL_TOOLS, browserToolVersion 5), per-session `ReplProvider`/
> `ReplRuntime`, the `pi-repl` realm, `page.*`/`tabs.*` over the normal
> browser-tool path, REPL-owned tabs, and the live-Firefox verification
> recorded in `VERIFICATION.md`.

### 4.2 Primitive → tool mapping (native shapes, no CDP emulation)

| primitive | implementation |
|---|---|
| `page.goto(url)` | `browser_navigate`; then poll `browser_evaluate(() => document.readyState !== 'loading')`; return `{url,title}` from `browser_get_page` |
| `page.info()` | `browser_get_page` |
| `page.evaluate(fn, arg)` | `browser_evaluate` (fn + JSON arg — same inlining the SDK does); map our `{error}` into a thrown Error (and include `Execution context was destroyed` in the text on mid-navigation errors so `page.waitFor`'s tolerance path works) |
| `page.waitFor(fn, arg, {timeoutMs})` | host/worker-side poll of `browser_evaluate` (100 ms), same tolerance regex as the SDK |
| `page.snapshot()` / `snapshot()` | **structured a11y mode**: `{url,title,nodes:[{id: ref, role, name, value?, checked?, disabled?, expanded?, selected?, href?, type?, level?, rect?}]}` — our native shape with **refs as ids** (the agent learns refs, not backendNodeIds); budget flags `truncated`/`note` pass through |
| `page.clickAt(x,y)` | **new `browser_click_at {x,y,frame?}`** → content cmd `pi:clickAt` (elementFromPoint + focus + click, atomic in one content-script run; result says what was hit — the "coordinates can hit an overlay" warning stays true) |
| `page.click(ref)` / `page.type(ref, text, {submit})` | `browser_click` / `browser_type` (existing) — exposed as extra primitives; the ref recipe replaces the SDK's box-model recipe |
| `page.typeFocused(text)` | `browser_type` on the active element — new content cmd `pi:typeFocused` (reuses the proven typing path) — or skip in v1 (agent focuses via `page.focus(ref)` = new `pi:focus`) |
| `page.screenshot()` / `screenshot()` | `browser_screenshot {format:'jpeg', quality:70}` → image into the cell result (max 4 per cell, 8 MB — SDK's limits) |
| `page.cdp(...)` | **absent by design** — replaced by the honest surface; unknown calls are a clear Error naming the closest primitive |
| `tabs.list()` | **new `browser_list_tabs`** (open tabs: id, url, title, bound?) → `[{targetId:'tab:<id>', …}]` |
| `tabs.open(url)` | **new `browser_open_tab {url}`** → child tab of the session; host tracks ownership; `page = await tabs.open(url)` rebinds the session's REPL page (the session's *primary* tab stays the bound one; opened tabs are REPL-owned and closed at session end — mirrors the SDK's owned-target cleanup) |
| `tabs.get(id)` | attach (validate id; page handle switches) |
| `page.close()` / close owned tabs at session end | **new `browser_close_tab {tabId}`** |
| frames | `frame` param on the primitives (maps to the tool param); cross-origin frames already work via all-frames content scripts |
| `artifact(name,data)` / `checkpoint(name,value,{partial})` | ported from the SDK worker (workspace files, atomic rename, partials over IPC) — per-session workspace dir |
| `reconnect()` | reset the tool channel state (host-side: nothing to reconnect — the transport persists; the REPL clears page handles + ref registry note "inspect before acting") |
| `finish` / `finish_from_js` | **not needed**: our ACP agent ends the turn naturally; the schema-validated delivery contract is a property of the SDK's standalone run, not of the tool. (Port later if we add structured run delivery.) |

Add-on deltas for C (all existing permissions):

1. a11y walker: **structured nodes mode** (same walk as the text outline; add `rect` via getBoundingClientRect on matched nodes).
2. `pi:clickAt {x,y}` content cmd (atomic hit-test + click).
3. `pi:focus {ref}`, `pi:scroll {ref}` (cheap, used by the typing/visibility recipes).
4. `pi:typeFocused {text}` (optional in v1).
5. (background) `browser_open_tab {url}` → `{tabId}`, `browser_close_tab {tabId}`, `browser_list_tabs` → `{tabs}`.
6. `browserToolVersion` 3 → 4; new tools into `BROWSER_TOOLS` + TypeBox (sync test).

### 4.3 The `javascript` ToolSpec

```ts
// packages/protocol: name "javascript", readOnly: false
{ name: "javascript",
  description: "Persistent JavaScript REPL for the bound tab: top-level await,
    variables and functions survive calls. Primitives: page.goto/info/evaluate/
    waitFor/snapshot/click/clickAt/type/focus/screenshot, tabs.list/open/get,
    artifact/checkpoint/reconnect. … (recipe text, ref-based)",
  parameters: Type.Object({ code: Type.String(),
    timeoutMs: Type.Optional(Type.Number()) }),
  execute: (id, args, signal) => replRuntime.call(sessionId, args, signal) }
```

`execute` returns `BackendToolResult` with `content: [text, …images]` (our
`BackendToolResult` already carries images; ACP `promptCapabilities.image`
is already true) — screenshots in the REPL flow to both the model and the
sidebar like `browser_screenshot` does today.

Session lifecycle: one ReplRuntime per ACP session, created lazily on first
cell; killed on session close; on `binding_changed`/`binding_removed` the
host invalidates page handles + ref registry and injects a note into the next
cell's preamble ("binding changed: inspect page before acting"); a session
with no bound tab gets a structured `BROWSER_NOT_BOUND` error.

Prompt strategy: the tool *description* carries the primitive recipes (adapt
from `src/prompt.ts`, ref-based instead of box-model-based); the existing
`browser_*` tools remain available alongside — hybrid surface, agent picks per
step (REPL for multi-step scripting/stateful extraction; single tool calls for
one-offs). The SDK prompt's guardrails copy over almost verbatim (page content
is untrusted; verify outcomes; don't replay uncertain mutations; large data to
workspace files).

### 4.4 What we deliberately do NOT port in v1

- `fetch` domain policy, recording/screencast, `highlightActions`,
  `sensitiveData`/`fillSecret` (all CDP-specific or Chrome-specific; revisit).
- `require` in the realm: the SDK allows Node libraries in cells. For v1 give
  the realm the curated globals (page/tabs/fetch/Buffer/URL/…) **without**
  `require` (smaller trust surface inside our host); revisit if the workflow
  needs it — the SDK's "worker is not a sandbox" disclosure applies either way.

---

## 5. Option B — fork `@browser_use/pi`, broker-UDS transport (fallback)

Run the **actual** `@browser_use/pi` agent (its exact prompt, cell machinery,
history format, future features) with `browser: Browser.pi()`, where the fork's
worker talks to us over the **broker Unix socket** instead of a CDP endpoint.
Verified feasible: the broker's handshake admits any same-user process as a
full ACP client (the Thunderbird relay does exactly this today; e2e even
covers relay re-attach and lifecycle).

### 5.1 Shape

```text
user app
└─ BrowserUse.create({ model, browser: Browser.pi(), workspace })
   ├─ model loop (SDK, in the app process)
   └─ worker (forked, env {})
      ├─ V8 realm + cells            (SDK, unmodified behavior)
      ├─ PiConnection                (fork: drop-in for CDP — same method
      │    send(method, params, sessionId?) / waitFor / close / observers)
      │    = CDP-shaped adapter over:
      └─ broker UDS: connect ~/.pi/run/agent-broker.sock
           → frame {type: PI_BROKER.handshake, token}   (token from 0600 state file)
           → {type: handshakeAck} → full ACP client channel (native framing)
           → initialize (piBrowser meta) → session/new → bind tab
           → x-pi-browser/tool calls (CDP method → tool, table below)
           → request_permission round-trips for screenshots (add-on UI)
           → tab_navigated/tab_closed/binding_* notifications
```

### 5.2 Fork surface (what changes in the SDK)

| file | change |
|---|---|
| `src/browser.ts` | `kind:'pi'` option; `openBrowser` returns `{endpoint:'pi://…', close}` (close = broker-client teardown, not browser kill) |
| `src/protocol.ts` | `WorkerConfig.transport?: {kind:'pi', socketPath?}` (socketPath optional: default `~/.pi/run`; token read by the worker from the 0600 state file — config travels over fork IPC, never argv/env, same as `endpoint` today) |
| `src/pi-connection.ts` (new) | `PiConnection` implementing the exact `CDP` method surface the worker/Page/Tabs/policy/highlight use: `send`, `waitFor`, `close`, `lazy`, `observeCommand/observeResponse/observeEvent`, `targetForSession`, `observationTargetId`, `activity` bookkeeping (session↔target, frame parents) |
| `src/worker.ts` | select `PiConnection` vs `CDP` from `config.transport`; `reconnect()` re-creates it |
| `src/runtime.ts` | host-side close cleanup: replace the `CDP.connect` owned-target sweep with `PiConnection`'s (same getTargets/closeTarget semantics) |
| `src/policy.ts` | `Fetch.*` interception unsupported → **fail fast at create** when `allowedDomains`/`prohibitedDomains` are set (clear error) |
| `src/highlight.ts` | map onto `DOM.getNodeForLocation`→`browser_element_at`, `resolveNode/callFunctionOn`→ new content cmd `pi:evalRef {ref, functionDeclaration}` (element-targeted evaluate) — or disable with a warning |
| `src/recording.ts` | unsupported → the SDK already degrades gracefully (warning event) |

### 5.3 CDP-shaped mapping (the fork keeps the SDK's CDP semantics)

Same translation core as the rejected Option A, but the response **shapes stay
CDP** (`backendDOMNodeId`, `AXNode`, `model.content[8]`, `exceptionDetails`…)
because the unmodified SDK worker consumes them. Concretely: numeric node-id
registry (ref↔id), `Accessibility.getFullAXTree` from the structured a11y mode,
`DOM.getBoxModel/scrollIntoViewIfNeeded/focus/getNodeForLocation` from
`rect`/`pi:scroll`/`pi:focus`/`browser_element_at`, `Input.dispatchMouseEvent`
triple → `browser_click_at`, `Input.insertText` → `pi:typeFocused`,
`Input.dispatchKeyEvent` → `pi:key`, `Page.navigate` → `browser_navigate`
(+readyState poll → `Page.loadEventFired`, `tab_navigated` →
`Page.frameNavigated` + `Runtime.executionContextDestroyed`), `Page.captureScreenshot`
→ `browser_screenshot`, `Target.*` → tab tools + session registry,
`Page.createIsolatedWorld{frameId}` → contextId registry → `browser_evaluate{frame}`.
Long tail → CDP error `-32601 'not implemented by pi-browser: <method>'`.

Add-on deltas: the Option-A set (structured a11y, `pi:rect`/`pi:scroll`/
`pi:focus`/`pi:typeFocused`/`pi:clickAt`/`pi:key`/`pi:setFiles`,
`browser_open_tab`/`browser_close_tab`) — **larger than C's**, because CDP
shapes force the ref↔id indirection and the CDP-shaped commands.

### 5.4 Protocol addition: client roles

Today the broker treats every authenticated relay as an app host (Firefox /
Thunderbird). The REPL worker would be a **third client category**. Add an
optional role to the handshake: `{type: handshake, token, role?: 'repl-worker'}`
— the broker tags the client and can restrict its advertised capability surface
(browser tools only; no mail/compose/contacts; no creating sessions that other
apps see in listings). Same token auth, same 0600/0700 files; no new network
surface.

### 5.5 Costs specific to B

- Permanent fork maintenance of a 0.1.0 package that ships fast (prompt,
  worker, compaction, image pipeline churn) — every upstream release is a
  re-merge against our seam.
- The worker becomes an ACP client: it must implement `initialize`/hello,
  session lifecycle, notification handling, and the permission round-trip —
  i.e. a slim re-implementation of our host's client side, in the fork.
- Two codebases in flight (fork + repo) with the mapping duplicated between
  them (fork's PiConnection vs. repo's add-on deltas).
- The app process (user's) holds the broker token path; every `BrowserUse`
  instance spawns a worker that opens a broker client — fine, but it is a new
  consumer profile the broker has not had (mitigated by 5.4 role tagging).

---

## 6. B vs C — decision

| dimension | C (in-product REPL) | B (SDK fork) |
|---|---|---|
| no CDP/TCP (owner constraint) | ✅ none | ✅ none (UDS) |
| invariant 9 & security surface | ✅ zero deviation; host stays sole ACP client | ✅ no TCP; + new broker client role, token exposure to app/worker |
| product fit | the capability **is** our product: every pi session (sidebar) gets Browser-Use-style scripting; diagnostics (console/network) already there | a third-party agent app uses our stack as a backend |
| "our pi instance" | literally: the ACP agent is the model loop | the SDK's own pi (in the app process) is the loop; our pi instance = tool executor |
| SDK identity / evals / history format | ✗ we run our agent (same design, our prompt) | ✅ the real `@browser_use/pi` |
| maintenance | one-time ~1 k-line port (MIT, attributed) into our repo, our test pyramid; upstream = reference | permanent fork re-merges of a fast-moving 0.1.0 |
| add-on deltas | small (structured a11y+rect, clickAt, focus/scroll, typeFocused?, open/close/list tabs) | larger (same + CDP-shape commands: key, setFiles, evalRef, rect-by-id) |
| e2e testability | direct: `PI_BROWSER_MOCK_SCRIPT` already scripts tool calls — a scripted model can drive `javascript` cells through the real host today's harness style | needs broker-third-client e2e + the SDK as a test dependency + scripted `models` collection |
| effort (v1) | ~2 weeks | ~2.5–3 weeks + ongoing |
| future upstream seam | irrelevant | if upstream ever adds a non-CDP transport, the fork pain ends |

**Decision (owner, 2026-09-14): C.** The requirement that the agent control
the user's **real** browser settles it. In C the controller is our pi instance
— the agent the user is already talking to in the sidebar, already bound to
their tab through the existing binding UX — so the REPL acts directly on the
user's live tab. In B the controller is an external headless SDK process in
the user's app that has to synthesize a tab binding out-of-band (the binding
UX lives in the add-on sidebar, tied to *our* sessions, not the worker's) — an
awkward fit for "the user's browser is in control." C also has the smallest
surface and lives fully in our test pyramid. **B remains only as a fallback**
if we later need to run the *actual* `@browser_use/pi` agent (its evals / 
history format / prompt identity) against our browser — a distinct goal from
"control the user's browser."

Note the two are not mutually exclusive long-term: C's mapping layer
(primitive→tool) and B's (CDP→tool) share ~70% of the add-on deltas; starting
with C keeps B cheap to bolt on later (the fork would reuse our
`pi:clickAt`/structured-a11y/tab tools).

---

## 7. Security analysis (both options)

| invariant (§49) | C | B |
|---|---|---|
| 1 allowed_extensions; 2 stdout protocol-only; 10 no separate bridge | ✅ unchanged | ✅ unchanged |
| 3 page content untrusted | ✅ cells execute page data only via content-script results (same as today's tools) | ✅ same |
| 4 page cannot initiate ACP prompt | ✅ | ✅ |
| 5 explicit session-bound tabs | ✅ by construction (ReplRuntime is per-session) | ✅ worker owns one session, bound explicitly; + role tagging (5.4) keeps its surface browser-only |
| 6–8 Pi owns execution / schemas / bounded inputs | ✅ `javascript` is a schema'd tool; cells bounded by timeout + child kill | ✅ same + SDK's own worker sandbox caveats apply (agent code can `require`/`fetch` in the app's worker — SDK-stated contract; document for users) |
| 9 no localhost TCP | ✅ | ✅ (UDS only) |

New disclosure for C's README/PRODUCT.md: the REPL cell runs in a child
process with Node globals (minus `require` in v1) and a per-session workspace
directory — same class as the SDK's worker ("not a security sandbox"), now
inside our host.

---

## 8. Implementation plan (Option C; B fallback in parens)

**Executable task-by-task plan: [`docs/BROWSER-USE-REPL-PLAN.md`](./BROWSER-USE-REPL-PLAN.md)**
(P0 prototype → P1 `javascript` tool + session wiring → P2 primitives +
add-on deltas → P3 hardening/docs; ~2 weeks; each phase CI-green). The
summary below is kept for context; the plan doc is authoritative.

### Phase 0 — REPL child prototype (0.5–1 day)
Bare ReplWorker child (node:inspector realm, one cell, curated globals) +
host-side runtime (spawn/IPC/timeout-kill) + a stub tool backend.
**Exit**: a cell with top-level await + `require`-less globals + synchronous
infinite loop killed by timeout without killing the host; state persists
across cells. (B: instead, prove a broker third-client handshake from a
standalone script — ~1 h.)

### Phase 1 — `javascript` tool end-to-end (4–6 days)
Protocol: `javascript` ToolSpec + `browserToolVersion` bump. Host: ReplRuntime
per session (port of `src/runtime.ts` cell discipline: one cell at a time,
output file, 1 MB capture, maxOutputChars, redaction, images ≤4/8 MB, partials).
Worker: port of `src/worker.ts` realm/output/`artifact`/`checkpoint`/
`reconnect` (~350 lines, MIT attribution in header) with `page/tabs` stubbed
to IPC tool calls. Tests: unit (runtime cell discipline), e2e through the real
host with the mock backend scripting `javascript` cells (`PI_BROWSER_MOCK_SCRIPT`)
against the fake add-on.

### Phase 2 — primitives + add-on deltas (4–5 days)
`page.*`/`tabs.*` per §4.2; add-on: structured a11y nodes (+rect),
`pi:clickAt`/`pi:focus`/`pi:scroll`/`pi:typeFocused`, `browser_open_tab`/
`browser_close_tab`/`browser_list_tabs`; tool description with ref-based
recipes (adapted from the SDK prompt, incl. its guardrail paragraphs).
Live-Firefox pass: "scrape + interact across a multi-step flow using the
javascript tool", recorded in `docs/VERIFICATION.md`.

### Phase 3 — hardening + docs (2–3 days)
rebind/unbind handling + stale-handle notes; timeout matrix; multi-session
isolation (two REPLs, two tabs, A/B test); cancellation; image pipeline caps;
workspace dir lifecycle; PRODUCT.md section (new §"Browser-Use-style REPL" +
§50 entry) and README quickstart; VERIFICATION.md live table.

**Total ≈ 2 weeks to v1.** (B fallback: Phase 0 handshake proof → fork plumbing
(browser.ts/protocol.ts/runtime.ts/worker.ts) → `pi-connection.ts` with the
§5.3 mapping → broker role tagging → add-on deltas (A-set) → e2e with the real
SDK + scripted `models` collection → live pass. ≈ 2.5–3 weeks + fork upkeep.)

> **Status (v1, option C): all four phases complete.** Phases 0–1:
> `repl: phase 0 core` / `repl: phase 1 — javascript tool + session wiring`;
> phase 2a (add-on): `repl: phase 2a — add-on primitives`; phases 2b/3
> (e2e + hardening): `repl: phase 2b/3`; docs + live verification: see
> `VERIFICATION.md` and the `repl: docs + live verification` commit.

### Test pyramid (C)

| layer | evidence |
|---|---|
| ReplRuntime (cell discipline, kill-on-timeout, redaction, image caps) | unit, node:test |
| `javascript` ToolSpec + session binding (no tab → structured error; rebind invalidation) | unit + addon.test.ts style |
| add-on: structured a11y shape, clickAt atomicity, tab tools | smoke-content-dom.mjs style (real bundles) + dispatcher tests |
| e2e: scripted model drives `javascript` cells through the real host + fake add-on (navigate → evaluate → screenshot image in result → checkpoint file) | tests/src/e2e.test.mjs extension |
| live Firefox | quickstart-style task + multi-step flow; VERIFICATION.md session ids |

---

## 9. Open questions

1. **Tab scope** (pending owner call) — "control the user's browser" can mean:
   **(a)** the session's **bound tab** only (current security model, invariant
   §49.5: explicit session→tab binding; the agent's `page.*` acts on that one
   live tab; `tabs.open` creates auxiliary REPL-owned tabs, closed at session
   end) — or **(b)** **any tab** in the user's browser (the agent can
   list/switch/operate on any of the user's tabs), a broader grant that
   changes invariant 5 and needs its own permission/approval story. **Default
   for v1: (a)** + auxiliary tabs. (b) is a later, explicitly-enabled
   extension, not a v1 blocker.
2. **`javascript` availability**: always (with `BROWSER_NOT_BOUND` errors) vs.
   only when the session has a bound tab. Leaning: always — the tool can
   explain what's missing; sessions often bind late.
3. **Realm `require`**: v1 without (decided above); revisit on first real
   workflow that needs libraries (the SDK allows it; our disclosure differs).
4. **REPL-owned tabs**: `tabs.open` creates session-owned tabs closed at
   session end (SDK parity) — confirm the add-on's tab-ownership model can
   track "repl-owned" vs "user-bound" (a `store` flag in the binding store;
   small).
5. **Prompt placement**: tool description (always visible, costs tokens every
   turn) vs. config-option/first-use preamble. Leaning: terse description +
   full recipe on first call result (the SDK teaches in its system prompt;
   we can teach in the first cell's preamble, cheaper).
6. **Node pinning**: the ReplWorker child runs on the host's Node (already
   ≥22.19 in our env — undici 8.9.0); no new requirement beyond the host's.
   (B would document `BROWSER_USE_NODE` for the SDK worker instead.)
7. **Upstream**: if we ever pick B, propose the non-CDP transport seam
   (transport descriptor in WorkerConfig) upstream so the fork thins over time.
