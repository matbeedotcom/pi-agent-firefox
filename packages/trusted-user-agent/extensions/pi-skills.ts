/**
 * Pi extension: skills runtime (skills-runtime-design.md §10).
 *
 * Loaded explicitly via an agent's `extensions:` list in the host broker:
 *
 *   extensions: ["<repo>/packages/trusted-user-agent/extensions/pi-skills.ts"]
 *
 * The factory registers nothing in a plain pi session (no host bridge) and
 * is never loaded into isolated job sessions (noExtensions). All behavior
 * lives in src/skills/extension.ts so it is testable from the test build.
 */
import { createSkillsExtensionFactory } from "../dist/skills/extension.js";

export default createSkillsExtensionFactory();
