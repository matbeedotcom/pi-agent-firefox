# mcp-client-installers Specification

## Purpose
How `trusted-ua mcp` installs, checks and removes the `trusted-ua` MCP server entry in each supported client's configuration.

## Requirements
### Requirement: Supported client targets
`/trusted-ua mcp <install|status|uninstall> [client]` and `trusted-ua mcp <install|status|uninstall> [client]` (the standalone command, see the standalone-install spec) SHALL accept these clients: `pi`, `claude`, `codex`, `cursor`, `gemini`, `vscode`, `all`. With no client given, the target SHALL be `pi`, matching current behaviour. `all` SHALL act on every supported client whose config location or CLI is present on this machine, and SHALL report the others as skipped.

#### Scenario: Default target unchanged
- **WHEN** the user runs `/trusted-ua mcp install` with no client
- **THEN** only `~/.pi/agent/mcp.json` is written, exactly as in v0.2.5

#### Scenario: Install for all clients
- **WHEN** the user runs `trusted-ua mcp install all` on a machine where Claude Code and Cursor are installed but Codex, Gemini CLI and VS Code are not
- **THEN** the `pi`, `claude` and `cursor` entries are written
- **AND** `codex`, `gemini` and `vscode` are reported as skipped, with the reason

### Requirement: Same stdio bridge entry for every client
Every client's entry SHALL be named `trusted-ua`. Each SHALL launch `<node> <pkgRoot>/dist/native-host/mcp-stdio-main.js` using absolute paths, in the format that client expects. Each client SHALL be written at user (global) scope.

#### Scenario: Claude Code entry
- **WHEN** the user installs for `claude`
- **THEN** Claude Code's user scope has a stdio server `trusted-ua` with that command and args
- **AND** `claude mcp list` shows `trusted-ua`

#### Scenario: Codex entry
- **WHEN** the user installs for `codex`
- **THEN** `~/.codex/config.toml` has a `[mcp_servers.trusted-ua]` table with that command and args, and the rest of the file is byte-for-byte unchanged

### Requirement: Installs are safe and repeatable
The installer SHALL change only the `trusted-ua` entry. It SHALL keep every other server and setting in the file, and keep keys the user added to the `trusted-ua` entry that the installer doesn't manage. Running install again with the same package SHALL leave the file unchanged. The installer SHALL NOT write a file it can't parse; it SHALL report the parse error and leave the file untouched. When a client has its own CLI for registering MCP servers, the installer SHALL use that CLI instead of editing files the client manages while running.

#### Scenario: Other servers kept
- **WHEN** `~/.cursor/mcp.json` already lists servers `a` and `b`, and the user installs for `cursor`
- **THEN** the file lists `a`, `b` and `trusted-ua`, and `a` and `b` are unchanged

#### Scenario: Unparseable config
- **WHEN** `~/.gemini/settings.json` is not valid JSON and the user installs for `gemini`
- **THEN** the installer reports the parse error for that file, does not change it, and still installs the other requested clients

#### Scenario: Running install twice
- **WHEN** the user runs install for `claude` twice with the same package version
- **THEN** the second run reports the entry as already current and changes nothing

### Requirement: Status and uninstall for each client
`mcp status` SHALL report, for each client it was asked about, one of `missing`, `current` or `stale`, plus the config location. An entry is stale when its command or args differ from the expected bridge launch. `mcp uninstall` SHALL remove only the `trusted-ua` entry and SHALL leave the rest of the config as it was.

#### Scenario: Stale after moving the package
- **WHEN** an entry points at a bridge path from an older package location
- **THEN** `mcp status claude` reports `stale`, showing both the configured and expected command
- **AND** `mcp install claude` updates the entry

#### Scenario: Uninstall
- **WHEN** the user runs `mcp uninstall all`
- **THEN** every client's `trusted-ua` entry is removed, and nothing else in those configs changes

