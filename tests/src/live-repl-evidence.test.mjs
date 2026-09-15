import test from "node:test";
import assert from "node:assert/strict";
import { screenshotImage, checkpointButtonRef, recipeEntriesValid } from "../../.probe/live-repl-evidence.mjs";

test("live-repl evidence: recognizes PNG and SDK-normalized JPEG bytes", () => {
  const image = (bytes) => ({ type: "image", data: Buffer.from(bytes).toString("base64") });
  assert.equal(screenshotImage(image([137,80,78,71,13,10,26,10,0])).extension, "png");
  assert.equal(screenshotImage(image([255,216,255,224,0,255,217])).extension, "jpg");
  assert.equal(screenshotImage({ type: "image", mimeType: "image/png", data: "bm90IGFuIGltYWdl" }), undefined);
  assert.equal(screenshotImage(image([])), undefined);
  assert.equal(screenshotImage(image([255,216,255,224,0])), undefined);
});

test("live-repl evidence: accepts model-chosen ref keys, rejects empty/stub refs", () => {
  for (const key of ["ref", "buttonRef", "button_ref", "elRef"]) {
    assert.equal(checkpointButtonRef({ [key]: "el-1" }), "el-1");
  }
  for (const checkpoint of [null, {}, { ref: "" }, { ref: "Go" }, { ref: "el-" }]) {
    assert.equal(checkpointButtonRef(checkpoint), undefined);
  }
});


test("live-repl evidence: recipe evaluation requires three distinct complete entries", () => {
  const entries = [1, 2, 3].map(n => ({ name: `Recipe ${n}`, url: `https://example.com/${n}`, description: "A dessert." }));
  assert.equal(recipeEntriesValid(entries), true);
  assert.equal(recipeEntriesValid({ recipes: entries }), true);
  for (const invalid of [null, {}, entries.slice(1), [entries[0], entries[0], entries[2]], [null, ...entries.slice(1)], [{ ...entries[0], description: "" }, ...entries.slice(1)]]) {
    assert.equal(recipeEntriesValid(invalid), false);
  }
});
