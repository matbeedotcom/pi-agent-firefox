## 1. Checks before building

- [x] 1.1 Check that `PI_BROWSER_HOST_CHILD` set in the broker's `process.env` reaches a stdio MCP server launched by (a) pi 1.5.2's built-in MCP client and (b) pi-mcp-adapter in a subagent child. Record the result in design.md D3, and switch to the ppid fallback if either drops it. *Done:* pi-mcp passes `process.env` through; the ppid fallback is also implemented (design D3).
- [x] 1.2 Check the current config format and CLI commands for each client adapter: `claude mcp add-json/get/remove --scope user`, `codex mcp add/remove` plus the `config.toml` table shape, `~/.cursor/mcp.json`, `~/.gemini/settings.json`, and the VS Code user `mcp.json` path and `code --add-mcp`. Update the table in design.md D7. *Done:* see design D7 (Codex writes TOML literal strings; Claude honours `CLAUDE_CONFIG_DIR`).
- [x] 1.3 Check `windows.create({type: "popup", focused: true})` from the background in Firefox 160 and Thunderbird 160 on Windows: does the window come to the front while another program has focus, or only flash in the taskbar? Record the result in design.md D6; if it only flashes, the badge and taskbar flash are the fallback. *Done:* on Windows the popup does not come to the front over another program; the taskbar flash (`drawAttention`) and badge are the fallback (design D6). Thunderbird rejects `focused` in `windows.create`.

## 2. Protocol

- [x] 2.1 Add the `pi-browser/caller` notification name and a `CallerInfo` type `{name, version?, pid?, hostChild?}` to `packages/protocol`.
- [x] 2.2 Add optional `_meta.piBrowser.caller` to the `RequestPermissionRequest` meta typing.
- [x] 2.3 Add permission-store keys for caller decisions (`callers.<app>.<name>`) and the `externalAccess` setting (default on), with `x-pi-browser/permissions`, `permission_set` and `permission_clear` able to list, set and clear them.
- [x] 2.4 Bump `PI_BROWSER_META.protocolVersion` and note what's new in v4 in `integration.ts`. *Changed:* the version stays 3 — add-ons reject any other value, which would break mixed versions; the additions are documented next to it (design, Migration Plan).

## 3. Caller sessions in the broker

- [x] 3.1 Have `mcp-server.ts` create a caller record per connection, fill it from `pi-browser/caller` or `initialize` `clientInfo`, and default the name to `unknown MCP client`.
- [x] 3.2 Pass `sessionId` and a caller context to `bridge.call` for caller sessions. Keep the no-sessionId path for host-spawned callers (matching `hostChild`).
- [x] 3.3 In `main.ts`, generate the broker instance id, set `PI_BROWSER_HOST_CHILD`, and resolve the caller-session context (no owner, mode `legacy`) in `toolBridge.call`.
- [x] 3.4 Call `closeSession` when the connection closes. Have the provider drop permission groups and session grants and dispose the REPL worker for that id.
- [x] 3.5 Replace the bare "no connected client provides tool" error for caller sessions with a message naming the required app (from `tool-capabilities.ts`).
- [x] 3.6 Unit tests (`packages/trusted-user-agent/test/mcp-server.test.ts` and a new `caller-sessions.test.ts`):
  - a call with no sidebar session runs;
  - a call while a sidebar session is active doesn't use its grants;
  - two connections don't share REPL state or grants;
  - closing a connection disposes its state;
  - `hostChild` matching the broker keeps last-active routing;
  - a missing app gives a tool error.

## 4. Bridge

- [x] 4.1 In `mcp-stdio-bridge.ts`, record `clientInfo` from `initialize` and send `pi-browser/caller` (name, version, pid, `process.env.PI_BROWSER_HOST_CHILD`) as the first line after each broker connect, including reconnects.
- [x] 4.2 Extend `mcp-stdio-bridge.test.ts`: the broker sees the caller name; a reconnect sends it again; an older broker that ignores the notification still works.

## 5. Approval for external callers (host)

- [x] 5.1 In `provider.routeTool`, add the caller-approval gate after target resolution and before the per-tool policy, keyed by caller name *and* executing app: externalAccess off means refuse; a stored allow/deny for that app is applied; otherwise prompt that app with a synthetic tool call and allow_once/allow_always/reject_once options; then cache the result on the session per app and persist "always" and deny.
- [x] 5.2 Add `_meta.piBrowser.caller` to every `session/request_permission` sent for a caller session, including caller approvals.
- [x] 5.3 Apply persistent Deny, Always approve and the 120 s timeout to caller sessions. Make sure timeouts and cancels return MCP tool errors (no hang through the bridge).
- [x] 5.4 Unit tests:
  - first-use prompt;
  - remembered allow skips the prompt;
  - Firefox approval doesn't approve Thunderbird;
  - an allowed caller still gets tool prompts;
  - deny refuses later calls without asking;
  - externalAccess off refuses with no prompt, and a fresh store defaults to on;
  - timeout returns a tool error;
  - host-spawned callers skip the gate;
  - a prompt answered Deny once because its window was closed is not stored.

## 6. Add-on UI

- [x] 6.1 Shared prompt rendering in `packages/webext`: show "<caller> wants to …" when `_meta.piBrowser.caller` is present, and make the prompt component usable outside a chat view (for the approval window).
- [x] 6.2 Approval window: a shared approval page (built and copied by both `build.mjs`) that shows the waiting caller prompts one at a time with the shared prompt component. Closing it answers every waiting prompt Deny once. It closes itself when the queue is empty, including after a timeout or an answer given elsewhere. *As built:* `approval/approval.html` from `packages/webext/src/approval/`; an emptied window waits 1.5 s for a follow-up prompt before closing.
- [x] 6.3 Firefox background: route prompts that carry `_meta.piBrowser.caller` to the approval window (open with `windows.create({type: "popup", focused: true})`, or reuse and focus the open one), never to the sidebar. Set and clear the `action` badge while any prompt is waiting. Make the button click focus the window while one is waiting.
- [x] 6.4 Thunderbird background: the same, with the Pi Space button badge and click handling.
- [x] 6.5 Settings (permissions view): an "Allow other apps (MCP) to use these tools" toggle (on by default), a list of remembered callers for this app, and Revoke.
- [x] 6.6 Add-on unit tests:
  - caller prompts go to the window, chat-session prompts to the sidebar or Space;
  - one window per app, queueing in order;
  - closing the window denies all waiting prompts;
  - a timeout removes the prompt and closes an empty window;
  - badge set and cleared, and the button click focuses the window;
  - settings round-trips through `x-pi-browser/permission_*`.

## 7. Installers for MCP clients

- [x] 7.1 Refactor `installer/mcp.ts` into an adapter interface. Move the current behaviour into the `pi` adapter with no change in output (existing installer tests must pass unchanged). *As built:* the `pi` path still runs the original `runMcpCommand` (unchanged output); the other clients are adapters in `installer/mcp-clients.ts`.
- [x] 7.2 Implement the `claude`, `codex`, `cursor`, `gemini` and `vscode` adapters from 1.2: CLI-backed where available, file-backed otherwise, with parse-error refusal and keeping unknown keys.
- [x] 7.3 Implement the `all` target with per-client results: `installed`, `current`, `stale`, `skipped (reason)`, `error`.
- [x] 7.4 Wire the client argument through `/pi-browser mcp …` (pi extension command) and `installer/cli.ts`, and update usage text.
- [x] 7.5 Installer tests using temporary home directories and a fake `exec`:
  - each adapter's install, status and uninstall;
  - running install twice changes nothing;
  - other servers are kept;
  - an unparseable file is left untouched;
  - Codex TOML snapshots keep comments and formatting.

## 8. npm package and standalone install

- [x] 8.1 Check that `trusted-user-agent` and `trusted-ua` are still free on npm, and publish a placeholder `0.0.0` of `trusted-user-agent` if you want to reserve the name before release. *Done 2026-11-20:* both names still free. The placeholder `0.0.0` was not published (a public publish needs the owner's go-ahead).
- [x] 8.2 Change the npm name of `packages/trusted-user-agent` from `@pi-browser/agent` to `trusted-user-agent` (the folder stays). Update every reference: root `package.json` build scripts (`-w @pi-browser/agent`), `tests/package.json`, `package-lock.json`, `installer/index.ts`, `integration.ts`, tests and probes, README, PRODUCT.md and docs. Add the `bin` entry there and in the root `package.json`, and a shebang to `installer/cli.ts`. Update CLI usage text.
- [x] 8.3 Bundle `@trusted-ua/protocol` into the published package (`bundleDependencies`), or publish it alongside. Make sure `files` leaves out `*.map` files and generated `native/*` launchers. Check with `npm pack --dry-run`. *As built:* the bundled copy carries no `dependencies` (design D8); `npm pack` = 91 files, no `*.map`.
- [x] 8.4 Reject temporary package roots (`_npx`, `os.tmpdir()`) in `runCommand` for install and `mcp install`, with an `--allow-temporary` test override, and print `npm i -g trusted-user-agent`.
- [x] 8.5 Test: from a clean `npm i -g <packed tarball>` into an isolated prefix in `%TEMP%`, with no pi CLI on PATH: *Done:* passed from a clean global install with only `node.exe` on PATH; the check found and fixed the bundling bug in D8. Registry restored.
  - `trusted-ua install` and `trusted-ua mcp install cursor` succeed;
  - `trusted-ua status` reports the host OK;
  - `npx`-style temporary roots are refused.
  Restore the HKCU `com.matbee.agent` registry value afterwards.
- [x] 8.6 Release process: add `npm publish` (2FA, or provenance from CI) after the GitHub release, at the tag's version. Update the release-process memory and README install section. *Done:* README install section, release notes draft, release-process memory. The `npm publish` itself happens at release time.

## 9. End-to-end check and docs

- [x] 9.1 Extend the release e2e harness: with a signed Firefox and no sidebar session, drive `mcp-stdio-main.js` as an MCP client named `e2e-client`, and check: *Done:* 19/19 against Firefox 160 (headless), dev add-on via temporary install, mock backend.
  - with Firefox in the background and the sidebar closed, the caller prompt opens an approval window and sets the badge;
  - answering through RDP lets `browser_get_page` run;
  - `browser_screenshot` gets its own prompt naming `e2e-client`, in the same window;
  - with the sidebar open, the prompt still goes to the window;
  - closing the window returns a deny error to the client.
- [x] 9.2 The same against Thunderbird 160 for `mail_search` and `mail_mark_read`, both in Thunderbird's approval window. Include one caller using both apps, which must get a separate caller prompt in each. *Done:* all caller checks pass against Thunderbird 160 (+ Firefox on the same broker); the harness's mail-seeding poll is flaky, not the product.
- [x] 9.3 With the CLIs available on this machine, run `trusted-ua mcp install all` against isolated homes and check that `claude mcp list` and `codex mcp list` show `pi-browser`. *Done:* `claude mcp list` shows `pi-browser ✔ Connected`, `codex mcp list` shows it enabled; install twice = current; uninstall all removes them; real configs untouched.
- [x] 9.4 README: add a "Use the tools from other agents" section: install commands per client, the approval model (per app, approval window), caller names are self-reported, turning access off. Add release-note text for the routing change and the npm package.
- [x] 9.5 Run `openspec validate external-mcp-callers --strict` and the full test suite.
