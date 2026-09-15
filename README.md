# Pi Browser Agent

A Firefox MV3 add-on that is a **full ACP (Agent Client Protocol) client for [Pi](https://pi.dev)**,
plus a Pi package (`@pi-browser/agent`) that provides the **`com.matbee.agent` Native Messaging host** (application-neutral: Firefox + Thunderbird).

Pi can inspect and operate a tab bound to a session — read page content/DOM (or a compact
accessibility tree), click and type into referenced elements, wait for selectors, evaluate page
JavaScript (page world, via Firefox user scripts), read the page console (JS errors, unhandled
rejections, failed loads) and the tab's network requests (4xx/5xx, blocked, timing), hit-test
viewport coordinates, navigate, reload, and take permission-gated screenshots — including inside
child frames (an optional `frame` argument targets any frame by id or URL; `browser_get_dom`
reports the frame's iframes and says so when the DOM is thin) and open web-component shadow
roots — while all
browser content flows to Pi as **untrusted tool data** (never into the prompt). The flagship workflow:
*“look at the app in this tab, find why the interaction is broken, inspect source, fix it, reload,
verify.”*

The product specification lives in **[PRODUCT.md](PRODUCT.md)** (single source of truth for
architecture and security invariants). Live verification evidence for the §52 Definition of Done:
**[docs/VERIFICATION.md](docs/VERIFICATION.md)**.

## Layout

```
packages/protocol/    dependency-light protocol package (shared by Firefox + Node)
packages/pi-agent/    the Pi package: native host, ACP↔Pi SDK adapter, installers, /pi-browser
firefox/              the Firefox add-on (background / content script / sidebar)
tests/                integration harness: real host + real framing + fake tab set
docs/                 verification record + evidence
```

## Quick start

Requires **Node 22+** (the host uses Pi SDK APIs that need it) and a stable/nightly Firefox.

### Order A — install the plugin first

The plugin (`@pi-browser/agent`) installs from this repository as a pi package
(requires Node.js >= 22 available on the machine; pi clones the repo and builds
the plugin automatically on install):

```sh
pi install git:github.com/matbeedotcom/pi-agent-firefox@v0.1.1
```

1. In any Pi session: `/pi-browser install` — registers the Firefox Native Messaging host.
2. Load the add-on: Firefox → `about:debugging#aboutThisFirefoxBrowser` →
   **“Load Temporary Add-on…”** → pick `firefox/dist/manifest.json`
   (from source: clone the repo and run `sh build.sh` first — see
   “Building from source” below).
3. Done — the sidebar shows `Pi · agent` (connected). Verify anytime with `/pi-browser doctor`.

### Order B — install the add-on first

1. Build + load the add-on as above (`firefox/dist/manifest.json`).
2. The sidebar shows the **“Connect Pi Browser to Pi”** screen — the add-on is waiting for the
   host. Install the plugin (step 1 of Order A), then `/pi-browser install`.
3. **No reload needed** — the add-on auto-detects the installed host within ~10 s
   (always-on keepalive). The screen disappears on its own, or press **“Check again now”**.

Both orders self-heal: `~/.pi-browser/client.heartbeat` (written by the host when the add-on
connects and on every keepalive ping) is what `/pi-browser status` and `doctor` use to report the
add-on side — `add-on: detected (heartbeat Ns ago)` / `last heartbeat … (stale)` /
`not detected` with step-by-step guidance.

### `pi_*` session control

With an MCP-capable client, the add-on also serves `pi_new_session`, `pi_select_session`,
`pi_prompt`, `pi_cancel`, `pi_close_session`, `pi_get_state`, `pi_bind_current_tab`,
`pi_unbind_tab`, `pi_open_bound_tab`, `pi_set_config_option` over MCP-over-ACP — the same
handlers the sidebar uses.

### Browser scripting: the `javascript` REPL

Page evaluation requires Firefox 153+ and the optional **user scripts** permission.
The first `page.evaluate` call shows an **Enable UI automation?** tool permission
request in the Pi sidebar. Click **Enable page evaluation**, then accept Firefox’s
permission prompt (check the user-scripts box, then click **Allow**). The waiting
call continues automatically; later calls skip the prompt while permission is granted.
Existing tabs work immediately. `page.evaluate` uses
`userScripts.execute` to compile scripts directly in the page world, preserving
page globals even when a site’s CSP blocks `eval`/`Function`. The site’s CSP and
the extension’s CSP remain unchanged. Other navigation and DOM tools work
without this optional permission.

Beyond the individual `browser_*` tools, the agent can call a persistent
`javascript` tool — a Browser-Use-style REPL bound to the session's tab. A
cell runs in a long-lived V8 realm (state persists across cells) with a
`page` object (`goto`, `snapshot`, `evaluate`, `waitFor`, `click`, `clickAt`,
`type`, `typeFocused`, `focus`, `scroll`, `screenshot`) and a `tabs` object
(`list`, `open`, `get`). Typical cell:

```js
const s = await page.snapshot();
const go = s.nodes.find((n) => n.role === "button" && n.name === "Go");
await page.click(go.ref);
await page.waitFor("() => document.title.includes('Done')", undefined, { timeoutMs: 10000 });
const shot = await screenshot();
```

Every `page.*` call goes through the normal browser-tool path (same
permissions, same bound tab). Screenshots from a cell prompt for approval
just like a direct `browser_screenshot`; `tabs.open()` tabs are closed when
the session ends. Design: PRODUCT.md §53.

You don't have to write the cell yourself. With a tab bound, just ask in
plain language and the agent picks the `javascript` tool and walks the tab
(observe → act → verify → persist), saving a checkpoint you can inspect:

```text
> In the tab you're bound to, find the Go button and click it, then tell me
  what the state text shows. Take a screenshot as evidence and save a
  checkpoint (live-walk.json) with the title, the resulting state, and the
  button's element ref.
```

The steering for that (tool description + first-call preamble + the
`browser-walk` skill) is described in PRODUCT.md §54.

## `/pi-browser` commands

| Command | Effect |
|---------|--------|
| `/pi-browser` (no arg) | `status` |
| `/pi-browser install` | register (re-)install the Native Messaging host |
| `/pi-browser status` | host state + add-on detection (heartbeat) |
| `/pi-browser doctor` | status + live framed host probe + add-on detection |
| `/pi-browser uninstall` | remove the registration |

## Using Firefox and Thunderbird together (cross-app broker)

Both add-ons connect to the same `com.matbee.agent` host, and the host makes the two
apps usable **from each other** — no extra setup beyond loading both add-ons and having
the host installed:

1. **First app to connect = broker.** It owns the Pi sessions and listens on private OS IPC
   (`~/.pi/run/agent-broker.sock`, 0600; Windows: single-app mode for now).
2. **Second app = relay.** Its host process transparently forwards the app's Native
   Messaging pipe into the broker. Native Messaging stays the only visible app boundary;
   there is no localhost TCP. If the broker is gone, the roles simply re-elect on the next
   connection — the add-ons' normal reconnect logic handles all of it.
3. **Every session sees every connected app's tools** (capabilities from each app's
   `pi.agent.hello`). Tool calls route to the app that provides the tool:
   - A session in the **Firefox sidebar** can call `mail_*`, `compose_*`, `contacts_*`
     → executed by the **Thunderbird** add-on.
   - A session in the **Thunderbird pane** can call `browser_*`
     → executed by the **Firefox** add-on (bind a tab to the session in the Firefox
     sidebar for browser tools to have a page to act on).
4. **Check the wiring:** `/pi-browser status` / `doctor` report per-app heartbeats and the
   broker state (`broker: running (pid N) — cross-app tool routing active`).
5. **Example flagship prompt** (either app): *“Look at the email Alice just sent about the
   login problem, reproduce it in the tab, fix it, and draft a reply.”* — one session,
   both apps.

Notes: a session's tool surface is fixed when the session is created (union of the apps
connected at that moment); a provider that connects later is used by sessions created
afterwards. Email content reaches Pi as untrusted tool data, exactly like page content,
and every mail-surface tool (read, compose, mutation, contacts) is approval-gated:
before the LLM's first call to a given tool runs, the app that executes it shows an
**Allow once / Allow for this session / Always allow / Deny** prompt
(always-allow sticks for the host's lifetime; session-allow for the session,
so each tool asks at most once per scope). When the prompt shows in the OTHER
app (cross-app), the session-owner UI draws attention with a banner —
“🔔 `mail_…` is waiting for your approval in **Thunderbird (mail)** — the prompt
will appear in your mail client” — and dismisses it when the tool finishes.
Verified live + integration: [docs/CROSS-APP-VERIFICATION.md](docs/CROSS-APP-VERIFICATION.md).

## Building from source (build instructions)

### Environment requirements

| Requirement | Version | Notes |
|---|---|---|
| Operating system | Any (Linux, macOS, Windows) | Developed/tested on Linux (x86-64); the build is cross-platform Node.js |
| Node.js | **>= 22** (tested on 22.22.3) | `https://nodejs.org` or your distro package manager. Node 21 crashes the Pi SDK import; the repo `engines` field enforces >= 22 |
| npm | >= 10 (ships with Node 22) | Used only for dependency installation |
| Network | npm registry at install time only | `npm ci` fetches pinned dependencies from `package-lock.json`; no other network access is needed |
| Other | none | No compiler toolchain, no system libraries, no browser required to build |

### Steps (exact)

```sh
git clone https://github.com/matbeedotcom/pi-agent-firefox.git
cd pi-agent-firefox
sh build.sh          # 1) verifies node >= 22  2) npm ci  3) npm run build
```

`build.sh` runs the complete technical pipeline:

1. Verifies the Node.js version (>= 22) and npm presence.
2. `npm ci` — installs the exact dependency versions pinned in `package-lock.json`
   (workspaces: `packages/protocol`, `packages/webext`, `packages/pi-agent`,
   `firefox`, `thunderbird`, `tests`).
3. `npm run build` — builds in dependency order: `@pi-browser/protocol` (tsc) →
   `@pi-browser/webext` (tsc) → `@pi-browser/agent` (tsc, the native host) →
   `firefox` and `thunderbird` (tsc `--noEmit` type-check gate, then esbuild 0.25.x
   bundles each TypeScript source into the classic scripts shipped in the add-on;
   see the add-on submission's tooling note for details).

Output: `firefox/dist/` is the loadable Firefox add-on (the exact code in the
AMO submission zip, rebuilt by `sh amo/make-zip.sh`), `thunderbird/dist/` the
Thunderbird add-on.

Optional verification:

```sh
npm test             # 257 tests across the workspaces (Node 22+)
sh amo/make-zip.sh   # rebuild the AMO submission zip from firefox/dist
```

- **Tests** run the real built host over real Firefox 4-byte framing with a deterministic mock
  backend and a fake tab set (`tests/src/e2e.test.mjs`); Firefox-side logic is unit-tested with
  API stubs. Use a Node 22 binary (e.g. `export PATH="$(node22-dir)/bin:$PATH"`) — Node 21 crashes
  the Pi SDK import.
- **Content-script smoke probe** (fake DOM, real built bundles): `node .probe/smoke-content-dom.mjs`
  (`SLOW=1` adds the 15 s page-eval fallback path).
- **Live smoke test** (real Pi backend, no mock): `node .probe/smoke-host.mjs`.
- The loadable add-on is **`firefox/dist/`** (built), not the `firefox/` source dir.
- For confined browsers (e.g. snap Firefox), the host launcher must exec a node that lives under
  `$HOME`; see the committed `packages/pi-agent/native/pi-browser-host`.

## Security posture (PRODUCT.md §49, condensed)

- stdout of the native host is protocol data only (logs → stderr)
- no localhost TCP; Native Messaging stdio framing only
- the host ships inside the Pi package — nothing separately downloaded
- page/DOM content is untrusted tool data, never concatenated into ACP prompts
- web pages cannot initiate prompts; tools resolve explicit session→tab bindings
  (`BROWSER_NOT_BOUND` / `BROWSER_TAB_CLOSED`, never silent fallback)
- `browser_screenshot` is permission-gated via ACP `session/request_permission`
  (allow once / allow for this session / always / deny; deny or timeout → `BROWSER_PERMISSION_DENIED`)
- Thunderbird mail tools (read, compose, mutations, contacts) are approval-gated
  the same way — the prompt is asked in the app that EXECUTES the tool (Thunderbird,
  in its Pi Space or side pane); deny or timeout → `BROWSER_PERMISSION_DENIED` and
  the dispatcher is never reached
- full checklist with code locations: [docs/VERIFICATION.md](docs/VERIFICATION.md)
