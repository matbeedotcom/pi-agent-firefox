# Pi Browser Agent

A Firefox MV3 add-on that is a **full ACP (Agent Client Protocol) client for [Pi](https://pi.dev)**,
plus a Pi package (`@pi-browser/agent`) that provides the **`dev.pi.browser` Native Messaging host**.

Pi can inspect and operate a tab bound to a session — read page content/DOM, click and type into
referenced elements, reload the tab, and take permission-gated screenshots — while all browser
content flows to Pi as **untrusted tool data** (never into the prompt). The flagship workflow:
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

```sh
npm install -g @pi-browser/agent        # or, from this repo: npm i -g packages/pi-agent
```

1. In any Pi session: `/pi-browser install` — registers the Firefox Native Messaging host.
2. Load the add-on: Firefox → `about:debugging#aboutThisFirefoxBrowser` →
   **“Load Temporary Add-on…”** → pick `firefox/dist/manifest.json`
   (from source, build it first: `npm run build`).
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

## `/pi-browser` commands

| Command | Effect |
|---------|--------|
| `/pi-browser` (no arg) | `status` |
| `/pi-browser install` | register (re-)install the Native Messaging host |
| `/pi-browser status` | host state + add-on detection (heartbeat) |
| `/pi-browser doctor` | status + live framed host probe + add-on detection |
| `/pi-browser uninstall` | remove the registration |

## Development

```sh
npm install
npm run build      # protocol + host + add-on (firefox/dist is the loadable build)
npm test           # 85 tests across 4 workspaces (Node 22)
```

- **Tests** run the real built host over real Firefox 4-byte framing with a deterministic mock
  backend and a fake tab set (`tests/src/e2e.test.mjs`); Firefox-side logic is unit-tested with
  API stubs. Use a Node 22 binary (e.g. `export PATH="$(node22-dir)/bin:$PATH"`) — Node 21 crashes
  the Pi SDK import.
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
  (allow once / always / deny; deny or timeout → `BROWSER_PERMISSION_DENIED`)
- full checklist with code locations: [docs/VERIFICATION.md](docs/VERIFICATION.md)
