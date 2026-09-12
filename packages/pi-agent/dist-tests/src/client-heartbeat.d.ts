/**
 * Client names the add-ons send in ACP `initialize` (acp-client.ts).
 * The host records a heartbeat for any recognized client so the installer
 * can report per-app add-on presence (plan §23: both apps share the host).
 */
export declare const ADDON_CLIENT_NAMES: readonly string[];
/** Legacy single-client constant (kept for tests/references). */
export declare const ADDON_CLIENT_NAME = "pi-browser-firefox";
export declare function isKnownAddonClient(name: string | undefined): name is string;
/** A heartbeat younger than this counts as "add-on connected" (3x the 10s ping). */
export declare const ADDON_HEARTBEAT_FRESH_MS = 90000;
export interface ClientHeartbeat {
    ts: number;
    client: string;
    version?: string;
    pid: number;
}
/** Heartbeat file location (env override for tests; default under $HOME). */
export declare function heartbeatPathForHome(homeDir: string): string;
export declare function heartbeatPath(): string;
/**
 * Record add-on presence. No-op for non-add-on clients (e.g. test harnesses).
 * Best-effort: never throws.
 */
export declare function touchClientHeartbeat(clientName: string | undefined, clientVersion?: string): void;
/** Read the latest add-on heartbeat, or undefined when absent/unreadable. */
export declare function readClientHeartbeat(homeDir: string): (ClientHeartbeat & {
    ageMs: number;
}) | undefined;
//# sourceMappingURL=client-heartbeat.d.ts.map