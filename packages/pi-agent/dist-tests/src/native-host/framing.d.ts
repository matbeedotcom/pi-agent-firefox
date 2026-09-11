/**
 * Firefox Native Messaging framing (PRODUCT.md §16).
 *
 * Frame: [4-byte little-endian payload length][UTF-8 JSON payload].
 * The reader must tolerate partial reads and multiple frames per chunk:
 * never assume "one data event == one message".
 */
export declare const FIREFOX_MAX_FRAME_BYTES: number;
export declare class FramingError extends Error {
    readonly reason: "frame-too-large" | "malformed-length";
    constructor(reason: "frame-too-large" | "malformed-length", message?: string);
}
/**
 * Incremental frame decoder. Feed raw chunks; pull out complete frames.
 */
export declare class FrameDecoder {
    private buf;
    get bufferedBytes(): number;
    /** Feed a raw chunk from stdin. */
    push(chunk: Buffer): void;
    /**
     * Try to read the next complete frame. Returns the payload, or null when
     * more bytes are needed. Throws FramingError on protocol violations.
     */
    read(): Buffer | null;
    /** Read as many complete frames as are currently buffered. */
    readAll(): Buffer[];
}
/** Encode a message as a single Firefox frame. */
export declare function encodeFrame(message: unknown): Buffer;
//# sourceMappingURL=framing.d.ts.map