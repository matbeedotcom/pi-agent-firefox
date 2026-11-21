<img src="assets/icon.svg" alt="Pi Browser Agent icon" width="96" align="right">

# Pi Browser Agent

A Firefox MV3 add-on (and a Thunderbird add-on) that is a **full ACP (Agent Client Protocol) client for [Pi](https://pi.dev)**,
plus the host package **`trusted-user-agent`** (npm; command `trusted-ua`, also installable as a pi package) that provides the **`com.matbee.agent` Native Messaging host** (application-neutral: Firefox + Thunderbird). It works with other agents both ways:

- **Chat with Claude Code or Codex inside the apps:** a sidebar, Space or pane session can run on Claude Code, Codex or another ACP agent instead of pi, with the browser and mail tools at hand — see [Chat with Claude Code or Codex in the sidebar](#chat-with-claude-code-or-codex-in-the-sidebar).
- **Use the tools from agents outside the apps:** the same host serves the Firefox and Thunderbird tools to **any MCP client** — Claude Code, Codex, Cursor, Gemini CLI, VS Code, pi — see [Use the tools from other agents](#use-the-tools-from-other-agents).

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

For focused tests, live probes, host logs, and Thunderbird debugger attachment,
see **[Debugging ACP/MCP tools](docs/DEBUGGING-TOOLS.md)**.

## Layout

```
packages/protocol/    dependency-light protocol package (shared by the add-ons + Node)
packages/webext/      add-on code shared by Firefox and Thunderbird (ACP client, session store, panels)
packages/trusted-user-agent/    trusted-user-agent: native host, ACP↔Pi SDK adapter, ACP relay to external
                      agents (Claude Code, Codex, ...), MCP server, installers, /pi-browser
firefox/              the Firefox add-on (background / content script / sidebar)
thunderbird/          the Thunderbird add-on (background / Space / side pane)
tests/                integration harness: real host + real framing + fake tab set
docs/                 verification record + evidence
```

## Quick start

Requires **Node 22+** (the host uses Pi SDK APIs that need it) and a stable/nightly Firefox.

### Order A — install the plugin first

Without pi, install the host from npm and register it:

```sh
npm i -g trusted-user-agent
trusted-ua install          # firefox | thunderbird | mozilla (default: both)
trusted-ua doctor
```

With pi, the plugin (`trusted-user-agent`) installs from this repository as a pi package
(requires Node.js >= 22 available on the machine; pi clones the repo and builds
the plugin automatically on install):

```sh
pi install git:github.com/matbeedotcom/pi-agent-firefox@v0.4.0
```

1. In any Pi session: `/pi-browser install` — registers the Firefox Native Messaging host.
2. Load the add-on: Firefox → `about:debugging#aboutThisFirefoxBrowser` →
   **“Load Temporary Add-on…”** → pick `firefox/dist/manifest.json`
   (from source: clone the repo and run `sh build.sh` first — see
   “Building from source” below).
3. Done — the sidebar shows `Pi · agent` (connected). Verify anytime with `/pi-browser doctor`.
4. Optional: to chat with Claude Code or Codex instead of pi, install its ACP adapter and pick it
   in the new-session panel — see [Chat with Claude Code or Codex in the sidebar](#chat-with-claude-code-or-codex-in-the-sidebar).

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
`pi_bind_tab`, `pi_open_tab`, `pi_list_tabs`, `pi_unbind_tab`, `pi_open_bound_tab`,
`pi_set_config_option` over MCP-over-ACP — the same handlers the sidebar uses.
`pi_open_tab` creates a tab and binds it in one step (works even when the session has no
bound tab yet), `pi_bind_tab` binds an existing tab by id, and `pi_unbind_tab` releases it —
the agent manages its own tab lifecycle.

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
(`list`, `open`, `get`). Cells can also read and write files through `fs`
(`read`, `write`, `append`, `list`, `stat`, `exists`, `mkdir`, `rename`,
`unlink`, `rm`) — confined to the session's task workspace, the same
directory `checkpoint()`/`artifact()` write into; paths outside it are
rejected. Typical cell:

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
| `/pi-browser status` | host state + add-on detection (heartbeat) + sidebar agents (available or not, `agents.json` problems) |
| `/pi-browser doctor` | status + live framed host probe + add-on detection + sidebar agents |
| `/pi-browser uninstall` | remove the registration |
| `/pi-browser mcp [install\|status\|uninstall] [client]` | register the broker's MCP server in `~/.pi/agent/mcp.json` so Pi subagents can use the add-on tools: `browser_*` + `javascript` (Firefox) and `mail_*`, `compose_*`, `contacts_*` (Thunderbird). Each call runs in the app that serves the tool. The entry launches a small stdio bridge, so it works with pi's built-in MCP client (tools appear as `mcp__pi-browser__<tool>`, loaded on demand via `tool_search`; change the exposure in `/mcp`) and with pi-mcp-adapter (`mcp:pi-browser/<tool>`). It works before Firefox/Thunderbird start; calls succeed once an app with the add-on is running. `client` is `pi` (default) or another MCP client — see below. |

`trusted-ua [install|status|doctor|uninstall] [app]` and `trusted-ua mcp [install|status|uninstall] [client]`
do the same without pi (after `npm i -g trusted-user-agent`).

## Use the tools from other agents

Any MCP client can use the Firefox and Thunderbird tools while either app is running — no
Pi chat needs to be open. (This is for agents you run outside the apps, in a terminal or an
editor. To chat with Claude Code or Codex *in* the sidebar, see
[the next section](#chat-with-claude-code-or-codex-in-the-sidebar); that needs no MCP setup.) Register the `pi-browser` MCP server (a small stdio bridge) in your
client's user config:

| Client | Command | Where the entry goes |
|--------|---------|----------------------|
| pi | `trusted-ua mcp install` (or `/pi-browser mcp install`) | `~/.pi/agent/mcp.json` |
| Claude Code | `trusted-ua mcp install claude` | user scope, through `claude mcp add-json` |
| Codex | `trusted-ua mcp install codex` | `~/.codex/config.toml` (through `codex mcp add` when available) |
| Cursor | `trusted-ua mcp install cursor` | `~/.cursor/mcp.json` |
| Gemini CLI | `trusted-ua mcp install gemini` | `~/.gemini/settings.json` |
| VS Code | `trusted-ua mcp install vscode` | the user `mcp.json` |
| every client found | `trusted-ua mcp install all` | each of the above that is installed |

`mcp status [client]` reports each entry as missing, current or stale (for example after the
package moved); `mcp uninstall [client]` removes only the `pi-browser` entry. Other servers and
settings in those files are never touched, and a file that can't be parsed is left as it is.

**How approval works for other agents**

- Each MCP connection is its own *caller session*: its own approvals, its own `javascript`
  REPL, nothing borrowed from your Pi chats. It ends when the agent disconnects.
- The first time an agent uses an app's tools, that app asks **"Allow codex to use Firefox
  tools?"** — *Allow this time*, *Always allow codex*, or *Deny*. Firefox and Thunderbird ask
  separately: allowing an agent in the browser doesn't open your mailbox to it.
- Every tool call still asks as set on the permissions page (Ask / Deny / Always approve),
  and the prompt names the agent: "claude-code wants to take a screenshot".
- Prompts from other agents open a small **approval window** in the app that runs the tool,
  even when the Pi sidebar or Space is closed. One window per app; further prompts queue in it.
  **Closing the window denies** what's waiting. While a prompt waits, the Pi toolbar button
  (Firefox) or Pi Space button (Thunderbird) shows a badge — clicking it brings the window back.
- Browser tools act on a tab bound to the connection: agents call `browser_list_tabs` +
  `browser_bind_tab` (or `browser_open_tab`) first. They can't take a tab that a Pi chat in the
  sidebar has bound.
- Agent names are what the agents report about themselves; they aren't verified. Any program
  running as your user can reach the host, so the approval is about knowing and consenting,
  not a security boundary.
- To turn it off: Pi settings → permissions → **Other apps (MCP)** → untick *Allow other apps
  (MCP) to use these tools*. Calls are then refused without a prompt. The same section lists the
  agents you allowed or denied, with **Revoke**.

Pi subagents that the host itself starts keep using the chat session they belong to.

## Chat with Claude Code or Codex in the sidebar

The new-session panel (Firefox sidebar, Thunderbird Space and pane) lets you pick the **agent**
a session runs on: **pi** (built in, the default), **Claude Code**, **Codex**, or any other ACP
agent you configure. The last choice is remembered per app, and the session list labels
sessions that don't use pi. The agent's replies, thinking, tool cards, file diffs, plans and
settings (model, mode, effort) show in the sidebar as the agent sends them.

**Requirements**

- The agent's ACP adapter on your `PATH`, and the agent logged in with its own CLI:

  | Agent | Install the adapter | Log in |
  |-------|---------------------|--------|
  | Claude Code | `npm i -g @agentclientprotocol/claude-agent-acp` | run `claude` once and log in |
  | Codex | `npm i -g @agentclientprotocol/codex-acp` | `codex login` |

  Agents that aren't found are shown disabled in the panel, with the missing command.
  `trusted-ua status` and `doctor` (and `/pi-browser status`) list them too.
- Nothing to set up in the agent's own config: each session gets the `pi-browser` tools
  automatically, tied to that sidebar session — its bound tab, its "allow for this session"
  approvals, prompts in the sidebar. Firefox sessions can still use Thunderbird's mail tools
  (and the other way round) when both apps run.

**Two kinds of prompts**

- *Tool prompts* ("Allow this action?" for `browser_screenshot`, `mail_search`, ...) are the
  add-on's own, the same as for pi sessions, governed by the permissions page.
- *Agent prompts* ("Codex wants to run a command", with the command or diff) are the agent's
  own permission requests, with the agent's own options. The add-on never remembers them:
  "Allow always" there is remembered by the agent. Unanswered prompts time out like tool prompts,
  and Stop withdraws them.

**How it runs**

- One process per agent, shared by its sessions, started on the first session. An agent with
  no activity for 15 minutes is stopped; the session stays in the sidebar and the next message
  starts the agent again and reloads the conversation. Agents that can't reload sessions are
  never stopped while a session is open.
- Sessions are listed with the others and reopen through the agent
  (`~/.pi/browser/agent-sessions.json` keeps the list).
- If the agent isn't logged in, creating a session says how to log in (for example "Codex needs
  you to log in: run `codex login` in a terminal, then try again"); the host never logs in for you.
  If the agent crashes, the turn ends with an error and the next message restarts it.
- One process serves both apps: a Claude Code session started in Thunderbird and one started
  in Firefox share the same Claude Code process.
- Claude Code and Codex work in the session's folder with their own tools and approval rules.
  New sessions default to a fresh `~/.pi/workspaces` folder, as for pi.

**`~/.pi/browser/agents.json`** adds agents or overrides a built-in one (changes apply to the
next session, no restart):

```json
{
  "agents": {
    "claude": { "command": "C:\\tools\\claude-agent-acp.cmd", "idleTimeoutMinutes": 30 },
    "my-agent": { "name": "My agent", "command": "my-agent", "args": ["--acp"], "env": { "MY_VAR": "1" } },
    "codex": { "disabled": true }
  }
}
```

Fields: `name`, `command`, `args`, `env`, `idleTimeoutMinutes` (0 = never stop), `loginHint`
(shown when the agent asks you to log in), `disabled`. Google's Antigravity CLI has no ACP mode,
so it isn't offered; an ACP agent that does speak ACP over stdio can be added here.

## Using Firefox and Thunderbird together (cross-app broker)

Both add-ons connect to the same `com.matbee.agent` host, and the host makes the two
apps usable **from each other** — no extra setup beyond loading both add-ons and having
the host installed:

1. **First app to connect = broker.** It owns the Pi sessions (and the Claude Code / Codex
   processes of agent sessions) and listens on private OS IPC
   (`~/.pi/run/agent-broker.sock`, 0600; Windows: a per-user named pipe
   `\\.\pipe\pi-agent-<hash>-agent-broker`, gated by the broker token).
2. **Second app = relay.** Its host process transparently forwards the app's Native
   Messaging pipe into the broker. Native Messaging stays the only visible app boundary;
   there is no localhost TCP. If the broker is gone, the roles simply re-elect on the next
   connection — the add-ons' normal reconnect logic handles all of it.
3. **Every session sees every connected app's tools** (capabilities from each app's
   `pi.agent.hello`), including sessions on Claude Code or Codex. Tool calls route to the app
   that provides the tool:
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
   (workspaces: `packages/protocol`, `packages/webext`, `packages/trusted-user-agent`,
   `firefox`, `thunderbird`, `tests`).
3. `npm run build` — builds in dependency order: `@trusted-ua/protocol` (tsc) →
   `@trusted-ua/webext` (tsc) → `trusted-user-agent` (tsc, the native host) →
   `firefox` and `thunderbird` (tsc `--noEmit` type-check gate, then esbuild 0.25.x
   bundles each TypeScript source into the classic scripts shipped in the add-on;
   see the add-on submission's tooling note for details).

Output: `firefox/dist/` is the loadable Firefox add-on (the exact code in the
AMO submission zip, rebuilt by `sh amo/make-zip.sh`), `thunderbird/dist/` the
Thunderbird add-on.

Optional verification:

```sh
npm test             # about 580 tests across the workspaces (Node 22+)
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
  `$HOME`; see the committed `packages/trusted-user-agent/native/pi-browser-host`.

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
- sessions on Claude Code, Codex or another ACP agent: the agent runs as you, in the session's
  folder, with its own tools and approval rules. Its own permission requests are shown in the
  session's UI and passed back as answered; the host never answers or remembers them. Its
  pi-browser tool calls go through the same approval prompts as pi's, and the host honours the
  session a bridge reports only from a process the host itself started (a forged report is
  treated as an external MCP caller). The host offers agents no client file system or terminal
- full checklist with code locations: [docs/VERIFICATION.md](docs/VERIFICATION.md)
