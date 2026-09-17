import { createHash } from "node:crypto";
import { canonicalAgentJson } from "@velvet/contracts";
import type { SystemOneDecisionRecord } from "../repo/systemOneDecisionRepo.js";
import type { GuardrailDisposition } from "./systemOneGuardrails.js";
import { directorSelectedCandidateIds, type DirectorDisagreementRow } from "./systemOneDisagreement.js";

/**
 * The harvest loop: turning reviewed shadow decisions into labelled corpus proposals.
 *
 * Shadow lanes accumulate live decisions; a human (or the deterministic provider-disagreement
 * comparison) marks some of them correct or incorrect, and this module converts those reviewed
 * decisions into lane-tagged proposals that can be merged into a lane's evaluation corpus. It is
 * pure and never reads or writes a database: the caller supplies the decision records, the human
 * annotations, and the Director authority comparison. Proposals carry provenance and a review
 * status so an unconfirmed correction can never be silently scored as a label.
 */

/** Where a proposal came from. */
export type HarvestProvenance = "review-annotated" | "provider-disagreement" | "agent-review";
/** Whether the proposal is already labelled, still needs a label, or was rejected on review. */
export type HarvestStatus = "confirmed" | "proposed" | "rejected";

/** One human verdict for one recorded decision. */
export interface HarvestAnnotation {
  verdict: "correct" | "incorrect";
  /**
   * The corrected expectation when the verdict is `incorrect`. Lane-specific:
   * `{ selections: string[] }` for the Director, `{ candidateId: string | null }` for adventure
   * selection, `{ disposition }` for guardrails. Absent means "incorrect but I do not know the
   * right answer yet", and the proposal stays `proposed`.
   */
  expected?: unknown;
  /** Who reviewed the decision; defaults to a human. Agent-reviewed labels are marked distinctly. */
  reviewer?: "human" | "agent";
  note?: string;
}

/** One reviewed live decision, projected into a lane corpus candidate. */
export interface HarvestProposal {
  proposalId: string;
  lane: string;
  sourceDecisionId: string;
  createdAt: string;
  provenance: HarvestProvenance;
  status: HarvestStatus;
  /** The state the lane reasoned over, exactly as recorded (candidate projections, declaration, message). */
  state: unknown;
  /** The lane-specific expected outcome, or null while the proposal is unlabelled. */
  expected: unknown | null;
  /** The reviewer's note when one was supplied (for example the evidence behind an agent review). */
  note?: string;
  /** Why this proposal exists and what still needs review. */
  reason: string;
}

const GUARDRAIL_DISPOSITIONS: readonly GuardrailDisposition[] = ["pass", "review", "block", "support"];

/**
 * Decodes a legacy record whose state was stored as a canonical JSON string (an early adventure
 * recorder did this) so harvesting works across record formats. Anything that does not parse to an
 * object or array is returned unchanged.
 */
function normalizeState(state: unknown): unknown {
  if (typeof state !== "string") return state;
  try {
    const parsed = JSON.parse(state) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed : state;
  } catch {
    return state;
  }
}

const digest = (value: unknown): string => createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? [...value] as string[] : null;
}

/**
 * The lane-specific expectation a correct decision records for itself. A malformed or foreign
 * selection shape is unusable (null) rather than read as a confirmed hold/defer: only a recorded
 * `selections` array or an explicit `defer`/`hold` method may produce an empty expectation.
 */
function recordedExpected(lane: string, record: SystemOneDecisionRecord): unknown | null {
  if (lane === "director-selection") {
    const selection = objectOf(record.selection);
    if (!selection || !Array.isArray(selection.selections)) return null;
    return { selections: directorSelectedCandidateIds(record.selection) };
  }
  if (lane === "adventure-selection") {
    const selection = objectOf(record.selection);
    if (!selection) return null;
    if (selection.selection === null) return { candidateId: null };
    const candidate = objectOf(selection.selection);
    return candidate && typeof candidate.candidateId === "string" ? { candidateId: candidate.candidateId } : null;
  }
  if (lane === "guardrails") {
    const disposition = objectOf(record.selection)?.disposition;
    return typeof disposition === "string" && GUARDRAIL_DISPOSITIONS.includes(disposition as GuardrailDisposition)
      ? { disposition }
      : null;
  }
  return null;
}

/** Validates a human-supplied correction for the lane. Invalid shapes degrade to "unlabelled". */
function annotatedExpected(lane: string, expected: unknown): unknown | null {
  if (expected === undefined || expected === null) return null;
  const value = objectOf(expected);
  if (!value) return null;
  if (lane === "director-selection") {
    const selections = stringArray(value.selections);
    return selections === null ? null : { selections };
  }
  if (lane === "adventure-selection") {
    if (value.candidateId === null) return { candidateId: null };
    return typeof value.candidateId === "string" ? { candidateId: value.candidateId } : null;
  }
  if (lane === "guardrails") {
    return typeof value.disposition === "string" && GUARDRAIL_DISPOSITIONS.includes(value.disposition as GuardrailDisposition)
      ? { disposition: value.disposition }
      : null;
  }
  return null;
}

function proposalId(lane: string, stateDigest: string, expected: unknown, provenance: HarvestProvenance): string {
  return digest({ lane, stateDigest, expected, provenance });
}

/**
 * Projects one recorded decision into a proposal. Returns null when there is nothing to learn:
 * the lane is unsupported, the decision is unannotated and agrees with its authority, or a
 * correction lacks a usable expectation and the caller wants confirmed cases only.
 */
export function harvestProposal(
  record: SystemOneDecisionRecord,
  annotation: HarvestAnnotation | undefined,
  authority?: Pick<DirectorDisagreementRow, "agreement" | "authoritativeCandidateIds">,
): HarvestProposal | null {
  const lane = record.lane;
  if (lane !== "director-selection" && lane !== "adventure-selection" && lane !== "guardrails") return null;
  const disagreements = authority !== undefined && authority.agreement === "disagree";
  if (!annotation && !disagreements) return null;

  if (annotation?.verdict === "correct" || annotation?.verdict === "incorrect") {
    const agentReviewed = annotation.reviewer === "agent";
    const provenance: HarvestProvenance = agentReviewed ? "agent-review" : "review-annotated";
    const reviewer = agentReviewed ? "agent review" : "human review";
    const note = annotation.note === undefined ? {} : { note: annotation.note };
    if (annotation.verdict === "correct") {
      const expected = recordedExpected(lane, record);
      if (expected === null) return null;
      return {
        proposalId: proposalId(lane, record.stateDigest, expected, provenance),
        lane,
        sourceDecisionId: record.decisionId,
        createdAt: record.createdAt,
        provenance,
        status: "confirmed",
        state: normalizeState(record.state),
        expected,
        ...note,
        reason: `${reviewer} confirmed the recorded ${lane} decision`,
      };
    }
    const expected = annotatedExpected(lane, annotation.expected);
    return {
      proposalId: proposalId(lane, record.stateDigest, expected, provenance),
      lane,
      sourceDecisionId: record.decisionId,
      createdAt: record.createdAt,
      provenance,
      status: expected === null ? "proposed" : "confirmed",
      state: normalizeState(record.state),
      expected,
      ...note,
      reason: expected === null
        ? `${reviewer} rejected the recorded ${lane} decision; the corrected answer is still needed`
        : `${reviewer} rejected the recorded ${lane} decision and supplied the corrected answer`,
    };
  }

  // No annotation: only a Director disagreement with its authoritative composition is actionable.
  if (lane !== "director-selection" || authority === undefined) return null;
  const expected = authority.authoritativeCandidateIds === null ? null : { selections: authority.authoritativeCandidateIds };
  return {
    proposalId: proposalId(lane, record.stateDigest, expected, "provider-disagreement"),
    lane,
    sourceDecisionId: record.decisionId,
    createdAt: record.createdAt,
    provenance: "provider-disagreement",
    status: "proposed",
    state: normalizeState(record.state),
    expected,
    reason: expected === null
      ? "the Director diverged from a held authoritative composition; review is needed"
      : "the Director diverged from the authoritative composition; the provider selection is the proposed label",
  };
}

export interface HarvestInput {
  records: readonly SystemOneDecisionRecord[];
  /** Human verdicts keyed by decision id. */
  annotations?: Readonly<Record<string, HarvestAnnotation>>;
  /** Director authority rows keyed by decision id, when the disagreement report was read. */
  authority?: Readonly<Record<string, Pick<DirectorDisagreementRow, "agreement" | "authoritativeCandidateIds">>>;
}

/**
 * Builds one proposal per reviewable decision, then deduplicates by lane, state, and expected
 * outcome. A confirmed proposal wins over a proposed one for the same state; otherwise the
 * earliest decision wins, so harvesting the same state again is idempotent.
 */
export function buildHarvestProposals(input: HarvestInput): HarvestProposal[] {
  const proposals: HarvestProposal[] = [];
  for (const record of input.records) {
    const proposal = harvestProposal(record, input.annotations?.[record.decisionId], input.authority?.[record.decisionId]);
    if (proposal) proposals.push(proposal);
  }
  const byId = new Map<string, HarvestProposal>();
  for (const proposal of proposals) {
    const existing = byId.get(proposal.proposalId);
    if (!existing) {
      byId.set(proposal.proposalId, proposal);
      continue;
    }
    const rank = (entry: HarvestProposal): number => (entry.status === "confirmed" ? 0 : 1);
    if (rank(proposal) < rank(existing) || (rank(proposal) === rank(existing) && proposal.createdAt < existing.createdAt)) {
      byId.set(proposal.proposalId, proposal);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.lane.localeCompare(right.lane) || left.createdAt.localeCompare(right.createdAt) || left.proposalId.localeCompare(right.proposalId));
}

export interface HarvestSummary {
  total: number;
  confirmed: number;
  proposed: number;
  byLane: Array<{ lane: string; confirmed: number; proposed: number }>;
  byProvenance: Array<{ provenance: HarvestProvenance; count: number }>;
}

export function summarizeHarvest(proposals: readonly HarvestProposal[]): HarvestSummary {
  const lanes = new Map<string, { confirmed: number; proposed: number }>();
  const provenances = new Map<HarvestProvenance, number>();
  let confirmed = 0;
  for (const proposal of proposals) {
    const entry = lanes.get(proposal.lane) ?? { confirmed: 0, proposed: 0 };
    if (proposal.status === "confirmed") {
      entry.confirmed += 1;
      confirmed += 1;
    } else if (proposal.status === "proposed") {
      entry.proposed += 1;
    }
    lanes.set(proposal.lane, entry);
    provenances.set(proposal.provenance, (provenances.get(proposal.provenance) ?? 0) + 1);
  }
  return {
    total: proposals.length,
    confirmed,
    proposed: proposals.length - confirmed,
    byLane: [...lanes.entries()].map(([lane, counts]) => ({ lane, ...counts })).sort((left, right) => left.lane.localeCompare(right.lane)),
    byProvenance: [...provenances.entries()].map(([provenance, count]) => ({ provenance, count }))
      .sort((left, right) => left.provenance.localeCompare(right.provenance)),
  };
}

/**
 * The confirmed proposals for one lane, in stable order: the cases an eval may score as harvested
 * corpus entries. Proposed cases stay out until a human labels them.
 */
export function confirmedHarvestProposals(proposals: readonly HarvestProposal[], lane: string): HarvestProposal[] {
  return proposals.filter((proposal) => proposal.lane === lane && proposal.status === "confirmed");
}
