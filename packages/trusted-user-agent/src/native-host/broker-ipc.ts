/**
 * Broker/relay private IPC (THUNDERBIRD-PLAN.md §26–27).
 *
 * One host process per app is spawned by Native Messaging. The FIRST process
 * to start becomes the broker: it owns the ACP agent + Pi sessions and
 * listens on a private OS IPC endpoint (POSIX: ~/.pi/run/agent-broker.sock —
 * 0700 dir, 0600 socket; Windows: a per-user named pipe, see ipcEndpoint). Later
 * processes detect the running broker via its state file (pid + token),
 * connect, authenticate with the token, and run in relay mode (byte
 * passthrough: app stdin → socket, socket → app stdout).
 *
 * Security: same-user only (socket in a 0700 dir under $HOME), per-broker
 * random token, no localhost TCP. Native Messaging remains the externally
 * visible Mozilla security boundary.
 *
 * Windows: Node's net API serves named pipes with the same stream semantics,
 * so only the endpoint differs. Pipes carry no file mode; their default DACL
 * grants other accounts READ only, which cannot send the handshake — the
 * token (in the 0600 state file under the user's profile, ACL'd to the user)
 * stays the same-user gate. A pipe vanishes with its owner, so there is no
 * stale endpoint to unlink.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { Duplex } from "node:stream";
import path from "node:path";
import { TRUSTED_UA_BROKER } from "@trusted-ua/protocol";
import { encodeFrame, FrameDecoder } from "./framing.js";
import type { Logger } from "../logger.js";
import { runDir } from "../paths.js";

/**
 * The listening endpoint for `file` in run dir `dir`.
 *
 * POSIX: the socket file itself. Windows: a named pipe whose name is derived
 * from the run dir (case-folded — Windows paths are case-insensitive), so it
 * is per-user (the run dir lives in the user's profile) and every
 * TRUSTED_UA_BROKER_DIR override gets its own pipe, exactly like a socket
 * file in that dir would.
 */
/** Windows pipe-name prefix (v0.4.0 used LEGACY_PIPE_PREFIX). */
export const PIPE_PREFIX = "trusted-ua-";
export const LEGACY_PIPE_PREFIX = "pi-agent-";

export function ipcEndpoint(
  dir: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
  prefix: string = PIPE_PREFIX,
): string {
  if (platform !== "win32") return path.join(dir, file);
  const key = path.win32.resolve(dir).toLowerCase();
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return "\\\\.\\pipe\\" + `${prefix}${hash}-${file.replace(/\.sock$/, "")}`;
}

/** True for a Windows named-pipe endpoint (no file to chmod or unlink). */
export function isNamedPipe(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

/** Paths for the broker IPC (env override for tests). */
export function brokerPaths(homeDir: string = os.homedir()): { dir: string; socket: string; state: string } {
  const dir = runDir(process.env, homeDir);
  return {
    dir,
    socket: ipcEndpoint(dir, TRUSTED_UA_BROKER.socketFile),
    state: path.join(dir, TRUSTED_UA_BROKER.stateFile),
  };
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

/** Reclaim only sockets whose broker and listener have both gone away. */
async function reclaimBrokerSocket(paths: ReturnType<typeof brokerPaths>): Promise<void> {
  if (existsSync(paths.socket)) {
    const state = readBrokerState(paths.state);
    if (state && isPidAlive(state.pid)) {
      throw new Error(`another broker is already running (pid ${state.pid})`);
    }
    // A listener can exist before its state file is published. Never unlink
    // a live socket during that startup window.
    const probe = new net.Socket();
    let listening = false;
    try {
      await connectWithTimeout(probe, paths.socket, 500);
      listening = true;
    } catch {
      // No listener remains at the stale socket.
    } finally {
      probe.destroy();
    }
    if (listening) throw new Error("another broker is starting");
    if (!isNamedPipe(paths.socket)) rmSync(paths.socket, { force: true });
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

  await reclaimBrokerSocket(paths);

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

  if (!isNamedPipe(paths.socket)) {
    try {
      chmodSync(paths.socket, 0o600);
    } catch {
      /* best-effort */
    }
  }
  const state: BrokerState = {
    pid: process.pid,
    token,
    socket: paths.socket,
    startedAt: Date.now(),
    version: TRUSTED_UA_BROKER.version,
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
        for (let frame = decoder.read(); frame !== null; frame = decoder.read()) {
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
          if (msg?.type === TRUSTED_UA_BROKER.handshake && typeof msg.token === "string" && msg.token === token) {
            socket.write(encodeFrame({ type: TRUSTED_UA_BROKER.handshakeAck, version: TRUSTED_UA_BROKER.version }));
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
      if (!isNamedPipe(paths.socket)) rmSync(paths.socket, { force: true });
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
  const paths = brokerPaths();
  const state = readBrokerState(paths.state);
  if (!state || !isPidAlive(state.pid)) return null;

  const socket = new net.Socket();
  socket.unref();
  try {
    await connectWithTimeout(socket, paths.socket, timeoutMs);
    socket.write(
      encodeFrame({ type: TRUSTED_UA_BROKER.handshake, token: state.token, version: TRUSTED_UA_BROKER.version }),
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

/**
 * Retry tryRelayAttach until it succeeds or `totalMs` elapses — for the
 * broker-election loser, whose winner may not have published its state
 * file yet (listen succeeds first, the state write follows).
 */
export async function waitForRelayAttach(log: Logger, totalMs: number, stepMs = 50): Promise<RelayAttachment | null> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const attachment = await tryRelayAttach(log, Math.min(1_000, Math.max(100, deadline - Date.now())));
    if (attachment || Date.now() >= deadline) return attachment;
    await new Promise((r) => setTimeout(r, stepMs));
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
      for (let frame = decoder.read(); frame !== null; frame = decoder.read()) {
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
        if (msg?.type !== TRUSTED_UA_BROKER.handshakeAck) {
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
