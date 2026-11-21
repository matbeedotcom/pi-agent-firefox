## ADDED Requirements

### Requirement: Published npm package with a CLI
The agent package SHALL be published to the npm registry as `trusted-user-agent`. It SHALL provide a `trusted-ua` executable with the same commands and arguments as the installer CLI: `install`, `status`, `doctor`, `uninstall`, and `mcp <sub> [client]`. With it, the native host and MCP entries can be registered on a machine where the pi CLI is not installed. The published package SHALL include the built host, the stdio bridge and the native launchers. It SHALL NOT include tests, source maps or the add-on builds.

#### Scenario: Install without pi
- **WHEN** a user with Node.js 22 or newer, and no pi CLI, runs `npm i -g trusted-user-agent` and then `trusted-ua install` and `trusted-ua mcp install claude`
- **THEN** the native host `com.matbee.agent` is registered for Firefox and Thunderbird
- **AND** Claude Code has the MCP entry
- **AND** after Firefox starts, Claude Code can call `browser_get_page`

#### Scenario: Published contents
- **WHEN** the package is packed for publishing (`npm pack --dry-run`)
- **THEN** the file list contains `dist/native-host/main.js`, `dist/native-host/mcp-stdio-main.js` and `dist/installer/cli.js`
- **AND** it contains no `test/`, `*.map` or add-on `.xpi` files

#### Scenario: Version matches the release
- **WHEN** a release tag `vX.Y.Z` is cut
- **THEN** the published `trusted-user-agent` version is `X.Y.Z`, the same as the add-ons and `PI_BROWSER_META.version`

### Requirement: Register only from a stable location
The installer SHALL refuse to register the native host or MCP entries when the package root is in a temporary location: an `npx` cache directory (path segment `_npx`) or the OS temp directory. It SHALL say to install the package globally instead. Without this, the registration would break when the cache is cleaned.

#### Scenario: Run through npx
- **WHEN** the user runs `npx trusted-user-agent install`, so the package is unpacked into npx's cache
- **THEN** the installer exits non-zero without registering anything, and prints `npm i -g trusted-user-agent`

### Requirement: pi install keeps working
Installing through `pi install git:...` followed by `/pi-browser install` SHALL keep working unchanged. Both routes SHALL produce the same native-host manifest layout and the same MCP entry format. The one difference is the package root path.

#### Scenario: Switching install methods
- **WHEN** a user who installed through `pi install` later runs `trusted-ua install` from a global npm install
- **THEN** the native-host registration points at the global install's launcher
- **AND** `trusted-ua mcp status` reports each existing MCP entry pointing at the old root as `stale`
