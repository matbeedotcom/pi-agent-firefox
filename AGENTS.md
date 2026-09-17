# Creating a browser reactive skill

How to add a **reactive (triggered) skill** to this repo's filesystem skills
runtime: a skill that observes page events (`comment.draft.paused`,
`comment.before-submit`), gets a bounded isolated Pi review job, and — in
`review-before-submit` mode — holds submission behind a local review gate.

The architecture spec is `skills-runtime-design.md` (v0.1, *proposed*).
**Where code and doc differ, the code is authoritative.** Known drift: the
design's package layout shows a `package.json` per package, but the code
never reads it — `activation.json` is the only required file (see
`packages/pi-agent/src/skills/registry.ts`: discovery works "without loading
package.json").

## 1. What a browser reactive skill is

A skill is a **package** — a directory on disk, no executable code:

```text
tests/skills-packages/fixture-reply/
  activation.json          # declarative activation contract (validated, see §2)
  reply/SKILL.md           # the instructions the Pi review job receives
```

- `skillKey = packageId/skillId` (e.g. `fixture-reply/reply`), built in
  `packages/pi-agent/src/skills/registry.ts`.
- `revision` = sha256 of the serialized definition + SKILL.md. Any change to
  the package content changes the revision, which **invalidates existing
  grants** (planner reason: `"Package changed; review permissions"`).
- `SKILL.md` is injected into the isolated job's system prompt verbatim
  (`packages/pi-agent/src/skills/isolated-runner.ts`, `skillBlock`).

## 2. `activation.json` — the real schema

Validated by `parseSkillManifest` in `packages/protocol/src/skills.ts`.
Objects are **strict**: unknown fields throw (`Unknown field: …`). Copy the
shape from `tests/skills-packages/fixture-reply/activation.json`:

```jsonc
{
  "schemaVersion": 1,                    // must be exactly 1
  "packageId": "my-package",             // identifier: ^[a-z0-9]+(-[a-z0-9]+)*$, ≤64
  "skills": [{
    "id": "my-skill",                    // identifier, unique within package
    "type": "triggered",                 // "triggered" | "active" | "passive"
    "instructions": "my-skill/SKILL.md", // package-relative, MUST end in /SKILL.md,
                                         // no backslash/colon/./.., ≤512 chars
    "scope": {
      "applications": ["firefox"],       // non-empty subset of ["firefox","thunderbird"]
      "hosts": ["127.0.0.1"],            // EXACT hosts (normalized, lowercase)
      "subdomainHosts": ["example.com"], // optional; explicit subdomain matching
      "pathPrefixes": ["/messages"]      // optional; must start with "/", no ?#\\*
    },
    "subscriptions": [                   // triggered: REQUIRED, non-empty
      { "event": "comment.draft.paused",
        "conditions": { "minCharacters": 40 },   // 0..32768
        "debounceMs": 800 },                       // 0..60000
      { "event": "comment.before-submit" }
    ],
    "context": {
      "required": ["draft"],
      "optional": ["replyTarget"]
      // fields: draft, replyTarget, parentPost, visibleAncestors, mail, applicationRecord
    },
    "review": { "defaultMode": "advisory" },   // "advisory" | "review-before-submit"
    "capabilities": ["context.read", "suggestion.present", "draft.replace-on-accept"],
    "memory": { "namespace": "prefs", "scope": "account" },  // optional; scope: account|profile
    "execution": { "handler": "agent", "timeoutMs": 10000 }  // timeout 1..10000, only "agent"
  }]
}
```

**Event catalog** (`SKILL_EVENTS`): `comment.draft.paused` (speculative,
debounced draft review), `comment.before-submit` (the gate event),
`mail.arrived` (Thunderbird, not browser-side).

**Capabilities** (`SKILL_CAPABILITIES`) and what they mean in code:

| capability | effect |
| --- | --- |
| `context.read` | **required** in the grant or the rule is unavailable (`"Context access is not granted"`, `planner.ts`) |
| `suggestion.present` | the job may report `decision: "suggest"` with UI |
| `draft.replace-on-accept` | the review card's Apply edits the composer (content-side) |
| `memory.read` / `memory.propose` | declared; memory store is not implemented yet (design §11) |

Type rules: `triggered` requires `subscriptions` and forbids `command`;
`active` requires `command` only; `passive` requires `observations` + `batch`
and additionally needs `grant.learningEnabled === true`.

## 3. Granting and arming

A skill is inert until **granted**. Grants + adapter coverage are user
settings; in the test world they come from the `PI_BROWSER_SKILLS_CONFIG`
env var (JSON file path or inline JSON), parsed in
`packages/pi-agent/src/native-host/main.ts` (`loadMockSkillsConfig`). Shape:

```jsonc
{
  "grants": [{
    "skillKey": "my-package/my-skill",
    "revision": "*",                     // "*" or the registry's sha256; must match skill.revision
    "capabilities": ["context.read", "suggestion.present", "draft.replace-on-accept"],
    "mode": "review-before-submit"        // "advisory" (default) | "review-before-submit"
  }],
  "adapters": [{
    "id": "fixture/comment-page",         // matches a packaged adapter (see §5)
    "version": "1.0.0",
    "hosts": ["127.0.0.1"],
    "events": ["comment.draft.paused", "comment.before-submit"],
    "gates": ["comment.before-submit"]    // which events this adapter can HARD-HOLD
  }],
  "job": { "delayMs": 5,
           "report": { "decision": "suggest", "explanation": "…", "replacementText": "…" } }
  // job: only for the fake host's scripted mock model (test seam)
}
```

`SkillGrant` fields (real settings, `packages/pi-agent/src/skills/planner.ts`):
`enabled`, `revision`, `capabilities`, `scope?`, `accounts?`, `mode?`,
`learningEnabled?`. Mock config grants get `enabled: true` by construction.

**Plan compilation** (`SkillsPlanner.compile`): per document, the host
compiles a `PagePlan` (`planId`, `planVersion`, `documentGeneration`,
`expiresAt` = **now + 60 s**, `rules[]`, `unavailable[]`). A rule is emitted
only when: granted + revision-bound + `context.read` granted + an adapter
exists whose `hosts` match and whose `events` cover ALL subscriptions +
(`review-before-submit` ⇒ `comment.before-submit` ∈ adapter `gates`).
Limits: ≤64 rules and ≤64 total subscriptions per document, else no plan.
`unavailable[]` carries exact reasons — surface them, don't hide them.

**Content-side arming** (`firefox/src/content/index.ts` +
`packages/webext/src/skills/page-runtime.ts`): on document load the content
script probes the host (`skills_plan`). If the native host is still starting
(cold browser), a failed probe is **retried** (bounded: 10× 1 s); definitive
negatives (no plan, no adapter) are not retried. When a plan with rules
arrives, the page runtime starts, registers listeners in **capture phase**
(the synchronous hold decision runs before the page's own handlers), and
arms the gate on a **debounced** draft change (`armDelayMs`) with a fresh
bounded `{draft, replyTarget, contextRevision}` snapshot. In e2e
(`?skills_test=1`) the armed state is exposed as
`document.documentElement.setAttribute("data-skills-armed", …)` — scripted
input must wait for it.

**installed ≠ enabled ≠ armed**: package on disk → grant in settings →
plan compiled for this document → runtime armed for this composer.

## 4. The review job

On a matching event the host submits an isolated Pi job
(`packages/pi-agent/src/skills/skills-protocol.ts` → `skills-service.ts`).
`comment.before-submit` jobs are `kind: "gate"` (highest priority);
`comment.draft.paused` jobs are `"speculative"`. Dedup key:
`skillKey:interactionId:draftRevision` — one running + one replacement per key;
superseded jobs are cooperatively aborted. Budgets: 2 concurrent model jobs,
queue 64 (+replacements); a required job that cannot be admitted settles
`unavailable` — **never** `clear` by absence.

**What the job receives** (`isolated-runner.ts`): the skill instructions, a
job-contract block with the exact `jobId`/`eventId`/`skillKey`/
`skillRevision`, and the context JSON (the resolved snapshot fields).
Toolset is minimal: `skill_report` only (no chat access, no shell).

**What it must return**: call `skill_report` **exactly once** with those
exact identity values plus `decision`:

- `"clear"` — review passed, no change;
- `"suggest"` — plus `explanation` and `replacementText` (≤32 KiB; only
  `suggest` may replace text);
- `"abstain"` — no verdict (required-reviewer abstention ⇒ gate
  `unavailable`).

Results are parsed against the protocol
(`parseSkillsResultParams`); identity fields from model output are NOT
authoritative — the host binds its own job identity.

**Gate behaviour** (`packages/webext/src/skills/submission-gate.ts`, states in
`GateState`):

| state | meaning | submit in review-before-submit |
| --- | --- | --- |
| `dirty` | current draft has no valid result | hold, request review |
| `reviewing` | job in flight (deadline 10 s) | hold, coalesce |
| `clear` | all required reviews match current identity | allow |
| `suggestion` | ≥1 reviewer offered a change | hold, show card |
| `unavailable` | timeout / disconnect / abstain / limits | hold; **local bypass** ("Post my text") |
| `authorized` | user approved this exact draft (15 s) | allow ONE attempt (1 s chain window) |
| `closed` | target removed / navigation | discard everything |

Editing the draft (or the reply target) invalidates to `dirty` — stale
results can never apply. **Apply** replaces the composer text, which re-arms
the gate for the NEW draft; applying never authorizes submission.
`advisory` mode never holds (`submit()` returns `"allow"`).

## 5. Site adapters

A packaged `PageAdapter` (`packages/webext/src/skills/adapters.ts`) declares
how ONE site expresses a composer:

```ts
{
  adapterId: "site/example",            // referenced by plan rules
  composer: ["textarea.js-composer"],   // selector set: active composer
  submit: ["button[data-action=post]"], // selector set: submit control
  submitKey?: { key: "Enter", modifiers: [] }, // exact keyboard chain
  chainId: "example-submit",            // adapter-owned, gate dedups on it
  capture: { maxDraftChars: 262144, replyTarget: [".comment-target"] },
}
```

The host-side **coverage declaration** (in grants config, §3) is separate and
must agree: `events` = what the adapter can observe, `gates` = what it can
hard-hold. Only adapters with **observed, tested coverage** belong in
`BUILTIN_ADAPTERS` (design §6); today only `fixture/*` adapters exist.

**V1 coverage limitation (documented in the e2e suite):** a content-world
`preventDefault()` on `keydown` is not observable in the page world
(`event.defaultPrevented` stays false), so **JS-handler Enter chains are
advisory-only** — the gate consults, records the gesture
(`consult=hold`), and the user's text posts. Click chains and form-default
submit ARE hard-held (see `tests/skills-e2e/scenarios/keyboard-enter.json`
`note` and `basic-approve-apply.json`). Treat adapter coverage as a tested
capability and advertise only what you observed.

## 6. Testing a new skill

### (a) Unit tests (imitate these)

- Host: `packages/pi-agent/test/skills-package-roots.test.ts`,
  `skills-protocol.test.ts`, `skills-service.test.ts`,
  `skills-pi-integration.test.ts`, `skills-runtime.test.ts`,
  `test/skills-host/integration.test.ts`
- Content: `packages/webext/test/skills-runtime.test.ts`,
  `skills-coordinator.test.ts`
- Run: `npm test -w @pi-browser/agent` / `-w @pi-browser/webext`

### (b) E2E scenario authoring

Scenarios live in `tests/skills-e2e/scenarios/`. Shape (see
`basic-approve-apply.json`):

```jsonc
{
  "name": "my-scenario",
  "fixture": "fixture-basic.html",          // in tests/fixtures/skills/
  "prompt": "REVIEW-…",
  "pageUrl": "http://127.0.0.1:0/fixture-basic.html",
  "skillsConfig": { "grants": [ …§3… ], "adapters": [ …§3… ] },
  "job": { "delayMs": 5,
           "report": { "decision": "suggest", "explanation": "…", "replacementText": "…" } },
  "steps": [
    { "side": "agent", "type": "prompt", "text": "REVIEW-…" },
    { "side": "agent", "type": "say", "text": "…" },
    { "side": "agent", "type": "tool", "tool": "browser_evaluate",
      "args": { "expression": "…(see the two harness rules below)…" } }
  ],
  "expect": {
    "submitted": true,
    "logIncludes": ["held", "submitted"],   // window.__fixture.log event types
    "logExcludes": ["held"],
    "receiptIncludes": "Fixture reply: …",
    "note": "what this scenario proves"
  }
}
```

**The two non-negotiable harness rules** (root-caused by flaky runs):

1. **Wait for `data-skills-armed` before any scripted input.** The arm is a
   debounced round-trip; typing before it races the runtime and drops the
   draft (this was the keyboard/ime flake). Poll the attribute in the same
   `browser_evaluate` that performs the action.
2. **Poll caps at 5000 ms** (`Date.now() - t0 > 5000`, tick 100–250 ms).
   Longer caps turn a missing precondition into a multi-minute hang.

### (c) Running

```sh
node tests/skills-e2e/run.mjs --list
node tests/skills-e2e/run.mjs                      # full matrix
node tests/skills-e2e/run.mjs my-scenario           # one scenario
```

Real Firefox via web-ext + the real built add-on + the **fake native host**
(`packages/pi-agent/test/skills-host/fake-host.mjs` — real
`dist/native-host/main.js` with a scripted mock backend;
`mock-session-factory.ts` scripts the job's `skill_report` call). Stale
dists are auto-rebuilt. Exit 0 = pass; report JSON on stdout.

### (d) Fixture page contract

Every fixture includes `tests/fixtures/skills/_recorder.js`:
`window.__fixture.record(type, detail)` / `markSubmitted(draft)` /
`reset()`; submit success sets `body[data-submitted="1"]` and reveals
`#receipt`. With `?skills_test=1` (harness-only) every record beacons to
`POST /__report` — the driver's observation channel — and the page-world
`window.__skillsTest` bridge (round-trips through the isolated-world router
via postMessage) exposes `state()` etc. to `browser_evaluate`. Plain pages
without the flag are inert.

## 7. Pitfalls and invariants

- **Package paths**: no escapes (`..`, absolute, backslash, colon);
  instructions must name `SKILL.md`; sizes bounded (manifest 256 KiB,
  instructions 32 KiB, whole registry 32 MiB).
- **Strict schemas**: unknown JSON fields are rejected — extend
  `packages/protocol/src/skills.ts`, not just one consumer.
- **Revision binding**: package content changes ⇒ new revision ⇒ grants
  stop matching (`"Package changed; review permissions"`).
- **Plans expire** (60 s) and on install/disable/update; the coordinator
  re-plans before arming again. A missing plan means *monitoring
  unavailable*, never silent non-protection.
- **Never auto-post on timeout**: expiry/disconnect ⇒ `unavailable` + local
  bypass; an abstention or failure never becomes `clear`.
- **One bounded snapshot per arm**; final gate validation re-reads the live
  draft — never trust input-event revisions alone.
- **Identity bounds** (gate): draft ≤256 KiB, reply target ≤2048 chars,
  identity JSON ≤256 KiB, ≤64 reviewers; over-limit ⇒ `unavailable`.
- **Advisory ≠ review-before-submit**: only `review-before-submit` holds;
  and only where the adapter's `gates` cover the event.

## 8. Deeper reading

`skills-runtime-design.md`: §4 (manifest contract), §6 (adapters and
observation), §8 (submission gate), §9 (scheduling and budgets), §12
(management view), §14 (delivery sequence and acceptance checks).
