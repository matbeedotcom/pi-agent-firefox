## Why

The Firefox sidebar and the Thunderbird Space/pane can only start **pi** sessions: the host runs pi in-process (`PiSdkBackend`) and the new-session panel asks only for a folder. v0.3.0 made the tools available to Claude Code, Codex and others from *outside* the apps, but someone who works with Claude Code or Codex still can't chat with it inside Firefox or Thunderbird, with the page or mailbox at hand.

The add-ons already speak ACP (Agent Client Protocol) to the host, and Claude Code and Codex have ACP adapters. So the host can relay a sidebar session to any of them, and give them the browser and mail tools the same way it gives them to pi.

## What Changes

- **Choose the agent per session.** The new-session panel gets an agent choice:
  - **pi** (built in, the default, unchanged);
  - **Claude Code**, **Codex**, and any other ACP agent the user configures, listed only when found on the machine.
  - The last choice is remembered. The session list shows which agent each session uses.
- **External agent sessions.** For a non-pi session, the host starts that agent's ACP adapter, one process per agent, shared by its sessions, started on first use. The host relays the session to it: prompts, streamed replies, tool cards, plans, cancel, close.
  - The agent's own updates are forwarded as ACP updates, not converted to pi events. Its own tool cards (file edits, shell commands), plans and thinking show as the agent sent them.
- **Browser and mail tools for those agents.** The host gives each external session the `pi-browser` MCP server (the stdio bridge from v0.3.0), tied to that sidebar session.
  - Tool calls act on the session's bound tab, use the session's approvals, and prompt in the sidebar or pane where the user is chatting, not in the approval window.
  - The user doesn't install anything in the agent's own config for this.
- **The agent's own permission requests.** When Claude Code or Codex asks permission (edit a file, run a command), the prompt appears in the sidebar or pane with the agent's own options. The answer goes back to the agent. Unanswered prompts time out as today.
- **Model and mode settings.** The agent's own settings (model, mode) appear in the sidebar's session settings, the way pi's model and thinking level do now.
- **Reopening sessions.** External sessions are listed, and reopen through the agent when it supports loading sessions; otherwise they're shown as unavailable.
- **Setup and errors.**
  - `trusted-ua status` and `doctor` list which agents are available and why others aren't.
  - Starting a session with an agent that is missing, or not logged in, gives a clear message in the panel, for example "Log in first: run `claude` in a terminal".
  - Agent launch commands can be overridden in a small config file.
- Nothing changes for pi sessions or for the external MCP callers from v0.3.0.

## Capabilities

### New Capabilities

- `agent-choice`: The available agents (built-in pi plus configured ACP agents), how they are detected and configured, and how the user picks one per session in the new-session panel. Also the session list's agent label, and status reporting.
- `acp-agent-sessions`: Running a sidebar session on an external ACP agent. Covers the per-agent process, relaying prompts, updates, cancel and close, settings, listing and reopening sessions, and errors when the agent is missing, not logged in, or crashes.
- `agent-session-tools`: Giving an external agent session the browser and mail tools, tied to its own sidebar session (tab binding, approvals, prompts in the sidebar).
- `agent-permission-relay`: Showing an external agent's own permission requests in the sidebar or pane, and returning the user's answer to the agent.

### Modified Capabilities

None. `openspec/specs/` has no archived specs yet. This change builds on the unarchived `external-mcp-callers` change (caller identity, the stdio bridge, and the host-child marker).

## Impact

- **Host (`packages/pi-agent`):**
  - `src/acp/agent.ts`: sessions get an agent kind and dispatch to either the existing pi path or a new ACP relay path.
  - New `src/acp/agents/`: the agent registry (detection, config file), the ACP client connection to an agent process, and the session relay.
  - `src/native-host/mcp-server.ts`, `mcp-stdio-bridge.ts`, `main.ts`: a bridge started for an agent session reports which sidebar session it belongs to; the broker routes its calls with that session's context.
  - `src/installer/`: status and doctor list agents.
- **Protocol (`packages/protocol`):**
  - `x-pi-browser/agents` (list available agents).
  - An optional `agent` field on `session/new` `_meta`.
  - The agent id on listed sessions.
  - Additive only; older add-ons keep creating pi sessions.
- **Add-ons (`packages/webext`, `firefox`, `thunderbird`):**
  - The new-session panel's agent choice.
  - The agent label in the session list.
  - Rendering of ACP updates pi never sends (plans, diffs, terminal output), where it's missing today.
  - The sidebar prompt showing an agent's own option names.
- **Dependencies:** none bundled. The ACP adapters (for example Claude Code's and Codex's) are the user's own installs, found on `PATH` or configured.
- **Docs:** README section "Chat with Claude Code or Codex in the sidebar".
