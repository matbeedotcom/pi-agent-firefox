/**
 * Approval window for external MCP callers (openspec external-mcp-callers
 * D6): one window per app, queued oldest-first, closing it denies what
 * waits, badge as a backup, and the prompt text names the caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCallerApprovalRequest,
  buildPermissionRequest,
  type RequestPermissionRequest,
} from "@trusted-ua/protocol";
import { ApprovalWindowController, isCallerPermissionRequest } from "../src/approval/controller.js";
import { describePermissionRequest } from "../src/approval/prompt-text.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function callerToolPrompt(id: string, caller = "codex", tool = "browser_screenshot"): RequestPermissionRequest {
  return buildPermissionRequest({ sessionId: "mcp:1", toolCallId: id, toolName: tool, caller: { name: caller } });
}

function rig(opts: { closeDelayMs?: number } = {}) {
  const log: string[] = [];
  const badges: string[] = [];
  const pages: number[] = [];
  const cancelled: string[] = [];
  let nextId = 100;
  let openWindows = new Set<number>();
  const controller: ApprovalWindowController = new ApprovalWindowController({
    url: "moz-extension://x/approval/approval.html",
    api: {
      open: async (url) => {
        const id = nextId++;
        openWindows.add(id);
        log.push(`open ${url} -> ${id}`);
        return id;
      },
      focus: async (id) => {
        if (!openWindows.has(id)) throw new Error("no window");
        log.push(`focus ${id}`);
      },
      close: async (id) => {
        openWindows.delete(id);
        log.push(`close ${id}`);
        // The browser fires onRemoved for our own close too.
        controller.onWindowRemoved(id);
      },
    },
    setBadge: (text) => badges.push(text),
    notifyPage: (requests) => pages.push(requests.length),
    cancel: (permId) => {
      cancelled.push(permId);
      controller.remove(permId);
    },
    closeDelayMs: opts.closeDelayMs ?? 0,
  });
  return {
    controller,
    log,
    badges,
    pages,
    cancelled,
    userCloses: (id: number) => {
      openWindows.delete(id);
      controller.onWindowRemoved(id);
    },
    get openWindows() {
      return openWindows;
    },
    reset() {
      openWindows = new Set();
    },
  };
}

test("approval: caller prompts are recognised; chat-session prompts are not", () => {
  assert.equal(isCallerPermissionRequest(callerToolPrompt("a")), true);
  assert.equal(isCallerPermissionRequest(buildPermissionRequest({ sessionId: "s", toolCallId: "b", toolName: "browser_screenshot" })), false);
});

test("approval: one window per app, prompts queue oldest first, the window closes when empty", async () => {
  const r = rig();
  r.controller.add(callerToolPrompt("p1", "codex"));
  r.controller.add(callerToolPrompt("p2", "claude-code"));
  await tick();
  assert.deepEqual(r.log, ["open moz-extension://x/approval/approval.html -> 100"], "a single window");
  assert.deepEqual(r.controller.pending().map((p) => p.toolCall.toolCallId), ["p1", "p2"]);
  assert.deepEqual(r.badges.slice(-1), ["2"]);

  r.controller.remove("p1");
  assert.deepEqual(r.controller.pending().map((p) => p.toolCall.toolCallId), ["p2"]);
  assert.equal(r.openWindows.has(100), true, "still open while p2 waits");
  r.controller.remove("p2");
  await tick();
  assert.equal(r.openWindows.has(100), false, "closed when empty");
  assert.deepEqual(r.badges.slice(-1), [""], "badge cleared");
  assert.deepEqual(r.cancelled, [], "closing it ourselves denies nothing");
});

test("approval: a new prompt while the window is open focuses it instead of opening another", async () => {
  const r = rig();
  r.controller.add(callerToolPrompt("p1"));
  await tick();
  r.controller.add(callerToolPrompt("p2"));
  await tick();
  assert.deepEqual(r.log, ["open moz-extension://x/approval/approval.html -> 100", "focus 100"]);
});

test("approval: the user closing the window denies every waiting prompt", async () => {
  const r = rig();
  r.controller.add(callerToolPrompt("p1"));
  r.controller.add(callerToolPrompt("p2"));
  await tick();
  r.userCloses(100);
  assert.deepEqual(r.cancelled, ["p1", "p2"]);
  assert.deepEqual(r.controller.pending(), []);
  assert.deepEqual(r.badges.slice(-1), [""]);
  // The next prompt opens a fresh window.
  r.controller.add(callerToolPrompt("p3"));
  await tick();
  assert.match(r.log.at(-1) ?? "", /open .* -> 101/);
});

test("approval: a timed-out prompt is removed and an empty window closes", async () => {
  const r = rig();
  r.controller.add(callerToolPrompt("p1"));
  await tick();
  // The background's timeout (or the host's permission_withdrawn) resolves it.
  r.controller.remove("p1");
  await tick();
  assert.equal(r.openWindows.size, 0);
  assert.deepEqual(r.cancelled, []);
});

test("approval: the toolbar button focuses a waiting window, and does nothing special otherwise", async () => {
  const r = rig();
  assert.equal(r.controller.focus(), false, "nothing waiting: the button keeps its usual action");
  r.controller.add(callerToolPrompt("p1"));
  await tick();
  assert.equal(r.controller.focus(), true);
  await tick();
  assert.equal(r.log.at(-1), "focus 100");
  // The window vanished without onRemoved: the button reopens it.
  r.reset();
  r.controller.focus();
  await tick();
  assert.match(r.log.at(-1) ?? "", /open .* -> 101/);
});

test("approval: an answer that lands while the window is still opening closes it", async () => {
  const r = rig();
  r.controller.add(callerToolPrompt("p1"));
  r.controller.remove("p1"); // answered elsewhere before open() resolved
  await tick();
  await tick();
  assert.equal(r.openWindows.size, 0);
});

test("prompt text: tool prompts and caller approvals name the caller", () => {
  const shot = describePermissionRequest(callerToolPrompt("a", "claude-code", "browser_screenshot"));
  assert.equal(shot.caller, "claude-code");
  assert.equal(shot.title, "claude-code wants to run browser_screenshot");
  assert.match(shot.description, /^claude-code wants to take a screenshot/);

  const approval = describePermissionRequest(
    buildCallerApprovalRequest({
      sessionId: "mcp:1",
      toolCallId: "c",
      caller: { name: "codex" },
      application: "thunderbird",
      toolName: "mail_search",
    }),
  );
  assert.equal(approval.callerApproval, true);
  assert.equal(approval.title, "Allow codex to use Thunderbird tools?");
  assert.match(approval.description, /search and read your mail/);
  assert.match(approval.description, /First request: mail_search/);

  const own = describePermissionRequest(buildPermissionRequest({ sessionId: "s", toolCallId: "d", toolName: "mail_search" }));
  assert.equal(own.caller, undefined);
  assert.equal(own.title, "Allow this action?");
});

test("approval: a follow-up prompt within the grace period reuses the window", async () => {
  const r = rig({ closeDelayMs: 40 });
  r.controller.add(callerToolPrompt("caller-ok"));
  await tick();
  r.controller.remove("caller-ok"); // caller approved...
  await new Promise((res) => setTimeout(res, 10));
  r.controller.add(callerToolPrompt("tool-1")); // ...then the tool's own prompt
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.openWindows.has(100), true, "same window, never closed");
  assert.equal(r.log.filter((l) => l.startsWith("open")).length, 1);
  r.controller.remove("tool-1");
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.openWindows.size, 0, "closes after the grace period");
});
