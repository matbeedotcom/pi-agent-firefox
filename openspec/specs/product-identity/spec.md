# product-identity Specification

## Purpose
TBD - created by archiving change rename-trusted-user-agent. Update Purpose after archive.
## Requirements
### Requirement: The product is called Trusted User Agent
The add-ons, their UI, prompts, onboarding and the documentation SHALL name the product "Trusted User Agent", or "Trusted Agent" where space is short. "pi" SHALL only name the pi agent (the built-in agent choice, the embedded pi SDK and pi's own files and commands). Add-on IDs, the native host name and tool names SHALL NOT change.

#### Scenario: Firefox add-on
- **WHEN** the user opens the Firefox add-ons manager
- **THEN** the add-on is listed as "Trusted User Agent" with the same add-on ID as before

#### Scenario: pi stays an agent
- **WHEN** the user opens the new-session panel
- **THEN** the built-in agent is still listed as "pi"

### Requirement: New protocol names with the old ones still understood
The add-ons and the host SHALL use `x-trusted-ua/*` methods and `_meta.trustedUa` / `_meta.trustedUaAgent` keys. Each SHALL accept messages that use `x-pi-browser/*`, `_meta.piBrowser` and `_meta.piAgent`, and SHALL use those old names toward a peer that only speaks them. The protocol version SHALL stay the same.

#### Scenario: Old add-on, new host
- **WHEN** a v0.4.0 add-on connects to the new host
- **THEN** it initializes, lists and creates sessions, receives tool calls and permission requests, and shows the connected state as before

#### Scenario: New add-on, old host
- **WHEN** the new add-on connects to a v0.4.0 host
- **THEN** it initializes and works, sending the old names to that host

### Requirement: The MCP server is named trusted-ua
The installers SHALL register the MCP server as `trusted-ua`, and SHALL replace an existing `pi-browser` entry of this package in the same client. `mcp status` SHALL report a `pi-browser` entry as an old name to replace. An existing `pi-browser` entry SHALL keep working.

#### Scenario: Upgrading a Claude Code entry
- **WHEN** Claude Code has a `pi-browser` entry and the user runs `trusted-ua mcp install claude`
- **THEN** Claude Code has a `trusted-ua` entry and no `pi-browser` entry

### Requirement: Data in ~/.trusted-ua with the old files still read
The host SHALL keep its files under `~/.trusted-ua/`. When a file there doesn't exist, it SHALL read the same file from `~/.pi/browser/`. New writes SHALL go to `~/.trusted-ua/`. Old files SHALL NOT be deleted.

#### Scenario: Saved approvals carry over
- **WHEN** the user had "Always allow" for `browser_screenshot` in `~/.pi/browser/permissions.json` and upgrades
- **THEN** the screenshot tool is still always allowed, and the next change is saved in `~/.trusted-ua/permissions.json`

### Requirement: TRUSTED_UA_ environment variables with the old names as fallback
Every setting read from the environment SHALL be read from its `TRUSTED_UA_` name, else from its `PI_BROWSER_` name. Variables the host sets for processes it starts SHALL be set under both names.

#### Scenario: Old variable
- **WHEN** only `PI_BROWSER_LOG_FILE` is set
- **THEN** the host logs to that file

### Requirement: The pi command is /trusted-ua
The pi package SHALL provide `/trusted-ua` with the same subcommands as before, and SHALL keep `/pi-browser` working.

#### Scenario: Old command
- **WHEN** the user runs `/pi-browser doctor`
- **THEN** it runs the same check as `/trusted-ua doctor`

