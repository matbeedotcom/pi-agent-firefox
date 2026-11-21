/**
 * Add-on side of sidebar sessions on external ACP agents (openspec
 * sidebar-acp-agents): the agent selector with and without the host feature,
 * the session label, plan/diff rendering, and the agent's permission prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSONRPC_ERROR, type AgentsResult, type RequestPermissionRequest } from "@trusted-ua/protocol";
import { agentChoices, diffText, fetchAgents, planStatus, planText } from "../src/agents.js";
import { resultParts } from "../src/activity/tool-activity.js";
import { describePermissionRequest } from "../src/approval/prompt-text.js";
import { SessionStore } from "../src/session-store.js";

const HOST: AgentsResult = {
  defaultAgent: "pi",
  agents: [
    { id: "pi", name: "pi", available: true },
    { id: "claude", name: "Claude Code", available: true },
    { id: "codex", name: "Codex", available: false, reason: "not found (codex-acp)" },
  ],
};

test("agent selector: pi by default, unavailable agents disabled with the reason, last choice preselected", () => {
  const fresh = agentChoices(HOST, undefined);
  assert.equal(fresh.show, true);
  assert.equal(fresh.selected, "pi");
  assert.deepEqual(fresh.options.map((o) => [o.id, o.disabled]), [["pi", false], ["claude", false], ["codex", true]]);
  assert.equal(fresh.options[2]!.label, "Codex — not found (codex-acp)");
  assert.equal(agentChoices(HOST, "claude").selected, "claude", "remembered choice");
  assert.equal(agentChoices(HOST, "codex").selected, "pi", "a remembered agent that is now unavailable falls back");
});

test("agent selector: no choice with an older host or pi alone", () => {
  assert.equal(agentChoices(undefined, "claude").show, false);
  assert.equal(agentChoices({ defaultAgent: "pi", agents: [{ id: "pi", name: "pi", available: true }] }, undefined).show, false);
});

test("fetchAgents: the host's answer, or undefined from a host without x-pi-browser/agents", async () => {
  assert.deepEqual(await fetchAgents(async <T>() => HOST as T), HOST);
  const old = async <T>(): Promise<T> => {
    throw { code: JSONRPC_ERROR.METHOD_NOT_FOUND, message: "unknown method: x-pi-browser/agents" };
  };
  assert.equal(await fetchAgents(old), undefined);
  await assert.rejects(fetchAgents(async () => { throw new Error("port closed"); }));
});

test("session list carries the agent label for non-pi sessions", () => {
  const store = new SessionStore("test");
  store.upsertFromList([
    { sessionId: "p1", cwd: "/w", updatedAt: "2026-11-20T10:00:00Z", title: "pi chat" },
    { sessionId: "c1", cwd: "/w", updatedAt: "2026-11-20T11:00:00Z", title: "codex chat", _meta: { piBrowser: { agent: { id: "codex", name: "Codex" } } } },
  ] as never);
  const snap = store.snapshot().sessions;
  assert.deepEqual(snap.find((s) => s.sessionId === "c1")?.agent, { id: "codex", name: "Codex" });
  assert.equal(snap.find((s) => s.sessionId === "p1")?.agent, undefined);
  store.upsertCreated("c2", "/w", [], { id: "claude", name: "Claude Code" });
  assert.deepEqual(store.get("c2")?.agent, { id: "claude", name: "Claude Code" });
});

test("diff content renders as a line diff in the tool card", () => {
  const { text } = resultParts([{ type: "diff", path: "/w/file.txt", oldText: "a\nold\nc\n", newText: "a\nnew\nc\n" }]);
  assert.equal(text, "/w/file.txt\n  a\n- old\n+ new\n  c");
  assert.equal(diffText("/w/n.txt", null, "x\n"), "new file /w/n.txt\n+ x");
  assert.equal(resultParts([{ type: "terminal", terminalId: "t1" }]).text, "[terminal t1]");
});

test("plan entries render as a checklist; the card completes with the plan", () => {
  const entries = [
    { content: "Read the page", status: "completed", priority: "high" },
    { content: "Write the summary", status: "in_progress", priority: "medium" },
    { content: "Send it", status: "pending", priority: "low" },
  ];
  assert.equal(planText(entries), "✓ Read the page\n▸ Write the summary\n○ Send it");
  assert.equal(planStatus(entries), "in_progress");
  assert.equal(planStatus(entries.map((e) => ({ ...e, status: "completed" }))), "completed");
});

test("an agent's own permission request is labelled with the agent and shows the command", () => {
  const request = {
    sessionId: "s1",
    toolCall: {
      toolCallId: "p1",
      title: "Run npm test",
      kind: "execute",
      content: [{ type: "content", content: { type: "text", text: "npm test" } }],
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    _meta: { piBrowser: { agent: { id: "codex", name: "Codex" } } },
  } as unknown as RequestPermissionRequest;
  const text = describePermissionRequest(request);
  assert.equal(text.title, "Codex wants to run a command");
  assert.equal(text.detail, "npm test");
  assert.equal(text.agent, "Codex");
  assert.equal(text.callerApproval, false);

  const edit = describePermissionRequest({
    ...request,
    toolCall: { toolCallId: "p2", title: "Edit a.txt", kind: "edit", content: [{ type: "diff", path: "a.txt", oldText: "1\n", newText: "2\n" }] },
  } as unknown as RequestPermissionRequest);
  assert.equal(edit.title, "Codex wants to edit a file");
  assert.equal(edit.detail, "a.txt\n- 1\n+ 2");
});
