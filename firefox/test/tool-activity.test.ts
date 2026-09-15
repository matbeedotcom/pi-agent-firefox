import { test } from "node:test";
import assert from "node:assert/strict";
import { resultParts, targetPreview, isVisualTool } from "../src/tool-activity.js";
import { resultView, displayInput } from "@pi-browser/webext";

test("screenshots survive both ACP envelopes and browser results", () => {
  const content = [{ type: "text", text: "result" }, { type: "image", mimeType: "image/png", data: "QUJD" }];
  const raw = resultParts(content);
  assert.deepEqual(resultParts(content.map((content) => ({ type: "content", content }))), raw);
  assert.equal(raw.images.length, 1);
  assert.equal(raw.text, "result");
  assert.deepEqual(resultParts(undefined), { text: "", images: [] });
  assert.equal(resultParts([{ type: "image", mimeType: "image/svg+xml", data: "abc" }]).images.length, 0);
});

test("completed transport calls do not invent successful page outcomes", () => {
  assert.equal(resultView("browser_click_at", { x: 10, y: 20 }, '{"found":false}')?.heading, "No element found at this point");
  assert.equal(resultView("browser_navigate", {}, '{"navigatingTo":"https://example.com"}')?.caption, "Navigation requested");
  assert.equal(resultView("browser_wait_for", {}, '{"found":true,"state":"hidden","waitedMs":250}')?.heading, "Condition met: hidden");
});

test("result collections preserve failure and current-tab evidence and bound preview size", () => {
  const view = resultView("browser_get_network", {}, JSON.stringify({ requests: [{ url: "/missing", method: "GET", status: 404, durationMs: 82 }] }));
  assert.equal(view?.rows?.[0].tone, "error");
  assert.equal(view?.rows?.[0].duration, 82);
  const tabs = resultView("browser_list_tabs", {}, JSON.stringify({ tabs: Array.from({ length: 80 }, (_, i) => ({ title: `Tab ${i}`, bound: i === 0 })) }));
  assert.equal(tabs?.rows?.length, 40);
  assert.equal(tabs?.rows?.[0].badge, "Current");
  assert.match(tabs?.caption ?? "", /first 40/);
});

test("evaluation renders falsy values and malformed results without losing them", () => {
  for (const value of [false, 0, null, "", [1, 2]]) {
    assert.deepEqual(resultView("browser_evaluate", {}, JSON.stringify({ result: value }))?.value, value);
  }
  assert.equal(resultView("javascript", {}, "plain output")?.value, "plain output");
  assert.doesNotThrow(() => resultView("browser_get_dom", {}, '{"elements":[null,12,"text"]}'));
});

test("mail context unwraps the protocol envelope and draft fields are not presented as read-back", () => {
  const context = resultView("mail_get_context", {}, '{"context":{"selectedMessages":[{"subject":"Invoice","author":"A"}]}}');
  assert.equal(context?.rows?.[0].label, "Invoice");
  const draft = resultView("compose_prepare_reply", { subject: "Re: Invoice" }, '{"composeTabId":12}');
  assert.equal(draft?.heading, "Re: Invoice");
  assert.match(draft?.caption ?? "", /Requested draft fields/);
  assert.ok(isVisualTool("compose_update"));
  assert.ok(isVisualTool("contacts_get"));
});

test("typing diagnostics are redacted without changing the actual tool input", () => {
  const input = { ref: "e1", text: "sensitive-value" };
  assert.equal(input.text, "sensitive-value");
  assert.ok(!JSON.stringify(displayInput("browser_type_focused", input)).includes("sensitive-value"));
  assert.equal(targetPreview("browser_type_focused", input, '{"typed":{"name":"Email"},"chars":15}').label, "Email");
});

test("click preview uses the observed target and safely falls back without a result", () => {
  assert.equal(targetPreview("browser_click", { ref: "e4" }, '{"clicked":{"role":"button","text":"Continue"}}').label, "Continue");
  assert.equal(targetPreview("browser_click", { ref: "e4" }, "failed").label, "e4");
});

test("typing preview reports actual counts without exposing typed values", () => {
  const preview = targetPreview("browser_type", { text: "secret" }, '{"typed":{"role":"textbox"},"chars":6}');
  assert.equal(preview.detail, "6 characters entered");
  assert.ok(!JSON.stringify(preview).includes("secret"));
  assert.ok(isVisualTool("javascript"));
  assert.ok(isVisualTool("browser_screenshot"));
  assert.ok(isVisualTool("bash"));
});
