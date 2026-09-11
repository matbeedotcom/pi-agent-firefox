/**
 * ACP agent: implements the ACP agent-side methods over the transport
 * (PRODUCT.md §5, §17–24).
 *
 * ACP owns agent session semantics: one Native Messaging connection carries
 * one ACP connection with many independent sessions. The agent maps each
 * ACP session to one Pi backend session and streams `session/update`
 * notifications back to the client.
 */
import { type ContentBlock } from "@pi-browser/protocol";
import type { AcpTransport } from "../native-host/transport.js";
import type { Logger } from "../logger.js";
import type { PiBackend } from "./backend.js";
import type { BrowserToolProvider } from "../browser/provider.js";
import type { ImageAttachment } from "./backend.js";
export interface AcpAgentOptions {
    backend: PiBackend;
    provider: BrowserToolProvider;
    transport: AcpTransport;
    log: Logger;
    agentInfo: {
        name: string;
        version: string;
    };
}
export declare class AcpAgent {
    private readonly opts;
    private readonly sessions;
    /** Name of the connected client (set on initialize) — for the add-on heartbeat. */
    private clientIdentityName;
    constructor(opts: AcpAgentOptions);
    private transport;
    private handleRequest;
    private handleNotification;
    private respondFailure;
    private initialize;
    private sessionNew;
    private sessionResume;
    private sessionLoad;
    private sessionList;
    private sessionPrompt;
    private sessionCancel;
    private sessionClose;
    private sessionSetConfigOption;
    /**
     * Open a backend session and register all ACP-side state. Browser tools
     * are created with a lazily-bound session id because the backend assigns
     * the Pi session id at creation time.
     */
    private openBackendSession;
    private currentConfigOptions;
    private sendSessionUpdate;
    private mapEvent;
    private replayHistory;
    disposeSession(sessionId: string): void;
    /** Tear down every session (host shutdown). */
    shutdown(): void;
}
/** Split ACP prompt content blocks into text and image attachments. */
export declare function extractPromptContent(prompt: ContentBlock[]): {
    text: string;
    images: ImageAttachment[];
};
//# sourceMappingURL=agent.d.ts.map