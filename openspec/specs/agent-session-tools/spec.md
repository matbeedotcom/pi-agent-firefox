# agent-session-tools Specification

## Purpose
How a session on an external agent gets the Trusted User Agent browser and mail tools, tied to that session (its bound tab, approvals and prompts).

## Requirements
### Requirement: The agent gets the browser and mail tools for its session
When the host creates, loads or resumes a session on an external agent, it SHALL include the `trusted-ua` stdio MCP server in the session's `mcpServers`. That entry SHALL be the same bridge launch that the installers write, plus environment variables tying it to this sidebar session. The user SHALL NOT need to configure the agent for this.

#### Scenario: Tools available without setup
- **WHEN** the user starts a Codex session in the Firefox sidebar on a machine where Codex has no `trusted-ua` entry in its own config
- **THEN** Codex can call `browser_get_page`, and the call reads the tab bound to that session

### Requirement: Calls act for the sidebar session
A bridge started for an agent session SHALL report that session's id to the broker. The broker SHALL run its calls with that session's routing context: owner app, tab binding, "allow for session" grants and REPL state. It SHALL NOT create a caller session, and SHALL NOT apply the external-caller approval of v0.3.0. Approval prompts for these calls SHALL appear where the session is open (sidebar, Space or pane), as for pi sessions. A reported session id SHALL be honoured only when the bridge is also a child of this broker, by its host-child marker.

#### Scenario: Screenshot prompt in the sidebar
- **WHEN** a Claude Code session in the Firefox sidebar calls `browser_screenshot`
- **THEN** the approval prompt appears in the sidebar for that session, not in an approval window
- **AND** "Allow for this session" covers later screenshots in that session

#### Scenario: Two agent sessions, two tabs
- **WHEN** one Codex session is bound to tab A and another to tab B
- **THEN** each session's `browser_get_page` reads its own tab

#### Scenario: Forged session id
- **WHEN** a process that wasn't started by the broker reports a sidebar session id
- **THEN** the broker treats it as an external caller (caller session and caller approval), ignoring the reported id

### Requirement: Cross-app tools
Agent sessions SHALL reach the other app's tools the same way pi sessions do. A Firefox-sidebar agent session SHALL be able to call Thunderbird's mail tools when Thunderbird is connected, with the prompt shown in Thunderbird and the cross-app notice in the sidebar.

#### Scenario: Mail from a Firefox Claude Code session
- **WHEN** a Claude Code session in the Firefox sidebar calls `mail_search` while Thunderbird is running
- **THEN** Thunderbird shows the approval prompt, and the sidebar shows that approval is waiting in Thunderbird

