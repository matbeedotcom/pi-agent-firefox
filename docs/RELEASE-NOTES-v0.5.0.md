# v0.5.0 — release notes

## Pi Browser is now Trusted User Agent

The add-ons and the host package now use one name: **Trusted User Agent** (npm
`trusted-user-agent`, command `trusted-ua`). Since v0.4.0 the add-ons chat with Claude Code and
Codex as well as pi, so "Pi" no longer described the product. pi is still the built-in agent.

Nothing to do for the add-ons: they keep their IDs, so Firefox and Thunderbird update them in
place. Old and new add-ons and hosts work together, in any order.

**After upgrading the host**

```sh
trusted-ua install            # refresh the native host registration
trusted-ua mcp install all    # rename each MCP client's pi-browser entry to trusted-ua
```

**What changed**

| What | Before | Now |
|------|--------|-----|
| Add-ons | Pi Browser, Pi Thunderbird | Trusted User Agent, Trusted User Agent for Thunderbird |
| MCP server | `pi-browser` (`mcp__pi-browser__<tool>`) | `trusted-ua` (`mcp__trusted-ua__<tool>`) |
| pi commands | `/pi-browser`, `/pi-skills` | `/trusted-ua`, `/trusted-ua-skills` (old names still work) |
| Files | `~/.pi/browser/`, `~/.pi/run`, `~/.pi/workspaces`, `~/.pi-browser` | `~/.trusted-ua/` |
| Environment | `PI_BROWSER_*` | `TRUSTED_UA_*` (old names still read) |
| Package folder (git / pi installs) | `packages/pi-agent` | `packages/trusted-user-agent` |
| Release files | `pi-browser-firefox-X.xpi`, `pi-thunderbird-X.xpi` | `trusted-user-agent-firefox-X.xpi`, `trusted-user-agent-thunderbird-X.xpi` |

- Your approvals, `agents.json` and the list of Claude Code / Codex sessions are read from
  `~/.pi/browser/` until the first change saves them to `~/.trusted-ua/`. Nothing is deleted.
- An MCP client whose entry is still named `pi-browser` keeps working; `trusted-ua mcp status`
  reports it as old. Update agent instructions or allowlists that mention `mcp__pi-browser__…`.
- pi subagent definitions that load `…/packages/pi-agent/extensions/pi-browser-tools.ts`
  (`ext:pi-browser-tools`) need the new path
  `…/packages/trusted-user-agent/extensions/trusted-ua-tools.ts` (`ext:trusted-ua-tools`).
- The add-ons ⇄ host protocol uses new names (`x-trusted-ua/*`, `_meta.trustedUa`) and still
  understands the v0.4.0 ones; the protocol version stays 3. The add-ons keep their ACP client names (`pi-browser-firefox`, `pi-thunderbird`), which older hosts use to detect them.
