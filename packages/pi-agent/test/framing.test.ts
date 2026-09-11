import { test } from "node:test";
import assert from "node:assert/strict";

import { FrameDecoder, encodeFrame, FramingError, FIREFOX_MAX_FRAME_BYTES } from "../src/native-host/framing.js";

test("single frame round-trip", () => {
  const frame = encodeFrame({ hello: "world" });
  const decoder = new FrameDecoder();
  decoder.push(frame);
  const out = decoder.readAll();
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0].toString("utf8")), { hello: "world" });
});

test("fragmented frames (partial header, partial payload)", () => {
  const frame = encodeFrame({ n: 42 });
  const decoder = new FrameDecoder();
  // Feed one byte at a time.
  for (let i = 0; i < frame.length; i++) {
    decoder.push(frame.subarray(i, i + 1));
    if (i < frame.length - 1) {
      assert.equal(decoder.read(), null, `should be incomplete at byte ${i}`);
    }
  }
  const out = decoder.readAll();
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0].toString("utf8")), { n: 42 });
});

test("multiple frames in one read", () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame({ id: 1 });
  const b = encodeFrame({ id: 2 });
  const c = encodeFrame({ id: 3 });
  decoder.push(Buffer.concat([a, b, c]));
  const out = decoder.readAll();
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((f) => (JSON.parse(f.toString("utf8")) as { id: number }).id),
    [1, 2, 3],
  );
});

test("frame split across multiple reads", () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame({ id: 1 });
  const b = encodeFrame({ id: 2, big: "x".repeat(10_000) });
  const combined = Buffer.concat([a, b]);
  // Split at a mid-frame boundary.
  const cut = a.length + 6;
  decoder.push(combined.subarray(0, cut));
  assert.equal(decoder.readAll().length, 1);
  decoder.push(combined.subarray(cut));
  const out = decoder.readAll();
  assert.equal(out.length, 1);
  assert.equal((JSON.parse(out[0].toString("utf8")) as { id: number }).id, 2);
});

test("empty payload frame", () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0, 0);
  decoder.push(header);
  const out = decoder.readAll();
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 0);
});

test("malformed length above the limit", () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(FIREFOX_MAX_FRAME_BYTES + 1, 0);
  decoder.push(header);
  assert.throws(() => decoder.read(), FramingError);
});

test("buffered bytes tracked while incomplete", () => {
  const frame = encodeFrame({ x: 1 });
  const decoder = new FrameDecoder();
  decoder.push(frame.subarray(0, 5));
  assert.equal(decoder.bufferedBytes, 5);
  assert.equal(decoder.read(), null);
  decoder.push(frame.subarray(5));
  assert.equal(decoder.readAll().length, 1);
  assert.equal(decoder.bufferedBytes, 0);
});

test("large frame (screenshot-sized) works", () => {
  const payload = "A".repeat(5 * 1024 * 1024);
  const frame = encodeFrame({ data: payload });
  const decoder = new FrameDecoder();
  // Feed in 64KiB chunks.
  for (let i = 0; i < frame.length; i += 65536) decoder.push(frame.subarray(i, i + 65536));
  const out = decoder.readAll();
  assert.equal(out.length, 1);
  assert.equal((JSON.parse(out[0].toString("utf8")) as { data: string }).data.length, payload.length);
});
