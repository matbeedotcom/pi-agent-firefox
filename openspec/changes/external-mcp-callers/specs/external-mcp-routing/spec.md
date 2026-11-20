## ADDED Requirements

### Requirement: Caller session per external MCP connection
The broker SHALL create a distinct caller session for each MCP connection to its MCP endpoint that does not come from a process the host spawned. A tool call on that connection SHALL execute in that caller session. It SHALL NOT execute in any add-on chat session.

#### Scenario: Tool call with no add-on chat session open
- **WHEN** Firefox is running with the add-on connected, no chat session is open in the sidebar, and an MCP client calls `browser_get_page` through the stdio bridge
- **THEN** the call is routed to Firefox and returns the page content
- **AND** the result is not the error `no active ACP session`

#### Scenario: External call while a sidebar session is active
- **WHEN** the user has an active sidebar chat session and an external MCP client calls a tool
- **THEN** the call executes in the external client's caller session
- **AND** the call does not use that sidebar session's "allow for session" grants

### Requirement: Caller identity
The broker SHALL identify each caller session by a display name and version taken from the MCP client's `initialize` `clientInfo`, plus the bridge's process id when known. The stdio bridge SHALL send this identity to the broker in a `pi-browser/caller` notification as the first message on each broker connection. A direct socket client SHALL be identified from the `initialize` request it sends to the broker. When neither gives a name, the caller SHALL be named `unknown MCP client`.

#### Scenario: Identity through the stdio bridge
- **WHEN** an MCP client sends `initialize` with `clientInfo.name = "claude-code"` to the stdio bridge, then calls a tool
- **THEN** the bridge's first message on the broker connection is a `pi-browser/caller` notification with name `claude-code`
- **AND** the broker's caller session for that connection is named `claude-code`

#### Scenario: Direct socket client
- **WHEN** a client connects to the broker endpoint directly and sends `initialize` with `clientInfo.name = "custom"`
- **THEN** the caller session for that connection is named `custom`

#### Scenario: No identity given
- **WHEN** a client calls `tools/call` on a direct connection without having sent `initialize` or `pi-browser/caller`
- **THEN** the call runs in a caller session named `unknown MCP client`

### Requirement: Host-spawned callers keep parent-session routing
A tool call from a process the host spawned (for example a pi subagent of a sidebar session) SHALL keep today's behaviour: it is routed to the most recently active add-on chat session. The host SHALL mark its spawned processes so that the stdio bridge can report this in `pi-browser/caller`. A call that does not carry the marker SHALL be treated as an external caller.

#### Scenario: Subagent of a sidebar session
- **WHEN** a pi subagent spawned by the host calls `browser_get_page` through the stdio bridge while the user's sidebar session is active
- **THEN** the call executes in that sidebar session, with its grants and activity attribution, as before this change

#### Scenario: Separately started pi CLI
- **WHEN** the user runs `pi` in a terminal, so the process was not spawned by the host, and it calls a tool through the stdio bridge
- **THEN** the call executes in its own caller session

### Requirement: Routing through the capability registry
A call in a caller session SHALL be routed to a connected app that provides the tool, using the capability registry. A caller session has no owning app, so no app is preferred. When no connected app provides the tool, the call SHALL return an MCP tool error naming the tool and the app that provides it.

#### Scenario: Mail tool with only Firefox connected
- **WHEN** only Firefox is connected and an external caller calls `mail_search`
- **THEN** the result is an MCP tool error (`isError: true`) saying no connected client provides `mail_search`, and that Thunderbird with the Pi add-on is required

#### Scenario: Browser and mail tools from one caller
- **WHEN** Firefox and Thunderbird are both connected and one external caller calls `browser_get_page` and then `mail_search`
- **THEN** the first call executes in Firefox and the second in Thunderbird, both in the same caller session

### Requirement: Isolation between caller sessions
Session-scoped state SHALL belong to one caller session and SHALL NOT be visible to another caller session or to any add-on chat session. Session-scoped state includes "allow for session" grants, `javascript` REPL cells and variables, and permission-prompt grouping.

#### Scenario: Session grant does not leak
- **WHEN** caller A is approved for `browser_screenshot` with "Allow for this session", and caller B then calls `browser_screenshot`
- **THEN** caller B gets its own approval prompt

#### Scenario: REPL state per caller
- **WHEN** caller A runs `javascript` with `globalThis.x = 1`, and caller B then runs `javascript` with `typeof x`
- **THEN** caller B's result is `"undefined"`

### Requirement: Caller session lifecycle
A caller session SHALL end when its broker connection closes. Ending it SHALL discard its session-scoped state and dispose its REPL worker. A new connection from the same program SHALL start a new caller session. When the broker restarts, the stdio bridge SHALL reconnect on its next call and send `pi-browser/caller` again.

#### Scenario: MCP client exits
- **WHEN** the MCP client closes the stdio bridge's stdin
- **THEN** the bridge closes its broker connection
- **AND** the broker discards that caller session's state and REPL worker

#### Scenario: Broker restart
- **WHEN** Firefox restarts while an MCP client keeps the stdio bridge running, and the client then calls a tool
- **THEN** the bridge reconnects, sends `pi-browser/caller`, and the call runs in a new caller session
