# Project instructions

## Browser reactive skills

The full guide for creating and testing a **browser reactive skill**
(manifest schema, grants/adapter coverage, submission gate, e2e scenario
authoring, catalog reload, live observation via `skills-events.jsonl`) lives
in the project skill **`create-browser-skill`**
(`.pi/skills/create-browser-skill/SKILL.md`) — load it whenever a task
touches skill packages (`tests/skills-packages/`), the skills runtime
(`packages/pi-agent/src/skills/`, `packages/webext/src/skills/`), or the
e2e suite (`tests/skills-e2e/`).

Where code and doc differ, the code is authoritative (known drift: the
design's package layout shows a `package.json` per package, but the code
never reads it — `activation.json` is the only required file).
