## Context

- One native host (`com.matbee.agent`) serves both add-ons. Users upgrade the host (npm, pi package) and the add-ons (signed xpi, Thunderbird xpi) separately, so for a while a new host meets old add-ons and the other way round.
- The add-ons reject a host whose `protocolVersion` differs (and the host rejects a different ACP version), so the rename must not change those numbers.
- MCP client configs (Claude Code, Codex, Cursor, Gemini CLI, VS Code, pi) hold an entry named `pi-browser` written by earlier installers; the entry launches this package's stdio bridge.
- Files under `~/.pi/browser/` hold the user's approvals (`permissions.json`), `agents.json`, the agent session index, skill grants and packages.

## Goals / Non-Goals

**Goals:** one product name everywhere; new names on the wire, on disk and in the environment; v0.4.0 add-ons, hosts, MCP entries, files and environment variables keep working.

**Non-Goals:** changing add-on IDs, the add-ons' ACP client names (`pi-browser-firefox`, `pi-thunderbird`: v0.4.0 hosts record add-on presence for `status`/`doctor` only under those names; found in task 8.4), the native host name, tool names, the repository name; renaming the pi agent's own things (`pi`, `~/.pi/agent`, `PI_CODING_AGENT_DIR`); rewriting historical design docs.

## Decisions

### D1. Names

| What | Old | New |
|------|-----|-----|
| Product (UI, docs) | Pi Browser, Pi Thunderbird, Pi | Trusted User Agent (short: Trusted Agent) |
| Firefox add-on name | Pi Browser | Trusted User Agent |
| Thunderbird add-on name | Pi Thunderbird | Trusted User Agent for Thunderbird |
| Thunderbird space | Pi Space | Trusted Agent |
| Private ACP methods | `x-pi-browser/<m>` | `x-trusted-ua/<m>` |
| `_meta` keys | `piBrowser`, `piAgent` | `trustedUa`, `trustedUaAgent` |
| Hello type | `pi.agent.hello` | `trusted-ua.hello` |
| MCP server name | `pi-browser` | `trusted-ua` |
| MCP caller notification | `pi-browser/caller` | `trusted-ua/caller` |
| Data dir | `~/.pi/browser`, `~/.pi/run`, `~/.pi/workspaces`, `~/.pi-browser` | `~/.trusted-ua/` (`run/`, `workspaces/`, `logs/`, files at the top) |
| Env vars | `PI_BROWSER_*` | `TRUSTED_UA_*` |
| pi command | `/pi-browser` | `/trusted-ua` (old name kept) |
| Code | `PI_BROWSER`, `X_PI_BROWSER`, `PiBrowser…`, `@pi-browser/*`, `packages/pi-agent` | `TRUSTED_UA`, `X_TRUSTED_UA`, `TrustedUa…`, `@trusted-ua/*`, `packages/trusted-user-agent` |
| Add-on internal messages, storage keys | `pi/<action>`, `piBrowserState`, ... | `tua/<action>`, `trustedUaState`, ... (stored values read from the old key once) |

### D2. Two dialects on the wire, translated at the edge

The code uses only the new names. Each end translates at its transport:
- **Receiving:** every incoming message is normalized to the new names: method prefix `x-pi-browser/` → `x-trusted-ua/`, `_meta.piBrowser` → `_meta.trustedUa`, `_meta.piAgent` → `_meta.trustedUaAgent` (at any depth), hello type `pi.agent.hello` → `trusted-ua.hello`. When both old and new keys are present, the new one wins.
- **Sending:** to a peer that speaks the old dialect, the same mapping is applied in reverse.
- **Who speaks what:** the host decides per client from its `initialize`: old dialect when the request has only old keys. The add-on sends `initialize` with the hello under both keys (an old host reads `piAgent`, a new one `trustedUaAgent`) and decides from the response: old dialect when the response has only `_meta.piBrowser`.
- *Why at the edge:* the alternative, dual names at every call site, touches every message handler and is easy to get wrong in one place. One pure function (`packages/protocol/src/legacy.ts`) with tests covers all of it.
- `protocolVersion` stays 3: nothing changes in meaning.

### D3. MCP server and bridge

- Installers write the entry as `trusted-ua` and remove an existing `pi-browser` entry for this package in the same client. `mcp status` reports a `pi-browser` entry as "old name: run `trusted-ua mcp install <client>`". `mcp uninstall` removes both names.
- The bridge sends `trusted-ua/caller` and, for an older broker, `pi-browser/caller` (an older broker ignores the new one; the new broker treats the second as a repeat).
- The relay's `mcpServers` entry for agent sessions is named `trusted-ua`.

### D4. Files: read fallback, new writes

- Data root: `TRUSTED_UA_DATA_ROOT`, else `PI_BROWSER_DATA_ROOT`, else `~/.trusted-ua`.
- Each JSON file the host reads (`permissions.json`, `agents.json`, `agent-sessions.json`, `skills-grants.json`) is read from the new root, else from `~/.pi/browser/` when the new one doesn't exist. Writes always go to the new root, so the first write migrates it. Nothing is deleted.
- Skill packages: both `~/.trusted-ua/packages` and `~/.pi/browser/packages` are package roots (new first).
- Run dir (broker socket, named pipes, state): `~/.trusted-ua/run`. A v0.4.0 host and a new one don't meet as broker/relay; only one host version is registered at a time.
- Workspaces for new sessions: `~/.trusted-ua/workspaces`. Existing sessions keep their folders.
- Add-on heartbeat: written to `~/.trusted-ua/client.heartbeat`; `status` also reads the old file.
- Windows named pipes: `trusted-ua-<hash>-…` instead of `pi-agent-<hash>-…`.

### D5. Environment variables

`envValue("BROKER_DIR")` reads `TRUSTED_UA_BROKER_DIR`, then `PI_BROWSER_BROKER_DIR`. Variables the host sets for its children (host-child marker, parent session, broker dir) are set under both names, so an older bridge still finds them. `PI_BROWSER_AGENT_DIR` becomes `TRUSTED_UA_PI_AGENT_DIR` (it names pi's agent dir).

### D6. Add-on storage keys

On startup each store reads its new key, and if absent the old key, then writes the new key. The old key is left in place (a downgrade still finds its data).

## Risks / Trade-offs

- **[Mixed versions]** → D2 dialect translation; tested with the signed v0.4.0 xpi against the new host, and the new add-on against a v0.4.0 host.
- **[MCP entries named `pi-browser` in users' configs]** → they still launch the (upgraded) bridge and work; `mcp status` tells the user to re-run `mcp install`, which renames them. Agent prompts or allowlists that mention `mcp__pi-browser__…` need the new prefix; release notes say so.
- **[Data in two places]** → reads fall back, writes go to the new place; documented. A downgrade after the first write sees the old (older) file.
- **[Large mechanical diff]** → done in phases, each built and tested before the next.

## Migration Plan

Ships as v0.5.0. After upgrading: `trusted-ua install` (or `/trusted-ua install`) and `trusted-ua mcp install all`. Rollback: install v0.4.0; it reads `~/.pi/browser` (unchanged except for files it never had).
