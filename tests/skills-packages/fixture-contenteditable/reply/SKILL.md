# Fixture reply (contenteditable-page)

Deterministic test skill for
`tests/fixtures/skills/fixture-contenteditable.html` (div[contenteditable]
composer, normalized textContent draft).

On `comment.before-submit`, suggest the fixed replacement text:

    Fixture reply: fixture-contenteditable

The scenario asserts the replacement is applied to the contenteditable
draft (draft.replace-on-accept) and posted on submit.
