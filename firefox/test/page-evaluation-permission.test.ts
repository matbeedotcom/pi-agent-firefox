import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPermissionRequest, type RequestPermissionResponse } from "@pi-browser/protocol";
import { grantEvaluationPermission, requestBrowserToolPermission } from "../src/page-evaluation-permission.js";

const allowed: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow_once" } };
const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
const request = buildPermissionRequest({ sessionId: "s", toolCallId: "evaluate-1", toolName: "browser_evaluate" });

test("evaluation prompts only without the Firefox grant and continues the waiting call", async () => {
  let granted = false;
  let requests = 0;
  Object.assign(globalThis, { browser: { permissions: {
    contains: async () => granted,
    request: () => { requests++; granted = true; return Promise.resolve(true); },
  } } });
  let prompts = 0;
  let answer!: (response: RequestPermissionResponse) => void;
  const prompt = async () => { prompts++; return new Promise<RequestPermissionResponse>(r => { answer = r; }); };
  const pending = requestBrowserToolPermission(request, prompt);
  await new Promise(r => setImmediate(r));
  assert.equal(prompts, 1);
  assert.equal(requests, 0, "showing a prompt does not itself request Firefox permission");
  let settled = false;
  void pending.then(() => { settled = true; });
  const granting = grantEvaluationPermission();
  assert.equal(requests, 1, "Firefox request is synchronous with the user's click");
  assert.equal(settled, false);
  await granting;
  answer(allowed);
  assert.deepEqual(await pending, allowed);
  assert.deepEqual(await requestBrowserToolPermission(request, prompt), allowed);
  assert.equal(prompts, 1, "subsequent calls skip the modal");
  granted = false;
  assert.deepEqual(await requestBrowserToolPermission(request, async () => { prompts++; return cancelled; }), cancelled);
  assert.equal(prompts, 2, "revocation causes a fresh request");
});

test("denial, dismissal, timeout and an ungranted browser permission do not authorize execution", async () => {
  Object.assign(globalThis, { browser: { permissions: { contains: async () => false } } });
  for (const response of [cancelled, allowed, { outcome: { outcome: "selected", optionId: "reject_once" } } as RequestPermissionResponse]) {
    assert.deepEqual(await requestBrowserToolPermission(request, async () => response), cancelled);
  }
  const screenshot = buildPermissionRequest({ sessionId: "s", toolCallId: "shot-1", toolName: "browser_screenshot" });
  assert.deepEqual(await requestBrowserToolPermission(screenshot, async () => allowed), allowed);
});

test("synchronous Firefox permission failures reject cleanly", async () => {
  Object.assign(globalThis, { browser: { permissions: { request: () => { throw new Error("No user gesture"); } } } });
  await assert.rejects(grantEvaluationPermission(), /No user gesture/);
});
