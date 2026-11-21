# external-call-approval Specification

## Purpose
How tool calls from external MCP clients (callers such as Claude Code or Codex run outside the add-ons) are approved in the add-ons, with prompts that name the caller.

## Requirements
### Requirement: Approval prompts name the caller
When a call in a caller session needs approval, the `session/request_permission` sent to the executing app SHALL carry `_meta.trustedUa.caller` with the caller's display name and version. The add-on's permission prompt SHALL show that name, for example "claude-code wants to take a screenshot". Add-ons that don't know the field SHALL still show their usual prompt.

#### Scenario: Screenshot from Claude Code
- **WHEN** a caller named `claude-code` calls `browser_screenshot`, which needs approval in Firefox
- **THEN** the Firefox prompt names `claude-code` as the requester

#### Scenario: Older add-on
- **WHEN** the host sends a permission request with `_meta.trustedUa.caller` to an add-on built before this change
- **THEN** the add-on shows its existing prompt in the sidebar or Space, and the answer is applied normally

### Requirement: External callers' prompts open an approval window
Every approval prompt for a caller session SHALL be shown in an approval window opened by the executing app. This includes first-use caller approval and per-tool approval. The window SHALL open whether or not the sidebar, Pi Space or a Pi pane is open, and SHALL ask the OS for focus. Opening it SHALL NOT need any new add-on permission. Each app SHALL have at most one approval window: further prompts SHALL queue in the open window and be shown one after another. The window SHALL close itself once no prompts are waiting. Prompts for the add-on's own chat sessions SHALL keep appearing in the sidebar, Space or pane as they do today.

#### Scenario: Prompt while the user is in another app
- **WHEN** the user is working in a terminal, Firefox is in the background with its sidebar closed, and an external caller calls `browser_screenshot`
- **THEN** Firefox opens an approval window naming the caller and the tool, and asks for focus
- **AND** answering in the window lets the call continue, and the window closes

#### Scenario: Sidebar already open
- **WHEN** the Firefox sidebar is open on the user's own chat and an external caller's call needs approval
- **THEN** the prompt appears in the approval window, not in the sidebar chat

#### Scenario: Thunderbird prompt
- **WHEN** an external caller calls `mail_search` and needs approval
- **THEN** Thunderbird opens an approval window naming the caller

#### Scenario: Several prompts
- **WHEN** two external callers each need approval in Firefox at the same time
- **THEN** one approval window shows the first prompt, then the second after the first is answered, then closes

### Requirement: Closing the window denies
If the user closes the approval window while a prompt is showing, that prompt and every prompt queued behind it SHALL be answered as Deny once. The calls SHALL return MCP tool errors saying the user denied the request. Closing the window SHALL NOT store a persistent decision.

#### Scenario: Window closed without answering
- **WHEN** the approval window shows a caller prompt for `codex` and the user closes the window
- **THEN** the `codex` call returns a tool error saying the user denied it
- **AND** the next `codex` call prompts again

### Requirement: Waiting-prompt badge as a backup
While an approval prompt is waiting, the add-on SHALL also show a badge on its toolbar button: the browser action in Firefox, and the Pi Space button in Thunderbird. Clicking the button while a prompt is waiting SHALL bring the approval window to the front. The badge SHALL be cleared when no prompts are waiting.

#### Scenario: Window behind other windows
- **WHEN** the OS doesn't let the approval window take focus and it opens behind other windows
- **THEN** the Pi toolbar button shows a badge, and clicking it brings the approval window to the front

### Requirement: First-use approval per caller and app
The first time a caller name calls a tool served by a given app (Firefox or Thunderbird), the host SHALL ask the user to approve that caller for that app before running the tool. The prompt SHALL be shown in that app. The choices SHALL be Allow once (for this caller session), Always allow this caller, and Deny. "Always allow" and Deny SHALL be stored by caller name *and* app, so approving a caller for Firefox SHALL NOT approve it for Thunderbird, and vice versa. Approving the caller SHALL NOT bypass per-tool approval for tools that need it.

#### Scenario: New caller
- **WHEN** a caller named `codex` that has never been approved calls `browser_get_page`
- **THEN** Firefox asks whether to allow `codex` to use the Firefox tools, and the tool runs only after Allow

#### Scenario: Remembered caller
- **WHEN** the user chose "Always allow" for `codex` in Firefox earlier and a new `codex` caller session calls `browser_get_page`
- **THEN** the tool runs without a caller prompt

#### Scenario: Approval does not carry over to the other app
- **WHEN** `codex` is always allowed in Firefox but has never been approved in Thunderbird, and it calls `mail_search`
- **THEN** Thunderbird asks whether to allow `codex` to use the Thunderbird tools

#### Scenario: Caller approved, tool still gated
- **WHEN** an always-allowed caller calls `browser_screenshot`
- **THEN** the usual per-tool approval prompt is still shown

#### Scenario: Caller denied
- **WHEN** the user chooses Deny for a caller
- **THEN** the call returns an MCP tool error saying the user denied access for that caller
- **AND** later calls in that caller session are refused without asking again

### Requirement: External access setting
The host SHALL have an external-access setting, on by default. It SHALL be changeable from the add-on settings, which SHALL also list remembered callers and allow revoking them. When the setting is off, every caller-session tool call SHALL be refused without a prompt, with an MCP tool error explaining how to turn it on. Calls from host-spawned processes SHALL NOT be affected.

#### Scenario: External access off
- **WHEN** external access is off and an external caller calls `browser_get_page`
- **THEN** the call returns an MCP tool error saying external MCP access is disabled in the Pi add-on settings
- **AND** no prompt is shown

#### Scenario: Revoking a caller
- **WHEN** the user revokes the remembered Firefox approval for `codex` in settings
- **THEN** the next `codex` call to a Firefox tool gets the first-use prompt again
- **AND** a remembered Thunderbird approval for `codex` is unchanged

#### Scenario: On by default
- **WHEN** the host starts with no stored external-access setting
- **THEN** external access is on, and new callers get the first-use prompt

### Requirement: Existing tool rules and timeouts apply
Caller sessions SHALL follow the same per-tool rules as add-on sessions: Ask, Always approve, and persistent Deny. They SHALL use the same 120-second prompt timeout. A prompt that times out or is cancelled SHALL return an MCP tool error, and the bridge SHALL NOT hang. When a prompt times out, it SHALL be removed from the approval window.

#### Scenario: Persistent deny
- **WHEN** `browser_screenshot` is set to Deny in the permission settings and an external caller calls it
- **THEN** the call returns an MCP tool error without a prompt

#### Scenario: Prompt not answered
- **WHEN** an external caller's approval prompt is not answered within the timeout
- **THEN** the call returns an MCP tool error saying the user did not respond
- **AND** the prompt is removed from the approval window

