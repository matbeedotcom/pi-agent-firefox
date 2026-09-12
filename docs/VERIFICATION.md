# §52 Definition of Done — Verification Record

**Date:** 2026-09-11 · **Machine:** Linux (x86_64), Node 22.22.3
**Browser:** Firefox 155 (tarball, `/home/acidhax/Downloads/firefox-155.0.1/`) — snap Firefox also exercised during development
**Agent:** real Pi (in-process `createAgentSession` inside the native host)
**Demo app:** `/home/acidhax/pi-browser-demo/` served at `http://127.0.0.1:8765/` (Counter page with note input; the note value is mirrored into `document.title` so tool results can verify page state)

> **Identity rename (2026-09-11, post-verification):** the add-on IDs and the
> native host name moved from `pi.*`/`@pi.dev` placeholders to the
> project-owned matbee domain —
> `pi-browser@pi.dev` → **`pi-agent-firefox@matbee.com`**,
> `pi-thunderbird@pi.dev` → **`pi-agent-thunderbird@matbee.com`**
> (`pi-firefox@matbee.com` stays authorized for compatibility),
> host name `dev.pi.agent` → **`com.matbee.agent`**
> (`dev.pi.browser` remains the legacy name, recognized for uninstall
> cleanup only). Integration protocol version bumped 1 → 2. The evidence
> citations below quote the identities as they were at verification time;
> the renames are identity changes only — behavior, transport, and security
> invariants are unchanged.

All 19 items were verified **live** on this machine (real Firefox + real Pi), except where a
test-only note is given explicitly. Evidence pointers resolve as of the date above:

- Session transcripts: `~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl`
- Host log: `/tmp/pi-browser-host.log` (set via `PI_BROWSER_LOG_FILE`; volatile — cite the timestamp, `grep` by pattern)
- This file's evidence notes: `docs/evidence/`

## The 19 items

| # | Requirement (§52) | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | User installs the Pi Browser package | ✅ live | Package installed from this repo; host runs from it — `pgrep -af native-host/main.js` shows the launcher executing `<repo>/packages/pi-agent/dist/native-host/main.js`. The user installed it on 2026-09-11 following the sidebar onboarding screen (see README quick-start). |
| 2 | `/pi-browser install` registers the host | ✅ live + unit | Manifest `~/.mozilla/native-messaging-hosts/dev.pi.browser.json` exists with `name: dev.pi.browser`, `allowed_extensions: ["pi-browser@pi.dev"]`. The `/pi-browser` command (`packages/pi-agent/extensions/pi-browser.ts`) delegates to the same `runCommand("install")` that was executed live this day (`node packages/pi-agent/dist/installer/cli.js install`). Cross-platform paths (macOS, Windows registry) are test-only: `packages/pi-agent/test/installer.test.ts`. |
| 3 | User installs the Firefox add-on | ✅ live | Temporary add-on loaded from **`firefox/dist/manifest.json`** (id `pi-browser@pi.dev`) via `about:debugging → Load Temporary Add-on` — repeated multiple times on 2026-09-11, incl. while the host was deliberately uninstalled (onboarding screen flow). |
| 4 | Firefox calls `connectNative("dev.pi.browser")` | ✅ live | Firefox spawned the host: the host process command line carries the connecting extension id as its last arg (`… main.js …/dev.pi.browser.json pi-browser@pi.dev` — `allowed_extensions` match enforced by Firefox). The host records add-on presence in `~/.pi-browser/client.heartbeat` (written only for client identity `pi-browser-firefox`). |
| 5 | Firefox initializes Pi as an ACP agent | ✅ live | Host log (2026-09-11T22:14:11Z, current build): `initialize: client=pi-browser-firefox v0.1.0 proto=1`. Response carries ACP capabilities + `piBrowser` integration metadata; version mismatch returns structured `PROTOCOL_VERSION_MISMATCH` (e2e `tests/src/e2e.test.mjs`). |
| 6 | Firefox can list existing Pi sessions | ✅ live | Sidebar session list populated on every connect (`refreshSessionList` after ACP initialize; `session/list` covered by e2e). Observed live all day 2026-09-11 (multi-session sidebar in use). |
| 7 | Firefox can create multiple Pi sessions | ✅ live | Live sessions exist in three different cwds — `~/.pi/agent/sessions/--home-acidhax--/`, `--home-acidhax-pi-browser-demo--/`, `--home-acidhax-dev-personal-firefox-acp-addon--/`. Sidebar “+ New” with cwd input; e2e creates concurrent sessions with isolation. |
| 8 | Firefox can resume an existing session | ✅ live (current build) | 2026-09-11T21:42:31Z: user resumed session `01a08f2a-1919-77bf-b99f-471ec46b7a22` (created 06:31Z) and prompted it — log line: `session/prompt 01a08f2a-… (18 chars, 0 images)`. Host log totals that day: 33× `session/resume`, 73× `session/load`. e2e covers resume semantics. |
| 9 | Firefox can send prompts | ✅ live | 650× `session/prompt` in the host log (real + harness). Flagship prompt in `…/01a090cf-…jsonl`; the 21:42:31Z prompt to the resumed session above. |
| 10 | Pi responses stream into the sidebar | ✅ live | Streamed `session/update` notifications rendered in the sidebar conversation (read live all day 2026-09-11). e2e asserts ordered chunk streaming over real framing. |
| 11 | Firefox can cancel an active turn | ✅ live | 47× `session/cancel` in the host log (e.g. 2026-09-11T21:41:00Z). Sidebar Stop button; e2e cancels a mid-stream mock turn and asserts clean stop. |
| 12 | A session can be bound to a Firefox tab | ✅ live | `pi_bind_current_tab` (MCP-over-ACP control tool) + sidebar binding row used live; tool dispatch resolves sessionId→tabId explicitly, returning `BROWSER_NOT_BOUND` / `BROWSER_TAB_CLOSED` otherwise (`firefox/src/background/tool-dispatcher.ts`). e2e asserts cross-session binding isolation (A's tool call never touches B's tab). |
| 13 | Pi can call `browser_get_page` | ✅ live | 9 calls in the flagship session `…/pi-browser-demo/…_01a090cf-…jsonl`; page text/markup flowed back as tool results (also 3–6 calls in sessions `01a0917f`, `01a09182`, `01a09173`, `01a09148`, `01a09153`, `01a0916c`, `01a09169`, `01a09170`). |
| 14 | Pi can call `browser_get_dom` | ✅ live | 9 calls in flagship `01a090cf`; 3 each in `01a0917f`/`01a09182`/`01a09173`. Stable element refs returned and reused by click/type. |
| 15 | Pi can call `browser_screenshot` | ✅ live, pixel-verified | `docs/evidence/screenshot-do15-note.md` (root-cause + verification). Session `…/01a091b1-…jsonl` contains a real base64 PNG (`iVBORw0KGgo…`) tagged `screenshot via captureTab`; the agent correctly described the captured pixels. Permission-gated per §43: log lines `browser_screenshot: requesting user permission` / `user denied permission` (2026-09-11T21:41:04Z) — allow once/always/deny via sidebar modal, deny/timeout → structured `BROWSER_PERMISSION_DENIED`. |
| 16 | Pi can reload the bound tab | ✅ live | 9× `browser_reload` in flagship `01a090cf` — used in the fix→reload→verify loop (item below). |
| 17 | Pi can click a referenced element | ✅ live | 9× `browser_click` in `01a090cf`; transcript: “The click succeeded (browser_click returned success)” — counter incremented to “Counter: 2” and verified via `browser_get_page`. |
| 18 | Pi can type into a referenced element | ✅ live | Sessions `01a09148`, `01a09153` (and original `01a08f2a`): `browser_type` put “hello pi” into the Note input; page title became `Counter Demo — note: hello pi` (demo title hook) and was read back via `browser_get_page`. |
| 19 | Browser content remains tool data, not trusted prompt data | ✅ live, analyzed | Transcript analysis of flagship `01a090cf`: exactly **one** user text message (241 chars — the human instruction) vs **22** `toolResult` entries carrying all page/DOM/screenshot data. Page content reaches Pi only as untrusted tool results (content script → background ToolDispatcher → tool result); nothing is concatenated into ACP prompts. See also §49 invariant 3 below. |

## Flagship workflow (the “inspect → fix → reload → verify” E2E)

Session `~/.pi/agent/sessions/--home-acidhax-pi-browser-demo--/2026-09-11T14-12-18-247Z_01a090cf-e2c6-7531-8509-4360bd1e7e5b.jsonl`:

1. User prompt (241 chars): look at the app in this tab, find why the interaction is broken, fix it, verify.
2. Agent: `browser_get_page` → `browser_get_dom` → read `app.js` → found the real bug (`getElementById("display ")` — trailing space in the id string → `null` → TypeError on click).
3. Agent: edited `app.js` (fix persisted in `/home/acidhax/pi-browser-demo/app.js`), `browser_reload`, `browser_click`, verified via `browser_get_page` that the counter displays (“Counter: 2”).

Authenticity markers: real HTTP-server access logs, real viewport metadata, and a genuine
Firefox WebExtension error surfaced in a tool result
(`"cannot capture tab …: it must be the visible tab in its window"` — snap-build limitation that
led to the captureTab-first implementation).

## Phase 5 — browser tools behind `BrowserToolTransport`

- **Interface + two transports** (`packages/pi-agent/src/browser/`): `LegacyBrowserCallbackTransport`
  (`x-pi-browser/tool` host→client callbacks — the working default) and `NativeMcpOverAcpTransport`
  (MCP-over-ACP; the add-on's `McpServer` fronts the 8 browser tools + 10 `pi_*` control tools).
- **Feature detection:** the host selects MCP-over-ACP only when the ACP handshake advertises
  `mcpCapabilities.acp`; otherwise legacy. Verified in `packages/pi-agent/test/provider.test.ts`
  and end-to-end in `tests/src/e2e.test.mjs` (the real add-on `McpServer` class fronts the MCP path;
  the harness drives the real host over real 4-byte framing).
- **Transport-independence:** tool names/schemas/args/results are identical across transports —
  enforced by `packages/pi-agent/test/tool-schemas.test.ts` (byte-level schema sync with
  `packages/protocol`) and by the e2e running both paths.
- **Live:** 107× `mcp/connect` in the host log (2026-09-11); all 10 `pi_*` control tools exercised
  live (session creation, tab binding, prompting from the control surface).

## §49 security invariants — where each is enforced

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | `allowed_extensions` contains only the production Firefox id | `packages/pi-agent/src/installer/platforms.ts` — manifest builder hard-codes `PI_BROWSER.extensionId`; install refuses to write a manifest without it (guard at line ~159). Manifest on disk shows exactly `["pi-browser@pi.dev"]`. |
| 2 | Native Messaging stdout carries protocol data only | `packages/pi-agent/src/logger.ts` — stderr-only diagnostics logger; nothing in the host writes to stdout except framed protocol JSON. |
| 3 | Browser page content is untrusted | Page data flows only as tool results (content script → `tool-dispatcher.ts` → ACP tool result). Prompt path carries user text only — proven by transcript analysis (item 19). |
| 4 | A web page cannot initiate an ACP user prompt | No page-originated prompt path exists: the content script exposes read/act tools only; `session/prompt` is issued exclusively by the sidebar composer (user gesture) or `pi_prompt` (an authenticated agent-side control tool). |
| 5 | Tool calls target explicit session-bound tabs | `firefox/src/background/tool-dispatcher.ts` — every tool resolves sessionId→tabId explicitly; unbound → `BROWSER_NOT_BOUND`, tab gone → `BROWSER_TAB_CLOSED` (never silent fallback to another tab). |
| 6 | Firefox cannot arbitrarily invoke shell commands | `grep -rn "child_process\|spawn" firefox/src/` → no matches. The add-on prompts Pi; Pi (host) owns agent execution. |
| 7 | Pi's coding tools retain Pi's own security/permission policy | `packages/pi-agent/src/acp/sdk-backend.ts` uses the real Pi SDK session services — the host does not bypass or re-implement Pi's permission system. |
| 8 | Browser tools use explicit schemas and bounded inputs | `packages/protocol/src/browser-tools.ts` (canonical schemas) + TypeBox validation in `packages/pi-agent/src/browser/provider.ts`/`schemas.ts`; `tool-schemas.test.ts` keeps host and protocol byte-identical. |
| 9 | No localhost TCP port required | `grep -rn "createServer\|\.listen(" packages/pi-agent/src/` (non-test) → no matches. Transport is Native Messaging stdio framing only. |
| 10 | No native bridge separately downloaded by the user | `packages/pi-agent/src/installer/platforms.ts` — the host ships inside the Pi package; `/pi-browser install` copies/points at the package's own build (`dist/native-host/main.js`). |

## Phase T1 — Thunderbird connection + Pi Space (2026-09-11)

Thunderbird added as a second capability provider over the same application-neutral
`dev.pi.agent` host (THUNDERBIRD-PLAN.md §36). T1 ships the Thunderbird add-on
(`thunderbird/` workspace) as a **complete Pi chat interface** — a custom **Pi Space**
with session list, new/resume, prompt, streaming, and cancel. T1 declares **no
capabilities** (`capabilities: []`), so the host registers **no tools** for it (mail
=T2, compose =T3).

Shared code was extracted to `@pi-browser/webext` (the `AcpClient` + `SessionStore` the
Firefox and Thunderbird backgrounds both use); Firefox was migrated to it with no
behavior change (its 14 tests still green).

**Verified live** on Thunderbird 155 ESR (flat install, `/home/acidhax/thunderbird/`),
in an isolated test profile on a private Xvfb (`xvfb-run`-style, display :99), add-on
pre-installed as an unsigned xpi (`xpinstall.signatures.required=false`):

| Item | Status | Evidence |
|------|--------|----------|
| Add-on loads in real Gecko | ✅ live | Pre-installed xpi (id `pi-thunderbird@pi.dev`) from `thunderbird/dist`; background event page started. |
| `connectNative("dev.pi.agent")` | ✅ live | The host recorded the connection: with `PI_BROWSER_HEARTBEAT_FILE` redirected, the heartbeat file read `{"client":"pi-thunderbird","pid":…}`. Thunderbird discovered the host from `~/.mozilla/native-messaging-hosts/dev.pi.agent.json` (the shared Linux path, plan §23) — `allowed_extensions` authorizes `pi-thunderbird@pi.dev`. |
| ACP initialize + `pi.agent.hello` | ✅ live | Pi Space status bar showed **green dot “Pi · pi-coding-agent”** (connected; real backend `agentInfo`), i.e. the initialize handshake completed with `application: "thunderbird"`. |
| Pi Space created + opens chat UI | ✅ live | `browser.spaces.create("Pi", {url: …/space/index.html})` added a puzzle-piece button to the spaces toolbar; clicking it opened the Pi tab (`moz-extension://…/space/index.html`). `docs/evidence/thunderbird-t1-pi-space-session-list.png`. |
| Session list (real sessions) | ✅ live | The rail listed real Pi sessions (`session/list`) with cwd labels; footer shows **“capabilities: chat only”**. |
| New session + config selectors | ✅ live | “+ New” → cwd `/tmp/pi-t1-check` → session `01a0933e` created; **Model** (Qwen3.8-27B-GGUF) and **Reasoning** (medium) selectors rendered from `session/new` configOptions. |
| Prompt streams (user + thinking + reply) | ✅ live | Prompt “Reply with exactly the two words: T1 works” streamed back: user bubble + a `agent_thought_chunk` reasoning block (“The user is asking me to reply with exactly two words.”) + assistant reply **“T1 works”**. `docs/evidence/thunderbird-t1-pi-space-chat-roundtrip.png`. |
| No tools registered for `capabilities: []` | ✅ e2e | `tests/src/e2e.test.mjs` “thunderbird client…”: the real host echoes `application: thunderbird, capabilities: []`; a scripted `browser_get_page` call reports `unknown tool` (proving no browser tools were registered); chat streams; cancel works. |
| Host discovery path (Thunderbird logic) | ✅ verified | Replicated Thunderbird `NativeManifests` discovery (profile dir + `~/.mozilla/native-messaging-hosts`): both resolve `dev.pi.agent.json`, validate (name/type/absolute path), and authorize `pi-thunderbird@pi.dev`; the host spawns cleanly with the extension id as the last argv (as Thunderbird passes it). |

**To load the add-on for real use** (temporary): Thunderbird → `about:debugging` →
“This Thunderbird” → **Load Temporary Add-on…** → pick `thunderbird/dist/manifest.json`
(build first: `npm run build`). The Pi Space button then appears in the spaces toolbar.
(Or a permanent install of a signed xpi of `thunderbird/dist`.)

## Phase T2 — read-only mail tools (2026-09-12)

T2 adds the read-only mail surface + the normalized context model (THUNDERBIRD-PLAN.md
§9–14). The add-on declares `capabilities: ["mail","attachments"]`; the host registers the
mail tools and dispatches them to `thunderbird/src/background/mail-dispatcher.ts` over the
legacy `x-pi-browser/tool` transport (host-side `MailToolProvider` in `@pi-browser/agent`).
**No mutation**: there is no send/move/delete/tag/flag tool; the user composes and presses
Send manually (T3 stays draft-first).

**Tools** (11): `mail_get_context`, `mail_search`, `mail_get_selected_messages`,
`mail_get_displayed_messages`, `mail_list_messages`, `mail_get_message`, `mail_get_body`,
`mail_list_attachments`, `mail_get_attachment`, `mail_list_accounts`, `mail_list_folders`.

**Normalized context model** — `mail_get_context` answers “what am I looking at?” and is the
seed for “summarize this email”: active mail tab + selected folders + selected messages +
displayed messages, each normalized to a durable id (prefer `headerMessageId`, fall back to the
transient numeric `id`), subject, author, recipients, date, folder. Untrusted email content
(bodies/headers/attachments) is **tool output only** — never merged into the user prompt (§13).

**Tab resolution** — `getCurrent()` resolves the WebExtension *active* tab. When the user chats
from the full **Pi Space** (a separate tab), the active tab is not a mail tab, so the dispatcher
falls back to `mailTabs.query()` → prefer an `.active` mail tab → the first one showing a
displayed message → else the first. Mail tabs carry their id as **`tabId`** in MV3
(`convertMailTab`), not `id`.

**Verified:**
- **Unit tests (19):** `thunderbird/test/mail-dispatcher.test.ts` — tool routing, context/tab/
  folder/message normalization, the `headerMessageId` durability rule, HTML→text body fallback,
  pagination, attachment truncation, structured not-found errors.
- **Live API-shape conformance:** the dispatcher was checked field-by-field against the installed
  Thunderbird 155.0.1 ESR schema (`ext-messages.js`, `messages.json`, `mailTabs.json`,
  `folders.json`, `accounts.json`). Fixed during live testing: `messages.query` must **not** set
  `returnMessageListId` (else it returns a bare list-id string, not `{id, messages}`);
  `fromDate`/`toDate` are **`Date`** objects (the API calls `.getTime()`); `mailTabs.query`
  has **no `type`** property.
- **Live “Summarize this email.” — CONFIRMED (2026-09-12):** on a real selected/displayed message
  in the installed Thunderbird, the search + context path resolves and Pi summarizes the email with
  no copy/paste. **T2 closed.**

## Phase T3 — draft-first compose tools (2026-09-12)

T3 adds the draft-first compose surface (THUNDERBIRD-PLAN.md §15–17). The add-on now declares
`capabilities: ["mail","attachments","compose"]` and the `compose` permission; the five compose
tools are dispatched to `thunderbird/src/background/compose-dispatcher.ts` over the same
`x-pi-browser/tool` transport, and the host registers them (gated on the `compose` capability)
via `@pi-browser/agent` (`compose/schemas.ts` + `CapabilityToolProvider`).

**Tools** (5): `compose_prepare_new`, `compose_prepare_reply`, `compose_prepare_forward`,
`compose_get`, `compose_update`. Each `prepare_*` opens a populated compose window (returned as
`composeTabId`); `compose_get`/`compose_update` read/edit an already-open window. Recipients are
mailbox strings; the body is HTML.

**Draft-first / no send (§15, §21)** — enforced at three layers:
1. **Tool layer:** there is no `compose_send` tool exposed to the agent (protocol + dispatcher both
   reject any non-compose tool name).
2. **Code layer:** the dispatcher never calls `browser.compose.sendMessage` or `saveMessage` (grep
   of the built `background.js` shows zero such calls).
3. **Permission layer (Thunderbird-enforced):** the manifest declares only `compose`, **not**
   `compose.send`/`compose.save`. The installed 155 schema gates `sendMessage` on `['compose.send']`
   and `saveMessage` on `['compose.save']`, so even if the code called them, Thunderbird would
   deny the call. `begin*`/`getComposeDetails`/`setComposeDetails` need only `compose`.

The user reviews the window and presses Send manually.

**Verified:**
- **Unit tests (9):** `thunderbird/test/compose-dispatcher.test.ts` — routing, the right
  `begin*`/`setComposeDetails` call with the right arguments, `composeTabId` surfaced, recipient
  list normalization (object → “Name <email>”), update-only-provided-fields, structured
  not-found / missing-`messageId` errors, and a guard proving **no send path exists**
  (`compose_send` is rejected; `prepare*` never invokes a send/save function).
- **Schema sync:** the compose JSON schemas (protocol) and TypeBox schemas (agent) are
  byte-checked by `tool-schemas.test.ts` (the same strict contract as the mail/browser tools).
- **Capability gate:** `acp-agent.test.ts` proves a `["mail","compose","attachments"]` hello
  registers all 16 tools (10 mail + 6 compose), no browser tools, and **no `compose_send`**.
- **Built xpi:** `/tmp/pi-thunderbird-t3.xpi` — manifest carries the `compose` permission; the
  background hello carries `["mail","attachments","compose"]`; grep confirms the five
  `begin*`/`get`/`set` calls and **zero** `compose.sendMessage`/`saveMessage`.
- **Live verify — CONFIRMED (2026-09-12):** with `/tmp/pi-thunderbird-t3.xpi` loaded, “Draft a
  reply saying Thursday works." opens a populated Thunderbird reply compose window for review;
  nothing is sent. **T2 and T3 both live-confirmed functional.**

## Phase T4 + T6 + draft attachments (2026-09-12)

Completes the remaining Thunderbird capabilities (goal `mtymz4tm`): draft-side file
attachments, T4 mail organization, and T6 contacts. The add-on now declares
`capabilities: ["mail","attachments","compose","mailModify","contacts"]`. **T7 (calendar) is
deferred** — the installed 155 has no stable calendar WebExtension API (plan §42 says not to
depend on an Experiment).

**Draft attachments** — `compose_add_attachment` takes `{tabId, name, content (base64),
contentType}`; the dispatcher decodes base64 → bytes → a real `File` and calls
`browser.compose.addAttachment(tabId, {file, name})`. Read-side attachment tools were T2
(unit-tested); the read side still needs a live confirm.

**T4 mail organization** (plan §39) — `mail_mark_read`, `mail_set_tags`, `mail_archive`,
`mail_move`, each acting only on explicitly-selected message ids: mark read →
`messages.update(id, {read})`; tags → additive by default (reads current tags via
`messages.get`, unions, then `messages.update(id, {tags})`; `additive:false` replaces);
archive → `messages.archive(ids)`; move → `messages.move(ids, folderId)`. Gated on the new
`mailModify` capability; permissions `messagesUpdate` + `messagesMove` + `messagesTags` (create/update tags)
+ `messagesTagsList` (list/get tags — a distinct read permission; without it `browser.messages.tags.list`
is undefined and tag set/search can't resolve names to keys).
**No deletion:** `messages.delete` / `deleteAttachments` / `messagesModifyPermanent` are never
called and never declared.

**Tags end-to-end:** Thunderbird applies tags by an internal lowercase *key*, not by display
name — so `mail_set_tags` resolves the caller's tag names/keys to keys (case-insensitive match
on name or key) and **creates any tag that doesn't exist yet**, reporting them under `created`.
`mail_list_tags` lists the available tags (`{key, name, color}`). `mail_search` filters by tag:
`tags: [names]` resolved to keys, combined per `tagMode` (`any` = OR, the default; `all` = AND)
into `messages.query({tags: {mode, tags: {key: true}}})`; an unknown tag name is a structured
`PI_NOT_FOUND`. `mail_get_message` / `mail_get_selected_messages` / `mail_get_context` all expose
`tags` on each message ref, so an applied tag can be read back and verified.

**T6 contacts** (plan §41) — `contacts_search` / `contacts_get` (read-only) via
`browser.contacts.query({searchString})` / `get(id)`, permission `addressBooks`. Normalization
is defensive over vCard key styles (displayName / firstName+lastName, email / emailAddresses,
organization / org / company) and falls back to the raw `properties` when nothing resolves.

**Verified:**
- **Unit tests (20):** `mutation-dispatcher.test.ts` (8: additive vs replace tagging, **create
  an unknown tag**, archive/move args, **no-delete guard**), `contacts-dispatcher.test.ts` (7:
  normalization across key styles, raw-properties fallback, **no-mutation guard**),
  `compose-dispatcher.test.ts` +1 (`compose_add_attachment` builds a real `File` from base64),
  plus 4 tag tests in `mail-dispatcher.test.ts` (search-by-tag name→key, `tagMode` all/any,
  unknown-tag error, `mail_list_tags`).
- **Schema sync:** the new JSON + TypeBox schemas are byte-checked by `tool-schemas.test.ts`.
- **Capability gate:** `acp-agent.test.ts` proves a `[..., "mailModify", "contacts"]` hello
  registers 23 tools (11 mail + 6 compose + 4 mutation + 2 contacts) with **no delete tool**.
- **Built xpi:** `/tmp/pi-thunderbird-t46.xpi` — manifest permissions are exactly
  `nativeMessaging storage accountsRead messagesRead compose messagesUpdate messagesMove
  messagesTags messagesTagsList addressBooks tabs`; grep confirms **zero** `compose.sendMessage`/`saveMessage`,
  `messages.delete(`, `deleteAttachments`, `messagesModifyPermanent`, and **none of**
  `messagesDelete`/`messagesImport`/`sensitiveDataUpload`/`compose.send`/`compose.save` declared.
- **Live verify (pending, user):** read a real attachment; “attach /tmp/x.pdf to the draft”;
  “Archive these three and tag the invoice thread Finance”; “Draft a message to Sarah from Acme.”

## Test suite map (§48)

`npm test` (Node 22 required) → **153/153 green** as of 2026-09-12:

| Workspace | Tests | Covers |
|-----------|-------|--------|
| `@pi-browser/protocol` | 14 | framing helpers, JSON-RPC, structured errors, permission helpers, schema constants, **agent identity + `pi.agent.hello` (firefox + thunderbird) + capability normalization** |
| `@pi-browser/agent` | 62 | framing edge cases (fragmented/multiple/malformed), transport, ACP agent (multi-session isolation, stream routing, cancel, resume, close, config selection, **capability-gated tool registration**), provider (both transports, feature detection, permission gate), **application-neutral installer (`firefox`/`thunderbird`/`mozilla`, macOS path split, Windows per-app registry, legacy cleanup)**, client heartbeat |
| `@pi-browser/webext` | — | shared `AcpClient` (injected identity + hello) + `SessionStore` (shared by both add-ons; exercised by the firefox tests + e2e) |
| `@pi-browser/firefox` | 14 | session store, tool dispatcher (binding, stale refs, closed tabs, screenshot fallback), MCP server (control tools), AcpClient (reconnect, auto-detection, lifecycle state) — now on the shared `@pi-browser/webext` |
| `@pi-browser/thunderbird` | 48 | **mail tool dispatcher** (T2, 19 + 4 tag tests: search-by-tag name→key, `tagMode` all/any, unknown-tag error, `mail_list_tags`): routing, context/tab/folder/message normalization, `headerMessageId` durability, HTML→text body fallback, pagination, attachment truncation, structured not-found errors. **+ compose dispatcher (T3, 10)**: `begin*`/`setComposeDetails`/`addAttachment` args, recipient normalization, base64→File, **no-send guard**. **+ mutation dispatcher (T4, 8)**: mark read / additive+replace tags / create-unknown-tag / archive / move, **no-delete guard**. **+ contacts dispatcher (T6, 7)**: query pass-through, normalization across vCard key styles, raw-properties fallback, **no-mutation guard** |
| `pi-browser-tests` (e2e) | 15 | **real built host + real 4-byte framing + real add-on `McpServer`** with a fake in-memory tab set and deterministic mock backend: initialize/version-mismatch, multi-session, streaming, cancel, binding isolation, tool failures, permission flow, add-on heartbeat, **a fake-Thunderbird client for `capabilities: []`, one for the T2 mail set, and one for the full T4/T6 set (mailModify + contacts tools registered + round-trip over the legacy transport)** |

## Live real-backend smoke test

`.probe/smoke-host.mjs` drives the **real Pi SDK backend** (no mock) over real framing:
initialize → capabilities + `mcpCapabilities.acp` → `session/new` → `session/list` (real sessions) →
`session/resume` from a real `~/.pi/agent/sessions/*.jsonl` → close. Run:
`node .probe/smoke-host.mjs` (Node 22).

## Per-DoD mapping (plan §35–38)

| DoD / success criterion | Status | Evidence |
|---|---|---|
| **T0** host `dev.pi.agent` (both add-on IDs authorized) + `application`/`capabilities` hello + browser gate + installer (`firefox`/`thunderbird`/`mozilla`, macOS split, Windows per-app) + Firefox suite green | ✅ | `acp-agent.test.ts` (hello + capability normalization), `installer.test.ts` (targets + platform paths); Firefox 14 + e2e green |
| **T1** add-on connects via `runtime.connectNative("dev.pi.agent")`; Pi Space session list/new/resume/prompt/stream/cancel | ✅ | `space/` UI; live green dot “Pi · pi-coding-agent” (T1); chat round-trip live-confirmed |
| **T2** 10 read-only mail tools; “Summarize this email” on a real selected message, no copy/paste | ✅ | `mail-dispatcher.test.ts` (19); live-confirmed (T2 section) |
| **T3** compose tools; “Draft a reply saying Thursday works.” opens populated compose; user sends; no send anywhere | ✅ | `compose-dispatcher.test.ts` (incl. no-send guard); 3-layer no-send (tool/code/permission); live-confirmed (T3 section) |
| **Draft attachments:** `compose_add_attachment` attaches a file; read-side `mail_list/get_attachment` | ✅ impl+unit · live pending | `compose-dispatcher.test.ts` (base64→`File`, `addAttachment`); read-side unit tests (T2) |
| **T4** mail organization: mark read / tags (set + **list + search/filter + read-back**) / archive / move (selected only); **no deletion** | ✅ impl+unit · live pending | `mutation-dispatcher.test.ts` (8, incl. no-delete guard) + `mail-dispatcher.test.ts` tag tests; `mailModify` cap + `messagesUpdate`/`messagesMove`/`messagesTags`/`messagesTagsList` |
| **T6** contacts: `contacts_search`/`contacts_get` (read-only, `addressBooks`) | ✅ impl+unit · live pending | `contacts-dispatcher.test.ts` (7, incl. no-mutation guard); defensive vCard normalization + raw fallback |
| **T7** calendar — deferred (no stable WebExtension calendar API in 155) | ⏸ | plan §42: do not depend on an Experiment; revisit when a stable API exists |
| Untrusted email = tool output only, never merged into the user prompt (§31–32) | ✅ | dispatcher returns normalized refs; body only via explicit `mail_get_message_body`; no prompt merging |
| Durable id = `headerMessageId` (not numeric `messageId`) (§7) | ✅ | `MailMessageRef` dual-id; `mail-dispatcher.test.ts` durability rule |
| Permissions: read (`nativeMessaging`,`accountsRead`,`messagesRead`,`compose`) + T4 (`messagesUpdate`,`messagesMove`,`messagesTags`,`messagesTagsList`) + T6 (`addressBooks`) — **no** `compose.send`/`messagesDelete`/`messagesImport`/`sensitiveDataUpload` | ✅ | `manifest.json` = exactly that set; built `background.js` has zero `sendMessage`/`saveMessage`/`messages.delete`/`deleteAttachments` |
| **Gate:** Firefox suite stays green after every change | ✅ | Firefox 14 + e2e 15 green in the 153/153 run |
| `npm run typecheck` + `npm test` at root: 0 failures | ✅ | typecheck 0 failures; `npm test` **153/153** |

> **Note on the `piPane` column:** the `browser.piPane` Experiment API (4th column) was built and
> proven working in an earlier stage, but Experiment APIs are **out of scope** for this goal
> (objective Boundaries). It is bonus work, not a success criterion; T0–T3 above are the DoD.

## Related commits (2026-09-11)

`0fa664d` scaffold + protocol + host · `32f38d4` add-on + e2e harness · `39d6444` pi_* control
tools · `c0dafc6` screenshot permission gate · `68f1661` modal fix · `f8b674c` captureVisibleTab
+ e2e flake fix · `89ffb2b` captureTab-first · `00c31b5` captureTab note · `dcabea9` onboarding
auto-detection · `fe69686` onboarding screens · `979600b` Firefox-155 lifecycle detection ·
`c8592bd` bootstrap state-clobber fix.
