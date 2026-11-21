# trusted-user-agent

Let AI agents use **Firefox** and **Thunderbird**, with your approval.

`trusted-user-agent` is the host half of
[Trusted User Agent](https://github.com/matbeedotcom/pi-agent-firefox). The add-ons run inside
your browser and mail client. This package runs on your machine and connects them to agents:

- **Any MCP client** (Claude Code, Codex, Cursor, Gemini CLI, VS Code, pi) gets the
  `trusted-ua` MCP server. It reads and drives a browser tab, and reads, searches, files and
  drafts mail, while Firefox or Thunderbird is running.
- **The add-ons' own chat** (Firefox sidebar, Thunderbird space and pane) talks to an
  embedded [pi](https://pi.dev) agent through this host over the Agent Client Protocol (ACP),
  or, if you pick it for a session, to **Claude Code**, **Codex** or another ACP agent, with the
  browser and mail tools at hand.

It installs the `com.matbee.agent` Native Messaging host, which both add-ons share, and gives
you the `trusted-ua` command to set it up.

## Requirements

- **Node.js 22 or newer**
- **Firefox** and/or **Thunderbird** with the Trusted User Agent add-on
  (both are on the [releases page](https://github.com/matbeedotcom/pi-agent-firefox/releases))
- Linux, macOS or Windows

## Quick start

```sh
npm i -g trusted-user-agent
trusted-ua install              # register the native host for Firefox and Thunderbird
trusted-ua mcp install all      # add the trusted-ua MCP server to every MCP client found
trusted-ua doctor               # check the host and whether an add-on has connected
```

Then install the add-ons:

- **Firefox:** download `trusted-user-agent-firefox-<version>.xpi` from the
  [latest release](https://github.com/matbeedotcom/pi-agent-firefox/releases/latest) and open it
  in Firefox (it is signed).
- **Thunderbird:** download `trusted-user-agent-thunderbird-<version>.xpi`, then go to Add-ons and Themes → ⚙ →
  *Install Add-on From File…*.

The add-ons find the host by themselves within about 10 seconds. You don't need to restart
anything. If you install the add-on first, it shows a *Connect* screen until the host is there.

> Install globally. `trusted-ua install` refuses to run from a temporary location (an `npx`
> cache or the temp directory), because the registration would break when npm cleans it up.

## Using the tools from your agent

After `trusted-ua mcp install <client>`, your agent sees a `trusted-ua` MCP server. It starts
before Firefox or Thunderbird does, and tool calls work while an app with the add-on is running.

| Client | Command | Where the entry goes |
|--------|---------|----------------------|
| pi | `trusted-ua mcp install` | `~/.pi/agent/mcp.json` |
| Claude Code | `trusted-ua mcp install claude` | user scope, through `claude mcp add-json` |
| Codex | `trusted-ua mcp install codex` | `~/.codex/config.toml` (through `codex mcp add` when available) |
| Cursor | `trusted-ua mcp install cursor` | `~/.cursor/mcp.json` |
| Gemini CLI | `trusted-ua mcp install gemini` | `~/.gemini/settings.json` |
| VS Code | `trusted-ua mcp install vscode` | the user `mcp.json` |
| Every client found | `trusted-ua mcp install all` | each of the above that is installed |

The installer edits only the `trusted-ua` entry (and replaces an old `pi-browser` one). It leaves your other servers and settings
alone, and it never rewrites a config file it can't parse. It reports the error instead.

### What the agent can do

| App | Tools |
|-----|-------|
| Firefox | `browser_*`: list, open, bind and close tabs; read the page, DOM or accessibility tree; click, type, scroll, wait for selectors; read the console and network requests; navigate and reload; take screenshots. Also `javascript`, a persistent REPL bound to the tab (`page`, `tabs` and a workspace-confined `fs`). |
| Thunderbird | `mail_*` (accounts, folders, search, read messages and attachments, tag, mark read, move, archive), `compose_*` (prepare new mail, replies and forwards, add attachments), `contacts_*` (list, search, get). |

Browser tools act on a tab bound to the agent's connection. The agent calls
`browser_list_tabs` and then `browser_bind_tab`, or opens a new tab with `browser_open_tab`.
An agent can't take a tab that one of your chats in the sidebar has bound.

Page and mail content reach the agent as untrusted tool data, never as instructions.

### How approval works

- **Each MCP connection is its own session.** It has its own approvals and its own
  `javascript` REPL, and it ends when the agent disconnects.
- **You approve each agent once per app.** The first call from a new agent asks
  *"Allow codex to use Firefox tools?"* with *Allow this time*, *Always allow codex* and
  *Deny*. Firefox and Thunderbird ask separately, so allowing an agent in the browser doesn't
  open your mailbox to it.
- **Tool calls still ask** as set on the add-on's permissions page (Ask / Deny / Always
  approve), and each prompt names the agent: *"claude-code wants to take a screenshot"*.
- **Prompts come to you.** They open a small approval window in the app that runs the tool,
  even when the sidebar or the Trusted Agent space is closed. **Closing the window denies** whatever is
  waiting. While a prompt waits, the toolbar or space button shows a badge.
- **You can turn it off.** In the add-on, go to settings → permissions → *Other apps (MCP)*.
  You can switch external access off there, or revoke agents you allowed or denied.

Agent names are what agents report about themselves and are not verified. Any program running
as your user can reach the host, so the approval is about knowing and consenting. It is not
a security boundary between programs on your machine.

## Chat with Claude Code or Codex in the add-ons

The add-ons' new-session panel has an **Agent** choice: **pi** (the default), **Claude Code**,
**Codex**, or an ACP agent you add yourself. The last choice is remembered per app, and
sessions that don't use pi are labelled in the session list.

Install the agent's ACP adapter and log in with the agent's own CLI:

| Agent | Adapter | Log in |
|-------|---------|--------|
| Claude Code | `npm i -g @agentclientprotocol/claude-agent-acp` | run `claude` once and log in |
| Codex | `npm i -g @agentclientprotocol/codex-acp` | `codex login` |

`trusted-ua status` lists which agents are available. Agents that aren't found show disabled in
the panel, with the missing command.

- **Nothing to set up in the agent's config.** Each session gets the `trusted-ua` tools tied to
  that sidebar session: its bound tab, its approvals, and prompts in the sidebar or pane. It can
  reach the other app's tools when both apps run.
- **Two kinds of prompts.** Tool prompts (*"Allow this action?"*) are the add-on's own, as for
  pi. Agent prompts (*"Codex wants to run a command"*, with the command or diff) are the agent's
  own permission requests, with its own options. The add-on never remembers those answers.
- **One process per agent**, shared by its sessions in both apps. After 15 minutes without
  activity the process stops. The session stays open, and your next message starts the agent
  again and reloads the conversation.
- The agents work in the session's folder with their own tools and approval rules. New sessions
  default to a fresh folder under `~/.pi/workspaces`.

Add agents or change a built-in one in `~/.trusted-ua/agents.json` (no restart needed):

```json
{
  "agents": {
    "claude": { "idleTimeoutMinutes": 30 },
    "my-agent": { "name": "My agent", "command": "my-agent", "args": ["--acp"] },
    "codex": { "disabled": true }
  }
}
```

Fields: `name`, `command`, `args`, `env`, `idleTimeoutMinutes` (0 means never stop),
`loginHint` and `disabled`.

## Firefox and Thunderbird together

Both add-ons use the same host. The first app to connect becomes the broker and owns the
sessions. The second app's host process relays into it over private OS IPC: a `0600` Unix
socket in `~/.trusted-ua/run`, or a per-user named pipe on Windows. Nothing listens on TCP.

So one session can use both apps. A chat in the Firefox sidebar can search your mail, and an
agent connected over MCP can read an email and then reproduce its bug in a tab.
`trusted-ua status` shows the broker and per-app heartbeats.

## Command reference

```
trusted-ua [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]
trusted-ua mcp [install|status|uninstall] [pi|claude|codex|cursor|gemini|vscode|all]
```

| Command | Effect |
|---------|--------|
| `trusted-ua` / `trusted-ua status` | Host registration, add-on heartbeat, broker state, and which chat agents (Claude Code, Codex, ...) are available |
| `trusted-ua install [app]` | Register (or repair) the native host. `app` defaults to `mozilla`, which means both apps |
| `trusted-ua doctor [app]` | `status` plus a live probe of the host |
| `trusted-ua uninstall [app]` | Remove the registration (the package files stay) |
| `trusted-ua mcp install [client]` | Add or update the `trusted-ua` MCP entry (default client: `pi`); renames an old `pi-browser` entry |
| `trusted-ua mcp status [client]` | Report each entry as missing, current or stale (for example after the package moved) |
| `trusted-ua mcp uninstall [client]` | Remove only the `trusted-ua` entry (and an old `pi-browser` one) |

After upgrading or moving the package, run `trusted-ua install` and
`trusted-ua mcp install <client>` again. `status` and `mcp status` tell you when an entry is
stale.

### What `install` writes

| Where | What |
|-------|------|
| The package's `native/` directory | The host launcher, pinned to the `node` that ran the install |
| Linux | `~/.mozilla/native-messaging-hosts/com.matbee.agent.json` |
| macOS | `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.matbee.agent.json` (Firefox) and `~/Library/Mozilla/NativeMessagingHosts/com.matbee.agent.json` (Thunderbird) |
| Windows | `HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\com.matbee.agent`, pointing at a manifest in the package's `native/` directory |
| `~/.agents/skills/browser-walk/SKILL.md` | A skill that teaches agents to walk a tab: observe, act, verify, save |

## Using it as a pi package

The same package is a [pi](https://pi.dev) package. It adds the `/trusted-ua` command (old name `/pi-browser` still works), which
works like `trusted-ua`:

```sh
pi install git:github.com/matbeedotcom/pi-agent-firefox@v0.5.0
```

In pi: `/trusted-ua install`, `/trusted-ua doctor`, `/trusted-ua mcp install [client]`.

## Configuration

The pi chat in the add-ons runs on the embedded pi SDK and uses your normal pi setup
(`~/.pi/agent`: models, API keys, extensions, skills). Approvals the add-ons store live in
`~/.trusted-ua/`, next to `agents.json` (chat agents) and `agent-sessions.json` (the list of
Claude Code / Codex sessions started from the add-ons).

| Variable | Effect |
|----------|--------|
| `TRUSTED_UA_LOG_FILE` | Host log path. Set it to `off` to disable logging |
| `TRUSTED_UA_LOG_LEVEL` | Host log level |
| `TRUSTED_UA_PI_AGENT_DIR` | pi agent directory for the embedded agent (default: pi's own) |
| `TRUSTED_UA_PREWARM` | `0` turns off the warm-up session the host starts at launch |

The v0.4.0 names (`PI_BROWSER_*`) are still read when the new ones are not set.

The host's stdout carries only protocol data. Logs go to stderr and the log file.

## Upgrading from v0.4.0 (Pi Browser)

Up to v0.4.0 the product was called Pi Browser. After upgrading, run `trusted-ua install` and
`trusted-ua mcp install all`: the second renames each client's `pi-browser` MCP entry to
`trusted-ua` (tools become `mcp__trusted-ua__<tool>`). Your approvals and settings in
`~/.pi/browser/` are read until the first change saves them to `~/.trusted-ua/`; nothing is
deleted. Old and new add-ons and hosts work together.

## Troubleshooting

- **The add-on says it can't find the host.** Run `trusted-ua doctor`. If the host is not
  installed, run `trusted-ua install`. If it reports a stale launcher, the package moved
  (for example after a Node upgrade), so run `install` again.
- **`doctor` says the add-on heartbeat is stale.** Reload the add-on or restart the app.
- **The agent's browser calls fail with `BROWSER_NOT_BOUND`.** The agent has to bind a tab
  first (`browser_bind_tab` or `browser_open_tab`).
- **Nothing happens when the agent calls a tool.** Look for the approval window or the badge
  on the Trusted Agent toolbar / space button.
- **Claude Code or Codex is greyed out in the new-session panel.** Its ACP adapter isn't on
  your `PATH`. Install it (see above), or set its `command` in `~/.trusted-ua/agents.json`.
- **"Codex needs you to log in".** Log in with the agent's own CLI (`codex login`, or run
  `claude` once), then create the session again.

More: [debugging guide](https://github.com/matbeedotcom/pi-agent-firefox/blob/main/docs/DEBUGGING-TOOLS.md),
[project README](https://github.com/matbeedotcom/pi-agent-firefox#readme),
[product spec and security invariants](https://github.com/matbeedotcom/pi-agent-firefox/blob/main/PRODUCT.md).

## License

MIT
