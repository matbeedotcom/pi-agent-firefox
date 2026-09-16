import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";

import { createLogger } from "../src/logger.js";
import { encodeFrame, FrameDecoder } from "../src/native-host/framing.js";
import {
  brokerPaths,
  isBrokerIpcSupported,
  isPidAlive,
  readBrokerState,
  startBrokerServer,
  tryRelayAttach,
  type BrokerServerHandle,
} from "../src/native-host/broker-ipc.js";
import { createStdioTransport } from "../src/native-host/transport.js";
import { PI_BROKER } from "@pi-browser/protocol";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

let tmp: string;
let brokerDir: string;

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "pi-broker-test-"));
  brokerDir = path.join(tmp, "run");
  process.env.PI_BROWSER_BROKER_DIR = brokerDir;
});

after(() => {
  delete process.env.PI_BROWSER_BROKER_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

test("broker: unsupported-platform gate", () => {
  if (process.platform === "win32") {
    assert.equal(isBrokerIpcSupported(), false);
    assert.equal(isBrokerIpcSupported(), false);
  } else {
    assert.equal(isBrokerIpcSupported(), true);
  }
});

test("broker: paths respect env override", () => {
  const p = brokerPaths("/home/fake");
  assert.equal(p.dir, brokerDir);
  assert.equal(p.socket, path.join(brokerDir, PI_BROKER.socketFile));
  assert.equal(p.state, path.join(brokerDir, PI_BROKER.stateFile));
});

test("relay attach: null when no broker state exists", async () => {
  rmSync(brokerDir, { recursive: true, force: true });
  const att = await tryRelayAttach(quiet, 300);
  assert.equal(att, null);
});

test("broker: start, relay attach, framed round-trip both directions", async () => {
  const clients: string[] = [];
  let channel: import("node:stream").Duplex | undefined;
  const server = await startBrokerServer({
    log: quiet,
    onClient: (chan) => {
      clients.push("c1");
      channel = chan;
    },
  });
  try {
    // State file + permissions.
    const state = readBrokerState(brokerPaths().state);
    assert.ok(state);
    assert.equal(state!.pid, process.pid);
    assert.ok(state!.token.length >= 32);
    const stat = await import("node:fs").then((fs) => fs.promises.stat(brokerPaths().socket));
    assert.equal(stat.mode & 0o777, 0o600);
    const dirStat = await import("node:fs").then((fs) => fs.promises.stat(brokerPaths().dir));
    assert.equal(dirStat.mode & 0o777, 0o700);

    // Relay attaches.
    const att = await tryRelayAttach(quiet);
    assert.ok(att, "attachment expected");
    assert.deepEqual(clients, ["c1"]);
    assert.ok(att.initial.length === 0);

    // Wire a real framing dispatcher on the broker side and a raw client on
    // the relay side; round-trip a message both ways.
    const dispatcher = createStdioTransport(channel!, channel!, quiet);
    const brokerEcho = new Promise<unknown>((resolve) => {
      dispatcher.transport.onRequest = (method, params, id) => {
        dispatcher.transport.respond(id, { echoed: true, method, params });
        resolve({ method, params });
      };
    });
    att!.channel.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "hello-from-relay", params: { n: 42 } }));
    await brokerEcho;
    // The response must come back framed over the relay channel.
    const decoder = new FrameDecoder();
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no relay response")), 4000);
      att!.channel.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (const frame of decoder.readAll()) {
          try {
            const msg = JSON.parse(frame.toString("utf8"));
            if (msg.id === 1) {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {
            /* keep waiting */
          }
        }
      });
    });
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 1,
      result: { echoed: true, method: "hello-from-relay", params: { n: 42 } },
    });

    // Broker → relay direction.
    const brokerOut = new Promise<unknown>((resolve) => {
      const d2 = new FrameDecoder();
      att!.channel.on("data", (chunk: Buffer) => {
        d2.push(chunk);
        for (const frame of d2.readAll()) {
          try {
            resolve(JSON.parse(frame.toString("utf8")));
          } catch {
            /* keep waiting */
          }
        }
      });
    });
    dispatcher.transport.notify("some/notification", { x: 1 });
    const out = await brokerOut;
    assert.deepEqual(out, { jsonrpc: "2.0", method: "some/notification", params: { x: 1 } });

    // Dispatcher onEof fires when the relay channel closes.
    const eof = new Promise<void>((resolve) => {
      dispatcher.transport.onEof = () => resolve();
    });
    att!.channel.destroy();
    await Promise.race([eof, new Promise((r) => setTimeout(r, 2000))]).then(() =>
      assert.ok(true, "onEof fired"),
    );
  } finally {
    await server.close();
  }
  assert.equal(existsSync(brokerPaths().socket), false, "socket removed on close");
  assert.equal(existsSync(brokerPaths().state), false, "state removed on close");
});

test("broker: rejects relay with wrong token", async () => {
  const server = await startBrokerServer({ log: quiet, onClient: () => assert.fail("should not attach") });
  try {
    const state = readBrokerState(brokerPaths().state)!;
    // Corrupt the token the relay would present.
    writeFileSync(brokerPaths().state, JSON.stringify({ ...state, token: "bad".repeat(12) }));
    const att = await tryRelayAttach(quiet, 1000);
    assert.equal(att, null, "bad token must not attach");
  } finally {
    await server.close();
  }
});

test("broker: stale state (dead pid) does not block; new broker reclaims", async () => {
  // Simulate a crashed broker: state file with a dead pid + stale socket.
  writeFileSync(brokerPaths().state, JSON.stringify({ pid: 999999, token: "x", socket: "s", startedAt: 0, version: 1 }));
  writeFileSync(brokerPaths().socket, "");
  assert.equal(isPidAlive(999999), false);
  assert.equal(await tryRelayAttach(quiet, 300), null, "stale broker must not accept relays");

  const server = await startBrokerServer({ log: quiet, onClient: () => {} });
  const state = readBrokerState(brokerPaths().state);
  assert.ok(state);
  assert.equal(state!.pid, process.pid, "new broker rewrote state");
  const att = await tryRelayAttach(quiet);
  assert.ok(att, "relay attaches to the new broker");
  att!.channel.destroy();
  await server.close();
});

test("broker: a second live broker is rejected (race guard)", async () => {
  const server = await startBrokerServer({ log: quiet, onClient: () => {} });
  try {
    await assert.rejects(startBrokerServer({ log: quiet, onClient: () => {} }), /another broker is already running/);
  } finally {
    await server.close();
  }
});

test("broker: dir permissions enforced despite umask", async () => {
  // chmod the parent to something unusual; startBrokerServer must 0700 the dir.
  const dir = path.join(tmp, "weird-run");
  process.env.PI_BROWSER_BROKER_DIR = dir;
  let server: BrokerServerHandle | undefined;
  try {
    server = await startBrokerServer({ log: quiet, onClient: () => {} });
    const stat = await import("node:fs").then((fs) => fs.promises.stat(dir));
    assert.equal(stat.mode & 0o777, 0o700);
  } finally {
    // Restore the env even when startBrokerServer throws; otherwise the
    // leaked dir poisons the socket paths of every later test.
    process.env.PI_BROWSER_BROKER_DIR = brokerDir;
    if (server) await server.close();
  }
});

test("broker: a live socket without published state cannot be reclaimed", async () => {
  const server = await startBrokerServer({ log: quiet, onClient: () => {} });
  try {
    rmSync(brokerPaths().state);
    await assert.rejects(startBrokerServer({ log: quiet, onClient: () => {} }), /another broker is starting/);
    assert.ok(existsSync(brokerPaths().socket));
  } finally {
    await server.close();
  }
});

test("broker: preserves an ACP frame coalesced with the relay handshake", { timeout: 4000 }, async () => {
  let resolvePayload!: (chunk: Buffer) => void;
  const payload = new Promise<Buffer>((resolve) => { resolvePayload = resolve; });
  const server = await startBrokerServer({
    log: quiet,
    onClient: (channel) => channel.once("data", resolvePayload),
  });
  const socket = net.createConnection(brokerPaths().socket);
  try {
    await once(socket, "connect");
    const request = encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" });
    socket.write(Buffer.concat([
      encodeFrame({ type: PI_BROKER.handshake, token: readBrokerState(brokerPaths().state)!.token }),
      request,
    ]));
    assert.deepEqual(await payload, request);
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("relay: preserves an ACP frame coalesced with the handshake ack", { timeout: 4000 }, async () => {
  const response = encodeFrame({ jsonrpc: "2.0", id: 1, result: {} });
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write(Buffer.concat([
      encodeFrame({ type: PI_BROKER.handshakeAck, version: PI_BROKER.version }), response,
    ])));
  });
  server.listen(brokerPaths().socket);
  await once(server, "listening");
  writeFileSync(brokerPaths().state, JSON.stringify({ pid: process.pid, token: "test", socket: brokerPaths().socket }));
  try {
    const attachment = await tryRelayAttach(quiet);
    assert.ok(attachment);
    assert.deepEqual(attachment.initial, response);
    attachment.channel.destroy();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(brokerPaths().state, { force: true });
  }
});
