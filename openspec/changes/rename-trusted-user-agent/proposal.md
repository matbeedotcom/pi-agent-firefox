## Why

The product is called **Trusted User Agent** (npm `trusted-user-agent`, command `trusted-ua`), but almost everything else still says "Pi": the add-ons are "Pi Browser" and "Pi Thunderbird", the UI says "Connect Pi Browser to Pi", the protocol uses `x-pi-browser/*` and `_meta.piBrowser`, files live in `~/.pi/browser`, and settings are `PI_BROWSER_*` environment variables. Since v0.4.0 the add-ons chat with Claude Code and Codex as well as pi, so "Pi" as the product name is now misleading: pi is one of the agents, not the product.

## What Changes

- **Name:** the product is **Trusted User Agent** everywhere it is shown (add-on names, UI, prompts, onboarding, docs); "Trusted Agent" where space is short (toolbar title, the Thunderbird space).
- **pi stays pi** where it means the pi agent: the built-in agent choice "pi", the embedded pi SDK, `~/.pi/agent`, `PI_CODING_AGENT_DIR`, `pi install`.
- **Wire protocol** (add-on ⇄ host): `x-pi-browser/*` becomes `x-trusted-ua/*`, `_meta.piBrowser` becomes `_meta.trustedUa`, `_meta.piAgent` becomes `_meta.trustedUaAgent`, the hello type becomes `trusted-ua.hello`. Both sides still understand the old names, so v0.4.0 add-ons work with the new host and new add-ons work with a v0.4.0 host.
- **MCP:** the server is named `trusted-ua` (tools become `mcp__trusted-ua__…`); `trusted-ua mcp install` replaces an old `pi-browser` entry, and `mcp status` reports one as outdated. The caller notification becomes `trusted-ua/caller`; the broker accepts both.
- **Files:** data moves to `~/.trusted-ua/` (permissions, agents.json, agent sessions, skills, logs, run dir, workspaces, heartbeat). Files still in `~/.pi/browser/` are read when the new one doesn't exist, and new writes go to the new place. Nothing is deleted.
- **Environment variables:** `TRUSTED_UA_*`, with `PI_BROWSER_*` still read as a fallback. Processes the host starts get both.
- **Commands:** the pi command becomes `/trusted-ua`; `/pi-browser` keeps working.
- **Code:** identifiers, workspace packages (`@pi-browser/*` → `@trusted-ua/*`) and the host package directory (`packages/pi-agent` → `packages/trusted-user-agent`) are renamed.
- **Unchanged:** add-on IDs (`pi-agent-firefox@matbee.com`, `pi-agent-thunderbird@matbee.com`; AMO and existing installs depend on them), the add-ons' ACP client names (`pi-browser-firefox`, `pi-thunderbird`; older hosts detect the add-ons by them), the native host name `com.matbee.agent`, tool names (`browser_*`, `mail_*`, ...), the GitHub repository name.

## Capabilities

### New Capabilities

- `product-identity`: the names the product shows and uses on the wire, on disk and in the environment, and how the old names keep working.

### Modified Capabilities

None (no archived specs yet).

## Impact

- Every package: `packages/protocol`, `packages/webext`, the host package (renamed directory), `firefox`, `thunderbird`, `tests`.
- Existing installations: after upgrading, `trusted-ua install` and `trusted-ua mcp install all` refresh the registration and MCP entries (as after any upgrade). Saved approvals, agents.json and sessions carry over through the read fallback.
- Docs: README, package README, AMO metadata, AGENTS.md. Historical design docs (PRODUCT.md, plans) keep their wording.
