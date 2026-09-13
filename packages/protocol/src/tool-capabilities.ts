/**
 * Tool → capability mapping for cross-application routing
 * (THUNDERBIRD-PLAN.md §29).
 *
 * The broker routes a tool call to the connected client whose advertised
 * capabilities provide the tool. The rule must stay identical to the
 * host's tool-surface selection (CapabilityToolProvider.createTools), so
 * every tool a client could be shown is a tool it can be routed.
 */
import { isBrowserTool } from "./browser-tools.js";
import { isControlTool } from "./control-tools.js";
import { isMailTool } from "./mail-tools.js";
import { isComposeTool } from "./compose-tools.js";
import { isMailMutationTool } from "./mail-mutation-tools.js";
import { isContactsTool } from "./contacts-tools.js";
import type { AgentCapability } from "./integration.js";

/**
 * True when a client advertising `caps` serves `toolName`.
 * Mirrors the provider's capability → schema selection:
 *  - browser_* / pi_* (control)     → "browser"
 *  - mail mutations                 → "mailModify"
 *  - compose_*                      → "compose"
 *  - contacts_*                     → "contacts"
 *  - mail_* (incl. attachments)     → "mail" or "attachments"
 */
export function capabilitiesProvideTool(caps: readonly string[], toolName: string): boolean {
  const has = (c: AgentCapability): boolean => caps.includes(c);
  if (isBrowserTool(toolName) || isControlTool(toolName)) return has("browser");
  if (isMailMutationTool(toolName)) return has("mailModify");
  if (isComposeTool(toolName)) return has("compose");
  if (isContactsTool(toolName)) return has("contacts");
  if (isMailTool(toolName)) return has("mail") || has("attachments");
  return false;
}
