/**
 * Firefox Native Messaging framing (PRODUCT.md §16).
 *
 * Frame: [4-byte little-endian payload length][UTF-8 JSON payload].
 * The reader must tolerate partial reads and multiple frames per chunk:
 * never assume "one data event == one message".
 */
export const FIREFOX_MAX_FRAME_BYTES = 100 * 1024 * 1024; // 100 MB (screenshots are large)
export class FramingError extends Error {
    reason;
    constructor(reason, message) {
        super(message ?? reason);
        this.reason = reason;
        this.name = "FramingError";
    }
}
/**
 * Incremental frame decoder. Feed raw chunks; pull out complete frames.
 */
export class FrameDecoder {
    buf = Buffer.alloc(0);
    get bufferedBytes() {
        return this.buf.length;
    }
    /** Feed a raw chunk from stdin. */
    push(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }
    /**
     * Try to read the next complete frame. Returns the payload, or null when
     * more bytes are needed. Throws FramingError on protocol violations.
     */
    read() {
        // Need at least the 4-byte length header.
        if (this.buf.length < 4)
            return null;
        const length = this.buf.readUInt32LE(0);
        if (length > FIREFOX_MAX_FRAME_BYTES) {
            throw new FramingError("frame-too-large", `frame length ${length} exceeds limit`);
        }
        if (this.buf.length < 4 + length)
            return null;
        const payload = this.buf.subarray(4, 4 + length);
        this.buf = this.buf.subarray(4 + length);
        return Buffer.from(payload);
    }
    /** Read as many complete frames as are currently buffered. */
    readAll() {
        const frames = [];
        for (;;) {
            const frame = this.read();
            if (frame === null)
                break;
            frames.push(frame);
        }
        return frames;
    }
}
/** Encode a message as a single Firefox frame. */
export function encodeFrame(message) {
    const payload = Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}
//# sourceMappingURL=framing.js.map