# Contextual, filesystem-driven skills

Status: implementation plan; no runtime changes implemented.
Date: 2026-09-14.

## Outcome

Users can create, discover, and explicitly apply portable Agent Skills from the Firefox sidebar and Thunderbird pane. Skills are suggested from the current site, inbox, folder, or contact. The user sees which instructions will apply and retains control over consequential actions. Future harness hooks can propose tasks through the same activation and authorization flow.

The first release includes filesystem discovery and refresh, contextual suggestions, per-turn activation, a skill library, and preview-before-save authoring. Unattended execution, automatic installation, a marketplace, and a general plugin runtime are deferred.

## Decisions

1. Use the [Agent Skills specification](https://agentskills.io/specification): a directory with `SKILL.md`, YAML frontmatter, and optional `references/`, `assets/`, and `scripts/`. Newly authored skills must pass standard validation, including matching directory and skill names.
2. Keep portable instructions, local context bindings, and execution permissions separate. A skill match or activation grants no additional tool authority. `allowed-tools` metadata cannot override host permission policy.
3. Reuse Pi's discovery and resource loading behind an adapter where feasible. Add our matching, UI, and activation semantics around that adapter.
4. Default to visible suggestions and explicit per-turn activation. Do not automatically attach skills because the user changed tabs or selected mail. Manual selection from the library remains available, including when no binding matches.
5. Match scope deterministically and rank eligible skills locally from name/description and prompt terms. No model request while the user types. Semantic ranking can be added later if real usage justifies it.
6. Treat context and selected skill revisions as a snapshot at prompt acceptance. File changes affect subsequent turns, not a turn already running.
7. Negotiate a versioned private ACP extension. Do not describe proposed skill methods as standard ACP or MCP methods. MCP remains the tool execution boundary.

## Existing integration points

| Area | Current code | Planned use |
| --- | --- | --- |
| SDK resources | `packages/pi-agent/src/acp/sdk-backend.ts`: `PiSdkBackend.servicesFor`, `spawnSession`, `wrapSession` | Adapt existing `createAgentSessionServices` resource loading and per-session prompt execution. |
| Backend contract | `packages/pi-agent/src/acp/backend.ts`: `BackendSession.prompt` | Add optional typed turn input for resolved skills; preserve plain text/image prompts. Update production and mock implementations together. |
| ACP lifecycle | `packages/pi-agent/src/acp/agent.ts`: `sessionPrompt`, `sessionLoad`, initialization | Negotiate capability, validate selections, resolve revisions, record and replay activation metadata. |
| Host lifecycle | `packages/pi-agent/src/native-host/main.ts`: `main`, `wireClient` | Own registry lifecycle once per broker host; isolate context and activation by client/session. |
| Shared protocol/client | `packages/protocol/src/integration.ts`, `packages/webext/src/acp-client.ts` | Add contracts and capability handling through existing transport. |
| Extension routing | Both apps' `src/background/index.ts`: `handleAction`, `sendPrompt` | Collect authoritative app context, transport selections, surface acceptance/errors. |
| Firefox UI | `firefox/src/sidebar/index.ts`: `sendPrompt` | Suggestions, selected skill chips, library and creation entry points. |
| Thunderbird UI/context | `thunderbird/src/pane/index.ts`: `sendPrompt`; `thunderbird/src/background/mail-dispatcher.ts`: `mailGetContext`; `packages/protocol/src/mail-tools.ts`: `ThunderbirdContext` | Reuse folder/message references and map them to matching context. |
| Tool permissions | `packages/pi-agent/src/browser/provider.ts`: `CapabilityToolProvider.requestPermission`; `packages/protocol/src/permission.ts` | Preserve action approval across direct tools, MCP, and REPL routes. |

The installed Pi SDK example `examples/sdk/04-skills.ts` documents `DefaultResourceLoader`, `skillsOverride`, `reload`, and `getSkills`. Its `docs/skills.md` documents global/project/package discovery and model-driven loading. These are evidence of reusable support, not proof that live, isolated per-turn activation already works.

`servicesFor` caches services by cwd. Mutating that shared loader to select skills could affect several sessions. The first milestone must settle this boundary before UI work proceeds. Ripwire's name-based graph misses interface dispatch and reports some ambiguous edges; treat this as a change spanning packages, both apps, and integration tests, regardless of small reported impact counts.

## Storage and identity

Use Pi's configured skill locations through the adapter. Default newly authored personal skills to `~/.agents/skills/<name>/SKILL.md`; allow a user-configured writable root. Discover project skills only under the existing project trust rules. Do not independently scan unrelated harness directories.

Store application bindings under the effective agent directory, proposed path `<agentDir>/pi-browser/skill-bindings.json`. Keep binding data out of portable skill directories. This file has `schemaVersion: 1` and atomic writes with a revision check to avoid overwriting external edits.

Example portable skill:

```text
~/.agents/skills/facebook-post/
  SKILL.md
  references/writing-style.md
```

Example proposed binding shape:

```json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "id": "facebook-post-on-facebook",
      "skill": { "rootId": "personal", "relativePath": "facebook-post" },
      "enabled": true,
      "scope": {
        "application": "firefox",
        "hostname": "facebook.com",
        "includeSubdomains": true
      }
    }
  ]
}
```

The host assigns opaque catalog IDs from root identity plus canonical relative location; names alone are not unique. Return display name, description, source label, diagnostics, revision, and availability. Duplicate names remain distinguishable in the library. Binding references use root/location identity; moved or removed skills become unresolved and require relinking rather than silently selecting a namesake.

The catalog revision identifies an index snapshot. Skill revisions hash loaded instructions; resource manifests record bundled file identities. Resolve all selected skills before dispatch. Retain immutable instruction bytes for the active turn; resolve bundled reads through the selected revision's resource snapshot. If the SDK cannot honor pinned resource access, block that integration until an adapter can, rather than claim version pinning while reading live paths.

Filesystem refresh uses debounced watches with explicit Refresh as fallback. Invalid or partially written files produce diagnostics and cannot silently substitute stale instructions for a new activation. Running snapshots remain usable. Apply file/count/size limits, canonicalize paths, and prevent traversal or symlinks escaping configured roots. Discovery never executes scripts.

## Context and matching

Introduce `SkillContext` in a new `packages/protocol/src/skills.ts`. Include application, client/profile identity, session ID, context revision, and source reference. App background code supplies this context; DOM text and message bodies cannot supply bindings or trusted instructions.

Firefox context uses a parsed URL hostname and tab/window reference. Normalize hostname casing, IDNs, and trailing dots. Match exact host by default; explicit subdomain matching uses a dot boundary, so `facebook.com.evil.test` cannot match `facebook.com`. Do not send URL queries/fragments for matching. Unsupported schemes yield no site matches.

Use the visible app context for suggestions and show its source. If the session's bound execution tab differs, expose that mismatch before submission and require the user to align the target or explicitly choose the intended context. Selection must not silently rebind a session. Recheck context revision at submission; a navigation requires fresh selection if scope no longer matches.

Thunderbird scopes support application, profile-local account ID, folder ID, and contact mailbox with an explicit role (`sender`, `recipient`, or `either`). All conditions within a binding are ANDed; multiple bindings are alternatives. Account/folder IDs are profile-local: retain labels for display and require relinking after profile migration. Never use transient message IDs as persistent binding identity.

Use normalized mailbox parsing, not display-name matching. Normalize the domain; avoid silently conflating local parts, aliases, or plus addresses. Address-book IDs may be stored as local links but mailbox matching should work without an address-book entry. Ambiguous addresses do not match. Sender matches indicate relevance, not authenticated identity or authorization.

For multi-selection, narrow folder/contact bindings must match every selected target. Mixed selections can still suggest broader account/app skills when all targets qualify. Unified/virtual folders must resolve actual target accounts before matching; unknown values do not behave as wildcards. Prefer selected messages, falling back to displayed messages when selection is empty; encode that source visibly.

Resolve scope first, rank by specificity and local prompt relevance second, and return a short reason for each suggestion. Explicitly selected skills retain user order; deduplicate catalog IDs and let users inspect conflicting instructions. No hidden rule that one matching skill overrides another. Suggested list is bounded (initially five); the full library remains searchable.

## Protocol and turn lifecycle

Proposed private capability: `piAgent.skills` with version `1`, advertised through the existing initialize metadata pattern. Exact wire namespace registration belongs in milestone 1.

| Proposed operation | Contract |
| --- | --- |
| `x-pi-agent/skills/list` | Session-scoped catalog descriptors, revision, diagnostics; no full bodies. |
| `x-pi-agent/skills/suggest` | Context and optional prompt text to bounded descriptors with matching reasons. Debounce locally and cancel/discard stale responses. |
| `x-pi-agent/skills/read` | Inspect one installed skill by opaque ID/revision, not arbitrary filesystem path. |
| `x-pi-agent/skills/save` | Save a reviewed draft and optional binding to an allowed root with expected revisions. No script execution or external installation. |
| `x-pi-agent/skills/refresh` | Rescan and return catalog revision/diagnostics. |
| Catalog change notification | Invalidate UI descriptors without replacing active turn snapshots. |

Carry ordered `{id, revision}` selections and context revision in namespaced `_meta` on the same `session/prompt` request. Avoid a separate mutable “activate” request that could race another prompt. Resolve a typed backend turn context rather than changing the user-visible message text. Responses/events identify which revisions were accepted.

Prompt acceptance must reserve the session while asynchronous context/skill validation runs; `isStreaming` alone may not cover this interval. Validate session ownership, client context, availability, revisions, and size limits before invoking the backend. Reject missing/changed skills with an actionable error and preserve the user's draft and selection. A private operation must not allow a different connected client to read or mutate another client's session context.

Old clients retain plain prompt behavior. Unsupported hosts hide the contextual feature with an explanation; selected skills must never be silently dropped and the prompt sent anyway. Disconnect/reconnect reloads catalog state. Session history records skill IDs, names, revisions, and provenance independently from user prose; replay shows historical attachments without reactivating them. Explain that earlier skill content may remain in conversation history even after it is removed from future turns.

## User interaction and authoring

Both apps use shared suggestion/selection logic in `packages/webext/src/skills/`, with small app-specific context adapters and UI wiring. Avoid a broad conversation UI rewrite.

The composer shows suggested skills, matching reason, Use, and Inspect. Applied skills appear as removable chips for the next turn. Provide a searchable library and “Create skill for this site/inbox/contact.” Creation shows editable name, description, Markdown instructions, destination, and binding scope; saving is an explicit user action. External file edits become visible after refresh.

“Save this workflow as a skill” generates a draft from user-selected conversation material. Do not automatically copy entire email threads, message bodies, credentials, or incidental page content into persistent files. Show the exact files and binding changes before saving. Initially author `SKILL.md` and optional text references; executable script authoring is deferred.

Use atomic per-file writes and stage new skill directories before publication. Existing files require expected revisions; conflict errors preserve the draft. If saving the skill succeeds but saving its binding fails, report the partial result and offer binding retry without duplicating or deleting the saved skill. Do not overwrite unrelated skills.

Keyboard navigation, accessible labels, loading/error states, and removal of selections are part of the initial UI work. The user prompt remains intact on failed acceptance; optimistic conversation rendering must be reconciled with host errors.

## Human control and future hooks

Suggestions are permission-free. Applying instructions authorizes their use for the turn but does not approve publishing, sending, deleting, changing recipients, or executing arbitrary bundled code. Reuse existing tool policy and audit bypass paths (including REPL/generic browser operations) before claiming a draft-only guarantee. Where a generic tool cannot enforce that boundary, expose the actual limitation and keep the workflow at a reviewable draft until an enforceable action gate exists. Prompt instructions alone are insufficient enforcement.

Hooks are a later milestone: event -> context snapshot -> match -> task proposal -> user authorization -> ordinary skill-backed turn. Keep event subscriptions and grants in separate local configuration. Define an origin on task proposals (`user` or `hook`) but do not ship an event runner in v1. Future grants need scope, expiry/revocation, duplicate suppression, and an audit record; they must reuse the same tool permission checks.

## Delivery milestones and validation gates

### 0. Prove SDK behavior and turn isolation

Inspect the installed SDK resource API and build a focused test fixture around the exact pinned dependency. Verify catalog discovery, diagnostics, reload, explicit loading, multi-skill instruction placement, relative references, and history handling. Test two sessions with the same cwd. Decide how contextual skills coexist with Pi's ordinary model-invoked skills: preserve ordinary existing behavior, but ensure bindings do not misleadingly imply restrictions the SDK ignores. For managed contextual skills, prevent implicit model activation through the ordinary catalog or make that capability unavailable until supported.

Gate: a documented adapter contract and passing isolation/revision fixture. No shared resource-loader mutation for per-turn selection. Record any SDK limitations and resolve required gaps before proceeding.

### 1. Define contracts and filesystem registry

Add `packages/protocol/src/skills.ts`, capability metadata, runtime validation, and exports. Add host modules under `packages/pi-agent/src/skills/` for SDK discovery adaptation, catalog, binding persistence, matching, and snapshot resolution. Wire shared registry lifecycle through `native-host/main.ts` and ACP options.

Gate: protocol compatibility tests plus new registry/matcher tests using temporary directories. Cover malformed frontmatter, duplicate names, broken bindings, atomic refresh, traversal, deleted resources, host normalization, mailbox parsing, mixed mail selection, and deterministic ordering. Skill discovery must cause no execution.

### 2. Wire one complete Firefox turn

Add negotiated private handlers, shared webext skill client state, Firefox context collection, and one composer suggestion/selection flow. Extend `AcpAgent.sessionPrompt`, `BackendSession.prompt`, SDK wrapping, and both mock backends with optional resolved turn context. Record/replay skill attachments.

Gate: extend `packages/pi-agent/test/acp-agent.test.ts`, `firefox/test/addon.test.ts`, and host integration tests. Prove selected bytes reach the backend exactly once, user text stays unchanged, unsupported capabilities do not drop selections, and stale revisions/concurrent prompts fail before execution. Verify bound/visible tab mismatch and navigation during submission.

### 3. Add Thunderbird and cross-app isolation

Implement context mapping from `mailGetContext`, account/folder/contact bindings, and the shared composer experience in the pane. Add any needed account resolution without reading message bodies for suggestion generation.

Gate: extend `thunderbird/test/mail-dispatcher.test.ts` and add pane/background integration coverage. Extend `tests/src/broker.test.mjs` for simultaneous Firefox/Thunderbird sessions sharing cwd, cross-client ownership, disconnects, and independent context revisions. Test unified folders and mixed selections explicitly.

### 4. Ship library, authoring, and refresh

Add library inspection, diagnostics, external-edit refresh, and the create/save-workflow preview UI to both apps. Wire version-checked saves and binding edits through the host. Add sample portable Facebook-post and customer-reply fixtures with synthetic data.

Gate: integration tests for preview -> save -> discover -> suggest -> activate, collisions, external edit conflicts, partial save recovery, disabled bindings, and reconnect. Perform keyboard/accessibility checks and live smoke tests in both apps using test data. Publishing/sending is not needed for these smoke tests.

### 5. Verify permission boundaries and release documentation

Audit tool routes used by the sample workflows, including MCP-over-ACP and REPL. Add targeted regression tests where a new path crosses the approval boundary. Document supported roots, scope semantics, manual activation, history behavior, permission limitations, and recovery from invalid files in README/product docs after runtime behavior is verified.

Gate: `npm run build`, `npm run typecheck`, and `npm test`. During each implementation change, use ripwire `--quality-delta` and `--test-gate` to guide focused checks; do not interpret graph coverage as proof of UI or dynamic-dispatch coverage. Record live evidence for both apps and old-host fallback. Release only after the SDK isolation and action-policy gates are satisfied.

## Completion criteria

- A user edits a standard skill on disk and sees it refresh without restarting either app.
- Facebook prompts receive explainable site suggestions; unrelated sites do not.
- Thunderbird suggestions distinguish accounts, folders, contact roles, and mixed selections correctly.
- Only explicitly selected managed contextual skills are applied, visibly and with pinned revisions, to the intended turn/session.
- Creation produces reviewable portable files and local bindings, with conflict-safe saving.
- Skill loading never grants execution permissions, and consequential workflow actions retain enforceable approval boundaries.
- Both apps continue ordinary chat against hosts without the new capability.
- Hook automation can later enter through the same task/activation boundary without changing the skill file format.
