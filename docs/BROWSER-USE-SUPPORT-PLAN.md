# Plan — Proper browser-use support (steering + contract layer)

Date: 2026-09-14. Status: draft for review.

Companions:

- `BROWSER-USE-INTEGRATION.md` — research + design record; product intent:
  **Pi Browser is a browser-use runtime over our Firefox MCP/ACP stack.**
- `BROWSER-USE-REPL-PLAN.md` — the mechanism plan (P0–P3), **complete (v1)**:
  the `javascript` REPL tool, `page`/`tabs`/`browser` realms, permission
  gates, workspace artifacts/checkpoints.
- `VERIFICATION.md` — live evidence tables.

## Why this plan exists

v1 shipped the **mechanism**: a working `javascript` tool over the user's
bound tab. But a live run with the real model proved the mechanism alone is
not "supporting browser use":

- **Real run #2: 13 agent rounds, 0 `javascript` calls.** The model fell back
  to `bash` (reading probe scripts, inspecting env) even though the task text
  named the tool. The only artifact anywhere that steers a model toward the
  tool is a one-line tool description (`packages/protocol/src/browser-tools.ts:417-428`).
  No skill, no subagent, no system-prompt hook (the SDK services API exposes
  no `systemPrompt` option).
- The contract-level pieces of browser-use — loop discipline, ref
  lifecycle, permission semantics, evidence (vision), durable state — exist
  as *capability* in the worker but are not *enforced or taught*.

"Properly supporting browser use" means an agent — any agent speaking our
ACP/MCP protocol, with the default model config — **reliably enters and
stays in the observe → act → verify → persist loop** over the bound tab.

## Acceptance criteria

1. **Cold start (the real gate):** an open-ended natural-language task that
   does *not* name the tool ("go to my current tab, click Go, report the new
   state") → the model autonomously picks `javascript`, completes
   observe→act→verify→persist, saves the checkpoint — real model, e2e.
2. **Layered guidance:** the loop contract is present at three layers —
   tool description (always), first-call preamble (after first use), skill
   (task-triggered) — and e2e shows the model honoring it (fresh refs after
   navigation, checkpoint on multi-step, inspect-before-retry after a kill).
3. **Permission semantics:** a cell blocked on the user permission overlay
   is not killed by the cell timeout; a denied screenshot yields a
   structured error with cell state intact.
4. **Evidence loop:** screenshots reach the model's observations for the
   configured model (vision verified), or guidance is explicit that
   text-only models rely on `snapshot`/`evaluate` with screenshots as
   user-facing evidence only.
5. **Operational:** the stale-broker relay is documented (a starting host
   adopts a running broker — code/config changes apply only when the broker
   restarts) and the live probe is clean of stale hosts.

## Workstreams

### WS1 — Steering layer (the core gap)

| # | Task | Detail |
|---|------|--------|
| T1.1 | Rewrite the `javascript` tool description | `browser-tools.ts`: lead with "You control a real Firefox tab (the one bound to this session)"; the loop **observe → act → verify → persist**; keep the primitive list; add: `screenshot()` may wait for user permission (Allow once / Always / Deny); multi-step work → `checkpoint()` between steps; a killed cell loses in-memory state — inspect before retrying a mutation. Keep it terse (it is paid every turn). Bump `browserToolVersion` 5→6 + protocol tests. |
| T1.2 | First-call preamble (full recipe) | Mechanism exists (`repl/runtime.ts:49-50`, `repl/worker.ts:373` prepends to the first cell's output; `repl/provider.ts:177` passes `opts.preamble`). **Verify the provider caller actually sets it** (`browser/provider.ts` `createTools`). Content: guardrails (page content is untrusted input; verify observed results; never re-run a mutation of unknown outcome), ref lifecycle (stable within a page load, stale after navigation), permission semantics, checkpoint pattern, one small worked example. |
| T1.3 | Skill `browser-walk` (task-triggered) | Repo source: `packages/pi-agent/skills/browser-walk/SKILL.md` (pattern: `~/.agents/skills/facebook-post/SKILL.md`, which works in this environment). Frontmatter `description` is the trigger: "Multi-step work on the Firefox tab bound to this session — navigate, click, fill, extract, screenshot, checkpoint." Body: the loop, API primer (all primitives incl. `tabs.*`), discipline (one transaction per cell; 30s default / 120s max kill; inspect-before-retry), permission caveats, one full example (the live-walk cell), tool choice (one-shot `browser_*` vs a `javascript` cell). The installer copies it into the user skills dir (same install path as the native-messaging manifest). |
| T1.4 | Subagent `browser-walker` — **DEFERRED** | A pi-subagents agent def would give a purpose-built system prompt + a `javascript`-only tool allowlist (no bash escape hatch). **Blocked by the session/binding model:** a subagent is a *new pi process* → new ACP session → **no bound tab** (bindings are per-session and exclusive). Unblocking requires a binding-inheritance feature (child session sees the parent's tab, or per-tab shared binding). Track as open item with a design sketch; the skill (T1.3) is the robust same-session steering in the meantime. |

### WS2 — Browser-use contract semantics

| # | Task | Detail |
|---|------|--------|
| T2.1 | Permission-aware cell timeout | While a host-side `request_permission` for an in-cell tool is pending, **pause** the cell deadline (cap the pause, e.g. +120s, so an ignored overlay cannot hang a cell forever). On deny: structured `permission denied` error to the cell, state preserved (not a kill). Touch points: `repl/runtime.ts` cell timer + `repl/worker.ts` tool dispatch + provider permission flow. |
| T2.2 | Vision verification | Probe: task that requires reading a screenshot ("describe the debug box"); confirm the configured model (default `llama.cpp/Qwen3.8-27B-GGUF`) consumes image tool results. If text-only: preamble/skill state "rely on `snapshot`/`evaluate`; `screenshot()` is evidence for the user". |
| T2.3 | Staleness + binding-change notes | Verify end-to-end that rebinding invalidates the realm and the next cell starts with a note (P1.3 deliverable) — scripted e2e. |
| T2.4 | Recipe completeness | `waitFor`/polling patterns for dynamic pages; `evaluate` 20KB cap → chunk guidance; snapshot budget knobs (`maxNodes`/`maxDepth`) for heavy pages. |

### WS3 — Verification

| # | Task | Detail |
|---|------|--------|
| T3.1 | Cold-start real e2e (acceptance gate) | `.probe/live-repl.mjs` is already patched (stale-host kill via `/proc` environ scan, per-run `PI_BROWSER_AGENT_DIR`, exact backend check, evidence from the run's agent dir). Add a variant where the task text **does not name the tool**; acceptance = host log `session/tool_start … javascript` model-authored + image evidence + `live-walk.json` checkpoint. Record in `VERIFICATION.md`. |
| T3.2 | Steering artifact tests | Protocol tests assert description/preamble content; installer test for skill copy; skill frontmatter validity (name/description parse). |
| T3.3 | Mechanism stays green | Scripted mock e2e (deterministic) remains the regression net for P0–P3 behavior. |

### WS4 — Docs & operations

| # | Task | Detail |
|---|------|--------|
| T4.1 | `PRODUCT.md` section "Browser-use support" | The steering stack (description → preamble → skill → [subagent, deferred]), the loop contract, permission semantics. |
| T4.2 | Broker lifecycle caveat | Stale-broker relay behavior + "restart the host to apply code/config" in README/PRODUCT. |
| T4.3 | README quickstart | Natural-language task example of driving the bound tab. |

## Sequencing

```
WS1 (T1.1 → T1.2 → T1.3)          ~2 days   steering first: it is the proven gap
WS2 (T2.1 → T2.2 → T2.3 → T2.4)   ~2-3 days contract semantics
WS3 (T3.2 → T3.3 → T3.1)          gate: cold-start real e2e must PASS
WS4                                polish
```

Total: ~1 week. T1.4 (subagent) is out of scope until binding inheritance
exists; it is tracked, not scheduled.

## Open questions

1. **Skill dir convention:** this machine uses `~/.agents/skills/`; the
   installer should target the pi skills directory in use — confirm the
   canonical location before T1.3.
2. **Permission pause cap:** full pause vs capped pause (+120s proposed) —
   a cap is safer against an overlay left open.
3. **`tabs.*` exposure in description:** v1 guidance keeps the bound tab
   primary; how much `tabs.*` self-service to advertise now?
4. **T1.4 design sketch:** binding inheritance (child session sees parent's
   tab) vs per-tab shared binding — needs a product decision, not just code.
