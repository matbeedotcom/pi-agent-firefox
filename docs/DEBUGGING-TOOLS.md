# Debugging ACP/MCP tools

Run commands from the repository root with Node 22+ and dependencies installed.
This guide describes the current source and harnesses, checked on 2026-09-15.
Historical test counts and timings in [VERIFICATION.md](VERIFICATION.md) are evidence
for those runs, not guarantees for the current build.

## Fastest useful test

| Question | Start here | What is real |
| --- | --- | --- |
| Does a mail filter/page/cursor work? | `thunderbird/test/mail-dispatcher.test.ts` | Dispatcher; mailbox APIs are stubs |
| Do permissions, routing, deadlines and updates work? | `packages/pi-agent/test/provider.test.ts` | Provider and transport test fixtures |
| Are requests correlated correctly? | `packages/pi-agent/test/transport.test.ts` | JSON-RPC dispatcher with in-memory peers |
| Does ACP render streamed tool updates correctly? | `packages/pi-agent/test/acp-agent.test.ts` | ACP adapter; scripted backend |
| Does MCP-over-ACP work end to end? | `tests/src/e2e.test.mjs` | Built host, framing, Firefox MCP server; fake tabs and model |
| Does cross-app routing work? | `tests/src/broker.test.mjs` | Host/broker IPC; simulated clients |
| Does the browser operation work in Gecko? | `.probe/live-repl.mjs` | Firefox, add-on, host and REPL; model mocked by default |
| Does search work on this mailbox? | `.probe/live-mail-search.mjs` | Running Thunderbird and its mailbox; model mocked |

Compile tests before selecting one; running old `dist-tests` can give a false pass:

```sh
npm run build -w @pi-browser/protocol
npx tsc -p thunderbird/tsconfig.tests.json
node --test --test-name-pattern='mail_search' thunderbird/dist-tests/test/mail-dispatcher.test.js

npx tsc -p packages/pi-agent/tsconfig.tests.json
node --test --test-name-pattern='tool_update|timeout|parallel' packages/pi-agent/dist-tests/test/provider.test.js
node --test packages/pi-agent/dist-tests/test/transport.test.js
```

Pass Node test options **before** filenames. These are Node's built-in tests;
Jest's `--runInBand` is not the mechanism for selecting or serializing them.
For complete package suites:

```sh
npm test -w @pi-browser/thunderbird
npm test -w @pi-browser/agent
```

Build the host and Firefox test exports before the cross-package harness:

```sh
npm run build
npx tsc -p firefox/tsconfig.tests.json
node --test tests/src/e2e.test.mjs tests/src/broker.test.mjs
```

## Follow the request across boundaries

ACP controls sessions (`initialize`, `session/new`, `session/prompt`,
`session/cancel`) and reports activity through `session/update`.
The host's capability provider chooses the tool executor:

| Execution path | Wire messages | Implementation |
| --- | --- | --- |
| Thunderbird mail and cross-app callbacks | `x-pi-browser/tool`, optional `x-pi-browser/tool_update` | `packages/pi-agent/src/browser/provider.ts`, `packages/webext/src/acp-client.ts`, `thunderbird/src/background/index.ts` |
| Firefox MCP-over-ACP | `mcp/connect`, `mcp/message`, `mcp/disconnect`; nested MCP `tools/call` | `packages/pi-agent/src/browser/mcp-acp-client.ts`, `firefox/src/background/mcp-server.ts` |
| Browser `javascript` tool | REPL worker invokes ordinary browser tools | `packages/pi-agent/src/repl/`, then the provider above |

Thunderbird declares no MCP server. To test mail, simulate/inspect the callback
path; sending an MCP `tools/call` to Thunderbird does not exercise it.
The actual mail tool name is `mail_search`, not `search_mail`.

Keep these identities distinct in instrumentation:

- JSON-RPC request `id`: matches a response on one transport connection.
- ACP `sessionId`: owns the conversation and tab binding.
- `toolCallId`: owns one invocation and its streamed updates.
- Executing `clientId`: identifies the capability provider selected by the broker.
- Mail `nextCursor`: opaque continuation of a search, not a tool-call ID.

For concurrency, record all five plus the search term, start/end timestamps,
backend (`Gloda` or WDAPI), and per-call update sequence. Existing round-trip
log lines do not always include call IDs or terms; timing proximity alone cannot
prove which search produced a late event.

Native Messaging uses a **4-byte little-endian length followed by UTF-8 JSON**.
Reuse `tests/src/host-client.mjs` and the e2e fixtures when writing a host probe.
Do not pipe newline-delimited JSON into the host, and never log diagnostics to
host stdout: stdout is exclusively the framed protocol channel.

## Build, reload, and verify what is actually running

```sh
npm run build -w @pi-browser/protocol
npm run build -w @pi-browser/agent
npm run build -w @pi-browser/thunderbird
# For Firefox changes:
npm run build -w @pi-browser/firefox
```

Reload the temporary add-on in `about:debugging` after rebuilding its `dist`.
For host changes, reconnect/restart the owning native host after its build.
An existing Node process retains its loaded modules. A relay may reconnect to an
older broker, so inspect the broker owner as well as the new relay process.
Restarting Thunderbird removes temporary add-ons; reload `thunderbird/dist/manifest.json`
if necessary. A debugger reconnect alone does not reload either product component.

Linux inspection:

```sh
pgrep -af 'native-host/main.js|thunderbird'
ls -lt ~/.pi/browser/logs/host-*.log | head
ss -lxnp | rg 'agent-broker'
node packages/pi-agent/dist/installer/cli.js doctor
```

Read the selected host log rather than concatenating every historical log:

```sh
tail -n 160 /absolute/path/to/selected-host.log
rg -n 'initialize:|registry:|permission:|mail_search|round-trip|tool_update|unknown id|session/cancel' /absolute/path/to/selected-host.log
```

`PI_BROWSER_LOG_LEVEL=debug` adds host diagnostics, including tool starts/results.
`PI_BROWSER_LOG_FILE=/absolute/path/to/debug.log` selects the log destination.
Set these in the launcher environment **before the host starts**; setting them in
an unrelated terminal does not change a running host. Debug logs and session
transcripts can contain message content, tool arguments and results; retain only
the evidence needed for the bug report.

The default broker socket is `~/.pi/run/agent-broker.sock`. It is private host IPC,
not an HTTP endpoint or Thunderbird debugger port. Creating a fresh session after
both apps connect avoids an older session's stale tool capability selection.

## Live mailbox and browser probes

Read each probe's header and setup/cleanup before running it. `.probe/` contains
development scripts with machine-specific assumptions, not a portable test API.

### Thunderbird mailbox

With Thunderbird and the rebuilt add-on already running:

```sh
PI_MAIL_PROBE_TEXT='addons.mozilla.org' PI_MAIL_PROBE_LIMIT=10 \
  node .probe/live-mail-search.mjs

PI_MATRIX_TEXT='addons.mozilla.org' PI_MATRIX_TERM='mozilla' \
  node .probe/engine-query-matrix.mjs
```

The mail probe temporarily replaces
`~/.mozilla/native-messaging-hosts/com.matbee.agent.json`, terminates current host
processes, and lets Thunderbird reconnect to a scripted mock broker. This interrupts
active host sessions. It supplies a narrowly scoped `PI_BROWSER_AUTO_APPROVE` test
override and restores the registration during cleanup. Run one such probe at a time;
after interruption verify the registration and reconnect to the normal host.
Do not leave the test approval override in a normal launcher.

Evidence goes under `VERIFICATION-evidence/mail-search-<timestamp>/` or
`VERIFICATION-evidence/engine-matrix-<timestamp>/`; the probe prints its temporary
workspace and host-log path. The matrix uses `mail_debug_query`, which requires
the `piDebug` manifest flag. It measures raw Thunderbird queries, bypassing the
normal Gloda branch and some dispatcher behavior.

`PI_MAIL_PROBE_RUNS` controls repeated fresh searches (1–5).
`PI_MAIL_PROBE_TIMEOUT_MS` controls the harness budget, not the production tool
deadline. `PI_MAIL_PROBE_PAGE_SIZE` currently injects `messagesPerPage` into tool
arguments, but `mailSearch` derives the query page size from `limit`; use the raw
query matrix when testing Thunderbird's pagination knobs.

### Firefox

```sh
node .probe/live-repl.mjs
PI_LIVE_REAL=1 node .probe/live-repl.mjs
PI_LIVE_COLD=1 node .probe/live-repl.mjs
```

The first uses a deterministic model script. `REAL` uses the configured model;
`COLD` tests whether it chooses the tool from a plain-language task. The script
uses Xvfb/xdotool, a hard-coded Firefox path, and a Node path overridable with
`PI_LIVE_NODE`. Inspect these before running on a different machine. It also
temporarily changes native-host registration. Use `PI_LIVE_TIMEOUT_MS` for the
model budget; `PI_LIVE_TASK` and `PI_LIVE_START_URL` change the task/page.

Prefer maintained test suites for transport smoke checks. The older
`.probe/smoke-host.mjs` hard-codes integration protocol version 1, so its version
assertion can fail against a newer working host.

## Attach to live Thunderbird

For a quick read-only engine test, open the Pi Thunderbird **background** inspector
from `about:debugging`, choose its console, and evaluate:

```js
typeof browser.piSearch?.searchMessages
await browser.messages.query({ subject: "Mozilla", messagesPerPage: 10 })
```

This exercises the WebExtension API, bypassing ACP, host permissions and dispatcher
normalization. Bundled dispatcher functions may be inside an IIFE and unavailable
as globals: `dispatchMailTool(...)` is not a supported console entry point. Use a
breakpoint in `onToolCall` or the live host probe for the actual tool path.

Discover the current debugger listener on Linux:

```sh
ss -ltnp | rg 'thunderbird|thunderbird-bin'
lsof -nP -iTCP -sTCP:LISTEN | rg thunderbird
```

Read the loopback port owned by the main Thunderbird process. Do not hard-code
previously observed ports: Browser Toolbox sessions can create a different one.
An open TCP socket proves reachability only, not successful debugger attachment.

Mozilla RDP uses **ASCII byte length, a colon, then JSON** (`123:{...}`), unlike
Native Messaging. A raw client should:

1. Read the root greeting, then send `listAddons` to `root`.
2. Select `pi-agent-thunderbird@matbee.com`; verify its loaded `url` points at this
   checkout's `thunderbird/dist/`.
3. Obtain that descriptor's watcher, watch frame targets, and select the generated
   background page. Handle notifications interleaved with request replies.
4. Evaluate through the target's console actor and wait for `evaluationResult`.
   Bound every socket read; handle EOF and disconnect cleanly.

During investigation, the listener answered `listAddons` but `getWatcher` stalled.
That is a debugger-attachment failure, not evidence of a mail-search failure.
Use the interactive background inspector if this occurs. The earlier
`/tmp/tb-rdp.py` was a session-local experiment, not a checked-in reliable harness.

## Reproduce parallel calls correctly

The mock backend's scripted `toolCalls` array executes **sequentially**
(`packages/pi-agent/src/acp/mock-backend.ts`, `stepTool`). Two entries do not prove
concurrent behavior. In a provider test, invoke the same tool's `execute` twice
with distinct IDs and use `Promise.allSettled`; in a dispatcher test, invoke
`dispatchMailTool` twice with distinct contexts.

Use deferred backend promises to force overlap, resolve the second before the
first, and assert the exact results and updates for each ID. Give fake mailbox
queries distinct list IDs and independent page queues. A single global
`list-1`/`searchCursorServed` stub cannot establish search isolation.

Compare each term alone, both concurrently, and reversed start order on live data.
Record cache/index state and whether Gloda was actually used. A later fast result
does not establish that it cancelled the earlier search.

## Timeout and streaming traps

- The mail transport currently allows 120 seconds plus 5 seconds slack. A failure
  near 125 seconds locates the host deadline, not the underlying engine cause.
- Streaming updates do not extend that deadline. Log the first update separately
  from final completion, and distinguish permission wait from execution time.
- WDAPI `fullText` may decode MIME bodies. Its automatic page timer starts only
  after a match exists, so a rare/no-match query can wait for a long scan.
- `returnMessageListId: true` returns a string handle, not `{messages, id}`.
  `continueList()` may still wait; one pending read must be retained per list.
- A transport timeout does not automatically abort Thunderbird's scan. Confirm
  an actual `abortList()` call and eventual backend settlement before claiming
  cleanup. A late event must be correlated by ID before attributing it.
- `complete: false` with an empty page and a cursor means pending work, not zero
  matches. Resume the cursor unchanged. `scanned` in the current dispatcher counts
  returned headers; it does not count every body Thunderbird inspected internally.

Current implementation limits to test explicitly: the 15-second wait applies to
selected continuation/header-page waits, while the initial fallback `query()` and
Gloda call remain directly awaited. Serializing `continueList()` consumers does
not serialize scans that Thunderbird already started in the background. The
phase-2 timeout path also needs coverage for resuming its pending first page.
The current parallel test checks maximum simultaneous continuation calls, but its
shared stub and weak result assertions do not prove independent message results.
Passing that test alone is not live verification of the timeout fix.

## Evidence for a useful handoff

Record the commit/dirty files, app version, loaded add-on path, host PID and start
time, exact arguments, session/call/list identities, selected backend, timings,
and result/error. Include one focused test command and the relevant log excerpt.
State separately whether validation used stubs, a real host, a real application,
and a real model. Keep verification reports in `VERIFICATION-evidence/` and link
them from a bug or change description; avoid committing mailbox content or credentials.
