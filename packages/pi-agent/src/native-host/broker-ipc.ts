/**
 * Broker/relay private IPC (THUNDERBIRD-PLAN.md §26–27).
 *
 * One host process per app is spawned by Native Messaging. The FIRST process
 * to start becomes the broker: it owns the ACP agent + Pi sessions and
 * listens on a private OS IPC socket (~/.pi/run/agent-broker.sock — 0700
 * dir, 0600 socket; Windows: not yet supported, single-app mode). Later
 * processes detect the running broker via its state file (pid + token),
 * connect, authenticate with the token, and run in relay mode (byte
 * passthrough: app stdin → socket, socket → app stdout).
 *
 * Security: same-user only (socket in a 0700 dir under $HOME), per-broker
 * random token, no localhost TCP. Native Messaging remains the externally
 * visible Mozilla security boundary.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { Duplex } from "node:stream";
import path from "node:path";
import { PI_BROKER } from "@pi-browser/protocol";
import { encodeFrame, FrameDecoder } from "./framing.js";
import type { Logger } from "../logger.js";

/** Paths for the broker IPC (env override for tests). */
export function brokerPaths(homeDir: string = os.homedir()): { dir: string; socket: string; state: string } {
  const dir = process.env.PI_BROWSER_BROKER_DIR || path.join(homeDir, ".pi", PI_BROKER.runDir);
  return {
    dir,
    socket: path.join(dir, PI_BROKER.socketFile),
    state: path.join(dir, PI_BROKER.stateFile),
  };
}

/** Broker IPC needs Unix sockets; Windows (named pipes) is a follow-up. */
export function isBrokerIpcSupported(): boolean {
  return process.platform !== "win32";
}

/** True when the pid is alive (EPERM = alive but owned by another user). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Broker state file contents (0600; same-user readable). */
export interface BrokerState {
  pid: number;
  token: string;
  socket: string;
  startedAt: number;
  version: number;
}

export function readBrokerState(statePath: string): BrokerState | undefined {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as BrokerState;
    if (typeof raw.pid !== "number" || typeof raw.token !== "string" || typeof raw.socket !== "string") {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export interface BrokerServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

export interface StartBrokerServerOptions {
  log: Logger;
  /** Called once per authenticated relay connection with its duplex channel. */
  onClient: (channel: Duplex) => void;
}

/**
 * Relay → broker duplex channel: readable = broker→relay bytes, writable =
 * relay→broker bytes. The broker's framing dispatcher re-frames both
 * directions, so this channel is raw bytes.
 */
class RelayChannel extends Duplex {
  constructor(private readonly socket: net.Socket) {
    super();
  }

  override _read(): void {
    // Flow is push-driven from the socket's "data" events.
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.socket.write(chunk, (err) => cb(err ?? undefined));
  }
}

/**
 * Start the broker socket server. Creates the 0700 run dir, reclaims a
 * stale socket when the previous broker is gone, writes the 0600 state
 * file (pid + token), and listens. Throws if another live broker owns the
 * socket (the caller should then attach as a relay instead).
 */
export async function startBrokerServer(opts: StartBrokerServerOptions): Promise<BrokerServerHandle> {
  const paths = brokerPaths();
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.dir, 0o700); // mkdir mode is subject to umask
  } catch {
    /* best-effort */
  }

  // Reclaim a stale socket (previous broker crashed without cleanup).
  if (existsSync(paths.socket)) {
    const state = readBrokerState(paths.state);
    if (state && isPidAlive(state.pid)) {
      throw new Error(`another broker is already running (pid ${state.pid})`);
    }
    rmSync(paths.socket, { force: true });
  }

  const token = randomBytes(24).toString("hex");
  const server = net.createServer((socket) => handleConnection(socket));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(paths.socket, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  try {
    chmodSync(paths.socket, 0o600);
  } catch {
    /* best-effort */
  }
  const state: BrokerState = {
    pid: process.pid,
    token,
    socket: paths.socket,
    startedAt: Date.now(),
    version: PI_BROKER.version,
  };
  writeFileSync(paths.state, JSON.stringify(state), { mode: 0o600 });

  function handleConnection(socket: net.Socket): void {
    const chan = new RelayChannel(socket);
    const decoder = new FrameDecoder();
    let handshakeDone = false;

    socket.on("data", (chunk: Buffer) => {
      if (handshakeDone) {
        chan.push(chunk);
        return;
      }
      try {
        decoder.push(chunk);
        for (const frame of decoder.readAll()) {
          if (handshakeDone) {
            chan.push(frame);
            continue;
          }
          handshakeDone = true;
          let msg: { type?: unknown; token?: unknown } | undefined;
          try {
            msg = JSON.parse(frame.toString("utf8"));
          } catch {
            msg = undefined;
          }
          if (msg?.type === PI_BROKER.handshake && typeof msg.token === "string" && msg.token === token) {
            socket.write(encodeFrame({ type: PI_BROKER.handshakeAck, version: PI_BROKER.version }));
            // Hand the pre-ack trailing bytes to the channel (re-framed there).
            const rest = decoder.drain();
            if (rest.length > 0) chan.push(rest);
            opts.log.info("broker: relay attached");
            opts.onClient(chan);
          } else {
            opts.log.warn("broker: rejected relay connection (handshake/token mismatch)");
            socket.destroy();
            chan.destroy();
          }
          return;
        }
      } catch (err) {
        opts.log.warn("broker: framing error on relay connection", err);
        socket.destroy();
        chan.destroy();
      }
    });
    socket.on("end", () => {
      if (!handshakeDone) {
        socket.destroy();
        return;
      }
      chan.push(null);
      // End the broker's writable side too: a half-open socket would keep
      // the server from closing and leak the client slot.
      socket.end();
    });
    socket.on("error", (err) => {
      opts.log.debug("broker relay socket error", err);
      chan.destroy(err);
    });
    chan.on("error", () => socket.destroy());
  }

  return {
    socketPath: paths.socket,
    close(): Promise<void> {
      rmSync(paths.socket, { force: true });
      rmSync(paths.state, { force: true });
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A successful relay attachment: the socket channel + any bytes that
 * arrived together with the handshake ack and already belong to the app
 * stream (must be written to the app's stdout before piped data). */
export interface RelayAttachment {
  channel: net.Socket;
  initial: Buffer;
}

/**
 * Try to attach to a running broker. Returns the attachment on success, or
 * null when no live broker exists (the caller should become the broker
 * instead).
 */
export async function tryRelayAttach(log: Logger, timeoutMs = 2_000): Promise<RelayAttachment | null> {
  if (!isBrokerIpcSupported()) return null;
  const paths = brokerPaths();
  const state = readBrokerState(paths.state);
  if (!state || !isPidAlive(state.pid)) return null;

  const socket = new net.Socket();
  socket.unref();
  try {
    await connectWithTimeout(socket, paths.socket, timeoutMs);
    socket.write(
      encodeFrame({ type: PI_BROKER.handshake, token: state.token, version: PI_BROKER.version }),
    );
    const { remainder } = await readHandshakeAck(socket, timeoutMs);
    log.debug("relay: attached to broker");
    return { channel: socket, initial: remainder };
  } catch (err) {
    log.debug("relay: broker attach failed", err);
    socket.destroy();
    return null;
  }
}

/** Wait for the broker's handshake ack frame; returns its remainder bytes. */
async function readHandshakeAck(socket: net.Socket, timeoutMs: number): Promise<{ remainder: Buffer }> {
  const decoder = new FrameDecoder();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      socket.destroy();
      reject(new Error("broker handshake ack timed out"));
    }, timeoutMs);
    function onData(chunk: Buffer): void {
      decoder.push(chunk);
      for (const frame of decoder.readAll()) {
        let msg: { type?: unknown } | undefined;
        try {
          msg = JSON.parse(frame.toString("utf8"));
        } catch {
          msg = undefined;
        }
        if (settled) continue;
        settled = true;
        clearTimeout(timer);
        socket.removeListener("data", onData);
        if (msg?.type !== PI_BROKER.handshakeAck) {
          socket.destroy();
          reject(new Error("broker handshake ack mismatch"));
          return;
        }
        resolve();
        return;
      }
    }
    socket.on("data", onData);
  });
  return { remainder: decoder.drain() };
}

function connectWithTimeout(socket: net.Socket, path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("broker connect timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.connect(path);
  });
}
