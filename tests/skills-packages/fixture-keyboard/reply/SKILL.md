# Fixture reply (keyboard-page)

Deterministic test skill for `tests/fixtures/skills/fixture-keyboard.html`
(Enter-to-submit composer, exact-modifier keyboard chain).

On `comment.before-submit`, suggest the fixed replacement text:

    Fixture reply: fixture-keyboard

The scenario asserts the replacement is posted via the Enter gesture
and that modifier+Enter is NOT treated as a submit by the gate.
