import type { DirectorDecisionAuthority } from "../repo/systemOneDecisionRepo.js";

/**
 * Read-only comparison between the Director lane's would-be selections and the
 * authoritative provider composition committed for the same run.
 *
 * The Director is shadow-only: it records what it would have committed while the
 * provider selection remains authoritative. A divergence is not proof that the
 * Director was wrong, but it is the sharpest deterministic signal that a case is
 * worth human review — and, once labelled, a candidate negative example for the
 * Director corpus. This module is pure: it never reads or writes a database.
 */

export type DirectorAgreement = "agree" | "disagree" | "unknown";

/** One Director decision compared against the authoritative provider composition. */
export interface DirectorDisagreementRow {
  decisionId: string;
  createdAt: string;
  shadow: boolean;
  /** The Director's ordered would-be selection; empty when it held or deferred. */
  directorCandidateIds: string[];
  /** The authoritative provider composition, or null when it held or the run is missing. */
  authoritativeCandidateIds: string[] | null;
  agreement: DirectorAgreement;
  /** True when the Director would have committed at least one beat. */
  directorActed: boolean;
}

export interface DirectorDisagreementSummary {
  total: number;
  agree: number;
  disagree: number;
  unknown: number;
  /** Disagreements where the Director would have committed at least one beat. */
  actedDisagree: number;
  /** Decision ids that disagreed, in input order. */
  disagreementDecisionIds: string[];
}

const NONE = "—";

/** The Director's ordered would-be candidate ids from a recorded `selection.selections` array. */
export function directorSelectedCandidateIds(selection: unknown): string[] {
  if (selection === null || typeof selection !== "object") return [];
  const selections = (selection as { selections?: unknown }).selections;
  if (!Array.isArray(selections)) return [];
  return selections.flatMap((item) => item && typeof item === "object" && typeof (item as { candidateId?: unknown }).candidateId === "string"
    ? [(item as { candidateId: string }).candidateId]
    : []);
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Compares each Director decision with its authoritative composition. A missing run is
 * `unknown`; otherwise the verdict is `agree` when the ordered candidate ids match
 * (a held decision and a held provider both normalize to an empty list) and `disagree`
 * otherwise. Order is significant because Director beats execute in sequence.
 */
export function compareDirectorAuthority(rows: readonly DirectorDecisionAuthority[]): DirectorDisagreementRow[] {
  return rows.map(({ decision, authoritativeCandidateIds, authoritativeMissing }) => {
    const directorCandidateIds = directorSelectedCandidateIds(decision.selection);
    const agreement: DirectorAgreement = authoritativeMissing
      ? "unknown"
      : sameOrdered(directorCandidateIds, authoritativeCandidateIds ?? [])
        ? "agree"
        : "disagree";
    return {
      decisionId: decision.decisionId,
      createdAt: decision.createdAt,
      shadow: decision.shadow,
      directorCandidateIds,
      authoritativeCandidateIds,
      agreement,
      directorActed: directorCandidateIds.length > 0,
    };
  });
}

/** Counts the agreement verdicts, highlighting disagreements the Director would have acted on. */
export function summarizeDirectorDisagreement(
  rows: readonly DirectorDisagreementRow[],
): DirectorDisagreementSummary {
  const disagreements = rows.filter((row) => row.agreement === "disagree");
  return {
    total: rows.length,
    agree: rows.filter((row) => row.agreement === "agree").length,
    disagree: disagreements.length,
    unknown: rows.filter((row) => row.agreement === "unknown").length,
    actedDisagree: disagreements.filter((row) => row.directorActed).length,
    disagreementDecisionIds: disagreements.map((row) => row.decisionId),
  };
}

function formatIds(ids: readonly string[] | null): string {
  if (ids === null || ids.length === 0) return "held";
  return ids.join(", ");
}

/**
 * Renders a deterministic disagreement report. Agreements are omitted by default so the
 * output is a review queue; set `includeAgreements` to list every decision.
 */
export function renderDirectorDisagreementReport(
  rows: readonly DirectorDisagreementRow[],
  options: { generatedAt?: string; source?: string; includeAgreements?: boolean } = {},
): string {
  const summary = summarizeDirectorDisagreement(rows);
  const shown = options.includeAgreements === true ? rows : rows.filter((row) => row.agreement !== "agree");
  const lines: string[] = [];
  lines.push("# System One Director disagreement report");
  lines.push("");
  if (options.generatedAt) lines.push(`Generated ${options.generatedAt} by \`scripts/report-system-one-disagreements.ts\`.`);
  if (options.source) lines.push(`Source: ${options.source}.`);
  if (options.generatedAt || options.source) lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Director decisions: ${summary.total}`);
  lines.push(`- Agree: ${summary.agree}`);
  lines.push(`- Disagree: ${summary.disagree} (${summary.actedDisagree} where the Director would have acted)`);
  lines.push(`- Unknown (no authoritative run): ${summary.unknown}`);
  lines.push("");
  lines.push("## Review queue");
  lines.push("");
  if (shown.length === 0) {
    lines.push(rows.length === 0
      ? "No Director decisions were recorded."
      : "Every Director decision agreed with the authoritative composition.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Decision | Created | Agreement | Director | Authoritative | Shadow |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of shown) {
    lines.push(`| ${row.decisionId} | ${row.createdAt} | ${row.agreement}`
      + ` | ${formatIds(row.directorCandidateIds)} | ${formatIds(row.authoritativeCandidateIds)}`
      + ` | ${row.shadow ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push(`Disagreeing decisions: ${summary.disagreementDecisionIds.length > 0 ? summary.disagreementDecisionIds.join(", ") : NONE}`);
  lines.push("");
  return lines.join("\n");
}
