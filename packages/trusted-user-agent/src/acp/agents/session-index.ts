/**
 * Index of sidebar sessions that run on external ACP agents (openspec
 * sidebar-acp-agents D5): `<data root>/agent-sessions.json`.
 *
 * The agents' own `session/list` returns every session the user has with
 * that agent (terminal sessions included), so the host keeps its own list of
 * the sessions started from Firefox or Thunderbird. Entries are written on
 * create and after each completed turn; `session/list` merges them with pi's
 * sessions, and load/resume look the id up to pick the agent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile, readableDataFile } from "../../paths.js";


export interface AgentSessionEntry {
  sessionId: string;
  agent: string;
  cwd: string;
  title?: string;
  /** ISO 8601. */
  updatedAt: string;
}

/** Most entries kept (oldest dropped first). */
const MAX_ENTRIES = 500;

export function agentSessionsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return dataFile("agent-sessions.json", "AGENT_SESSIONS_FILE", env);
}

export class AgentSessionIndex {
  private entries: Map<string, AgentSessionEntry> | undefined;

  /** Read from here first time (the v0.4.0 file in ~/.pi/browser when the new one doesn't exist). */
  private readonly readFrom: string;

  constructor(private readonly file: string = agentSessionsFilePath(), readFrom?: string) {
    this.readFrom = readFrom ?? (file === agentSessionsFilePath() ? readableDataFile("agent-sessions.json", "AGENT_SESSIONS_FILE") : file);
  }

  private load(): Map<string, AgentSessionEntry> {
    if (this.entries) return this.entries;
    const map = new Map<string, AgentSessionEntry>();
    if (existsSync(this.readFrom)) {
      try {
        const parsed = JSON.parse(readFileSync(this.readFrom, "utf8")) as { sessions?: unknown };
        for (const e of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
          const r = e as Partial<AgentSessionEntry>;
          if (typeof r.sessionId === "string" && typeof r.agent === "string" && typeof r.cwd === "string") {
            map.set(r.sessionId, {
              sessionId: r.sessionId,
              agent: r.agent,
              cwd: r.cwd,
              updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
              ...(typeof r.title === "string" && r.title ? { title: r.title } : {}),
            });
          }
        }
      } catch {
        // Unreadable: start empty; the next write replaces it.
      }
    }
    this.entries = map;
    return map;
  }

  private save(): void {
    const map = this.load();
    const sessions = [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ENTRIES);
    if (sessions.length < map.size) {
      this.entries = new Map(sessions.map((s) => [s.sessionId, s]));
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Best effort: the session still works, it just won't be listed later.
    }
  }

  get(sessionId: string): AgentSessionEntry | undefined {
    return this.load().get(sessionId);
  }

  list(cwd?: string): AgentSessionEntry[] {
    const all = [...this.load().values()];
    return (cwd ? all.filter((e) => e.cwd === cwd) : all).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Insert or update an entry; fields left undefined keep their value. */
  upsert(entry: { sessionId: string; agent: string; cwd: string; title?: string; updatedAt?: string }): void {
    const map = this.load();
    const prev = map.get(entry.sessionId);
    const title = entry.title ?? prev?.title;
    map.set(entry.sessionId, {
      sessionId: entry.sessionId,
      agent: entry.agent,
      cwd: entry.cwd,
      updatedAt: entry.updatedAt ?? new Date().toISOString(),
      ...(title ? { title } : {}),
    });
    this.save();
  }

  /** Set the title only when the entry has none yet (first prompt). */
  setTitleIfMissing(sessionId: string, title: string): void {
    const e = this.load().get(sessionId);
    if (!e || e.title) return;
    e.title = title;
    this.save();
  }

  remove(sessionId: string): void {
    if (this.load().delete(sessionId)) this.save();
  }
}
