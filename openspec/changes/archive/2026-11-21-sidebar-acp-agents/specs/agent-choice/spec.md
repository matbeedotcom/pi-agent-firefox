## ADDED Requirements

### Requirement: Available agents
The host SHALL offer the built-in pi agent and every configured external ACP agent whose launch command is available on this machine. Built-in definitions SHALL exist for Claude Code and Codex. The user SHALL be able to add agents, or override a built-in agent's command, arguments and environment, in `~/.pi/browser/agents.json`. The host SHALL answer `x-pi-browser/agents` with each agent's id, display name, whether it is available, and the reason when it isn't.

#### Scenario: Claude Code installed, Codex not
- **WHEN** the Claude Code ACP adapter is on `PATH` and the Codex adapter is not
- **THEN** `x-pi-browser/agents` lists pi and Claude Code as available, and Codex as unavailable with a reason naming the missing command

#### Scenario: User-configured agent
- **WHEN** `agents.json` defines an agent `my-agent` with command `my-agent` and arguments `["--acp"]`, and `my-agent` is on `PATH`
- **THEN** `my-agent` is listed as available

#### Scenario: Invalid config file
- **WHEN** `agents.json` is not valid JSON
- **THEN** the built-in agents are still offered, and status reports the parse error

### Requirement: Choosing the agent for a new session
The new-session panel SHALL let the user choose among the available agents, with pi selected by default. It SHALL remember the last choice per app. A host that does not answer `x-pi-browser/agents` SHALL be treated as offering pi only, and the panel SHALL then show no choice. The chosen agent SHALL be sent with `session/new` as `_meta.piBrowser.agent`. A request without it SHALL create a pi session.

#### Scenario: Start a Claude Code session
- **WHEN** the user picks Claude Code and a folder in the new-session panel and creates the session
- **THEN** the host creates the session on Claude Code
- **AND** the next time the panel opens, Claude Code is preselected

#### Scenario: Older host
- **WHEN** the add-on is connected to a host that doesn't know `x-pi-browser/agents`
- **THEN** the panel shows no agent choice and creates pi sessions as before

### Requirement: Agent shown per session
Listed sessions SHALL carry their agent id. The sidebar, Space and pane session lists SHALL label sessions that don't use pi with the agent's display name.

#### Scenario: Mixed session list
- **WHEN** the user has one pi session and one Codex session
- **THEN** the session list shows the Codex session with a "Codex" label and the pi session without a label

### Requirement: Agent status
`trusted-ua status`, `trusted-ua doctor` and `/pi-browser status` SHALL list each external agent as available or unavailable with the reason, and SHALL report `agents.json` problems.

#### Scenario: Status lists agents
- **WHEN** the user runs `trusted-ua status` on a machine with only the Claude Code adapter installed
- **THEN** the report includes `agent claude: available` and `agent codex: not found (<command>)`
