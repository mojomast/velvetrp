/**
 * Self-consistency measurement for System One lanes.
 *
 * TypeSafe's consistency cookbooks measure a lane by repeating the same state and comparing the
 * decisions it produces: raw agreement (the most common decision's share), per-question signal
 * standard deviation, and how often a decision abstains rather than acting. A lane whose composed
 * decision flips between repeats is dangerous to activate even when each individual decision looks
 * correct, because the same game state would receive different outcomes. This module is pure: the
 * eval scripts feed it one sample per repeat and it returns per-case and aggregate stability.
 *
 * The vendor's cookbooks also add a throwaway `uid` field to every repeat so the draws are
 * independent; `stabilityUid` builds that decorrelator deterministically for an eval run.
 */

/** One repeated evaluation of one case. */
export interface StabilitySample {
  caseId: string;
  /** The lane's composed decision for this repeat (candidate id, disposition, or "defer"). */
  decision: string;
  /** The confidence signal behind the decision, in [0, 1], when the lane measured one. */
  signal: number | null;
}

export interface CaseStability {
  caseId: string;
  repeats: number;
  /** Share of repeats that produced the most common decision, in [0, 1]. */
  agreement: number;
  /** Distinct decisions across the repeats, ordered by first appearance. */
  decisions: string[];
  /** True when the repeats produced more than one distinct decision. */
  conflicted: boolean;
  meanSignal: number | null;
  signalStdDev: number | null;
}

export interface StabilitySummary {
  cases: CaseStability[];
  repeats: number;
  /** Mean agreement across cases; 1 means every case repeated its decision. */
  meanAgreement: number;
  conflictCases: number;
  /** Share of cases whose repeats disagreed, in [0, 1]. */
  conflictRate: number;
  meanSignalStdDev: number | null;
  maxSignalStdDev: number | null;
}

function validSignal(signal: number | null): signal is number {
  return signal !== null && Number.isFinite(signal);
}

function stdDev(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Groups samples by case and reports agreement, conflicts, and signal variance per case, then
 * aggregates across cases. An empty input reports zero cases and a mean agreement of 0.
 */
export function summarizeStability(samples: readonly StabilitySample[]): StabilitySummary {
  const order: string[] = [];
  const byCase = new Map<string, StabilitySample[]>();
  for (const sample of samples) {
    let bucket = byCase.get(sample.caseId);
    if (!bucket) {
      bucket = [];
      byCase.set(sample.caseId, bucket);
      order.push(sample.caseId);
    }
    bucket.push(sample);
  }
  const cases = order.map((caseId): CaseStability => {
    const rows = byCase.get(caseId)!;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.decision, (counts.get(row.decision) ?? 0) + 1);
    const decisions = [...counts.keys()];
    const plurality = Math.max(...counts.values());
    const signals = rows.flatMap((row) => (validSignal(row.signal) ? [row.signal] : []));
    return {
      caseId,
      repeats: rows.length,
      agreement: rows.length === 0 ? 0 : plurality / rows.length,
      decisions,
      conflicted: decisions.length > 1,
      meanSignal: signals.length === 0 ? null : signals.reduce((sum, value) => sum + value, 0) / signals.length,
      signalStdDev: stdDev(signals),
    };
  });
  const allStds = cases.flatMap((entry) => (entry.signalStdDev === null ? [] : [entry.signalStdDev]));
  const repeats = cases.reduce((sum, entry) => sum + entry.repeats, 0);
  const conflicts = cases.filter((entry) => entry.conflicted).length;
  return {
    cases,
    repeats,
    meanAgreement: cases.length === 0 ? 0 : cases.reduce((sum, entry) => sum + entry.agreement, 0) / cases.length,
    conflictCases: conflicts,
    conflictRate: cases.length === 0 ? 0 : conflicts / cases.length,
    meanSignalStdDev: allStds.length === 0 ? null : allStds.reduce((sum, value) => sum + value, 0) / allStds.length,
    maxSignalStdDev: allStds.length === 0 ? null : Math.max(...allStds),
  };
}

/**
 * A deterministic, throwaway decorrelator for one eval repeat. The vendor cookbooks add a fresh
 * random `uid` to each repeated call so the draws are independent; an eval needs it stable across
 * runs, so this derives it from the lane, case, and repeat instead.
 */
export function stabilityUid(lane: string, caseId: string, repeat: number): string {
  return `${lane}:${caseId}:${Math.max(0, Math.trunc(repeat))}`;
}
