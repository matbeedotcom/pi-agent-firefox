## 1. Packages and directories

- [ ] 1.1 `packages/pi-agent` → `packages/trusted-user-agent`; workspace packages `@pi-browser/*` → `@trusted-ua/*`, root and tests package names; update scripts, build files, bundle-protocol, lockfile.
- [ ] 1.2 pi extension files and the skill path references.

## 2. Code identifiers

- [ ] 2.1 Protocol constants and types (`PI_BROWSER` → `TRUSTED_UA`, `X_PI_BROWSER` → `X_TRUSTED_UA`, `PiBrowser…` → `TrustedUa…`, `PI_AGENT` → `TRUSTED_UA_HOST`, ...) across all packages.

## 3. Wire names and the legacy dialect (D2)

- [ ] 3.1 `packages/protocol/src/legacy.ts`: normalize incoming / encode outgoing; tests.
- [ ] 3.2 Host transport: per-client dialect from `initialize`; translation in both directions.
- [ ] 3.3 Add-on `AcpClient`: hello under both keys, dialect from the response, translation in both directions.
- [ ] 3.4 Tests: a legacy client against the host; the add-on client against a legacy host response.

## 4. MCP (D3)

- [ ] 4.1 Server name `trusted-ua` (serverInfo, installers, relay `mcpServers`); installers replace and report `pi-browser` entries.
- [ ] 4.2 Caller notification `trusted-ua/caller`; bridge sends both; broker accepts both.

## 5. Files and environment (D4, D5)

- [ ] 5.1 `env.ts` helper (`TRUSTED_UA_*` then `PI_BROWSER_*`); all reads go through it; children get both names.
- [ ] 5.2 Paths helper: data root, run dir, workspaces, logs, heartbeat; JSON read fallback to `~/.pi/browser`; skills package roots.
- [ ] 5.3 Tests: read fallback and new writes; env fallback.

## 6. Add-ons (D1, D6)

- [ ] 6.1 Manifests (names, titles, descriptions); UI text, prompts, onboarding.
- [ ] 6.2 Internal message types `pi/*` → `tua/*`; page globals; log prefixes.
- [ ] 6.3 Storage keys with one-time read of the old key.

## 7. Commands and docs

- [ ] 7.1 `/trusted-ua` command with `/pi-browser` alias; installer usage text.
- [ ] 7.2 README, package README, AMO metadata, AGENTS.md, release notes.

## 8. Verification

- [ ] 8.1 Full test suite; `openspec validate rename-trusted-user-agent --strict`.
- [ ] 8.2 e2e: new add-on + new host (existing suites, agents e2e).
- [ ] 8.3 e2e: signed v0.4.0 xpi + new host (old add-on).
- [ ] 8.4 e2e: new add-on + v0.4.0 host (old host).
- [ ] 8.5 Installers against isolated homes: a `pi-browser` entry in pi/claude/codex configs becomes `trusted-ua`.
