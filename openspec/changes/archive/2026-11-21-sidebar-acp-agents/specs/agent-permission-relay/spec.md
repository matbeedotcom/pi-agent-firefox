## ADDED Requirements

### Requirement: The agent's own permission requests appear in the session's UI
When an external agent sends `session/request_permission` for one of its sessions, the host SHALL forward it to the client that owns the session, with the session id mapped and the agent's options unchanged. The add-on SHALL show it in the same prompt UI as tool approvals, in the sidebar, Space or pane where the session is. It SHALL use the agent's option names and the tool call's title and content (for example the command or the diff), and SHALL label it with the agent's name. The user's choice SHALL be returned to the agent as the selected option.

#### Scenario: Codex wants to run a command
- **WHEN** a Codex session asks permission to run `npm test`, with options "Allow", "Allow always" and "Reject"
- **THEN** the sidebar shows "Codex wants to run a command" with `npm test` and those three options
- **AND** choosing "Allow always" returns that option id to Codex

#### Scenario: Sidebar closed
- **WHEN** the agent asks permission while the Firefox sidebar is closed
- **THEN** the prompt is shown when the sidebar opens, the same as for pi tool approvals

### Requirement: The host doesn't remember agent decisions
The host SHALL NOT store or auto-answer the agent's own permission requests. "Always" options SHALL be the agent's to remember. These requests SHALL NOT appear in the add-on's tool permission settings.

#### Scenario: Always allow is the agent's
- **WHEN** the user chooses the agent's "Allow always" option once
- **THEN** whether the agent asks again is up to the agent; the host passes every later request through

### Requirement: Timeouts and cancellation
An agent permission request that isn't answered within the add-on's prompt timeout SHALL be answered `cancelled`. Cancelling the turn SHALL withdraw the session's waiting prompts from the UI. If the owning client disconnects, the host SHALL answer the agent's waiting requests `cancelled`.

#### Scenario: Prompt ignored
- **WHEN** an agent's permission prompt is left unanswered past the timeout
- **THEN** the agent receives `cancelled` and the prompt disappears from the sidebar
