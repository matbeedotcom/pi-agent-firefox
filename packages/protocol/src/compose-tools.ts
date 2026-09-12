/**
 * Draft-first Thunderbird compose tool definitions (THUNDERBIRD-PLAN §15–17, T3).
 *
 * These tools let the agent OPEN a populated compose window and READ/EDIT its
 * fields, so the user can review it and press Send. They are deliberately
 * NON-sending: there is no send/save-draft tool here — the user is the one who
 * sends. The schemas are transport-neutral (same as the mail tools): the
 * Thunderbird side implements them (compose-dispatcher) and the Pi side
 * registers them as agent tools, gated on the "compose" capability.
 *
 * Safety model (plan §15, §21):
 *  - `compose_prepare_*` open a compose window pre-filled; the user reviews it.
 *  - `compose_get`/`compose_update` read/edit an already-open window.
 *  - No `sendMessage` / `saveMessage` is exposed, so nothing can be sent by the
 *    agent. Recipients are mailbox strings; the body is HTML.
 */

export interface ComposeToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** compose_get is read-only; the prepare/update tools mutate the compose window. */
  readOnly: boolean;
}

const OBJECT_SCHEMA_BASE = {
  type: "object" as const,
  additionalProperties: false,
};

const composeTabId = {
  type: "number" as const,
  description:
    "Compose window tab id, returned by the compose_prepare_* tools; identifies the window to read or update.",
};
const messageIdProp = {
  type: "number" as const,
  description:
    "Thunderbird numeric message id of the message to reply/forward (from the current context or a search result). Transient: valid only within the current session.",
};
const toProp = {
  type: "string" as const,
  description:
    'Recipients in mailbox format ("Name <a@example.com>" or just "a@example.com"); separate several with commas.',
};
const ccProp = { type: "string" as const, description: 'CC recipients in mailbox format ("Name <a@example.com>"), comma-separated.' };
const bccProp = { type: "string" as const, description: 'BCC recipients in mailbox format ("Name <a@example.com>"), comma-separated.' };
const subjectProp = { type: "string" as const, description: "The message subject line." };
const bodyProp = { type: "string" as const, description: "The message body (HTML)." };
const contentTypeUnion = {
  anyOf: [
    { type: "string", const: "text/html" },
    { type: "string", const: "text/plain" },
  ],
  description: "Body MIME type (default text/html).",
};
const replyTypeUnion = {
  anyOf: [
    { type: "string", const: "replyToSender" },
    { type: "string", const: "replyToList" },
    { type: "string", const: "replyToAll" },
  ],
  description: "Who the reply is addressed to (default replyToSender).",
};
const forwardTypeUnion = {
  anyOf: [
    { type: "string", const: "forwardInline" },
    { type: "string", const: "forwardAsAttachment" },
  ],
  description: "How the message is forwarded (default forwardInline).",
};

export const COMPOSE_TOOLS: readonly ComposeToolDef[] = [
  {
    name: "compose_prepare_new",
    description:
      "Open a NEW message compose window pre-filled with the given recipients, subject, and body. The window opens for the user to review and send; this tool does not send.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        to: toProp,
        cc: ccProp,
        bcc: bccProp,
        subject: subjectProp,
        body: bodyProp,
        contentType: contentTypeUnion,
      },
    },
    readOnly: false,
  },
  {
    name: "compose_prepare_reply",
    description:
      "Open a REPLY compose window for a message, pre-filled with the reply. The recipient is derived from the message; the window opens for the user to review and send. This tool does not send.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        messageId: messageIdProp,
        replyType: replyTypeUnion,
        cc: ccProp,
        bcc: bccProp,
        subject: subjectProp,
        body: bodyProp,
      },
      required: ["messageId"],
    },
    readOnly: false,
  },
  {
    name: "compose_prepare_forward",
    description:
      "Open a FORWARD compose window for a message, pre-filled with the forwarding. The window opens for the user to review and send. This tool does not send.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        messageId: messageIdProp,
        forwardType: forwardTypeUnion,
        to: toProp,
        cc: ccProp,
        bcc: bccProp,
        subject: subjectProp,
        body: bodyProp,
      },
      required: ["messageId"],
    },
    readOnly: false,
  },
  {
    name: "compose_get",
    description:
      "Read the current fields (recipients, subject, body) of a compose window opened by the compose_prepare_* tools.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { tabId: composeTabId },
      required: ["tabId"],
    },
    readOnly: true,
  },
  {
    name: "compose_update",
    description:
      "Update the fields of an open compose window (recipients, subject, body). The window stays open for the user to review and send; this tool does not send.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        tabId: composeTabId,
        to: toProp,
        cc: ccProp,
        bcc: bccProp,
        subject: subjectProp,
        body: bodyProp,
        contentType: contentTypeUnion,
      },
      required: ["tabId"],
    },
    readOnly: false,
  },
];

export function getComposeTool(name: string): ComposeToolDef | undefined {
  return COMPOSE_TOOLS.find((t) => t.name === name);
}

export function isComposeTool(name: string): boolean {
  return COMPOSE_TOOLS.some((t) => t.name === name);
}

export const COMPOSE_TOOL_NAMES: readonly string[] = COMPOSE_TOOLS.map((t) => t.name);

export const COMPOSE_TOOL_TIMEOUT_MS = 30_000;
