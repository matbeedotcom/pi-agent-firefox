## 1. Checks before building

- [x] 1.1 Find the current ACP adapters and their launch commands for Claude Code and Codex: package names, binaries, flags, and how each is installed on Windows, macOS and Linux. Record them as the built-in launch specs in design D1. Also check whether Google ships an official ACP entry point for Antigravity CLI (Gemini CLI's replacement). If it does, record an `agents.json` example for it in the README, or make it a built-in if it works in 1.2.
  - Done 2026-11-20: `@agentclientprotocol/claude-agent-acp` (`claude-agent-acp`) and `@agentclientprotocol/codex-acp` (`codex-acp`), no flags, `npm i -g` everywhere (Windows `.cmd` shim). The installed `agy` has no ACP mode: not built in, README says so.
- [x] 1.2 For each target agent, record from a real session:
  - which methods it supports (`loadSession`, `session/resume`, `session/close`, `session/list`);
  - whether it reports `configOptions` or models/modes;
  - its session id format;
  - which update kinds it sends;
  - how it reports "not logged in".
  Update design D4, D5 and D8.
  - Done: both support loadSession, resume, close, list (list returns all the user's sessions → host index only); both report configOptions (+ modes; Codex + models); ids UUIDv4 (Claude) / UUIDv7 (Codex); updates seen: agent_message_chunk, tool_call(_update), session_info_update, usage_update, available_commands_update, current_mode_update, config_option_update; Codex advertises authMethods, Claude reports login in `auth/status_update`. Logged-out state was not reproduced (not logging the user out); the host handles ACP's -32000 "Authentication required".
- [x] 1.3 Check that each target agent passes the `env` of a stdio `mcpServers` entry to the process it starts (so `PI_BROWSER_HOST_CHILD` and `PI_BROWSER_PARENT_SESSION` reach the bridge). Record the result in design D6, and implement the socket-path fallback if any agent drops it.
  - Done: both pass it (Claude starts the server on the first prompt). No fallback needed. Codex trims the *inherited* environment, so the host also passes `PI_BROWSER_BROKER_DIR` in the entry (found in 8.3).

## 2. Protocol

- [x] 2.1 Add `x-pi-browser/agents` (request/result types: id, name, available, reason) and `AgentInfo` to `packages/protocol`. (`agents.ts`: `AGENTS_METHOD`, `AgentInfo`, `AgentsResult` with `defaultAgent` and `configError`; `X_PI_BROWSER.agents`.)
- [x] 2.2 Add the optional `_meta.piBrowser.agent` on `session/new` params and on listed sessions, and `_meta.piBrowser.agent = {id, name}` on relayed permission requests. (`requestedAgentId`, `agentRefOf`, `PermissionRequestPiBrowserMeta.agent`; `permission_withdrawn` reason gains `cancelled`.)
- [x] 2.3 Add `parentSession` to `CallerInfo` (`pi-browser/caller`) and the `PI_BROWSER_PARENT_SESSION` env name.

## 3. Agent registry and process (host)

- [x] 3.1 `src/acp/agents/registry.ts`: built-in specs from 1.1, `agents.json` loading with parse-error reporting, availability via `findExecutable`. (Own `findCommand`, same lookup plus `.bat` and absolute paths; also `disabled` and `loginHint` fields.)
- [x] 3.2 `src/acp/agents/connection.ts`:
  - spawn the agent;
  - an ACP client over its stdio, using `@agentclientprotocol/sdk`'s client side;
  - initialize with fs/terminal off;
  - restart after exit;
  - stderr to the host log;
  - shutdown with the host.
  - Note: a small JSON-RPC client instead of the SDK's typed client, so updates pass through unchanged (design D2b). Restart is done by the manager on the next request.
- [x] 3.3 Answer `x-pi-browser/agents` in `AcpAgent`.
- [x] 3.5 Idle stop (design D2a):
  - track last activity, held during turns and waiting permission requests;
  - a once-a-minute check against `idleTimeoutMinutes` (default 15, 0 = never), stopping only when every open session can be reloaded;
  - mark the sessions dormant;
  - on the next request: restart, `session/load` with the replay suppressed, then continue, with a "Starting <agent>…" progress update.
- [x] 3.4 Unit tests with a fake ACP agent (a small script speaking ACP over stdio):
  - start on first session;
  - one process for two sessions;
  - restart after a crash;
  - missing command;
  - invalid `agents.json`;
  - idle stop after the timeout (fake clock);
  - no stop during a long turn or a waiting permission request;
  - no stop when a session can't be reloaded;
  - `idleTimeoutMinutes: 0`;
  - a prompt to a dormant session restarts, reloads without re-sending history, and runs.
  - `test/fixtures/fake-acp-agent.mjs`, `test/external-agents.test.ts`.

## 4. Session relay (host)

- [x] 4.1 Per-session driver in `AcpAgent`: pi (existing) or `AcpRelaySession`, chosen from `_meta.piBrowser.agent` on create and from the index on load/resume.
- [x] 4.2 Relay `prompt` (text and images), `cancel` and `close`. Forward `session/update` to the owner transport with the session id mapped, and keep the streaming state the add-on relies on.
- [x] 4.3 Settings (design D4): keep and present `configOptions` or models/modes; forward `session/set_config_option`.
- [x] 4.4 Session index `~/.pi/browser/agent-sessions.json` (design D5); merge into `session/list`; load/resume through the agent when supported, otherwise a clear error.
- [x] 4.5 Errors (design D8): missing command, auth required with a per-agent hint, process exit mid-turn.
- [x] 4.6 Unit tests against the fake agent:
  - a streamed reply with a diff tool call reaches the client unchanged;
  - cancel;
  - a setting change;
  - list and reload;
  - auth-required message;
  - crash mid-turn then recovery.

## 5. Tools for agent sessions (host)

- [x] 5.1 Pass the `pi-browser` stdio server in `mcpServers` on create/load/resume, with `PI_BROWSER_HOST_CHILD` and `PI_BROWSER_PARENT_SESSION`. (The parent value is a per-session token mapped to the session id, design D6; plus `PI_BROWSER_BROKER_DIR`.)
- [x] 5.2 Bridge: read `PI_BROWSER_PARENT_SESSION` and send it as `parentSession`.
- [x] 5.3 Broker: when `hostChild` matches and `parentSession` names a registered session, run the connection's calls with that session's `BridgeSessionContext`; otherwise fall back to the v0.3.0 behaviour. (A host child whose session closed is refused rather than routed to another session.)
- [x] 5.4 Unit tests:
  - parent-session routing uses that session's grants and owner;
  - two sessions stay apart;
  - a forged `parentSession` without the marker becomes an external caller;
  - cross-app routing still works.
  - Cross-app: the agent session registers the same `BridgeSessionContext` (owner client and app) as pi sessions, so routing goes through the unchanged provider path; covered by the existing provider tests.

## 6. Permission relay (host and add-ons)

- [x] 6.1 Host: forward the agent's `session/request_permission` to the owner with the session id mapped and `_meta.piBrowser.agent`. Apply the timeout, answer waiting requests `cancelled` on cancel or client disconnect, and withdraw them from the UI.
- [x] 6.2 Add-ons: the prompt shows the agent's name, the tool call's title and content (command, diff), and the agent's own options. Route these to the sidebar, Space or pane (never the approval window), and keep them out of the tool permission settings.
- [x] 6.3 Tests: options passed through and the chosen id returned; timeout → `cancelled`; cancel withdraws; disconnect cancels.

## 7. Add-on UI

- [x] 7.1 New-session panel: an agent selector filled from `x-pi-browser/agents` (unavailable agents disabled with the reason), the last choice remembered per app, `_meta.piBrowser.agent` on create. Show no selector with older hosts.
- [x] 7.2 Session lists in the sidebar, Space and pane: the agent label for non-pi sessions.
- [x] 7.3 Update rendering: plans, and tool-call content of type diff and terminal; ignore unknown update kinds. (A plan is a "Plan" card updated in place; diffs render as a line diff in the tool card.)
- [x] 7.4 Add-on tests: the selector with and without the host feature, the label, diff/plan rendering. (`packages/webext/test/agents.test.ts`.)

## 8. Status, docs, end-to-end

- [x] 8.1 `trusted-ua status`, `doctor` and `/pi-browser status`: list agents and `agents.json` problems.
- [x] 8.2 e2e with the fake ACP agent against a real Firefox 160:
  - create an agent session from the panel;
  - stream a reply;
  - the agent calls `browser_get_page` on the session's tab through the bridge, with the approval prompt in the sidebar;
  - the agent's own permission request is answered in the sidebar;
  - reload the session after a restart;
  - prompt again after an idle stop (short timeout).
  - 21/21 headless, 2026-11-20. "Reload after a restart": the agent process restarted after the idle stop, and the closed session reopened through the agent (the host itself was not restarted in e2e; host restart + reload is in the unit tests).
- [x] 8.3 Manual check with the real Claude Code and Codex adapters on this machine: a short session each, with one browser tool call and one agent permission prompt.
  - 6/6, 2026-11-20, through the host's ExternalAgents, the real stdio bridge and broker MCP server (stand-in tool bridge, no Firefox): `browser_get_page` ran for each agent's own session; Claude asked permission for the MCP tool, Codex for the shell command; both turns ended with the page title in the reply.
- [x] 8.4 README section "Chat with Claude Code or Codex in the sidebar": requirements (the agent's ACP adapter and login), `agents.json`, what the two kinds of prompts mean. Release notes. (`docs/RELEASE-NOTES-v0.4.0.md`, draft.)
- [x] 8.5 `openspec validate sidebar-acp-agents --strict` and the full test suite.
