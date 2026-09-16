# Skills E2E fixtures — controlled test "sites"

Static HTML pages that stand in for real comment sites. The Firefox add-on's
**page-runtime** (design §6) starts on a page only when the background returns a
compiled plan naming a **packaged adapter** (`packages/webext/src/skills/adapters.ts`).
Each page here matches exactly one adapter, so scenarios can be exercised
end-to-end (browser → background → host → gate → card) without touching a real site.

## Serving

From the repo root:

```sh
python3 -m http.server 8123
# pages: http://localhost:8123/tests/fixtures/skills/<page>.html
```

They must also work from `file://` (no external resources, no modules).

## Adapter / selector contract

The `data-skill-fixture` attributes are the adapter's selector surface.
Pages MUST keep them exactly as specified — the packaged adapters select on them.

| Adapter id | Composer selector | Submit selector | Extra |
|---|---|---|---|
| `fixture/comment-page` | `textarea[data-skill-fixture]` | `button[data-skill-fixture=submit]` | target `[data-skill-fixture=target]` |
| `fixture/keyboard-page` | `textarea[data-skill-fixture=composer]` | `button[data-skill-fixture=submit]` | target `[data-skill-fixture=target]`, submit on **Enter** (no modifiers) |
| `fixture/contenteditable-page` | `div[data-skill-fixture=composer][contenteditable]` | `button[data-skill-fixture=submit]` | target `[data-skill-fixture=target]` |

## Page inventory

| Page | Adapter | Scenario |
|---|---|---|
| `fixture-basic.html` | `comment-page` | Click chain: type → click → (held) → (reviewed) → posts |
| `fixture-keyboard.html` | `keyboard-page` | Enter-to-submit + modifier exactness (Ctrl/Alt/Shift+Enter must NOT submit) |
| `fixture-contenteditable.html` | `contenteditable-page` | `contenteditable` composer (the `readDraft` text path) |
| `fixture-dynamic.html` | `comment-page` | Composer hidden until "Reply" is clicked (late binding); "Collapse" detaches it again |
| `fixture-threads.html` | `comment-page` | Two independent post/thread composers; only the ACTIVE composer should be tracked |
| `fixture-stale.html` | `comment-page` | "Simulate concurrent edit" button mutates the draft mid-review and fires `input` |
| `fixture-ime.html` | `comment-page` | "Simulate IME" button runs a deterministic `compositionstart → input → compositionend` sequence |

## Recorder contract (shared `_recorder.js`)

Every page includes `<script src="_recorder.js"></script>` and renders:

- `<pre id="fixture-log">` — JSON of `window.__fixture.log`
- `<p id="receipt" hidden>` — shown on success by `markSubmitted(draft)`

The driver asserts on:

1. `document.body.dataset.submitted === "1"` — a post actually happened.
2. `window.__fixture.log` — chronological events (`rejected-empty`, `submitted`,
   `held`, `key-ignored`, `tampered`, `ime-*`, ...).
   - `held` — the submit gesture arrived with `event.defaultPrevented` true
     (the add-on's page-runtime held it). Every page's submit handler checks
     this FIRST and records `held` instead of posting, so a held gesture is
     observable. Note: `preventDefault()` only stops the DEFAULT action
     (form submit/navigation), not a site's own JS click handler — the
     fixtures model the default-action path, which is what the packaged
     adapters claim coverage for (design §6: tested chains only).
3. The review card DOM (`div.pb-review-card`) — state, buttons, suggestions.
4. Gate state via the add-on's `get_state` action → `skills.state()`.

## Rules

- No external resources (fonts, CDNs, frameworks). Static HTML + vanilla JS only.
- Page JS must **never** `preventDefault()` on the submit gesture — holding the
  gesture is the page-runtime's job, not the site's.
- A successful submit ALWAYS goes through `window.__fixture.markSubmitted(draft)`.
- An empty/whitespace draft records `rejected-empty` and does NOT submit.
- Deterministic: same input → same log, no timestamps in assertions, no randomness.
