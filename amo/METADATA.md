# AMO submission — metadata & review notes

**Add-on:** Pi Browser · **ID:** `pi-agent-firefox@matbee.com` · **Version:** 0.1.0
**Zip:** `amo/pi-browser-0.1.0.zip` (build: `sh amo/make-zip.sh`)

## Form fields

- **Name:** Pi Browser
- **Version:** 0.1.0
- **Summary (≤60 chars):** Pi Coding Agent sidebar for Firefox — chat, sessions, tab control
- **Description (first paragraph, ~600 chars):**
  Pi Browser connects Firefox to the Pi coding agent through a local Native
  Messaging host installed by the companion Pi package. It adds a sidebar with
  multiple agent sessions (streamed replies, cancel, model/reasoning controls
  taken from the agent's own configuration). You can bind a session to a tab;
  the agent can then read that page's content and DOM, click and type into
  referenced elements, reload the tab, and — after your explicit approval via
  the built-in permission prompt — take a screenshot. All page content reaches
  the agent as untrusted tool data and is never inserted into prompts. Without
  the locally installed host the add-on shows a setup screen and stays inert.

## Permissions justification (review)

| Permission | Justification |
|------------|---------------|
| `nativeMessaging` | The add-on speaks only to the locally installed `com.matbee.agent` host (shipped with the separate Pi package, never downloaded by this add-on). Until that host is installed the add-on is inert and shows a setup screen. |
| `<all_urls>` (host) | Required to operate the tab the user **explicitly binds** to an agent session: read page content/DOM, click/type into referenced elements, reload, permission-gated screenshot. The add-on never acts on a tab that has not been bound by the user. |
| `activeTab` | Fallback for the screenshot capture path when the bound tab is the active tab. |
| `tabs` | Tab binding (session ↔ tab) and locating the bound tab. |
| `scripting` | Content-script message channel for the bound tab's tools (stable element refs, page reads). |
| `storage` | Presentation/binding state only (bound tab ids, last active session). The agent host is the authoritative session store. |

## Review notes

- **MV3**, non-persistent background (event page), `sidebar_action` panel.
- **Security model:** page/DOM content is untrusted tool data — never
  concatenated into agent prompts; web pages cannot initiate prompts; tool
  calls resolve an explicit session→tab binding (structured
  `BROWSER_NOT_BOUND` / `BROWSER_TAB_CLOSED` errors, never fallback to
  another tab).
- **Sensitive action gating:** `browser_screenshot` requires explicit user
  approval via the ACP `session/request_permission` dialog (allow once /
  always / deny; deny or timeout aborts the tool).
- **No network** of its own: the only transport is the Native Messaging stdio
  channel to the local host (no hosts/URLs contacted by the add-on code).
- **Inert without the host:** by design — the onboarding screen explains the
  missing host; there is no degraded data-collection mode.
- Source code: private repository (not linkable); the zip contains the built
  bundles without source maps.

## Submission checklist

- [ ] AMO account + API key (user)
- [ ] Confirm `pi-agent-firefox@matbee.com` ID is unclaimed on AMO
- [ ] Upload zip (web or `amo` CLI)
- [ ] Submit for review
- [ ] After approval: signed xpi available for regular (non-temporary) installs
