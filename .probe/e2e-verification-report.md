# Independent end-to-end verification — third run

## VERDICT: VERIFIED (deterministic mock-agent / real-browser scope)

All six gates were executed independently, in order, from `/home/acidhax/dev/personal/firefox-acp-addon`. No product or probe fixes were made by this verifier. The sole authored file is this report; the required build, tests, and probe generated their normal artifacts.

## Gate results

| Gate | Result | Concrete evidence |
|---|---|---|
| 1. Typecheck | PASS | `npm run typecheck`, exit 0; agent, protocol, webext, Thunderbird succeed. |
| 2. Build | PASS | `npm run build`, exit 0; protocol, webext, agent, Firefox, Thunderbird succeed. |
| 3. Tests | PASS | `npm test`, exit 0: protocol 18/18, agent 107/107, Firefox 33/33, Thunderbird 78/78, pi-browser-tests e2e 24/24. All have 0 failed/skipped/cancelled. Total 260 passed. |
| 4. Fresh live walk | PASS | `node .probe/live-repl.mjs`, exit 0; `--- live verification: 14/14 checks passed ---` and `LIVE VERIFICATION PASSED`. No Xvfb collision or retry. |
| 5. Evidence spot-check | PASS | Parsed fresh results: array length 14, every `ok === true`; host session/prompt/permission lines below; checkpoint evidence mode 600; 12 PNGs including final and typing overlays; mock backend explicitly confirmed. |
| 6. Cleanup audit | PASS | `pgrep -af 'pi-live-|Xvfb :9'` produced no output, exit 1 (no matches). Explicit `ps -p 522179,522571 -o pid=,args=` also produced no output: this run's Xvfb on `:0` and native host are gone. No processes killed by verifier. |

## Fresh evidence directory

`/home/acidhax/dev/personal/firefox-acp-addon/VERIFICATION-evidence/live-2026-09-14T21-07-09-609Z`

## Fourteen live checks

| Check | Result | Detail |
|---|---|---|
| exactly one live Firefox window on owned display | PASS | 2097155 |
| firefox window appears | PASS | window 2097155 |
| add-on connects to the native host | PASS | host log shows the ACP handshake |
| typed cwd reached session/new | PASS | |
| prompt reached the host (session/prompt) | PASS | |
| screenshot permission prompt shown + allowed | PASS | |
| checkpoint saved (live cell finished) | PASS | 779ea6b6-c92e-4b12-8507-3667f60e3140 |
| snapshot found the Go button by role+name | PASS | el-1 |
| click had a real effect on the live DOM | PASS | clicked:1789420043851 |
| evaluate read the page value | PASS | |
| info() carries the live title | PASS | Live REPL Walk |
| artifact written to the session workspace | PASS | title=Live REPL Walk \| state=clicked:1789420043851 |
| checkpoint file is 0600 | PASS | mode 384 (decimal = octal 0600) |
| in-cell screenshot passed the permission gate | PASS | Screenshot captured. |

`results.json` was independently parsed using Node and checked with assertions for `Array.isArray(results)`, `results.length === 14`, and `results.every(r => r.ok === true)`.

## Host evidence (verbatim)

```text
[2026-09-14T21:07:11.449Z] [info] [pi-browser-host] backend: mock
[2026-09-14T21:07:17.673Z] [info] [pi-browser-host] session/new -> 779ea6b6-c92e-4b12-8507-3667f60e3140 cwd=/tmp/pi-live-1789420029609/proj
[2026-09-14T21:07:23.807Z] [info] [pi-browser-host] session/prompt 779ea6b6-c92e-4b12-8507-3667f60e3140 (14 chars, 0 images)
[2026-09-14T21:07:23.854Z] [info] [pi-browser-host] browser_screenshot: requesting user permission (toolCall=repl:browser_screenshot)
[2026-09-14T21:07:26.541Z] [info] [pi-browser-host] browser_screenshot: user chose Allow once
```

The independent evidence-copy stat check returned:

```text
600 VERIFICATION-evidence/live-2026-09-14T21-07-09-609Z/checkpoint.json
```

Both previous failure points are resolved in this execution: evidence-copy mode is 0600, and the probe exits successfully without `ReferenceError: cpStat is not defined`.

## PNG evidence sizes

| File | Bytes |
|---|---:|
| 01-firefox.png | 53324 |
| 02-sidebar.png | 53359 |
| 03-new-panel.png | 60745 |
| 03b-cwd-typed.png | 62387 |
| 04-session-created.png | 65515 |
| 05-active-pane.png | 65503 |
| 06-bound.png | 65684 |
| 06b-composer-typed-1.png | 63398 |
| 07-prompt-sent.png | 90981 |
| 07b-permission-overlay.png | 90983 |
| 08-after-permission.png | 81038 |
| 09-final.png | 81038 |

## Scope and residual risks

The browser integration is real: Firefox 155.0.1, the built add-on, the actual native-host binary, native messaging/MCP-over-ACP, the REPL worker, DOM/content-script interactions, tabs and screenshot APIs, and the screenshot permission gate. XTEST drives the sidebar on a private owned Xvfb. The agent/LLM loop is a deterministic MOCK ACP backend with a scripted `javascript` cell, intentionally avoiding model API dependencies. This verdict does **not** verify autonomous real-model browser use, model-provider authentication, inference, or model-generated tool calls. Those require a separate real-backend run.

The probe header states (verbatim):

```text
 * Real Firefox (155.0.1) + real built add-on (firefox/dist) + real native
 * host (packages/pi-agent/dist) + real REPL worker. The agent backend is the
 * deterministic mock (scripted `javascript` cell) so the test needs no model
 * API; the BROWSER side (DOM, content scripts, tabs, screenshots) is all real.
```

Independent grep confirmed launcher lines 201–202:

```text
201:    `export PI_BROWSER_BACKEND=mock`,
202:    `export PI_BROWSER_MOCK_SCRIPT=${path.join(work, "mock-script.json")}`,
```

The live command printed an XGetInputFocus warning before successfully typing the cwd; it caused no failed check. This was a single successful live execution, not a flakiness/stress study. No user's normal Firefox instance was touched by this verifier.
