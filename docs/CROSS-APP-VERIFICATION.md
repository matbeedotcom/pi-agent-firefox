# Cross-App Broker — Verification Record (THUNDERBIRD-PLAN.md §26–31)

**Date:** 2026-09-13 · **Machine:** Linux (x86_64), Node 22.22.3
**Apps:** real Firefox (nightly, `/home/acidhax/Desktop/Firefox`) + real Thunderbird
**Host:** `com.matbee.agent` from this repo (`packages/pi-agent/dist/native-host/main.js`)
**Agent backend:** real Pi in the broker (user's model config)

## What was built

| Component | Location |
|---|---|
| Broker IPC (Unix socket, 0700 dir / 0600 socket, pid+token state, handshake) | `packages/pi-agent/src/native-host/broker-ipc.ts` |
| Relay mode (byte-transparent stdin↔socket pipe; stdout invariant kept) | `packages/pi-agent/src/native-host/relay.ts` |
| Host topology: first app = broker (owns AcpAgent/sessions), later apps = relays; race fallback; Windows gate | `packages/pi-agent/src/native-host/main.ts` |
| Capability provider registry (keyed by `pi.agent.hello`) | `packages/pi-agent/src/capability-registry.ts` |
| Tool router: union tool surface per session; owner-first routing; cross-app via legacy `x-pi-browser/tool`; permission prompts go to the executing client | `packages/pi-agent/src/browser/provider.ts` |
| Per-app registration in `initialize` | `packages/pi-agent/src/acp/agent.ts` |
| Tool → capability mapping (single source of truth for routing + tool surface) | `packages/protocol/src/tool-capabilities.ts` |
| Per-app heartbeats + broker state in `/pi-browser status\|doctor` | `packages/pi-agent/src/client-heartbeat.ts`, `packages/pi-agent/src/installer/index.ts` |
| Latent bug fixed: `onEof` never fired on stream EOF (dispose set `closed` before `emitEof`) | `packages/pi-agent/src/native-host/transport.ts` |

## Automated evidence

- **Unit:** `packages/pi-agent/test/broker-ipc.test.ts` (8), `capability-registry.test.ts` (8) — handshake/token rejection, stale-broker reclaim, race guard, permission modes, owner-first + cross-app routing, union tool surface, permission prompt targeting.
- **Integration (real host processes):** `tests/src/broker.test.mjs` (5) — two real host binaries, one broker + one relay, framed JSON-RPC end-to-end:
  1. Firefox-owned session calls `mail_get_selected_messages` + `compose_prepare_reply` (→ real relay client) AND `browser_get_page` (→ owner).
  2. Reverse: Thunderbird-owned session calls browser tools (→ Firefox client).
  3. MCP-over-ACP owner session: own tools via the session's MCP path, cross-app tools via legacy.
  4. Lifecycle: broker survives relay disconnect; a new relay re-attaches and serves tools again.
  5. Stdout invariant: relay stdout carries only framed protocol data.
- **Regression:** full suite green — protocol 14, agent 78, firefox 14, thunderbird 59, integration 20 (incl. the 15 pre-existing e2e tests, unchanged behavior for single-app users).

## Live evidence (real apps, 2026-09-13)

Topology (observed live):

```
$ node packages/pi-agent/dist/installer/cli.js doctor mozilla
probe: pong (integration v0.1.1, protocol v2)
add-on firefox: detected (pi-browser-firefox, heartbeat 5s ago)
add-on thunderbird: detected (pi-thunderbird, heartbeat 0s ago)
broker: running (pid 983157, up 54s) — cross-app tool routing active
doctor: OK (host + add-on connected)
```

- Broker state: `~/.pi/run/agent-broker.json` (`{"pid":983157,...}`), socket `srw-------` (0600), dir `drwx------` (0700). The Firefox host (first to connect after the host restart) became broker pid 983157; the Thunderbird host attached as a relay. The doctor's live probe itself attached as a third relay (pong from the broker).
- App reconnection was automatic: killing the two pre-broker host processes, both add-ons re-attached within ~3 s (existing keepalive/reconnect logic — no add-on changes needed).

**Firefox → Thunderbird (live):** a Firefox-hello ACP client attached to the running broker as a relay, created a real Pi session (real backend + model), and the agent invoked the registered `mail_list_folders` tool. The call was routed by the broker to the connected Thunderbird client and executed by the **real Thunderbird add-on**:

```
assistant toolCall: {"name":"mail_list_folders","arguments":{}}
assistant reply:
  Root / Archives / 2026 / Sent Messages / Deleted Messages /
  Drafts / Junk / Inbox / Root / Trash / Outbox
```

(The folder list is the user's actual mailbox — only the real Thunderbird add-on can produce it.)
Session transcript: `~/.pi/agent/sessions/--tmp-live-s1-UuKGVt--/2026-09-13T04-16-06-615Z_01a098fa-c5d7-74be-9052-332ef491e9a7.jsonl`

**Thunderbird → Firefox (live):** a Thunderbird-hello client (capabilities `mail,attachments,compose,mailModify,contacts`) created a session and the agent invoked `browser_get_page`; the broker routed it to the connected **Firefox** client and the real Firefox add-on answered:

```
toolCall: browser_get_page
tool failed: "session 01a098f7-8fa6-74be-9052-332c9b849ff2 has no bound Firefox tab"
```

(The error is produced only by the Firefox add-on's tool dispatcher — proof the call crossed the broker into the Firefox app. A successful browser call additionally needs a tab bound to the session via the Firefox sidebar UI.)

## Known follow-ups (out of scope, per goal)

- **Windows named pipes** — `isBrokerIpcSupported()` gates the broker off (clean standalone single-app mode; installer reports `broker: n/a (Windows — cross-app broker is a follow-up)`).
- A session's tool surface is fixed at session creation (the union of *then*-connected providers); a provider that connects later becomes routable only for sessions created afterwards. (Re-attached providers re-route existing sessions' calls that already had the tool registered — verified in the lifecycle test.)
- The running broker process keeps its code until the next app restart (normal: hosts are per-connection).
