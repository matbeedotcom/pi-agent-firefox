/**
 * Relay mode (THUNDERBIRD-PLAN.md §26): a thin, byte-transparent pipe
 * between the app's Native Messaging stdin/stdout and the running broker's
 * socket. No protocol parsing happens here — the broker re-frames — so the
 * relay cannot alter or inspect application traffic.
 *
 * stdout invariant: in relay mode this pipe is the ONLY writer to
 * process.stdout; everything else logs to stderr.
 */
import { Readable, Writable } from "node:stream";
import { Duplex } from "node:stream";
import type { Logger } from "../logger.js";

/**
 * Pipe app stdin → channel and channel → app stdout with backpressure.
 * Resolves (and ends the links) when either side goes away: the app closed
 * its port, or the broker disconnected. The caller exits the process.
 */
export function runRelay(
  channel: Duplex,
  initial: Buffer,
  stdin: Readable,
  stdout: Writable,
  log: Logger,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      log.info(`relay: closing (${reason})`);
      try {
        channel.end();
      } catch {
        /* already closed */
      }
      try {
        stdout.end();
      } catch {
        /* already closed */
      }
      resolve();
    };

    // App → broker (stdin → channel).
    stdin.on("data", (chunk: Buffer) => {
      if (done || channel.destroyed || channel.writableEnded) return;
      if (!channel.write(chunk)) {
        // Backpressure: pause app input until the socket drains.
        stdin.pause();
        channel.once("drain", () => {
          if (!done) stdin.resume();
        });
      }
    });

    // Broker → app (channel → stdout). Only this pipe writes stdout.
    channel.on("data", (chunk: Buffer) => {
      if (done) return;
      if (chunk.length === 0) return;
      if (!stdout.write(chunk)) {
        channel.pause();
        stdout.once("drain", () => {
          if (!done) channel.resume();
        });
      }
    });

    if (initial.length > 0) {
      // Bytes that arrived with the handshake ack already belong to the
      // app stream and must precede any piped data.
      if (!stdout.write(initial)) {
        channel.pause();
        stdout.once("drain", () => {
          if (!done) channel.resume();
        });
      }
    }

    stdin.on("end", () => finish("app stdin closed"));
    stdin.on("close", () => finish("app stdin closed"));
    stdin.on("error", (err) => {
      log.error("relay: stdin error", err);
      finish("stdin error");
    });
    channel.on("end", () => finish("broker closed"));
    channel.on("close", () => finish("broker closed"));
    channel.on("error", (err) => {
      log.error("relay: broker socket error", err);
      finish("broker socket error");
    });
    stdout.on("error", (err) => {
      log.error("relay: stdout error", err);
      finish("stdout error");
    });
  });
}
