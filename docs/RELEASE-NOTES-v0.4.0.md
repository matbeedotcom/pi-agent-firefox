# v0.4.0 — release notes

## Chat with Claude Code or Codex in the sidebar

The new-session panel in the Firefox sidebar and the Thunderbird Space and pane now has an
**Agent** choice: **pi** (the default, unchanged), **Claude Code**, **Codex**, or any ACP agent
you add in `~/.pi/browser/agents.json`.

- **Requirements:** the agent's ACP adapter on your `PATH`
  (`npm i -g @agentclientprotocol/claude-agent-acp`, `npm i -g @agentclientprotocol/codex-acp`)
  and the agent logged in with its own CLI. Missing agents are shown disabled, with the reason.
- **The agent as it is:** its streamed replies, thinking, tool cards, file diffs, plans and
  settings (model, mode, effort) show in the sidebar as the agent sends them.
- **Browser and mail tools, no setup:** each session gets the `pi-browser` tools tied to that
  session — its bound tab, its approvals, prompts in the sidebar or pane — and can reach the
  other app's tools when both run.
- **The agent's own prompts** ("Codex wants to run a command", with the command or diff) show in
  the sidebar with the agent's options. The add-on never remembers them.
- **Sessions are listed and reopen** through the agent.
- **Idle agents stop** after 15 minutes (`idleTimeoutMinutes` per agent; 0 = never). The next
  message starts the agent again and reloads the conversation.
- **Clear errors:** a missing adapter names the command; an agent that isn't logged in says how
  to log in ("Codex needs you to log in: run `codex login` in a terminal, then try again"); a
  crashed agent ends the turn with an error and restarts on the next message.
- `trusted-ua status` / `doctor` and `/pi-browser status` list the agents and `agents.json`
  problems.

Compatibility: additive. Older add-ons keep creating pi sessions; with an older host the panel
shows no agent choice. `PI_BROWSER.protocolVersion` stays 3.

Google's Antigravity CLI (Gemini CLI's successor) has no ACP mode, so it isn't offered.
