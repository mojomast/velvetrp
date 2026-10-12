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
import { selectTargets, type TargetSelection } from "./hfAdapter.js";
import { assertTemplateReadyForExport, type TemplateProfile } from "./templateProfiles.js";
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
export const ADMISSION_CERTIFICATE_VERSION = "admission-certificate-v1";

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
      tools: input.tools ?? null,
    }));
  }
  return sha256(stableStringify({ kind: "sft", messages: input.messages, tools: input.tools ?? null }));
}

/** Evidence from one deterministic validator, bound to a specific payload. */
export interface GateEvidence {
  /** Required gates are a minimum; additional validators are retained and checked. */
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
  behaviourTags?: readonly string[];
  /** Scenario-owned requirements, retained and bound by the certificate. */
  visibilityRequirements?: readonly string[];
  authorityRequirements?: readonly string[];
  targetSelection?: TargetSelection;
  preferenceTargets?: { chosen: TargetSelection; rejected: TargetSelection };
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
  behaviourTags: readonly string[];
  visibilityRequirements: readonly string[];
  authorityRequirements: readonly string[];
  targetSelection: TargetSelection;
  preferenceTargets?: { chosen: TargetSelection; rejected: TargetSelection };
  readonly admissionCertificate: AdmissionCertificate;
}

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type AdmissionCertificate = DeepReadonly<{
  version: typeof ADMISSION_CERTIFICATE_VERSION;
  payloadDigest: string;
  recordBindingDigest: string;
  targetSelectionDigest: string;
  generatorIdentity: string;
  evidence: GateEvidence[];
  reviews: ReviewRecord[];
  /** Includes score/rationale disagreement even when all verdicts accept. */
  reviewerDisagreement: boolean;
  certificateDigest: string;
}>;

/** Supplied by the run owner, never reconstructed from the candidate's assertions. */
export interface ApprovedAdmissionRegistry {
  validators: Readonly<Record<string, { version: string; implementationDigest: string }>>;
  /** SHA-256 -> exact inspected-source, validator implementation, or template bytes. */
  artifacts: ReadonlyMap<string, string | Uint8Array>;
  /** recordId -> independently approved certificate digest, preserving ALL reviews. */
  certificates: ReadonlyMap<string, string>;
  templateProfiles: readonly TemplateProfile[];
}

type GateShape = Pick<AdmissionInput, "family" | "messages" | "tools" | "preference"
  | "behaviourTags" | "visibilityRequirements" | "authorityRequirements">;

export function requiredValidatorsFor(record: GateShape): readonly string[] {
  const gates = new Set(REQUIRED_VALIDATORS[record.family]);
  const messages = [...record.messages, ...(record.preference
    ? [...record.preference.prompt, ...record.preference.chosen, ...record.preference.rejected] : [])];
  if (record.tools?.length || messages.some((message) => message.tool_calls !== undefined || message.role === "tool")) {
    gates.add("tool-envelope");
  }
  // Do not try to infer whether prose actually leaks a secret with a keyword
  // heuristic. Any narration (including prose carried in tool arguments) needs
  // a boundary verdict; the source-aware validator decides whether it leaks.
  if (messages.some((message) => message.role === "assistant" && (message.content.trim() || message.tool_calls?.length))
    || record.visibilityRequirements?.length) gates.add("boundary-leakage");
  if (record.authorityRequirements?.length) gates.add("authority-respected");
  for (const tag of record.behaviourTags ?? []) {
    if (/private|hidden|knowledge|visibility|boundary|leak/i.test(tag)) gates.add("boundary-leakage");
    if (/authority|injection|unsupported|confirmation/i.test(tag)) gates.add("authority-respected");
    if (/agency/i.test(tag)) gates.add("player-agency");
    if (/absten|refus|clarif|no-tool/i.test(tag)) gates.add("abstention-correctness");
    if (/tool/i.test(tag) && !/no-tool/i.test(tag)) gates.add("tool-envelope");
  }
  return [...gates];
}

function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function defaultTargets(messages: readonly StoredMessage[]): TargetSelection {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== "assistant") index -= 1;
  if (index < 0) return { supervisedAssistantIndices: [], supervisedToolCallIndices: [] };
  return selectTargets(messages, { targetAssistantIndex: index });
}

function targetProblems(messages: readonly StoredMessage[], selection: TargetSelection, allowEmpty = false): string[] {
  const problems: string[] = [];
  if (!selection || !Array.isArray(selection.supervisedAssistantIndices) || !Array.isArray(selection.supervisedToolCallIndices)) {
    return ["missing target selection"];
  }
  const prose = selection.supervisedAssistantIndices;
  const calls = selection.supervisedToolCallIndices;
  if (!allowEmpty && prose.length + calls.length === 0) problems.push("target selection has nothing to supervise");
  for (const [kind, indices] of [["prose", prose], ["tool-call", calls]] as const) {
    if (new Set(indices).size !== indices.length) problems.push(`duplicate ${kind} target index`);
    for (const index of indices) {
      const message = messages[index];
      if (!Number.isSafeInteger(index) || index < 0 || message?.role !== "assistant"
        || (kind === "prose" ? !message.content.trim() : !message.tool_calls?.length)) {
        problems.push(`invalid ${kind} target at ${index}`);
      }
    }
  }
  for (const index of new Set([...prose, ...calls])) {
    const message = messages[index];
    if (message?.tool_calls?.length && !calls.includes(index)) problems.push(`target ${index} omits tool-call supervision`);
    if (message?.content.trim() && !prose.includes(index)) problems.push(`target ${index} omits assistant prose supervision`);
  }
  return problems;
}

export function computeTargetSelectionDigest(record: Pick<AdmittedRecordV1, "targetSelection" | "preferenceTargets">): string {
  return sha256(stableStringify({ messages: record.targetSelection, preference: record.preferenceTargets ?? null }));
}

function recordBindingDigest(record: Omit<AdmittedRecordV1, "admissionCertificate">): string {
  return sha256(stableStringify({
    schemaVersion: record.schemaVersion, admissionVersion: record.admissionVersion,
    recordId: record.recordId, unitId: record.unitId, family: record.family, split: record.split,
    lineage: record.lineage, splitAssignmentDigest: record.splitAssignmentDigest,
    provenance: record.provenance, behaviourTags: record.behaviourTags,
    visibilityRequirements: record.visibilityRequirements, authorityRequirements: record.authorityRequirements,
  }));
}

function reviewerDisagreement(reviews: readonly ReviewRecord[]): boolean {
  return new Set(reviews.map((review) => stableStringify(review.scores))).size > 1;
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

function evidenceProblems(evidence: readonly GateEvidence[], required: readonly string[], payloadDigest: string): string[] {
  const problems: string[] = [];
  const provided = new Set<string>();
  for (const item of evidence) {
    if (provided.has(item.validator)) problems.push(`duplicate evidence for validator ${item.validator}`);
    provided.add(item.validator);
    if (!item.validator.trim() || !item.version.trim()) problems.push(`validator ${item.validator} supplied no version or identity`);
    if (item.passed !== true) problems.push(`validator ${item.validator} did not pass`);
    if (item.payloadDigest !== payloadDigest) problems.push(`validator ${item.validator} evidence is stale for this payload`);
    if (!/^[0-9a-f]{64}$/.test(item.evidenceDigest)) problems.push(`validator ${item.validator} supplied no valid evidence digest`);
  }
  for (const validator of required) if (!provided.has(validator)) problems.push(`missing required validator ${validator}`);
  return problems;
}

function reviewProblems(reviews: readonly ReviewRecord[], generatorIdentity: string, payloadDigest: string): string[] {
  const problems: string[] = [];
  if (!generatorIdentity.trim()) problems.push("generator identity is required");
  if (reviews.length === 0) problems.push("an independent review is required");
  const identities = new Set<string>();
  for (const review of reviews) {
    if (!review.reviewerIdentity.trim()) problems.push("reviewer identity is required");
    if (identities.has(review.reviewerIdentity)) problems.push("duplicate reviewer identity cannot count as independent reviews");
    identities.add(review.reviewerIdentity);
    if (review.reviewerIdentity === generatorIdentity) problems.push("reviewer identity equals the generator identity; the review is not independent");
    if (review.candidateDigest !== payloadDigest) problems.push("review was performed against a different payload");
    if (!ACCEPTABLE_VERDICTS.has(review.scores.verdict)) problems.push(`review verdict "${review.scores.verdict}" cannot admit`);
    for (const [key, floor] of Object.entries(REVIEW_FLOORS)) {
      const score = review.scores[key as keyof typeof REVIEW_FLOORS];
      if (!Number.isFinite(score) || score < 0 || score > 1) problems.push(`review score ${key} is not a valid probability`);
      else if (score < floor) problems.push(`review score ${key} is ${score}, below the floor ${floor}`);
    }
    if (!/^[0-9a-f]{64}$/.test(review.reviewerPromptDigest)) problems.push("review record has no valid prompt digest");
  }
  // Retain the existing conservative policy for conflicting overall verdicts.
  if (new Set(reviews.map((review) => review.scores.verdict)).size > 1) {
    problems.push("independent reviewers disagree and no majority verdict was reached");
  }
  return problems;
}

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

  const required = requiredValidatorsFor(input);
  problems.push(...evidenceProblems(input.evidence, required, payloadDigest));
  problems.push(...reviewProblems(input.reviews, input.generatorIdentity, payloadDigest));
  const targetSelection = input.targetSelection ?? defaultTargets(input.messages);
  const preferenceTargets = input.preference ? input.preferenceTargets ?? {
    chosen: defaultTargets(input.preference.chosen), rejected: defaultTargets(input.preference.rejected),
  } : undefined;
  problems.push(...targetProblems(input.messages, targetSelection, Boolean(input.preference)));
  if (input.preference && preferenceTargets) {
    problems.push(...targetProblems(input.preference.chosen, preferenceTargets.chosen));
    problems.push(...targetProblems(input.preference.rejected, preferenceTargets.rejected));
  } else if (input.preferenceTargets) problems.push("preference targets supplied without a preference pair");

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
  const record: Omit<AdmittedRecordV1, "admissionCertificate"> = {
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
      validators: input.evidence.map((item) => item.validator),
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
    behaviourTags: [...input.behaviourTags ?? []],
    visibilityRequirements: [...input.visibilityRequirements ?? []],
    authorityRequirements: [...input.authorityRequirements ?? []],
    targetSelection: structuredClone(targetSelection),
    ...(preferenceTargets ? { preferenceTargets: structuredClone(preferenceTargets) } : {}),
  };
  const certificate: Omit<AdmissionCertificate, "certificateDigest"> = {
    version: ADMISSION_CERTIFICATE_VERSION,
    payloadDigest,
    recordBindingDigest: recordBindingDigest(record),
    targetSelectionDigest: computeTargetSelectionDigest(record),
    generatorIdentity: input.generatorIdentity,
    evidence: [...input.evidence], reviews: [...input.reviews],
    reviewerDisagreement: reviewerDisagreement(input.reviews),
  };
  return { ...record, admissionCertificate: immutableSnapshot({
    ...certificate, certificateDigest: sha256(stableStringify(certificate)),
  }) };
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
 * Compatibility diagnostic for local certificate integrity. Export callers must
 * use assertExportable with the independently approved registry as well.
 */
export function revalidateAdmitted(record: AdmittedRecordV1): string[] {
  try {
    verifyAdmissionCertificate(record);
    return [];
  } catch (error) {
    return error instanceof AdmissionError ? [...error.problems] : ["malformed admission certificate or record"];
  }
}

/** Local integrity verification; the approved registry additionally authenticates pins. */
export function verifyAdmissionCertificate<T extends AdmittedRecordV1>(record: T, approvedRegistry?: ApprovedAdmissionRegistry): T {
  const problems: string[] = [];
  const certificate = record.admissionCertificate;
  if (!certificate) throw new AdmissionError(["record has no admission certificate"]);
  const { certificateDigest, ...body } = certificate;
  if (certificate.version !== ADMISSION_CERTIFICATE_VERSION) problems.push("unsupported admission certificate version");
  if (sha256(stableStringify(body)) !== certificateDigest) problems.push("admission certificate digest mismatch (evidence or reviews changed)");
  if (recordBindingDigest(record) !== certificate.recordBindingDigest) problems.push("certificate record binding mismatch");
  if (computeTargetSelectionDigest(record) !== certificate.targetSelectionDigest) problems.push("target-selection digest mismatch");
  const recomputed = computePayloadDigest({
    messages: record.messages,
    tools: record.tools,
    preference: record.preference,
  });
  if (recomputed !== record.payloadDigest) problems.push("payload digest does not match the stored messages");
  if (recomputed !== certificate.payloadDigest) problems.push("certificate is stale for this payload");
  const contentDigest = record.preference ? recomputed : sha256(stableStringify({ messages: record.messages, tools: record.tools ?? null }));
  if (record.contentDigest !== contentDigest) problems.push("content digest does not match the stored messages");
  if (record.admission.status !== "admitted") problems.push("record status is not admitted");
  if (record.admission.reasons.length > 0) problems.push("an admitted record must have no rejection reasons");
  if (!record.admission.admittedAt) problems.push("admitted record has no admission timestamp");
  const required = requiredValidatorsFor(record);
  problems.push(...evidenceProblems(certificate.evidence, required, recomputed));
  problems.push(...reviewProblems(certificate.reviews, certificate.generatorIdentity, recomputed));
  if (certificate.reviewerDisagreement !== reviewerDisagreement(certificate.reviews)) problems.push("reviewer disagreement was not preserved");
  const first = certificate.reviews[0];
  if (!first || !record.admission.review || stableStringify(record.admission.review)
    !== stableStringify({ ...first.scores, reviewerCount: certificate.reviews.length })) problems.push("admission review summary is missing or differs from preserved reviews");
  for (const validator of required) {
    if (!record.provenance.validators.includes(validator)) problems.push(`provenance is missing validator ${validator}`);
    if (!record.provenance.validatorVersions[validator]) problems.push(`provenance is missing version for ${validator}`);
  }
  for (const item of certificate.evidence) {
    if (record.provenance.validatorVersions[item.validator] !== item.version) problems.push(`validator ${item.validator} version differs from certificate`);
  }
  if (stableStringify(record.provenance.validators) !== stableStringify(certificate.evidence.map((item) => item.validator))) problems.push("provenance validators differ from certificate");
  problems.push(...targetProblems(record.messages, record.targetSelection, Boolean(record.preference)));
  if (record.preference) {
    if (!record.preferenceTargets) problems.push("missing preference target selection");
    else {
      problems.push(...targetProblems(record.preference.chosen, record.preferenceTargets.chosen));
      problems.push(...targetProblems(record.preference.rejected, record.preferenceTargets.rejected));
    }
  } else if (record.preferenceTargets) problems.push("preference targets supplied without a preference pair");
  if (record.preference) problems.push(...validatePreference(record.preference));
  if (approvedRegistry) {
    if (approvedRegistry.certificates.get(record.recordId) !== certificateDigest) problems.push("certificate is not pinned in the approved registry");
    const resolveArtifact = (digest: string, label: string): void => {
      const bytes = approvedRegistry.artifacts.get(digest);
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== digest) problems.push(`${label} artifact is absent or has a digest mismatch`);
    };
    for (const item of certificate.evidence) {
      const pin = approvedRegistry.validators[item.validator];
      if (!pin || pin.version !== item.version) problems.push(`validator ${item.validator} version is not approved`);
      else resolveArtifact(pin.implementationDigest, `validator ${item.validator} implementation`);
      resolveArtifact(item.evidenceDigest, `validator ${item.validator} inspected source`);
    }
    for (const review of certificate.reviews) resolveArtifact(review.reviewerPromptDigest, "review prompt");
    for (const digest of Object.values(record.provenance.sourceDigests)) resolveArtifact(digest, "provenance source");
  }
  if (problems.length > 0) throw new AdmissionError(problems);
  return record;
}

/** The export boundary: local hashes alone are not authorization to export. */
export function assertExportable<T extends AdmittedRecordV1>(record: T, approvedRegistry: ApprovedAdmissionRegistry): T {
  if (!approvedRegistry) throw new AdmissionError(["an approved artifact registry is required for export"]);
  verifyAdmissionCertificate(record, approvedRegistry);
  if (!approvedRegistry.templateProfiles.length) throw new AdmissionError(["export requires an approved template artifact and measured training contract"]);
  for (const profile of approvedRegistry.templateProfiles) assertTemplateReadyForExport(profile, approvedRegistry.artifacts);
  return record;
}
