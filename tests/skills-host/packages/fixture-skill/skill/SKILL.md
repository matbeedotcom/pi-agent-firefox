# Fixture Reply (test skill)

Deterministic test skill for the controlled test matrix. It reviews a
comment draft against the fixture page contract and reports a verified
result.

## Task

When a comment draft pauses or is about to be submitted, review the `draft`
context field:

1. If the draft contains the marker `[edited by site]`, report
   `decision: "abstain"` — the draft changed under review.
2. Otherwise report `decision: "suggest"` with
   `replacementText: "Fixture reply: <draft text>"` and a one-sentence
   explanation.

## Rules

- Call `skill_report` exactly once, with the exact job identity values from
  the job contract, then stop.
- Never call any tool other than `skill_report`.
- Never contact the user's chat session.
