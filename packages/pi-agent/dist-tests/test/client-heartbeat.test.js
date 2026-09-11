import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADDON_CLIENT_NAME, readClientHeartbeat, touchClientHeartbeat, } from "../src/client-heartbeat.js";
let tmp;
let file;
test.before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pi-heartbeat-"));
    file = path.join(tmp, "hb.json");
    process.env.PI_BROWSER_HEARTBEAT_FILE = file;
});
test.after(() => {
    delete process.env.PI_BROWSER_HEARTBEAT_FILE;
    rmSync(tmp, { recursive: true, force: true });
});
/** Run fn with the heartbeat file pinned to a specific path (restored after). */
function withHeartbeatPath(p, fn) {
    const prev = process.env.PI_BROWSER_HEARTBEAT_FILE;
    process.env.PI_BROWSER_HEARTBEAT_FILE = p;
    try {
        fn();
    }
    finally {
        process.env.PI_BROWSER_HEARTBEAT_FILE = prev;
    }
}
test("touch writes a heartbeat for the add-on client only", () => {
    withHeartbeatPath(file, () => {
        touchClientHeartbeat("fake-firefox", "9.9.9");
        assert.equal(existsSync(file), false, "non-add-on client must not write");
        touchClientHeartbeat(undefined);
        assert.equal(existsSync(file), false, "unknown client must not write");
        touchClientHeartbeat(ADDON_CLIENT_NAME, "0.1.0");
        assert.ok(existsSync(file), "add-on client writes the heartbeat");
        const raw = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(raw.client, ADDON_CLIENT_NAME);
        assert.equal(raw.version, "0.1.0");
        assert.ok(typeof raw.ts === "number" && raw.ts <= Date.now());
        assert.ok(raw.pid > 0);
    });
});
test("read: fresh heartbeat has a small ageMs", () => {
    withHeartbeatPath(file, () => {
        touchClientHeartbeat(ADDON_CLIENT_NAME, "0.1.0");
        const hb = readClientHeartbeat(os.homedir());
        assert.ok(hb, "reads the heartbeat written by touch");
        assert.equal(hb.client, ADDON_CLIENT_NAME);
        assert.ok(hb.ageMs >= 0 && hb.ageMs < 5_000, "age is small right after writing");
    });
});
test("read: absent, wrong-client, and corrupt files all yield undefined (no throw)", () => {
    // Absent file.
    const missingHome = path.join(tmp, "no-home");
    mkdirSync(missingHome, { recursive: true });
    withHeartbeatPath(path.join(missingHome, ".pi-browser", "client.heartbeat"), () => {
        assert.equal(readClientHeartbeat(missingHome), undefined, "absent -> undefined");
    });
    // Wrong client identity.
    const wrongHome = path.join(tmp, "wrong-home");
    mkdirSync(wrongHome, { recursive: true });
    const wrongFile = path.join(wrongHome, ".pi-browser", "client.heartbeat");
    mkdirSync(path.dirname(wrongFile), { recursive: true });
    withHeartbeatPath(wrongFile, () => {
        writeFileSync(wrongFile, JSON.stringify({ ts: Date.now(), client: "fake-firefox", pid: 1 }));
        assert.equal(readClientHeartbeat(wrongHome), undefined, "non-add-on client -> undefined");
        writeFileSync(wrongFile, "{not json");
        assert.equal(readClientHeartbeat(wrongHome), undefined, "corrupt file -> undefined");
    });
});
test("touch never throws (best-effort, uncreatable target path)", () => {
    // A regular FILE where the heartbeat's directory should be -> mkdirSync
    // throws ENOTDIR deterministically (no slow paths like /proc).
    const blocker = path.join(tmp, "blocker");
    writeFileSync(blocker, "i am a file");
    withHeartbeatPath(path.join(blocker, "sub", "hb.json"), () => {
        assert.doesNotThrow(() => touchClientHeartbeat(ADDON_CLIENT_NAME, "0.1.0"));
    });
});
//# sourceMappingURL=client-heartbeat.test.js.map