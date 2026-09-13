# Thunderbird contacts (address book) — implementation notes

Goal `mtymz4tm` (T6, plan §41). Read-only address-book access for the Pi agent:
resolve recipients ("draft a message to <person>") and browse the book
("who's in my address book?"). **No contacts mutation** (create/update/delete) is
implemented or permitted — contact data is untrusted external data.

## Tools (3, capability-gated on `contacts`)

| Tool | Purpose |
|---|---|
| `contacts_search` | Indexed lookup by name/email/org term. Fast path. |
| `contacts_get` | One contact by id (cardKey). |
| `contacts_list` | Enumerate all books, optional `filter` (name/email/org substring), `cursor`/`limit` pagination. The "list them all" path — needed because `query()` can't list-all. |

Every result is normalized to `{ id, name?, emails?, organization?, vCard, properties }`
— the extracted fields **plus** the raw `vCard` string and the flat property map, so the
full card is visible. Contact data is **untrusted external data**: tool output only, never
merged into the user prompt (plan §31–32).

## The MV3 API — three gotchas (all caught live)

1. **Namespace.** Top-level `browser.contacts` is **MV2-only** (`max_manifest_version: 2`)
   and is `undefined` in an MV3 add-on. The MV3 path is
   `browser.addressBooks.contacts.{query,get,list}`, permission `addressBooks`.

2. **`query()` include flags.** `contacts.query()` must be called with **all four**
   `include*` flags true (`includeLocal`, `includeRemote`, `includeReadOnly`,
   `includeReadWrite`). Without them it **skips local read-write books** (the Personal
   address book), so a real contact is never found. `query()` also returns `[]` for an
   empty `searchString` — that's why `contacts_list` exists (it enumerates via
   `addressBooks.list()` + `contacts.list(bookId)` instead).

3. **`list()`/`get()`/`query()` return a `vCard` STRING, not a `properties` map.**
   `ext-addressBook.js` `convert()` does:
   ```js
   if (extension.manifest.manifest_version < 3) {
     copy.properties = properties;   // MV2: flat map
   } else {
     copy.vCard = properties.vCard;  // MV3: a vCard string, no `properties`
   }
   ```
   so in MV3 a contact is `{ id, parentId, type, vCard, readOnly, remote }` — **no
   `properties`** (reading `c.properties` yields `undefined` → `{}`). The dispatcher
   parses the vCard (RFC 5545: CRLF, continuation/fold lines, `\,` / `\;` / `\\n` / `\\`
   unescaping) into an abCard-style map: `FN`/`N` → name, `EMAIL` → emails, `ORG` → org,
   plus `TEL`/`TITLE`/`NOTE`/`ADR`. A populated MV2 `properties` map is still honored when
   present (defensive), but the live path is always the vCard.

   > This was the last and deepest live bug. An earlier "abCard CamelCase property names"
   > theory was a red herring: unit tests stubbed a `properties` map that MV3 never sends,
   > so the empty result only appeared against the real add-on.

## Where it lives

- `thunderbird/src/background/contacts-dispatcher.ts` — vCard parser (`parseVCard`,
  `propsFromVCard`, `unescapeVCard`) + `contacts_search` / `contacts_get` / `contacts_list`
  + `normalizeContact`.
- `packages/protocol/src/contacts-tools.ts` — JSON tool schemas (`CONTACTS_TOOLS`).
- `packages/pi-agent/src/contacts/schemas.ts` — TypeBox schemas (mirror the protocol).
- `thunderbird/src/types/thunderbird.d.ts` — `browser.addressBooks.*` type surface
  (`AddressBook`, `contacts.{Contact,QueryInfo}`, `list()`/`query()`/`get()`).
- `thunderbird/test/contacts-dispatcher.test.ts` — 16 unit tests (MV3 vCard parsing,
  email-only card, continuation/escape, list/filter/paginate, no-mutation guard).

## Verified (live, Thunderbird 155.0.1 ESR)

- `contacts_list` returned a real **email-only** card — vCard = `VERSION:4.0` +
  `EMAIL;PREF=1:contact@paulwatsonfoundation.org` + `UID` — with the email correctly
  extracted and **no phantom name** (the card genuinely has no `FN`/`N`).
- Full T6 flow: resolve the contact → `compose_prepare_new` with the bare email → compose
  window pre-filled (user presses Send; the add-on never sends).
