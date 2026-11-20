# v0.3.0 — release notes

## Use Firefox and Thunderbird from any agent

The `pi-browser` MCP server now works for **any MCP client** — Claude Code, Codex, Cursor,
Gemini CLI, VS Code, or a separate pi — whenever Firefox or Thunderbird is running with the
add-on. No Pi chat needs to be open.

```sh
npm i -g trusted-user-agent
trusted-ua install              # register the native host (Firefox + Thunderbird)
trusted-ua mcp install all      # add pi-browser to every MCP client found
```

- **Each agent gets its own session.** Every MCP connection has its own approvals and its own
  `javascript` REPL, and ends when the agent disconnects.
- **You approve each agent once per app.** The first call from a new agent asks
  "Allow codex to use Firefox tools?" (Allow this time / Always allow / Deny). Firefox and
  Thunderbird ask separately. Every tool call still asks as set on the permissions page, and
  the prompt names the agent.
- **Prompts come to you.** Prompts from other agents open a small approval window in the app,
  even with the sidebar or Space closed. Closing the window denies. The toolbar / Space button
  shows a badge while a prompt waits.
- **You can turn it off.** Pi settings → permissions → *Other apps (MCP)*: switch off, or revoke
  agents you allowed or denied.
- Browser tools act on a tab the agent binds (`browser_list_tabs` + `browser_bind_tab`, or
  `browser_open_tab`). Agents can't take a tab bound to one of your Pi chats.

## New: the `trusted-user-agent` npm package

The host package is now published to npm as **`trusted-user-agent`** with the command
**`trusted-ua`** — no pi CLI needed:

- `trusted-ua [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]`
- `trusted-ua mcp [install|status|uninstall] [pi|claude|codex|cursor|gemini|vscode|all]`

The installer refuses to register from a temporary location (an `npx` cache or the temp
directory), because the registration would break when npm cleans it up: install globally first.
`pi install git:github.com/matbeedotcom/pi-agent-firefox` keeps working, and `/pi-browser mcp`
takes the same client argument.

## Changed (small breaking change)

MCP calls from programs the host didn't start no longer act inside the sidebar's most recent
Pi session. They run as their own session, with their own approvals. If you still have the
pre-v0.2.5 direct-socket entry in `~/.pi/agent/mcp.json` (`/pi-browser mcp status` reports it
as STALE), run `/pi-browser mcp install` again. Pi subagents started by the host keep using
their chat session as before.

`/pi-browser mcp install` no longer overwrites an `mcp.json` it can't parse; it reports the
error and leaves the file alone.

## Compatibility

- New host + older add-on: prompts from other agents show in the sidebar / Space as before
  (no approval window); the one-time agent prompt reads "codex wants to use Firefox tools".
- Older host + new add-on: nothing changes.
- Rolling back to v0.2.5 is safe; it ignores the new entries in `~/.pi/browser/permissions.json`.
