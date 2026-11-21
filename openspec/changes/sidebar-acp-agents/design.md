## Context

- **Add-on ⇄ host is already ACP.** The add-ons send `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/list`, `session/set_config_option`, and receive `session/update` and `session/request_permission`.
- **The host answers that ACP itself.** `AcpAgent` (`src/acp/agent.ts`) runs every session on a `PiBackend` (`src/acp/backend.ts`), in production `PiSdkBackend`, which runs pi in-process.
- **That backend interface is shaped around pi:**
  - tools are passed in-process as `ToolSpec`s (`customTools`);
  - events are reduced to five kinds (`text_delta`, `thinking_delta`, `tool_start`/`tool_update`/`tool_end`), which `AcpAgent` turns back into ACP updates;
  - settings are pi's model list and thinking level.
- **From v0.3.0 (`external-mcp-callers`):**
  - the broker serves all tools over MCP;
  - the stdio bridge reports who it is (`pi-browser/caller`);
  - processes the broker spawns carry `PI_BROWSER_HOST_CHILD=<instance id>`;
  - the provider routes calls by a `BridgeSessionContext` (owner client, app, mode).
- **The external agents:** Claude Code and Codex each have an ACP adapter. The host would be their ACP *client*. Gemini CLI, Google's reference ACP agent, is being replaced by Antigravity CLI (announced 2026-05-19; consumer logins ended 2026-06-18), and whether Antigravity CLI speaks ACP is unclear (D1).

## Goals / Non-Goals

**Goals:**
- Start a sidebar, Space or pane session on Claude Code, Codex or another ACP agent, chosen per session; pi stays the default and is unchanged.
- The agent's own experience survives the relay: its tool cards, diffs, plans, thinking, settings and permission prompts.
- The agent gets the browser and mail tools tied to its sidebar session, with no setup in the agent's config.
- Clear errors for missing, logged-out and crashed agents.

**Non-Goals:**
- **Logging in to agents from the sidebar.** ACP `authenticate` flows are not run; the user logs in with the agent's CLI.
- **Offering the agents the client file system or terminals.** ACP `fs/*` and `terminal/*` are not advertised in v1. The agents use their own tools in the session's folder.
- **Bundling or installing agent adapters.**
- **Remote agents, and agents talking to each other.**
- **Changing pi sessions,** or the external MCP callers from v0.3.0.

## Decisions

### D1. Agent registry: built-in pi plus launch specs

An agent is `{id, name, command, args, env?}`, except pi, which is built in (`kind: "pi"`).
- **Built-in defaults:** `claude` (Claude Code's ACP adapter) and `codex` (Codex's ACP adapter). Checked 2026-11-20 (task 1.1):
  - Claude Code: npm `@agentclientprotocol/claude-agent-acp` 0.109, binary `claude-agent-acp` (renamed from `@zed-industries/claude-code-acp`); no flags.
  - Codex: npm `@agentclientprotocol/codex-acp` 2.8, binary `codex-acp` (renamed from `@zed-industries/codex-acp`); no flags.
  - Both install with `npm i -g` on Windows, macOS and Linux; on Windows npm puts a `.cmd` shim on `PATH`, which the host starts through `cmd.exe /d /s /c` with `windowsHide`.
- **Not built in: Google's agent (decided 2026-11-20).** Gemini CLI is being retired in favour of Antigravity CLI. The installed `agy` CLI has no ACP mode or subcommand (task 1.1), so there is nothing to build in; an ACP entry point, if Google ships one, can be added through `agents.json`.
- **User overrides:** `~/.pi/browser/agents.json` (`{"agents": {"<id>": {...}}}`) adds agents or overrides a built-in one. `PI_BROWSER_AGENTS_FILE` overrides the path, for tests.
- **Availability** means the command resolves on `PATH` (same lookup as the installers' `findExecutable`). It is re-checked when the panel asks, cheaply, without launching anything.
- *Why a file, not settings UI:* the commands are developer tooling, edited rarely. A UI can come later.

### D2. One process per agent, many sessions

ACP allows many sessions over one connection, so the broker keeps one `AgentConnection` per agent id.
- **Start:** lazily on the first session.
- **Initialize:** once per start, with `clientCapabilities: {fs: false, terminal: false}`, and the agent's `loadSession` and `mcpCapabilities` remembered.
- **Stop:** when idle (D2a), and at host shutdown.
- **Crash:** if the process exits, sessions on it are marked "agent stopped" and the connection restarts on the next use (spec acp-agent-sessions).
- *Alternative considered:* a process per session. That is simpler isolation, but costs each session a full Node or binary startup and a re-authentication check. The adapters are built to multiplex sessions.

### D2a. Idle agents stop (decided 2026-11-20)

Each `AgentConnection` keeps a last-activity time. It is updated on every message in either direction, and held while a turn runs or a permission request waits. A timer checks once a minute. The process stops when all of these hold:
- the idle time is at least `idleTimeoutMinutes` (default 15; 0 = never);
- no turn is running and no permission request is waiting;
- every session the connection has open can be reloaded: the agent reported `loadSession`, and the session is in the index (D5).

**Stopping:**
- The host closes the connection: stdin ends, then a kill after a grace period.
- It marks the connection's sessions *dormant*. They stay registered in `AcpAgent`, so the add-on sees no change.

**The next request for a dormant session** (prompt, setting change, load):
- starts the agent and initializes it again;
- sends `session/load` (with the same `mcpServers` as D6), and suppresses the replayed history, since the sidebar already shows it;
- then sends the request.

The add-on gets a progress update while that happens: a tool card "Starting Claude Code…" that completes ("Started Claude Code") or fails. An unexpected exit adds a failed card "Claude Code stopped (exit code N). Your next message restarts it."

- *Why idle time, not "no open sessions":* sidebar sessions stay open in the host for as long as the add-on is connected, often for days. Waiting for them to close would almost never stop anything.
- *Why keep agents that can't reload:* stopping them would silently lose the session's context, which is worse than the memory cost.
- *Why 15 minutes:* long enough that a user stepping away for a coffee doesn't pay a restart, short enough that a forgotten agent doesn't hold its memory all day. It is per agent, because start costs differ.

### D2b. The host's ACP client

The host talks to the agent over newline-delimited JSON-RPC on its stdio, with its own small client (`src/acp/agents/connection.ts`) instead of the SDK's typed `ClientSideConnection`. A validating client would drop fields it doesn't know (newer update kinds, `_meta`, the agents' extra notifications), and D3 forwards updates as they are.

### D3. Relay sessions instead of adapting them to `PiBackend`

`AcpAgent` gets a per-session driver: the existing pi path (`PiBackend`), or an `AcpRelaySession` that forwards ACP both ways.
- The relay forwards `session/update` notifications **as ACP**: no `BackendEvent` round trip.
- *Why:* converting the agent's ACP updates into pi's five event kinds and back would lose tool kinds, diffs, locations, terminal output, plans and the agent's titles. It would also need ongoing upkeep as ACP grows.
- **What the relay does:**
  - rewrites the session id (D5);
  - tracks streaming state, so the add-on's busy/recovery logic keeps working;
  - leaves the content untouched.
- **Add-on rendering:** the add-on's update renderer gains plan, diff and terminal content, which pi never sent. Unknown update kinds are ignored, as ACP requires.

### D4. Settings

On `session/new`, `load` or `resume`, the relay keeps what the agent returned: `configOptions`, or else its models and modes. It presents them to the add-on as `SessionConfigOption`s, the type the sidebar already renders for pi's model and thinking level. `session/set_config_option` is forwarded to the agent: as `session/set_config_option` when the agent supports config options, otherwise mapped to setting the agent's model or mode. Checked in task 1.2: both Claude Code and Codex report `configOptions` (Claude: model, effort, fast, ultracode, mode, agent; Codex: model, reasoning effort, fast mode, mode, collaboration mode), and also `modes` (Codex also `models`), so the relay forwards `session/set_config_option`. The models/modes mapping is kept for agents that report only those (covered by the fake agent's tests).

### D5. Session ids and the index

The host uses the agent's own session id as the add-on-visible session id.
- **Why it's safe:** ACP session ids are opaque and, in practice, UUIDs, so they can't clash with pi's UUID session ids.
- **The index:** `~/.pi/browser/agent-sessions.json` keeps `{sessionId, agent, cwd, title, updatedAt}`, written on create and on each completed turn, with the title from the agent's session info, or else the first prompt.
- **Listing:** `session/list` merges pi's sessions with this index; each entry carries `_meta.piBrowser.agent`.
- **Reopening:** load and resume look the id up to choose the driver.
- *Alternative considered:* host-generated ids with a mapping table. That would allow agents with colliding ids, but adds a translation in every message. Not needed: Claude Code uses UUIDv4 and Codex UUIDv7 session ids (task 1.2).
- **Why not the agents' own `session/list`:** both return every session the user has with that agent, terminal sessions included, so the host lists only its own index.

### D6. Tools: the stdio bridge, tied to the sidebar session

On `session/new`, `load` or `resume` to an agent, the relay passes one stdio MCP server, built from the same launch the installers write (`node <pkg>/dist/native-host/mcp-stdio-main.js`):
`{name: "pi-browser", command: <node>, args: [<bridge>], env: [{name: "PI_BROWSER_HOST_CHILD", value: <instance id>}, {name: "PI_BROWSER_PARENT_SESSION", value: <token>}, {name: "PI_BROWSER_BROKER_DIR", value: <run dir>}]}`

- **A token, not the session id:** the agent assigns the session id only in its `session/new` answer, after the `mcpServers` were sent. So `PI_BROWSER_PARENT_SESSION` carries a random token per session, which the broker maps to the session id once it is known (and drops when the session closes). A token is also unguessable.
- **The broker dir is passed explicitly:** Codex starts MCP servers with a trimmed environment, so the bridge doesn't inherit `PI_BROWSER_BROKER_DIR`.

- **The bridge** adds `parentSession` to its `pi-browser/caller` notification.
- **The broker** honours `parentSession` only when `hostChild` matches its instance id: it routes the connection's calls with that session's registered `BridgeSessionContext`, exactly like an in-process pi tool call.
  - That gives the owner's tab binding, grants, REPL state and prompts in the sidebar.
  - It also gives cross-app routing and the cross-app notice.
- **Forged ids:** a process the broker didn't start can't use `parentSession`. It falls back to being an external caller (spec agent-session-tools).
- **Side benefit:** this also replaces the "most recently active session" guess for any host child that reports its session, which was ambiguous with several open sessions.
- **Whether the env reaches the bridge:** checked in task 1.3 — Claude Code and Codex both pass the entry's `env` to the MCP server they start (Claude starts it on the first prompt, not at `session/new`). No socket-path fallback is needed.
- **The REPL:** `javascript` works through the bridge as for v0.3.0 callers, on the session's own REPL state, because the session id is the sidebar session's.

### D7. Permission relay

- **Forwarding:** the agent's `session/request_permission` is forwarded to the owning client's transport, with the session id mapped and `_meta.piBrowser.agent = {id, name}` added.
- **In the add-on:** the existing prompt UI shows it in the sidebar, Space or pane, never in the approval window (that window is for external MCP *callers*, which this isn't).
  - The add-on uses the request's own option names and kinds, which its modal already supports (it renders `request.options`).
  - It shows the tool call's title and content, such as the command or the diff.
- **Timeouts and cancel:** the host applies the add-on's existing prompt timeout and returns `cancelled`. On `session/cancel` it answers the session's waiting requests `cancelled` and sends `x-pi-browser/permission_withdrawn` (from v0.3.0), so the UI drops them.
- **Nothing remembered by the host:** "always" options are the agent's own memory. They are kept apart from the add-on's tool permissions, which govern the pi-browser tools only.

### D8. Errors

- **Missing command:** before launch, a `SESSION_CREATE_FAILED`-style error naming the command and the `agents.json` override.
- **Authentication required:** an ACP auth-required error (code -32000, "Authentication required"), or another error whose message says so. Codex advertises `authMethods` (API key, ChatGPT); Claude Code advertises none and reports its login state in `auth/status_update` notifications, which the host ignores. The error text comes from a per-agent hint ("run `claude` in a terminal and log in"; "run `codex login`"), with a generic "log in with the agent's own CLI" otherwise.
- **Process exit:** pending requests reject with "Claude Code stopped (exit code N)", the add-on shows it in the session, and the next prompt restarts the agent and reloads the session when the agent can (D2).
- **The agent's stderr** goes to the host log, prefixed with the agent id, for diagnosis.

### D9. UI

- **New-session panel** (shared, `packages/webext/src/new-session-panel.ts): an agent selector next to the folder, filled from `x-pi-browser/agents`.
  - Unavailable agents are shown disabled with their reason.
  - The last choice is stored per app in `browser.storage.local`.
  - `create(cwd, agent)` sends `_meta.piBrowser.agent`.
- **Session lists** (sidebar, Space, pane): show the agent's name as a small label for non-pi sessions.
- **Session settings:** render whatever `SessionConfigOption`s the session reports (already generic).

## Risks / Trade-offs

- **[Adapter churn]:** ACP adapters are young; their names, flags and supported methods change. → *Mitigation:* the launch specs are data (D1) and overridable; tasks 1.x pin what was checked; unknown updates are ignored.
- **[Two permission systems in one session]:** the agent's own prompts (files, shell) and the pi-browser tool prompts look alike. → *Mitigation:* agent prompts are labelled with the agent's name and keep the agent's wording; README explains the difference.
- **[Agents act on the user's files]:** Claude Code and Codex edit files and run commands in the session's folder, with their own approval rules, unlike pi under the add-on's sandboxed defaults. → *Mitigation:* this is the agents' normal behaviour; their permission requests come to the sidebar (D7). The default folder for a new session stays the `~/.pi` workspace, not a project.
- **[Slow first start]:** an agent's first session pays its process start and initialize. → *Mitigation:* the panel shows progress; later sessions reuse the process (D2).
- **[Cost and accounts]:** sessions use the user's own Claude, OpenAI or other accounts. The host never handles their credentials.

## Migration Plan

- Ships as v0.4.0. Older add-ons send `session/new` without `_meta.piBrowser.agent` and get pi sessions; older hosts don't answer `x-pi-browser/agents`, so new add-ons show no choice.
- No data migration: the session index is new; pi's session files are untouched.
- **Rollback:** an older host ignores the index. External sessions disappear from the list until upgraded again; nothing is lost.

## Open Questions

None at this time. Decided 2026-11-20:
- idle agents stop (D2a);
- Google's agent is not built in, pending an official Antigravity ACP entry point (D1).
