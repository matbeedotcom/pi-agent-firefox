## Context

The host has three layers today:

1. **Add-on ⇄ host:** ACP over native messaging. The broker (the first `com.matbee.agent` process) runs one `AcpAgent` per connected add-on and keeps a capability registry, which records which app provides which tools.
2. **Tool execution:** `BrowserToolProvider.routeTool(sessionId, …, ownerClientId, ownerApplication)`. It resolves the target through `registry.resolveTarget(owner, tool)`, applies the approval policy, and sends either `x-pi-browser/tool` or MCP-over-ACP to the executing app. Approval prompts are `session/request_permission` messages to that app, keyed by tool call id. Firefox shows them in the sidebar, and re-shows them when the sidebar opens. Thunderbird broadcasts them to the Space and its panes.
3. **MCP access:**
   - `mcp-server.ts` serves the static 50-tool list on the broker's socket or named pipe.
   - Since v0.2.5, `mcp-stdio-bridge.ts` makes that reachable from any stdio MCP client.
   - Every `tools/call` goes to `toolBridge.call({tool, args})` with no session id. `main.ts` then falls back to `lastActiveBridgeSession`, which was designed for pi subagents of a sidebar session.

That fallback is the blocker. With no sidebar session the call fails (`SESSION_NOT_FOUND: no active ACP session`). With one, any local program borrows the user's chat session, including its "allow for session" grants and REPL state.

The host is started by the add-on whenever Firefox or Thunderbird is running: the background reconnects every 10 s. So the MCP server is available whenever an app is open, even if no sidebar or chat is open.

## Goals / Non-Goals

**Goals:**
- Any stdio MCP client can use the Firefox and Thunderbird tools while an app is running, without an open chat.
- Each external caller has its own approvals, REPL state and attribution.
- The user can see who is asking and can approve, remember, revoke or disable external callers.
- One command registers the bridge in the common MCP clients.
- The host and the MCP entries can be installed without the pi CLI.
- Today's behaviour for pi subagents of a sidebar session doesn't change.

**Non-Goals:**
- Running other ACP agents in the sidebar. That is step 2 and needs a separate change, though it reuses the caller-session work here.
- HTTP/SSE MCP transport. Every target client supports stdio.
- Authenticating callers. A caller name is whatever the client reports. Same-user processes are already trusted with the socket, so the caller approval protects against surprises, not against attackers.
- Changing the tool list or tool schemas.
- Renaming the add-ons, the native host id `com.matbee.agent`, or the `pi-browser` MCP server name. Only the npm package and its command get the new name (`trusted-user-agent`, `trusted-ua`) in this change (D8).

## Decisions

### D1. One caller session per broker connection

`mcp-server.ts` gives each accepted connection a caller session with id `mcp:<uuid>` and a record `{id, name, version, pid?, hostChild}`. Every `tools/call` on that connection runs as `toolBridge.call({tool, args, sessionId: caller.id, ctx})`. The context is `{ownerClientId: undefined, ownerApplication: <resolved target's app>, mode: "legacy", caller}`. When the socket closes, the server calls `closeSession(caller.id)`. The provider then drops grants and permission groups, and `repl.dispose(caller.id)` stops the worker.

- *Why per connection:* the stdio bridge holds one broker connection per MCP client process, and reconnects after a broker restart. So a connection lines up with "one running agent". Neither side needs extra state.
- *Alternative considered:* a caller id chosen by the bridge and sent with each call. This would survive broker restarts, but a restart already drops the provider's in-memory state, so there's nothing to keep. It would also let one caller send another's id.
- *Alternative considered:* one session per caller *name*. This would merge two separate Claude Code windows, which goes against isolation.

### D2. Caller identity: `pi-browser/caller` and `initialize`

The bridge already answers `initialize` itself, so it knows the client's `clientInfo`. When it connects to the broker (lazily), it first sends a notification `{"method":"pi-browser/caller","params":{"name","version","pid","hostChild"}}`. The broker reads the same `clientInfo` from `initialize` on direct socket connections, which is how pi-mcp-adapter-style clients connect. A notification never gets a response, so an older broker (v0.2.5) simply ignores it, because unknown notifications are already dropped. A newer bridge talking to an older broker therefore still works.

### D3. Telling host-spawned processes from external callers

At startup the broker sets `PI_BROWSER_HOST_CHILD=<broker instance uuid>` in its own `process.env`, so every process it spawns inherits it (pi subagents, and their MCP stdio servers). The bridge reports the value it sees in `hostChild`. When the value matches the running broker's instance id, the broker skips the caller session and uses today's `lastActiveBridgeSession` routing. A missing or different value means an external caller.

- *Why an env marker:* it's cheap and works on every platform. Walking the process tree on Windows needs WMI or CIM queries.
- *Risk:* an MCP client that starts stdio servers with a clean environment would drop the marker. The MCP TypeScript SDK's `getDefaultEnvironment()` passes only a short safe list. See Risks.
- *A stale value is harmless:* an old broker's id doesn't match the new one, so the caller is treated as external, which is the safe direction.
- *Checked (task 1.1):* pi 1.5.2's built-in client (`@earendil-works/pi-mcp`, `transports/stdio.js`) starts stdio servers with `{...process.env, ...entry.env}` unless the entry sets `inheritEnv: false`, so the marker reaches the bridge. pi-mcp-adapter connects to the socket directly (no bridge), so its calls are external callers named from `initialize`; that is the pre-v0.2.5 entry `mcp status` already reports as stale. The parent-pid fallback is implemented as well: the bridge reports `ppid`, and a bridge whose parent is the broker counts as a host child.

### D4. Routing needs no owner

The context has no `ownerClientId`, so `registry.resolveTarget(undefined, tool)` picks the first connected app that provides the tool. That is already how the registry behaves. The "no connected client provides tool" error gets a friendlier message from the server (`<tool> needs Thunderbird with the Pi add-on running`), derived from the tool's capability family in `tool-capabilities.ts`. REPL cells in a caller session call tools through the same `replExecutor` with no owner.

### D5. Caller approval comes before tool approval, in the provider, per app

A new check in `routeTool`, before the per-tool approval policy. It runs after the target is resolved, because the decision is per *executing app*. If the caller session isn't yet approved for that app, look in the permission store for `callers.<app>.<name> = "allow" | "deny"`. If there is no stored decision, send a `session/request_permission` to that app. That request uses a synthetic tool call `{title: "<name> wants to use <App> tools", kind: "other"}` and three options: `allow_once`, `allow_always`, `reject_once`. It shares the existing coalescing, timeout and cancellation code. Results are cached on the caller session per app; `allow_always` and deny are also persisted. With external access off (`externalAccess: false` in the store), calls are refused before any prompt.

- *Why in the provider:* this is where the prompt plumbing, timeouts and persistent rules already live. It also means the in-process and MCP paths can't drift apart.
- *Why reuse `session/request_permission`:* add-ons from before this change show it as a normal prompt with a readable title, so the feature still works for users who haven't updated their add-on.
- *Default on, with a one-time prompt (decided):* off by default would make the feature invisible. Silent on would let any local process read the current page without the user knowing.
- *Per app (decided):* mail access is more sensitive than the browser. Approving `codex` for Firefox must not approve it for the mailbox. Each app shows its own caller prompt, in the app whose data it opens.

### D6. External callers are asked in an approval window

`sendPermissionRequest` adds `_meta.piBrowser.caller = {name, version}` for caller sessions. When the add-on sees that field, it shows the prompt in an approval window instead of the sidebar or Space. Prompts from the add-on's own chat sessions (no `caller`) keep today's behaviour.

- **The window:** a shared page `approval/approval.html` (source `packages/webext/src/approval/`), opened by the background with `windows.create({type: "popup", url, width, height})` followed by `windows.update(id, {focused: true})` and `windows.update(id, {drawAttention: true})`. Thunderbird 160 rejects `focused` inside `createData` ("unsupported"), so it is not passed there. The page renders "<name> wants to …" with the shared prompt text (`describePermissionRequest`).
  - An emptied window stays open for 1.5 s before closing, so the tool prompt that follows a caller approval appears in the same window instead of a new one.
  - The host withdraws a prompt it no longer needs (timeout, or the caller disconnected) with the notification `x-pi-browser/permission_withdrawn`; the window drops it.
- **Focus on Windows (checked, task 1.3):** with another program in the foreground (a full-screen game in the live check), Firefox 160 opened the popup and reported it focused *inside Firefox*, but Windows kept the other program in front (foreground lock). So on Windows the popup does not come to the front by itself: the taskbar flash (`drawAttention`) and the toolbar badge are what the user sees, and clicking the toolbar button brings the window up.
  - At most one window per app. New prompts queue in it, and it shows them one at a time, oldest first.
  - It closes itself when nothing is waiting: answered, timed out, or answered elsewhere.
  - Closing it with prompts still showing answers them all as Deny once.
- **Why a window, always:** someone using an outside agent is usually in their terminal or editor, not looking at Firefox or Thunderbird. A badge, or a prompt inside an open sidebar in a background window, goes unseen until the 120 s timeout. Then the agent fails and the user doesn't know why. The window is the one surface that appears on its own.
- **Why not the sidebar or Space:** Firefox's `sidebarAction.open()` needs a user gesture, and opening the Space would take over the user's current Thunderbird tab. Neither can come to the front from the background.
- **Backup badge:** while any prompt is waiting, `browser.action.setBadgeText` (Firefox) or the Pi Space button badge (`spaces.update`, Thunderbird) is set. Clicking the button with a prompt waiting focuses the approval window (`windows.update(id, {focused: true})`). This covers the OS refusing to give the new window focus.
- **No new permissions:** `windows.create` and badges need none in either app. A `notifications` permission would show a permission warning on update.
- **Older add-ons:** an add-on built before this change ignores `caller` and shows the prompt in its sidebar or Space as today.
- **Thunderbird's button:** the Pi Space button is bound to the docked Pi pane, and extensions get no click event for it. So opening the pane or the Space page while a prompt waits asks the background to focus the approval window.
- **Tabs for callers (added during implementation):** a caller session starts with no bound tab; `browser_list_tabs` + `browser_bind_tab` (or `browser_open_tab`) work without one, and the MCP `instructions` say so. A caller can't bind a tab that one of the user's chat sessions has bound (the user's session can take a caller's tab). When the caller disconnects, the host sends `x-pi-browser/session_ended` and Firefox releases the binding and closes the caller's REPL tabs; on reconnect to a host, Firefox also drops stale `mcp:` bindings.

### D7. Installer client adapters

`installer/mcp.ts` gets one small adapter per client, each with `{detect(), read(), upsert(entry), remove(), describe()}`:

| Client | Mechanism | Location |
|---|---|---|
| `pi` | JSON file (as today) | `~/.pi/agent/mcp.json` → `mcpServers` |
| `claude` | `claude mcp add-json --scope user pi-browser '<json>'` / `claude mcp remove --scope user pi-browser`; status from `claude mcp get pi-browser` | Claude Code's user config (owned and edited by its CLI) |
| `codex` | `codex mcp add` / `remove` when the CLI exists; otherwise a careful TOML table write | `~/.codex/config.toml` → `[mcp_servers.pi-browser]` |
| `cursor` | JSON file | `~/.cursor/mcp.json` → `mcpServers` |
| `gemini` | JSON file | `~/.gemini/settings.json` → `mcpServers` |
| `vscode` | `code --add-mcp '<json>'` when available; otherwise JSON file | user `mcp.json` → `servers` (path differs per platform) |

The entry fields are the same everywhere: `{command: <node>, args: [<bridge>]}`, plus `type: "stdio"` where the client needs it. `pi` keeps its `directTools` and `exposure` keys.

*Checked (task 1.2), and what was built:*
- `claude mcp add-json [--scope user] <name> <json>` and `claude mcp remove --scope user <name>` (Claude Code 2.x). Status reads the user config read-only: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set. Live check: `claude mcp list` shows `pi-browser ✔ Connected`.
- `codex mcp add <name> -- <command> <args…>` / `codex mcp remove <name>`. The CLI writes TOML *literal* strings (`command = 'C:\…'`), so the reader parses basic and literal strings and multi-line arrays. `CODEX_HOME` is honoured.
- `~/.claude.json`, `~/.codex/config.toml` and the VS Code user `mcp.json` (`{"servers": …, "inputs": []}`) were confirmed on this machine. Cursor and Gemini CLI aren't installed here; their file formats (`mcpServers`) follow their docs.
- VS Code is file-only: `code --add-mcp` was not used, because the file needs reading for status anyway. A `mcp.json` that isn't strict JSON (comments) is reported and left alone, as the spec requires.
- An unparseable `~/.pi/agent/mcp.json` is now refused too (it used to be overwritten).

- **Codex without its CLI:** the writer replaces or appends only the `[mcp_servers.pi-browser]` table, using text operations at table boundaries. It doesn't round-trip the TOML through a library, because that would rewrite the user's formatting and comments. This is checked with snapshot tests.
- *Why use the CLIs where they exist:* Claude Code's user config is a large file the running app rewrites. Editing it directly risks lost updates.

### D8. Publish to npm as `trusted-user-agent` (CLI `trusted-ua`), and the stable-location check

**Decided (2026-11-20):** publish the agent package to npm as **`trusted-user-agent`**, with the command **`trusted-ua`**. Both are unscoped and were free on npm on that date, so no npm org is needed.

Why this name: "user agent" is the web-standards term for the browser or mail client itself. So the name reads as "your user agents (Firefox, Thunderbird), made safe for AI agents", in the same register as the Trusted Web initiative.

Names ruled out:
- `trusted-agent`: Visa's Trusted Agent Protocol (October 2025) is a standard for shops to verify AI agents at checkout. The bare name would read as an implementation of it.

The naming rules that were applied:
- `pi-browser` (unscoped) is already taken on npm.
- `@pi-browser/agent` is free, but publishing under the `@pi-browser` scope needs that npm org created first.
- Avoid "Firefox", "Thunderbird" and "Mozilla" in the name: Mozilla's trademark policy limits their use in product names.
- The package is no longer only for pi, so the name shouldn't need pi to make sense.

Packaging:
- `packages/pi-agent/package.json` takes the new `name` and gets `"bin": {"trusted-ua": "dist/installer/cli.js"}`, with a shebang on the CLI. Its `files` already limit what's published to `dist`, `extensions` and `native`; the `*.map` files and generated `native/*` launchers must be excluded.
- **`@pi-browser/protocol`:** the agent depends on it at runtime. Bundle it into `trusted-user-agent` (`bundleDependencies`) rather than publish a second package. The workspace package names (`@pi-browser/*`) stay as they are inside the repo.
  - *As built:* `prepack` (`scripts/bundle-protocol.mjs copy`) copies the built protocol into `packages/pi-agent/node_modules/@pi-browser/protocol` (the workspace symlink in the root `node_modules` is not bundled by `npm pack`); `postpack` removes it.
  - The bundled copy's `package.json` has **no `dependencies`**: npm treats a bundled package's dependencies and peers as part of the bundle and never installs them, which left empty `@agentclientprotocol/sdk` and `zod` directories in a real global install. The script checks that every protocol dependency is declared by `trusted-user-agent` itself, so npm installs it next to the bundle.
  - `files` excludes `*.map`, `*.d.ts` and the generated `native/*` launchers, and now includes `skills/` (the installer copies `skills/browser-walk/SKILL.md`). The package also carries `pi.extensions`, so `pi install npm:trusted-user-agent` works too.
  - License: MIT (decided 2026-11-20 for the v0.3.0 release): `LICENSE` at the repo root, a copy in `packages/pi-agent/` (npm ships it), and `"license": "MIT"`.
- **Release:** `npm publish` (with provenance from CI, or by hand with 2FA) after the GitHub release, at the same version as the tag.
- **pi:** `pi install git:…` keeps working. The repo's root `package.json` keeps its `pi.extensions` entry, and the root gets the same `bin` pointing into `packages/pi-agent`. `/pi-browser …` stays the pi command name.

`runCommand` rejects a `pkgRoot` that contains a `_npx` path segment or sits under `os.tmpdir()`, unless `--allow-temporary` is passed (for tests). The native-host launcher (`native/pi-agent-host.cmd` or `.sh`) and the manifest are written under `pkgRoot` exactly as today. For a global npm install that's the global `node_modules`, which is stable.

## Risks / Trade-offs

- **[An MCP client starts stdio servers with a clean environment, so `PI_BROWSER_HOST_CHILD` is lost]** → Subagents would be treated as external callers. They would still work, but would ask for caller approval as e.g. `pi` instead of using the sidebar session's grants. *Mitigation:* task 1.1 checks pi 1.5.2's built-in client and pi-mcp-adapter first. If either drops the variable, use the process ancestry as a fallback: the broker records the pids it spawns, and the bridge sends its ppid chain, which `process.ppid` gives one level of.
- **[Caller names can be faked]** → A malicious local process can claim to be `claude-code` and inherit its "Always allow". *Accepted:* same-user processes can already read the user's profile and the socket. The caller approval is about knowing what's happening and consenting, not about security. Documented in the settings UI and the README.
- **[Prompt fatigue]** → Agents that call many gated tools now get a caller prompt plus tool prompts. *Mitigation:* the caller prompt happens once per name with "Always allow". Tool prompts keep the existing "Allow for session" and coalescing.
- **[Users who relied on borrowing the sidebar session]** → For example a terminal `pi` reusing sidebar grants. They now see a caller prompt. *Mitigation:* release notes. This is the intended fix.
- **[Client config formats change]** → The installer adapters could break. *Mitigation:* use client CLIs where possible. When a file can't be parsed, never write it; report and continue (spec).
- **[A long-lived bridge holds a REPL worker]** → *Mitigation:* the REPL worker is created lazily on the first `javascript` call and disposed when the connection closes, as specified.

## Migration Plan

1. Ship the host, bridge and add-ons together in one release (v0.3.0). Mixed versions behave like this:
   - **New bridge, old broker:** `pi-browser/caller` is ignored, and calls use the old last-active routing.
   - **Old bridge, new broker:** callers are named from `initialize` when the client connects directly. Otherwise they're `unknown MCP client`, and get a caller prompt with that name.
   - **New host, old add-on:** prompts appear in the sidebar or Space as today, with no approval window. The synthetic caller-approval title is still readable.
2. Release notes: rerun `/pi-browser mcp install` (or `trusted-ua mcp install all`) and expect a one-time "Allow <client>" prompt per agent. Draft: `docs/RELEASE-NOTES-v0.3.0.md`.
   - **Protocol version stays 3 (deviation from task 2.4):** add-ons reject a host whose `PI_BROWSER.protocolVersion` differs from theirs, so a bump would break the mixed versions listed above. Every addition is optional and ignored by older peers, so the version is unchanged and the additions are listed in a comment next to it in `integration.ts`.
3. **Rollback:** reinstall v0.2.5. Caller entries in the permission store are ignored by older hosts.

## Decisions recorded (2026-11-20)

- **External access:** on by default, with a first-use prompt per caller (D5).
- **npm:** publish as `trusted-user-agent`, with the command `trusted-ua` (D8).
- **Caller approval:** per app (D5).
- **Attention:** every prompt from an external caller opens an approval window. The badge is only a backup (D6). This replaces an earlier draft where most prompts were badge-only.

## Open Questions

None at this time.
