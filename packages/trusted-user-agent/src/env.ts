/**
 * Environment settings (openspec rename-trusted-user-agent D5).
 *
 * Every setting is read from its `TRUSTED_UA_<NAME>` variable, and from the
 * v0.4.0 name `PI_BROWSER_<NAME>` when the new one isn't set. Variables the
 * host sets for processes it starts are set under both names, so an older
 * bridge (or a test harness) still finds them.
 */

export const ENV_PREFIX = "TRUSTED_UA_";
export const LEGACY_ENV_PREFIX = "PI_BROWSER_";

/** `TRUSTED_UA_<name>`, else `PI_BROWSER_<name>`, else undefined. A set-but-empty new variable wins. */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fresh = env[ENV_PREFIX + name];
  if (fresh !== undefined) return fresh;
  return env[LEGACY_ENV_PREFIX + name];
}

/** Both variable names for one setting, e.g. for a child process's env. */
export function envBoth(name: string, value: string): Record<string, string> {
  return { [ENV_PREFIX + name]: value, [LEGACY_ENV_PREFIX + name]: value };
}

/** Set a setting under both names (in `process.env` by default). */
export function setEnvBoth(name: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  env[ENV_PREFIX + name] = value;
  env[LEGACY_ENV_PREFIX + name] = value;
}

/** pi's agent dir for the embedded pi agent: TRUSTED_UA_PI_AGENT_DIR, else the v0.4.0 PI_BROWSER_AGENT_DIR. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TRUSTED_UA_PI_AGENT_DIR || env.PI_BROWSER_AGENT_DIR || undefined;
}
