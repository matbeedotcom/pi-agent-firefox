# Filesystem Skills Runtime for Firefox and Thunderbird

Status: proposed implementation design, v0.1.

Based on the supplied Pi extension reference and the design decisions in this conversation. This is an architecture specification, not an implemented or benchmarked system. Names prefixed with `skills/`, application events, manifests, and TypeScript contracts below are proposed application APIs rather than built-in Pi, ACP, or MCP APIs.

## 1. Core decision

Use filesystem packages containing Markdown skills and declarative activation metadata. A shared host service indexes these packages, routes application events, and schedules bounded Pi evaluations. A small Pi extension connects agent sessions to that service. Browser adapters detect interactions and own synchronous submission gates.

Do not instantiate an agent, Pi extension, event listener set, or filesystem watcher per installed skill. Keep the registry outside chat-session lifetime. Keep interruption outside agent-execution lifetime.

The three types are activation contracts:

| Type | Activation | Execution | Presentation |
| --- | --- | --- | --- |
| Triggered | A matching semantic event | One bounded evaluation | Optional suggestion or proposed action |
| Active | Explicit user invocation | Interactive session until completed/stopped | Task card and conversation |
| Passive | Eligible observations | Coalesced or batched background work | Quiet activity and inspectable memory |

Type does not grant permission. Passive does not imply constant inference. A package may contribute several skills of different types. Defaults are advisory for triggered skills, explicit invocation for active skills, and no durable learning until enabled for passive skills.

## 2. Ownership and topology

| Component | Owns | Does not own |
| --- | --- | --- |
| Content runtime, per eligible document/frame | DOM references, delegated listeners, active interactions, local gates | Global registry or durable memory |
| Addon background coordinator | Sender identity, route tracking, page-plan delivery, transport reconnect | Agent reasoning |
| Native host SkillsService | Registry, compilation, settings, scheduler, memory, job lifecycle | Synchronous DOM interception |
| Pi integration extension | Commands, bounded tools, session context/result integration | Global background resources |
| Pi execution workers | Selected skill instructions and task context | Other tabs' drafts or unrelated chat history |
| Sidebar | Management, activation reasons, suggestions, user decisions | Authoritative permission enforcement |

The service lives in the existing native host. If the current host is short-lived, start with reconnect/recovery rather than introducing a daemon. Observation and passive processing are available only while their required addon/host components are running. A future daemon would be a separate deployment decision.

Browser content events travel through the addon background coordinator. It supplies verified tab/frame/source identity; page-provided payloads cannot claim another account or source. Thunderbird emits mail events through the addon coordinator without a DOM adapter for message arrival.

Use the existing native connection for transport. If it carries ACP, negotiate namespaced custom methods for application messages; standard prompt traffic remains separate. MCP is optional for exposing interoperable tools/resources. Neither protocol is the scheduler.

## 3. Package and state layout

Example package-relative paths:

```text
social-companion/
  package.json
  activation.json
  skills/
    friendliness/SKILL.md
    constructive-reply/SKILL.md
    communication-preferences/SKILL.md
```

Its Pi package metadata can expose the `skills` directory. Our manager reads `activation.json` without importing code. Ordinary skill packages need no Pi extension entry. Install the shared integration extension once in the host's controlled runtime configuration, not once per skill or worker.

Optional trusted native handlers live outside Pi's automatic extension discovery and are imported by the manager only when selected. Node module imports are not reliably unloadable: handlers that require eviction use disposable worker processes. This is resource isolation, not a security sandbox.

Application data layout, under a configurable native-host data root:

```text
packages/                    # source packages or registered external paths
state/settings.json          # user activation and scope overrides
state/runtime.sqlite         # derived index, job receipts, scoped memory
state/activity/              # bounded diagnostic history
```

The filesystem package is authoritative for skill definitions. The derived index is rebuildable. User settings and memory are not overwritten on package updates. Memory remains exportable to JSON/Markdown. Pi conversation entries are not the global memory database.

## 4. Manifest contract

Example `activation.json`:

```json
{
  "schemaVersion": 1,
  "packageId": "social-companion",
  "skills": [{
    "id": "friendliness",
    "type": "triggered",
    "instructions": "skills/friendliness/SKILL.md",
    "scope": {
      "applications": ["firefox"],
      "hosts": ["facebook.com", "www.facebook.com", "reddit.com", "www.reddit.com", "x.com"]
    },
    "subscriptions": [{
      "event": "comment.draft.paused",
      "conditions": { "minCharacters": 40 },
      "debounceMs": 800
    }, {
      "event": "comment.before-submit"
    }],
    "context": {
      "required": ["draft", "replyTarget"],
      "optional": ["parentPost", "visibleAncestors"]
    },
    "review": { "defaultMode": "advisory" },
    "capabilities": ["context.read", "suggestion.present", "draft.replace-on-accept"],
    "memory": { "namespace": "communication-preferences", "scope": "account" },
    "execution": { "handler": "agent", "timeoutMs": 10000 }
  }]
}
```

An Active contribution declares a command instead of an automatic subscription. A Passive contribution declares observations and a batch policy. Package identity plus skill ID forms the canonical skill key.

Validate schemas and package-relative paths. Reject unknown event names, unsupported operators, conflicting IDs, path escapes, and unbounded selectors or regular expressions. Explicitly distinguish exact-host matching from subdomain matching; never use loose string suffix comparisons. Frames need their own origin evaluation. Account scopes are opaque verified bindings, with an explicit unknown state.

The effective configuration is the validated definition intersected with granted capabilities and user scope settings. A package update cannot silently broaden existing grants. Store a content revision covering instructions and metadata; it invalidates cached evaluations.

## 5. Registry and page-plan compilation

Build indexes by application, normalized hostname, bounded path pattern, event, and semantic target. Keep global rules in a separately bounded bucket. Re-evaluate on same-document navigation and account changes, not just document loads.

On document registration, compile a PagePlan containing only relevant adapter IDs, event subscriptions, local predicates, gate policies, and configuration versions. Do not send skill Markdown or long-term memory to the page.

A plan has `planId`, `planVersion`, `documentGeneration`, and an expiry/revalidation rule. Installation, disable, scope changes, package updates, and adapter updates invalidate affected plans. Apply updates atomically and invalidate dependent approvals. Cache compact plans in the addon for reconnects; if a required plan is missing, display monitoring as unavailable instead of claiming protection.

Index thousands of stored rules without executing them. Matching many rules on one page still has a cost: bound active rules per document, reject excessive configuration at activation, and show which rules could not be armed. Never silently drop required reviewers while claiming a gate is protected.

## 6. Shared adapters and observation

Adapters translate website-specific DOM behaviour into stable application events. Start with packaged, versioned adapters. Declarative selector data may be supplied by skill packages under a restricted grammar; arbitrary downloaded page code is not part of this design.

Each adapter declares supported semantics, capture fields, and interception coverage. Facebook and Reddit can emit the same `comment.before-submit` event using different recognition logic. A generic adapter may provide advisory observations without claiming reliable interruption.

Use delegated listeners per document and event type. Resolve a semantic target once from a bounded event path. Only then dispatch to matching rules. Track active composers rather than every comment in the feed. Observe narrow containers for replacement/removal and relevant context changes; avoid repeated whole-document scans and synchronous layout reads in the event path.

IME composition suspends speculative review. Focus or a supported submission intent can discover a composer. Programmatic draft changes require adapter-specific detection; final gate validation reads the current bounded draft and reply target rather than trusting input-event revisions alone.

DOM nodes never cross the bridge. Strongly held references are released on removal, navigation, disable, expiry, or teardown. Weak references alone do not clear timers, queues, observers, or retained snapshots.

## 7. Event and result contracts

```ts
type SkillEvent = {
  version: 1;
  eventId: string;
  event: string;
  source: {
    application: "firefox" | "thunderbird";
    connectionEpoch: string;
    documentGeneration?: string;
    tabId?: number;
    frameId?: number;
    accountId?: string;
  };
  interactionId: string;
  draftRevision?: number;
  contextRevision: number;
  planVersion: number;
  origin: "user" | "site" | "skill";
  causedBy?: string;
  contextRef: string;
};

type ReviewResult = {
  jobId: string;
  eventId: string;
  skillKey: string;
  skillRevision: string;
  decision: "clear" | "suggest" | "abstain";
  explanation?: string;
  replacementText?: string;
};
```

`contextRef` resolves only through a scoped host/addon capability. The host binds each result to the complete immutable job identity: source, target, revisions, plan, skill revision, and memory revision. Identity fields supplied by model output are not authoritative. Runtime failures are separate from semantic results; an abstention does not satisfy a required review.

Commands, acknowledgements, cancellation, reconnect, and results require explicit request IDs. `pi.events` is in-process coordination, not a durable cross-process transport or request/reply protocol. Application messages might include `skills/plan`, `skills/event`, `skills/invoke`, `skills/cancel`, `skills/result`, and `skills/status`; ACP transport names require a negotiated custom namespace.

## 8. Submission gate

One local coordinator owns interruption per composer. Agents can report review decisions but cannot directly release or submit a DOM action.

| State | Meaning | Submit behaviour in review-before-submit mode |
| --- | --- | --- |
| Dirty | Current input has no valid result | Hold and request review |
| Reviewing | Current input is being evaluated | Hold; coalesce duplicate attempts |
| Clear | All required reviews match current identity | Allow original user action |
| Suggestion | One or more reviewers offer changes | Hold and show unified decision UI |
| Unavailable | Missing support, context, timeout, or disconnect | Explain and provide explicit bypass |
| Authorized | User approved this exact original draft | Allow one logical submission attempt |
| Closed | Target removed or navigation occurred | Discard work and authorization |

Read the current draft and target synchronously, compare with the reviewed snapshot, then decide. Cancel a recognized supported gesture synchronously before awaiting agent work. An early listener cannot undo an earlier handler, and no generic interceptor guarantees coverage of arbitrary programmatic submission. Treat adapter coverage as a tested capability.

Advisory mode never holds an action. Unsupported adapters remain advisory and explain this limitation. When a supported gate is already armed but its host fails, keep the draft and expose a local bypass that does not require the host. Never silently auto-post after a timeout.

Aggregate all required reviewers. Any suggestion holds; errors/abstentions become unavailable unless the user bypasses. Optional advisory reviewers do not delay posting. Applying a suggestion edits the draft and invalidates its previous review; it never implies permission to submit.

For v1, bypass authorizes the unchanged draft and target for a second real click on the site's own button. Authorization is short-lived and covers one logical attempt, including its click/keyboard-to-submit event chain. The adapter tracks this chain and prevents duplicate dispatch. Do not implement it as a generic `skipNextEvent` flag. Record an attempt separately from confirmed posting; confirmation requires site evidence.

Approval identity includes document generation, frame, account, interaction, reply target, exact draft, context revision, and effective plan/skill revisions. Editing, target replacement, account change, navigation, or relevant policy changes revoke it.

## 9. Scheduling and resource budgets

Use a host-owned bounded queue. Priority is held submissions, explicit Active tasks, speculative reviews, then Passive learning; age queued work to avoid permanent starvation. Reserve capacity or preempt speculative work so a passive batch cannot monopolize the runtime.

For draft jobs, retain at most one running and one replacement job per skill/interaction. Abort superseded work cooperatively; do not launch another merely because cancellation was requested. If a disposable worker ignores a deadline, terminate it. Arbitrary trusted extension code cannot be preempted safely inside the host event loop.

Proposed initial limits, to tune with measurements:

| Resource | Starting limit |
| --- | --- |
| Global model jobs | 2 concurrent |
| Pending queue | 64 jobs plus one coalesced replacement per running job |
| Automatic rules per document | 64; explicit management error above cap |
| Retained interaction snapshots per document | 4, with admission checks before arming additional composers |
| Snapshot data per document | 256 KiB total |
| Context per review | 32 KiB; separate model-token cap |
| Speculative debounce | 800 ms, disabled during composition |
| Review deadline | 10 seconds; local bypass always available |
| Idle interaction expiry | 5 minutes; never expire an actively held gate without UI resolution |

Large drafts are explicitly marked unreviewable or reviewed in a supported segmented flow; do not silently truncate and issue whole-draft clearance. Under queue saturation, drop/coalesce speculative work first. Required reviews that cannot be admitted become unavailable, not clear. Bound total per-process caches as well as per-document caches, since many tabs multiply limits.

The gate path does no model inference, disk access, IPC wait, full-page traversal, or hashing of an unbounded document. Target added synchronous handler time below 2 ms p95 on the agreed test machine; measure before claiming it. Runtime cost depends on active documents, matching rules, input size, and queue limits, not merely installed package count.

## 10. Pi integration

Use documented APIs from the supplied reference:

| Pi API | Application use |
| --- | --- |
| `registerCommand` | Active skill invocation and management commands |
| `registerTool` | Scoped context access, validated result reporting, memory proposals |
| `resources_discover` | Contribute explicitly selected skill paths |
| `before_agent_start` | Inject selected task instructions where needed |
| `tool_call` | Additional gating of agent tool calls, not DOM events |
| `pi.events` | Local integration events between extensions |
| `appendEntry` | Session-local audit entries outside model context |
| `session_start` / `session_shutdown` | Attach/detach session bindings idempotently |

Factories register capabilities; they do not start global watchers or background loops. SkillsService is owned by the embedding native host. Changing or reloading a chat session detaches only its binding. Host shutdown closes global resources.

Triggered and Passive evaluations use isolated execution contexts with explicit resource loading and a minimal tool set. Prevent ambient extension/skill auto-discovery from loading the manager recursively into workers. No default shell or broad filesystem tools for simple comment review. Active skills receive only their granted tools and relevant context.

Do not use `sendUserMessage` to represent browser observations as user instructions. Do not send raw events via `sendMessage` into the current chat: the supplied reference says these messages enter model context, and steering affects that session. Use separate jobs, then deliberately surface results. Pi's TUI renderers do not define the addon UI.

Executable Pi extensions run with host permissions. Tool restrictions protect agent access but do not sandbox extension code. Untrusted executable packages require a separate security design and are out of v1 scope.

## 11. Memory, persistence, and delivery

Durable memory is namespaced by user profile, skill or explicit shared record type, account, and optional site/community. Store observations separately from inferred preferences, including evidence, confidence, and timestamps. Never infer a stable preference from a single passive observation.

Retrieve only the memory needed by a job. Memory writes are serialized/versioned and idempotent by event/job ID. Cancelled or stale jobs cannot commit derived memory without revalidation. Cross-skill access requires explicit shared record types rather than arbitrary access to another skill's private namespace.

Mail matching reads a durable job-application record containing role/company, submission date, resume version, and correspondence identifiers. Ambiguous matches produce candidates; they do not silently advance application state.

Draft events are ephemeral and may be replaced. Mail-arrival work uses durable source IDs and checkpointed reconciliation so reconnects do not lose meaningful arrivals. Use at-least-once delivery with deduplication for durable events. Do not promise exactly-once external actions. Never replay a DOM submission on reconnect.

Activity records store reasons, timings, result categories, and references by default, not raw drafts. Bound retention. Raw diagnostic snapshots require explicit opt-in and expiry.

## 12. Management experience

The Skills view lists Triggered, Active, and Passive behaviours independently of package grouping. Each skill shows enabled state, applicable scopes, read/write capabilities, last activation, and a plain-language activation rule.

Current-context states: available here, armed for review, running, suggestion ready, learning enabled, paused, unavailable. Installed is distinct from enabled; enabled is distinct from armed.

Each activation exposes: matched event, matched scope, context requested, queue delay, evaluation duration, and outcome. Provide Test against current context as a dry run that cannot post or commit memory. Show unsupported interception and resource-cap rejection clearly.

Controls: enable/disable, per-site/account overrides, advisory/review-before-submit, pause here, inspect/delete memory, activity retention, and package version. Disabling sends immediate local disarm updates, cancels affected jobs, and revokes approvals. Reconnecting documents receive current plan versions before being marked armed again.

## 13. Implementation modules

| Module | Main responsibilities |
| --- | --- |
| `contracts` | Versioned schemas, event catalog, result validation |
| `registry` | Filesystem discovery, validation, content revisions, atomic index updates |
| `planner` | Scope matching, capability intersection, page-plan compilation |
| `browser-runtime` | Shared listeners, adapter loading, interaction lifecycle |
| `submission-gate` | Synchronous policy, review aggregation, authorization state |
| `addon-coordinator` | Source identity, plans, transport, reconnect |
| `skills-service` | Scheduling, deadlines, deduplication, worker admission |
| `pi-integration` | Session binding, commands/tools, isolated job execution |
| `memory-store` | Scoped reads, proposals, transactional writes, retention |
| `skills-ui` | Management, activation history, review cards |

## 14. Delivery sequence and acceptance

1. Build contracts, filesystem registry, and compiler. Prove inactive packages import no executable code.
2. Build a controlled comment-page fixture and local gate. Exercise click, keyboard, IME, DOM replacement, duplicate events, stale results, and disconnect before integrating a real site.
3. Connect isolated Pi review jobs and one friendliness skill. Confirm the current chat receives no background draft traffic.
4. Implement and verify one real site adapter across its supported posting paths. Advertise only observed coverage. Add remaining sites incrementally.
5. Add Active reply assistance using the same context builder and acceptance flow.
6. Add Passive preference learning with a bounded batch queue and inspectable memory.
7. Add Thunderbird arrival reconciliation and application matching.

Required acceptance checks:

- With 1,000 nonmatching skills installed, visiting the fixture loads no nonmatching handlers and performs no model work until a relevant interaction.
- Matching-rule overload is rejected or explicitly degraded without false protection claims.
- Editing during review cannot display an applicable stale result or authorize stale content.
- Two required skills produce one held action and one combined UI; neither can release it independently.
- Disconnect/timeout leaves a usable local bypass and never causes delayed automatic posting.
- Navigation, removal, session reload, and package disable leave no orphan observers/timers or unbounded retained snapshots.
- Repeated mail delivery does not duplicate memory updates; reconnect reconciliation processes missed source IDs.
- Submission attempts and confirmed external outcomes are recorded separately.
- Model job, queue, memory, snapshot, and activity limits remain bounded under an event storm.

Measure event-handler time, selector work, retained heap after churn, queue depth, cancellation delay, inference count, and held-submission latency. Compare the same active page with a small and large inactive registry. This validates the scaling claim without inventing performance numbers.

## 15. Scope boundaries

V1 supports declarative skills, trusted host integration, packaged adapters, advisory review, and verified local gates. It does not promise universal interception, secure execution of arbitrary third-party extensions, automatic replay across every site, or continuous passive processing while the host is offline.

Open implementation-specific checks are the installed Pi version's SDK/session interfaces, the existing ACP adapter's extension transport, and live site interception coverage. They affect integration details rather than the component ownership defined here.
