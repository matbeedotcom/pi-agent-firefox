## Why

The broker already serves all 50 Firefox and Thunderbird tools over MCP, and v0.2.5 added a stdio bridge that any MCP client can launch. In practice, though, only pi works, and only while a chat session is open in the add-on: every MCP call is routed to "the most recently prompted add-on session" (`native-host/main.ts`, `toolBridge.call`). With no such session it fails with `no active ACP session`. With one, the call borrows that session's approvals and attribution even though a different program made it.

Fixing this makes the add-ons a general tool provider for any harness: Claude Code, Codex, Cursor, Gemini CLI, VS Code, or a separate pi CLI. It is also the groundwork for running other ACP agents in the sidebar later.

## What Changes

- **Caller sessions.** Each MCP connection from outside the host becomes its own *caller session* in the broker. Caller sessions are routed through the capability registry to whichever connected app provides the tool, and need no add-on chat session. Each one has its own "allow for session" grants and its own REPL state, and ends when its connection closes.
- **Caller identity.**
  - The stdio bridge tells the broker who is calling: the MCP client's `clientInfo` from `initialize`, plus the bridge's process id.
  - Clients that connect to the socket directly are identified by their own `initialize`.
  - Calls from pi sessions spawned by the host itself (subagents of a sidebar session) keep today's routing to their parent session.
- **Approvals for external callers.**
  - Approval prompts say which program is asking.
  - Prompts appear even when no chat for that caller is open in the UI.
  - Every prompt from an external caller opens an approval window in the app that runs the tool, whether or not the sidebar or Pi Space is open. The user is usually in another program, so a prompt inside the add-on UI would go unseen.
  - At most one window per app; it queues further prompts. Closing it denies the waiting prompts.
  - The toolbar button (Firefox) or Pi Space button (Thunderbird) shows a badge while a prompt is waiting, and clicking it brings the window to the front.
  - Prompts from the add-on's own chat sessions are unchanged.
  - The first call from a new caller name to each app needs a one-time "Allow <caller> to use Firefox tools?" (or Thunderbird) approval, which can be remembered. Approving a caller for one app doesn't approve it for the other.
  - External access is on by default. A setting turns it off entirely.
- **Installers for other MCP clients.** `/pi-browser mcp install|status|uninstall` and the installer CLI take a client: `pi` (the default, as today), `claude`, `codex`, `cursor`, `gemini`, `vscode`, or `all`. Each writes the same stdio bridge entry into that client's user-level config. Status reports each one as missing, current or stale.
- **Install without pi.** The agent package is published to npm as `trusted-user-agent`, with the command `trusted-ua`. `npm i -g trusted-user-agent` then registers the native host and MCP entries without the pi CLI. The installer refuses to register a host from a temporary `npx` cache. `pi install git:…` keeps working.
- **BREAKING (small):** MCP calls from processes the host did not spawn no longer act inside the sidebar's latest session. They run as their own caller session, with their own approvals. Users who still have the pre-v0.2.5 direct-socket entry in `~/.pi/agent/mcp.json` (which `mcp status` already reports as STALE) should rerun `/pi-browser mcp install`.

## Capabilities

### New Capabilities

- `external-mcp-routing`: Caller sessions for MCP connections from outside the host. Covers identifying callers, routing tool calls through the capability registry without an add-on chat session, keeping callers' state separate, and the session lifecycle and errors.
- `external-call-approval`: How approval-gated tools and first-use caller approval (per app) work for external callers. Covers attribution, the approval window and backup badge, the external-access setting, and timeouts.
- `mcp-client-installers`: Installing, checking and removing the stdio bridge entry in each supported MCP client's config without losing other entries or user settings.
- `standalone-install`: Publishing the agent package to npm as `trusted-user-agent` with the `trusted-ua` CLI, and installing the native host and MCP entries from a stable global install without the pi CLI.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first OpenSpec change in the repo.

## Impact

- **Host (`packages/trusted-user-agent`):**
  - `src/native-host/mcp-server.ts`: a caller per connection, the `pi-browser/caller` notification, and `initialize` clientInfo.
  - `src/native-host/mcp-stdio-bridge.ts`: sends caller identity when it connects.
  - `src/native-host/main.ts`: caller-session routing next to the existing `toolBridge`, and a marker in the environment of processes the host spawns.
  - `src/browser/provider.ts`: caller attribution on permission requests, and the per-app caller-approval gate.
  - `src/permission-store.ts`: stores remembered caller approvals per app, and the external-access setting.
  - `src/installer/{mcp,index,cli}.ts`: client targets, per-client config writers, and the temporary-location check.
  - `package.json`: new npm name, `bin` entry, publish contents. `@trusted-ua/protocol` is bundled or published alongside.
- **Protocol (`packages/protocol`):**
  - Optional `_meta.piBrowser.caller` on `session/request_permission`.
  - The new MCP notification name.
  - New permission-store keys for caller approvals.
  - An integration protocol version bump. Older add-ons ignore the new fields.
- **Add-ons (`packages/webext`, `firefox`, `thunderbird`):**
  - The permission modal shows the caller and doesn't depend on which chat session is open.
  - An approval window page for external callers' prompts.
  - Toolbar/Space backup badge for waiting prompts.
  - Settings UI for external access and remembered callers per app.
- **Release process:** an `npm publish` of `trusted-user-agent` after the GitHub release.
- **Tests:**
  - Unit tests for caller routing, separation between callers, attribution and installers.
  - An e2e check that drives the stdio bridge against a real Firefox and Thunderbird with no add-on session open.
- **Docs:** README section "Use the tools from other agents".
- **Dependencies:** none new.
