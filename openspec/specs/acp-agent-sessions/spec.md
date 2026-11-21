# acp-agent-sessions Specification

## Purpose
How the host runs sidebar and pane sessions on external ACP agents (Claude Code, Codex, or one from `agents.json`): one process per agent, started on demand, session updates relayed as the agent sends them, idle stop and reload.

## Requirements
### Requirement: One agent process per agent, started on demand
The broker SHALL start an external agent's ACP adapter when the first session for that agent is created or reopened. It SHALL initialize the agent once, and SHALL run all of that agent's sessions over the same connection. The process SHALL be started with the session's working directory available to it, and SHALL be stopped when the host shuts down.

#### Scenario: Two Claude Code sessions
- **WHEN** the user creates two Claude Code sessions
- **THEN** one Claude Code adapter process serves both

#### Scenario: No agent sessions
- **WHEN** the user only uses pi sessions
- **THEN** no external agent process is started

### Requirement: Idle agent processes stop
The broker SHALL stop an agent's process once it has been idle for the agent's idle timeout. The default timeout SHALL be 15 minutes, set per agent in `agents.json` with `idleTimeoutMinutes`, where 0 means never stop. Idle means no turn running, no permission request waiting, and no message to or from the agent during that time. The broker SHALL NOT stop an agent while any of its open sessions can't be reloaded: either the agent doesn't support loading sessions, or the session has no stored history. Stopping SHALL leave the sessions open in the add-on. The next prompt or setting change in such a session SHALL start the agent again and reload the session before continuing, with the panel showing that the agent is starting.

#### Scenario: Idle Claude Code stops
- **WHEN** a Claude Code session has had no activity for 15 minutes and Claude Code supports loading sessions
- **THEN** the Claude Code process is stopped and the session stays in the sidebar

#### Scenario: Coming back after the stop
- **WHEN** the user prompts that session again
- **THEN** the host starts Claude Code, reloads the session, and runs the prompt, with the conversation's context intact

#### Scenario: Agent without session loading
- **WHEN** an agent that can't load sessions has an open session with no activity for 15 minutes
- **THEN** the process keeps running, so the session's context isn't lost

#### Scenario: Long turn
- **WHEN** a Codex turn has been running for longer than the idle timeout
- **THEN** the process is not stopped

### Requirement: Relay of the session
For a session on an external agent, the host SHALL relay:
- `session/prompt` (text and images), and return the agent's stop reason;
- `session/cancel`;
- `session/close`, when the agent supports it.

The host SHALL forward the agent's `session/update` notifications to the client that owns the session, unchanged except for the session id where the ids differ. That includes message and thought chunks, tool calls and updates, and plans. The add-on SHALL render every update kind that pi sessions render today. It SHALL also render plans and tool-call content of type diff and terminal, and SHALL ignore update kinds it doesn't know.

#### Scenario: Streaming reply with a file edit
- **WHEN** the user prompts a Codex session and Codex streams text, then reports an edit tool call with a diff
- **THEN** the sidebar shows the streamed text and a tool card with the diff
- **AND** the prompt returns when Codex ends the turn

#### Scenario: Cancel
- **WHEN** the user presses Stop during a Claude Code turn
- **THEN** the host sends `session/cancel` to the agent and the turn ends with stop reason `cancelled`

### Requirement: Session settings
The host SHALL expose the agent's session settings to the add-on as session config options: the config options the agent reports, or its models and modes when it reports those instead. Changing a setting in the sidebar SHALL be forwarded to the agent. An agent that reports no settings SHALL show none.

#### Scenario: Pick a model
- **WHEN** a Claude Code session reports models and the user picks another one in the sidebar
- **THEN** the host forwards the change to the agent, and the session settings show the new model

### Requirement: Listing and reopening sessions
The host SHALL keep an index of external agent sessions: session id, agent, working directory, title, last activity. `session/list` SHALL include them alongside pi sessions. Reopening one (`session/load` or `session/resume`) SHALL go to its agent when the agent supports loading sessions, replaying its history into the sidebar. When the agent doesn't support it, the host SHALL return an error saying the session can't be reopened with that agent.

#### Scenario: Reopen after a restart
- **WHEN** Firefox restarts and the user opens a Claude Code session from the session list, and the agent supports loading sessions
- **THEN** the host starts the agent, loads the session, and the sidebar shows its history

#### Scenario: Agent can't reload
- **WHEN** the user opens an old session of an agent that doesn't support loading sessions
- **THEN** the sidebar shows that the session can't be reopened with that agent, and offers a new session

### Requirement: Clear errors for missing, logged-out or crashed agents
Creating a session with an unavailable agent SHALL fail with a message naming the missing command. When the agent requires authentication, the host SHALL fail with a message telling the user how to log in for that agent, and SHALL NOT attempt authentication itself. When an agent process exits, its open sessions SHALL show that the agent stopped. A running prompt SHALL end with an error, and the next prompt SHALL restart the agent and reopen the session when the agent supports it.

#### Scenario: Not logged in
- **WHEN** the user creates a Codex session and Codex reports that authentication is required
- **THEN** the panel shows "Codex needs you to log in: run `codex login` in a terminal, then try again"

#### Scenario: Agent crash mid-turn
- **WHEN** the Claude Code adapter process exits during a turn
- **THEN** the turn ends with an error saying the agent stopped
- **AND** the next prompt in that session restarts the agent

