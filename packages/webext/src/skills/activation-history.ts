/**
 * Activation history for skills (skills-runtime-design.md §252 "Activity
 * records store reasons, timings, result categories, and references by
 * default, not raw drafts. Bound retention.").
 *
 * Pure in-memory ring buffer shared by the management view and the review
 * card. Retention is bounded; no timers, no storage — persistence belongs
 * to the settings/memory modules, not to history.
 */
export type ActivationOutcome =
  | "clear"
  | "suggest"
  | "abstain"
  | "unavailable"
  | "applied"
  | "bypassed";

export interface ActivationRecord {
  at: number;
  skillKey: string;
  skillRevision: string;
  eventId: string;
  outcome: ActivationOutcome;
  /** Review duration in ms (unavailable outcomes carry 0). */
  durationMs?: number;
  /** Bounded reason text (unavailable/bypassed). Never a raw draft. */
  note?: string;
}

export interface ActivationSummary {
  total: number;
  byOutcome: Record<ActivationOutcome, number>;
  bySkill: { skillKey: string; count: number; applied: number; bypassed: number }[];
}

const MAX_RECORDS = 512;
const NOTE_MAX = 512;

export class ActivationHistory {
  private records: ActivationRecord[] = [];

  record(entry: Omit<ActivationRecord, "at">, at: number): void {
    const record: ActivationRecord = {
      ...entry,
      at,
      ...(entry.note ? { note: entry.note.slice(0, NOTE_MAX) } : {}),
    };
    this.records.push(record);
    while (this.records.length > MAX_RECORDS) this.records.shift();
  }

  /** Newest first. */
  snapshot(limit = 100): ActivationRecord[] {
    return this.records.slice(-limit).reverse().map((r) => ({ ...r }));
  }

  summarize(): ActivationSummary {
    const summary: ActivationSummary = {
      total: this.records.length,
      byOutcome: { clear: 0, suggest: 0, abstain: 0, unavailable: 0, applied: 0, bypassed: 0 },
      bySkill: [],
    };
    const skills = new Map<string, { skillKey: string; count: number; applied: number; bypassed: number }>();
    for (const record of this.records) {
      summary.byOutcome[record.outcome] += 1;
      const skill = skills.get(record.skillKey) ?? { skillKey: record.skillKey, count: 0, applied: 0, bypassed: 0 };
      skill.count += 1;
      if (record.outcome === "applied") skill.applied += 1;
      if (record.outcome === "bypassed") skill.bypassed += 1;
      skills.set(record.skillKey, skill);
    }
    summary.bySkill = [...skills.values()].sort((a, b) => b.count - a.count);
    return summary;
  }

  clear(): void {
    this.records = [];
  }

  get size(): number {
    return this.records.length;
  }
}
