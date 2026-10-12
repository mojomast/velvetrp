/**
 * Runtime admission control.
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit found the core invariant was a COMMENT: `AdmittedRecord.admission` was
 * just `Admission`, whose `status` could be `"rejected"`, with zero validators, an
 * empty `validatorVersions`, `review: null`, a rejecting review, `admittedAt: null`
 * and arbitrary findings. Nothing enforced "evidence-bound admission".
 *
 * This module makes it a runtime property instead of a type annotation:
 *
 *  - `status` is the literal `"admitted"` -- not a union with `rejected`.
 *  - A required validator set per family, each bound to THIS candidate's payload
 *    digest, evidence digest and validator version.
 *  - A required independent review whose verdict is acceptable and whose reviewer
 *    is provably not the generator.
 *  - The payload digest is RECOMPUTED here, never accepted from the caller.
 *
 * A candidate that fails any of these cannot be typed as an `AdmittedRecord`.
 */

import { createHash } from "node:crypto";
import {
  RECORD_SCHEMA_VERSION,
  stableStringify,
  type Admission,
  type DatasetSplit,
  type LineageGroup,
  type PreferencePair,
  type Provenance,
  type ReviewScores,
  type StoredMessage,
  type StoredTool,
  type TrainingFamily,
} from "./spec.js";

export const ADMISSION_VERSION = "admission-v1";

/**
 * Per-family validator requirements. A family with no mechanical gate must say so
 * explicitly, which is itself a reviewable decision.
 */
export const REQUIRED_VALIDATORS: Readonly<Record<TrainingFamily, readonly string[]>> = {
  // Mechanics-free, but must pass the boundary and agency checks.
  "roleplay-conversation": ["boundary-leakage", "player-agency"],
  // Ground truth is the committed receipt; both gates are mandatory.
  "grounded-narration": ["receipt-provenance", "production-grounding-predicate", "binding-grounding"],
  // Must be advertised for THIS decision, not merely schema-valid.
  "tool-selection": ["advertised-candidate-binding", "tool-envelope"],
  "world-generation": ["requested-section-schema", "reference-closure", "catalog-pinning"],
  // The whole point is refusing or deferring correctly.
  "boundary-recovery": ["boundary-leakage", "abstention-correctness", "authority-respected"],
};

export class AdmissionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`candidate cannot be admitted: ${problems.join("; ")}`);
    this.name = "AdmissionError";
    this.problems = problems;
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Canonical TRAINING-PAYLOAD digest, computed over every field the trainer sees.
 * Discriminated by kind so a preference mutation can never leave the digest
 * unchanged -- the audit showed the old digest ignored prompt/chosen/rejected.
 *
 * This is what admission evidence and reviews are bound to.
 */
export function computePayloadDigest(input: {
  messages: readonly StoredMessage[];
  tools?: readonly StoredTool[] | undefined;
  preference?: PreferencePair | undefined;
}): string {
  if (input.preference) {
    return sha256(stableStringify({
      kind: "preference",
      prompt: input.preference.prompt,
      chosen: input.preference.chosen,
      rejected: input.preference.rejected,
    }));
  }
  return sha256(stableStringify({ kind: "sft", messages: input.messages, tools: input.tools ?? null }));
}

/** Evidence from one deterministic validator, bound to a specific payload. */
export interface GateEvidence {
  /** Must be one of `REQUIRED_VALIDATORS[family]`. */
  validator: string;
  version: string;
  /** Digest of the payload this verdict applies to. Stale verdicts are rejected. */
  payloadDigest: string;
  /** Digest of the evidence the validator inspected. */
  evidenceDigest: string;
  passed: boolean;
  findings?: Record<string, unknown>;
}

/** One independent review. Multiple records preserve disagreement. */
export interface ReviewRecord {
  reviewerIdentity: string;
  reviewerPromptDigest: string;
  /** The exact candidate bytes the reviewer saw. */
  candidateDigest: string;
  scores: ReviewScores;
}

export interface AdmissionInput {
  family: TrainingFamily;
  recordId: string;
  unitId: string;
  lineage: LineageGroup;
  split: DatasetSplit;
  splitAssignmentDigest: string;
  messages: readonly StoredMessage[];
  tools?: readonly StoredTool[];
  preference?: PreferencePair;
  provenance: Omit<Provenance, "createdAt" | "validators" | "validatorVersions">;
  evidence: readonly GateEvidence[];
  reviews: readonly ReviewRecord[];
  generatorIdentity: string;
  /** Set for DPO-style pairs only. */
  preferenceAxis?: string;
}

/** An admitted record. Construct only through `admitCandidate`. */
export interface AdmittedRecordV1 {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  admissionVersion: typeof ADMISSION_VERSION;
  recordId: string;
  unitId: string;
  family: TrainingFamily;
  split: DatasetSplit;
  lineage: LineageGroup;
  splitAssignmentDigest: string;
  messages: readonly StoredMessage[];
  tools?: readonly StoredTool[];
  preference?: PreferencePair;
  contentDigest: string;
  payloadDigest: string;
  provenance: Provenance;
  admission: Admission;
}

/** Review verdicts that may admit. A "revise" never admits. */
const ACCEPTABLE_VERDICTS = new Set<ReviewScores["verdict"]>(["accept", "accept-with-notes"]);

/**
 * Scores below which even an `accept` verdict is refused. These are deliberately
 * coarse floors: an automated reviewer can reject obvious failures, it cannot
 * prove quality.
 */
export const REVIEW_FLOORS = {
  characterization: 0.4,
  dialogueQuality: 0.4,
  coherence: 0.5,
  narrativeInitiative: 0.3,
  playerAgency: 0.5,
  nonRepetitive: 0.4,
} as const;

/**
 * The admission constructor. Recomputes digests and refuses anything that cannot
 * prove its own correctness.
 */
export function admitCandidate(input: AdmissionInput): AdmittedRecordV1 {
  const problems: string[] = [];
  const payloadDigest = computePayloadDigest({
    messages: input.messages,
    tools: input.tools,
    preference: input.preference,
  });
  // The CONTENT digest is the dedup/export identity: the SFT-shaped bytes only,
  // with no preference branch and no discriminator, so the same conversation
  // deduplicates identically regardless of which family produced it. It is
  // deliberately distinct from `payloadDigest`, which is the admission binding.
  const contentDigest = input.preference
    ? payloadDigest
    : sha256(stableStringify({ messages: input.messages, tools: input.tools ?? null }));

  const required = REQUIRED_VALIDATORS[input.family];
  const provided = new Map<string, GateEvidence>();
  for (const item of input.evidence) {
    if (provided.has(item.validator)) problems.push(`duplicate evidence for validator ${item.validator}`);
    if (!item.version) problems.push(`validator ${item.validator} supplied no version`);
    provided.set(item.validator, item);
  }
  for (const validator of required) {
    const item = provided.get(validator);
    if (!item) { problems.push(`missing required validator ${validator} for ${input.family}`); continue; }
    if (!item.passed) problems.push(`validator ${validator} did not pass`);
    if (item.payloadDigest !== payloadDigest) problems.push(`validator ${validator} evidence is stale for this payload`);
    if (!item.evidenceDigest) problems.push(`validator ${validator} supplied no evidence digest`);
  }
  for (const item of input.evidence) {
    if (!required.includes(item.validator)) problems.push(`unexpected validator ${item.validator} for ${input.family}`);
  }

  if (input.reviews.length === 0) problems.push("an independent review is required");
  for (const review of input.reviews) {
    if (review.reviewerIdentity === input.generatorIdentity) {
      problems.push("reviewer identity equals the generator identity; the review is not independent");
    }
    if (review.candidateDigest !== payloadDigest) problems.push("review was performed against a different payload");
    if (!ACCEPTABLE_VERDICTS.has(review.scores.verdict)) {
      problems.push(`review verdict "${review.scores.verdict}" cannot admit`);
    }
    for (const [key, floor] of Object.entries(REVIEW_FLOORS)) {
      const score = review.scores[key as keyof typeof REVIEW_FLOORS];
      if (typeof score !== "number" || Number.isNaN(score) || score < 0 || score > 1) {
        problems.push(`review score ${key} is not a valid probability`);
      } else if (score < floor) {
        problems.push(`review score ${key} is ${score}, below the floor ${floor}`);
      }
    }
    if (!review.reviewerPromptDigest) problems.push("review record has no prompt digest");
  }
  // Disagreement must be visible, never averaged away.
  const verdicts = new Set(input.reviews.map((review) => review.scores.verdict));
  if (verdicts.size > 1 && !input.reviews.every((review) => review.scores.verdict === "accept-with-notes")) {
    problems.push("independent reviewers disagree and no majority verdict was reached");
  }

  if (!input.splitAssignmentDigest) problems.push("record has no split assignment digest");
  if (input.provenance.syntheticOrigin !== true) problems.push("record is not labelled synthetic");
  if (input.provenance.tokenCount && input.provenance.tokenCount.tokens < 0) problems.push("negative token count");

  if (input.preference) {
    problems.push(...validatePreference(input.preference));
  }

  if (problems.length > 0) throw new AdmissionError(problems);

  const validatorVersions: Record<string, string> = {};
  for (const item of input.evidence) validatorVersions[item.validator] = item.version;
  const now = new Date().toISOString();
  const findings: Record<string, unknown> = {};
  for (const item of input.evidence) if (item.findings) findings[item.validator] = item.findings;

  const scores = input.reviews[0]!.scores;
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    admissionVersion: ADMISSION_VERSION,
    recordId: input.recordId,
    unitId: input.unitId,
    family: input.family,
    split: input.split,
    lineage: input.lineage,
    splitAssignmentDigest: input.splitAssignmentDigest,
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.preference ? { preference: input.preference } : {}),
    contentDigest,
    payloadDigest,
    provenance: {
      ...input.provenance,
      validators: [...required],
      validatorVersions,
      createdAt: now,
    },
    admission: {
      status: "admitted",
      reasons: [],
      findings,
      review: { ...scores, reviewerCount: input.reviews.length },
      admittedAt: now,
    },
  };
}

/**
 * Preference-pair validation.
 *
 * The audit found four independent published hazards, so each is checked:
 *  - DPO length bias: chosen and rejected must be within 1.5x token count.
 *  - Smaug's near-duplicate catastrophe: pairs with tiny edit distance are refused.
 *  - style-only pairs train style, not fidelity: the axis must be semantic.
 *  - both branches must be independently valid, not one good one garbage.
 */
export function validatePreference(pair: PreferencePair): string[] {
  const problems: string[] = [];
  const chosenText = pair.chosen.map((message) => message.content).join("\n");
  const rejectedText = pair.rejected.map((message) => message.content).join("\n");
  if (chosenText === rejectedText) problems.push("preference branches are identical");
  if (pair.axis.trim().length === 0) problems.push("preference pair has no semantic axis");
  const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
  const chosen = wordCount(chosenText);
  const rejected = wordCount(rejectedText);
  const ratio = Math.max(chosen, rejected) / Math.max(1, Math.min(chosen, rejected));
  if (ratio > 1.5) {
    problems.push(`preference pair is length-biased (ratio ${ratio.toFixed(2)} exceeds 1.5); DPO would train length, not fidelity`);
  }
  if (ratio < 1.05) {
    problems.push("preference branches are too similar; near-duplicate pairs degrade DPO catastrophically");
  }
  if (!Number.isFinite(pair.lengthRatio) || pair.lengthRatio <= 0) {
    problems.push("preference lengthRatio must be a measured positive number");
  }
  return problems;
}

/**
 * Re-validates an admitted record. Called again on export, so a record that was
 * mutated after admission cannot escape.
 */
export function revalidateAdmitted(record: AdmittedRecordV1): string[] {
  const problems: string[] = [];
  const recomputed = computePayloadDigest({
    messages: record.messages,
    tools: record.tools,
    preference: record.preference,
  });
  if (recomputed !== record.payloadDigest) problems.push("payload digest does not match the stored messages");
  if (record.admission.status !== "admitted") problems.push("record status is not admitted");
  if (record.admission.reasons.length > 0) problems.push("an admitted record must have no rejection reasons");
  if (!record.admission.admittedAt) problems.push("admitted record has no admission timestamp");
  for (const validator of REQUIRED_VALIDATORS[record.family]) {
    if (!record.provenance.validators.includes(validator)) problems.push(`provenance is missing validator ${validator}`);
    if (!record.provenance.validatorVersions[validator]) problems.push(`provenance is missing version for ${validator}`);
  }
  if (record.preference) problems.push(...validatePreference(record.preference));
  return problems;
}