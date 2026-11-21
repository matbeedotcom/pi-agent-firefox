## 1. Packages and directories

- [x] 1.1 `packages/pi-agent` → `packages/trusted-user-agent`; workspace packages `@pi-browser/*` → `@trusted-ua/*`, root and tests package names; update scripts, build files, bundle-protocol, lockfile.
- [x] 1.2 pi extension files and the skill path references.
  - `extensions/trusted-ua.ts`, `trusted-ua-tools.ts`, `trusted-ua-skills.ts`; native launcher `trusted-ua-host`.

## 2. Code identifiers

- [x] 2.1 Protocol constants and types (`PI_BROWSER` → `TRUSTED_UA`, `X_PI_BROWSER` → `X_TRUSTED_UA`, `PiBrowser…` → `TrustedUa…`, `PI_AGENT` → `TRUSTED_UA_HOST`, ...) across all packages.

## 3. Wire names and the legacy dialect (D2)

- [x] 3.1 `packages/protocol/src/legacy.ts`: normalize incoming / encode outgoing; tests.
- [x] 3.2 Host transport: per-client dialect from `initialize`; translation in both directions.
- [x] 3.3 Add-on `AcpClient`: hello under both keys, dialect from the response, translation in both directions.
- [x] 3.4 Tests: a legacy client against the host; the add-on client against a legacy host response.
  - `packages/protocol/test/legacy.test.ts`, acp-agent "a v0.4.0 add-on …", addon "AcpClient: works with a v0.4.0 host …".

## 4. MCP (D3)

- [x] 4.1 Server name `trusted-ua` (serverInfo, installers, relay `mcpServers`); installers replace and report `pi-browser` entries.
- [x] 4.2 Caller notification `trusted-ua/caller`; bridge sends both; broker accepts both.

## 5. Files and environment (D4, D5)

- [x] 5.1 `env.ts` helper (`TRUSTED_UA_*` then `PI_BROWSER_*`); all reads go through it; children get both names.
- [x] 5.2 Paths helper: data root, run dir, workspaces, logs, heartbeat; JSON read fallback to `~/.pi/browser`; skills package roots.
- [x] 5.3 Tests: read fallback and new writes; env fallback.

## 6. Add-ons (D1, D6)

- [x] 6.1 Manifests (names, titles, descriptions); UI text, prompts, onboarding.
- [x] 6.2 Internal message types `pi/*` → `tua/*`; page globals; log prefixes.
- [x] 6.3 Storage keys with one-time read of the old key.
  - The add-ons' ACP client names stay `pi-browser-firefox` / `pi-thunderbird` (found in 8.4: v0.4.0 hosts record add-on presence only under those names).

## 7. Commands and docs

- [x] 7.1 `/trusted-ua` command with `/pi-browser` alias; installer usage text.
- [x] 7.2 README, package README, AMO metadata, AGENTS.md, release notes.

## 8. Verification

- [x] 8.1 Full test suite; `openspec validate rename-trusted-user-agent --strict`.
- [x] 8.2 e2e: new add-on + new host (existing suites, agents e2e).
  - 2026-11-20: agents e2e 21/21, callers e2e 19/19 (headless Firefox 160).
- [x] 8.3 e2e: signed v0.4.0 xpi + new host (old add-on).
  - 13/13; host log shows the v0.4.0 dialect; the run set only `PI_BROWSER_*` variables (env fallback).
- [x] 8.4 e2e: new add-on + v0.4.0 host (old host).
  - 19/19 (v0.4.0 built in a worktree, registry switched and restored). Found and fixed: client names (above), and the bridge now falls back to the v0.4.0 broker endpoint (`~/.pi/run`, `pi-agent-` pipe).
- [x] 8.5 Installers against isolated homes: a `pi-browser` entry in pi/claude/codex configs becomes `trusted-ua`.
  - Unit-level with temp homes (pi, Cursor JSON, Codex TOML); Claude Code goes through its CLI (`claude mcp remove pi-browser` + `add-json trusted-ua`), covered by the adapter tests. Not run against the real CLIs.
