# Thunderbird mail tools — user approval / tool authorization

## Design

Thunderbird's mail tools read and write the user's real mailbox and address
book, so the LLM's access to **each tool** is approval-gated, mirroring the
`browser_screenshot` gate (PRODUCT.md security posture; canonical ACP
`session/request_permission`).

**Policy** — `toolRequiresApproval(application, toolName)` in
`packages/protocol/src/permission.ts`, keyed on the application of the client
that EXECUTES the tool (the routed peer in broker mode, not the session owner):

- `firefox` → only `browser_screenshot` (unchanged; live-gesture capture).
- `thunderbird` → every tool on the mail surface: read-only `mail_*`,
  `compose_*`, mail mutations (`mailModify`), `contacts_*`.

"Allow for this session" is remembered per ACP session (dropped when the
session is disposed); "Allow always" is remembered per host lifetime; "Allow
once" and "Deny" are per call — so each tool asks at most once per scope.

## Flow

1. Agent calls a mail tool (e.g. `mail_get_message_body`).
2. Host (`CapabilityToolProvider.execute`, `packages/pi-agent/src/browser/
   provider.ts`) checks `toolRequiresApproval(targetApp, tool)` and, when
   gated, sends `session/request_permission` (built by
   `buildPermissionRequest`, tool name in `_meta.piBrowser.tool`) to the
   executing client and **blocks** (120s timeout).
3. Thunderbird add-on background (`thunderbird/src/background/index.ts`
   `onRequestPermission` → `requestPermissionFromUser`) pushes
   `pi/permission_request` to the Pi Space AND every open Pi pane Port, and
   blocks until the user answers (125s auto-cancel timer).
4. The Space/pane renders an **Allow once / Allow for this session / Always
   allow / Deny** modal
   (per-tool friendly description from
   `permissionPromptDescription(tool)`, tool name shown in monospace).
5. On allow the host proceeds to the dispatcher; on deny/timeout the tool
   fails with structured `BROWSER_PERMISSION_DENIED` and **never reaches the
   dispatcher**.

## Cross-app attention (prompt shows in the OTHER app)

When the session owner and the executing app differ (plan §29), the user is
watching the session in one app while the prompt shows in the other. The host
therefore also sends the owner a display-only `x-pi-browser/permission_prompted`
(params: sessionId, toolCallId, tool, application — the app showing the
prompt) just before the prompt fires (skipped when a session/host-level
allow covers the tool, or when owner == executor). The owner's UI — Firefox
sidebar, Thunderbird Space, and side pane — shows a pulsing banner:

> 🔔 `mail_get_message_body` is waiting for your approval in **Thunderbird
> (mail)** — the prompt will appear in your mail client.

The banner is per `sessionId:toolCallId`, renders for the active session only
(including a `(+N more)` count), and auto-dismisses when that tool call
reaches a terminal status in the session/update stream. The owner cannot
answer the prompt — the executing client's modal is authoritative — and the
notify is fire-and-forget (5s timeout): a closed/old owner UI never blocks
the prompt itself. Reverse direction works identically (Thunderbird session,
browser tool → “approval in Firefox (browser)”).

## Status

- **Code complete** across protocol / host / add-on background / Space UI /
  pane UI; unit + integration tested:
  - protocol: `toolRequiresApproval` per-application policy,
    `permissionPromptDescription` fallback.
  - provider: deny → `BROWSER_PERMISSION_DENIED` (dispatcher never reached);
    allow_once re-prompts; allow_always sticks; ALL mail-surface tools gated
    on first call; Firefox keeps screenshot-only gating (mail tools ungated
    for firefox applications; cross-app prompts go to the executing client).
  - e2e (real host, mock backend): Thunderbird mail + T4/T6 round-trips now
    assert the permission prompt fired naming the tool.
  - broker (real hosts, relay): cross-app mail/compose prompts routed through
    the relay to Thunderbird; the session owner receives the
    `permission_prompted` heads-up (and the executing client does not).
  - provider: heads-up goes to the session owner on cross-app prompts in
    both directions; never to the executing client about its own prompt;
    never when owner == executor.
- **Live verification pending** in Thunderbird (Space modal + pane modal):
  drive a session that calls a mail tool and confirm the modal appears in
  whichever UI is open, deny/allow behave, and "Always allow" suppresses the
  next prompt for that tool.
