# Thunderbird live checks (goal `mtymz4tm`)

Operational runbook for the 4 live verifications that close the goal. The
implementation + unit/e2e tests are already green (148/148); these confirm the
real add-on against the installed Thunderbird (`/home/acidhax/thunderbird`,
155.0.1 ESR).

## Prereqs
- Native host installed for Thunderbird: `npx @pi-browser/agent install thunderbird`
  (registers `dev.pi.agent`). `npx @pi-browser/agent status` should show a fresh heartbeat.
- The xpi: **`/tmp/pi-thunderbird-t46.xpi`** (rebuild with `cd thunderbird && node build.mjs && zip -r -X /tmp/pi-thunderbird-t46.xpi .` from `thunderbird/dist/` if in doubt).
- A test account with **at least one message that has an attachment**, **three messages** (one being an “invoice” for T4), and **one contact** (e.g. “Sarah …, Acme”) for T6.

## Load the add-on
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick the xpi.
(Or install permanently for repeated runs.) In the mail window, open the **Pi Space**
(custom space) — the status bar should go green (“Pi · pi-coding-agent”).

**Where to look for errors:** the Web Extension console (that same `about:debugging`
page → the loaded add-on → “Inspect” / console) for background errors, and the Pi
Space tool cards for per-tool results. A tool that isn’t registered fails with
`Thunderbird does not serve tool: <name>` or a schema error.

## Check 1 — read a received attachment
1. Open an email that has an attachment.
2. In the Pi Space: **“What's in the attachment?”** (or “describe the attachment”).
3. **Expected:** Pi calls `mail_get_context` → `mail_list_attachments` → `mail_get_attachment`
   and summarizes/quotes the attachment (or reports its name/type/size).
4. **If it fails:** check the tool cards for which tool errored. `mail_get_attachment`
   returns `MAIL_ATTACHMENT_NOT_FOUND` if the part name is wrong; a huge file is
   base64-truncated (look for `truncated: true`).

## Check 2 — attach a file to a draft
1. Open any email → **Reply** (a compose window opens), or click **Write** for a new message.
2. In the Pi Space: **“attach /tmp/x.pdf to the draft”** (use any real file path that exists).
3. **Expected:** Pi reads the file (base64) → `compose_add_attachment` → the compose
   window shows the attachment. The window stays open; **nothing is sent**.
4. **If it fails:** the tool card should show the note “Attachment added … does not
   send.” A `File` construction error would mean `atob`/`File` are unavailable in the
   background (they are — `btoa`/`File` are used by `mail_get_attachment`).

## Check 3 — T4 mail organization
1. Select **three** messages (one whose subject contains “invoice”).
2. In the Pi Space: **“Archive these three and tag the invoice thread Finance.”**
3. **Expected:** Pi reads the selection via `mail_get_context`, then
   `mail_archive(messageIds)` on the three and `mail_set_tags(messageIds, ["Finance"])`
   on the invoice. In Thunderbird: the three leave the current folder (archive) and the
   invoice carries the **Finance** tag. Tags are additive (existing tags preserved).
   `mail_set_tags` resolves “Finance” to Thunderbird’s internal tag key and **creates the
   tag if it doesn’t exist yet** (reported under `created`).
4. **Verify the tag (read-back + filter):** in a fresh prompt ask
   **“What tags are on the invoice email?”** → `mail_get_message` now returns `tags` (you
   should see `finance`). Then **“Find all emails tagged Finance.”** → `mail_search({tags:
   ["Finance"]})` resolves the name to its key and returns only the matching messages.
5. **If it fails:** confirm the selected ids are in the tool args. A missing folder/tag
   id is a `MAIL_*` structured error on the tool card; an unknown tag name in
   `mail_search` is a `PI_NOT_FOUND` (see `mail_list_tags`). Archive/move are reversible —
   nothing is deleted.

## Check 4 — T6 contacts
1. Ensure the address book has a contact like “Sarah <name>, Acme” (Address Book → Personal
   or Collected Addresses).
2. **Isolate the contacts API first:** “Who’s in my address book matching <a known name>?”. Pi
   should call `contacts_search` and return normalized contacts (`name`, `emails`,
   `organization`). This separates T6 from compose so a failure is unambiguous.
3. **The full flow:** **“Draft a message to Sarah from Acme.”** Pi calls
   `contacts_search("Sarah Acme")` → normalized contact → `compose_prepare_new` with the
   recipient filled in; the compose window opens with Sarah addressed.
4. **If it fails with `browser.contacts is undefined`:** that’s the MV2-namespace bug — the
   add-on must use the MV3 path `browser.addressBooks.contacts.*` (already fixed; a stale xpi
   or an un-reloaded temporary add-on would still show it). Reload `/tmp/pi-thunderbird-t46.xpi`.
5. **If it fails / empty (contact comes back with the email but a blank name, or a raw blob):**
   the variable is the vCard property key names. The dispatcher tries `displayName`/
   `firstName+lastName`, `email`/`emailAddresses`, `organization`/`org`/`company`; if none match
   it returns the raw `properties`. Paste the raw `properties` here and the normalization keys
   can be corrected to match this build.

## Recording results
Paste a one-line result per check (pass/fail + any error signature). On pass for all
four, the goal is complete (mark via the goal). On any fail, include the tool-card
error text so the shape can be corrected.
