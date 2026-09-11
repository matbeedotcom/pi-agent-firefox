import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair, TransportTimeoutError, } from "../src/native-host/transport.js";
import { JSONRPC_ERROR } from "@pi-browser/protocol";
const quiet = createLogger({ level: "error", stderr: { write: () => true } });
function pair() {
    return createMemoryTransportPair(quiet, quiet);
}
test("request/response correlation across multiple in-flight requests", async () => {
    const { a, b } = pair();
    const seen = [];
    b.transport.onRequest = (method, params, id) => {
        seen.push({ method, params });
        b.transport.respond(id, { echo: params, method });
    };
    const results = await Promise.all([
        a.transport.request("m1", { x: 1 }),
        a.transport.request("m2", { x: 2 }),
        a.transport.request("m3", { x: 3 }),
    ]);
    assert.deepEqual(results, [
        { echo: { x: 1 }, method: "m1" },
        { echo: { x: 2 }, method: "m2" },
        { echo: { x: 3 }, method: "m3" },
    ]);
    assert.equal(seen.length, 3);
});
test("error responses carry structured error objects", async () => {
    const { a, b } = pair();
    b.transport.onRequest = (_m, _p, id) => {
        b.transport.respondError(id, { code: JSONRPC_ERROR.INVALID_PARAMS, message: "bad", data: { piBrowserError: "SESSION_BUSY" } });
    };
    const err = (await a.transport.request("m").catch((e) => e));
    assert.equal(err.code, JSONRPC_ERROR.INVALID_PARAMS);
    assert.equal(err.data.piBrowserError, "SESSION_BUSY");
});
test("notifications flow without responses", async () => {
    const { a, b } = pair();
    const notes = [];
    a.transport.onNotification = (method, params) => notes.push({ method, params });
    b.transport.notify("session/update", { sessionId: "s1", update: {} });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].method, "session/update");
});
test("request timeout rejects with TransportTimeoutError", async () => {
    const { a, b } = pair();
    b.transport.onRequest = () => {
        // never respond
    };
    await assert.rejects(a.transport.request("slow", {}, 30), (err) => err instanceof TransportTimeoutError && err.method === "slow");
});
test("unknown method gets METHOD_NOT_FOUND", async () => {
    const { a, b } = pair();
    // b has no handler set
    const err = (await a.transport.request("nope").catch((e) => e));
    assert.equal(err.code, JSONRPC_ERROR.METHOD_NOT_FOUND);
});
test("close rejects pending requests", async () => {
    const { a, b } = pair();
    b.transport.onRequest = () => { };
    const pending = a.transport.request("never");
    a.transport.close();
    await assert.rejects(pending);
    assert.ok(a.transport.closed);
});
test("response for unknown id is ignored, not fatal", async () => {
    const { a, b } = pair();
    // Send a response for an id nobody asked about.
    b.transport.respond(999, { hello: 1 });
    const ok = await a.transport.request("fine", undefined, 100).catch(() => "no-handler");
    assert.equal(ok, "no-handler");
});
//# sourceMappingURL=transport.test.js.map