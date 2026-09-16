# Fixture reply (comment-page)

Deterministic test skill for the controlled skills matrix
(`tests/fixtures/skills/fixture-basic.html`, `fixture-threads.html`,
`fixture-dynamic.html`).

On `comment.before-submit` for a non-empty draft, suggest the fixed
replacement text:

    Fixture reply: fixture-reply

Do not depend on the draft content. This skill exists to drive the
plan → event → job → result → gate-accept → submit chain end to end;
the reply text is the assertion token.
