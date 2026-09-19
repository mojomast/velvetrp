#!/usr/bin/env node
/**
 * Human case review for the harvested System One adventure-selection corpus.
 *
 * The harvested fixture holds proposals whose `provenance` is `agent-review`: only a human may
 * promote one to `review-annotated`, the provenance the promotion gate scores. This tool makes
 * that review cheap in two modes:
 *
 *   --packet [--limit N] [--out <file.md>]
 *     Renders a markdown packet (declaration, advertised candidates, expected pick label, note,
 *     provenance) plus a sibling annotations JSON skeleton the reviewer fills in. Cases are
 *     ordered cheapest-first for a human:
 *       1. `receipt-backed-pick` — the review reason says the reviewer confirmed the recorded
 *          decision and the expected pick is a concrete advertised candidate: the committed
 *          execution (receipt) is the label, so the human only re-checks the binding.
 *       2. `corrected-pick` — the recorded decision was rejected and a concrete corrected
 *          candidate was supplied; the label is a proposed correction, not a committed run.
 *       3. `no-expected-pick` — `expected.candidateId` is null (a confirmed defer) or the
 *          expectation is unusable.
 *     Within a tier cases are ordered by `proposalId`.
 *
 *   --apply <annotations.json> [--write-fixture]
 *     Validates `{ [proposalId]: { verdict: "correct" | "incorrect" | "unsure", reviewer:
 *     "human", note? } }`, reports `incorrect`/`unsure` without promoting them, and promotes
 *     `correct` cases to `provenance: "review-annotated"` with the original note kept and the
 *     human note appended. Without `--write-fixture` it only prints the plan; with it, the
 *     fixture is rewritten in place with proposals sorted by `proposalId` so repeated runs are
 *     byte-identical (an already `review-annotated` case is never touched twice).
 *
 * The tier vocabulary was derived from the real fixture (2026-09-19): every proposal has
 * `status: "confirmed"` and `reason` is either "... confirmed the recorded adventure-selection
 * decision" (committed executions, some of them defers) or "... rejected the recorded
 * adventure-selection decision and supplied the corrected answer".
 *
 * Usage:
 *   npx tsx scripts/review-adventure-cases.ts --packet [--limit N] [--out <file.md>]
 *   npx tsx scripts/review-adventure-cases.ts --apply <annotations.json> [--write-fixture]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarvestProposal, HarvestProvenance } from "../server/src/agent/systemOneHarvest.js";

/** The only lane this tool reviews; the harvest fixture is lane-specific. */
export const REVIEW_LANE = "adventure-selection";
export const REVIEW_FIXTURE_DIRECTORY = path.join("server", "test", "fixtures", "system-one-harvested");
export const REVIEW_FIXTURE_FILENAME = `${REVIEW_LANE}.json`;
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Default locations for the packet and skeleton when the caller passes no `--out`. */
export const DEFAULT_PACKET_PATH = path.join(tmpdir(), "velvet-adventure-review-packet.md");
export const DEFAULT_ANNOTATIONS_PATH = path.join(tmpdir(), "velvet-adventure-review-annotations.json");

export const MAX_REVIEW_LIMIT = 1_000;

export const USAGE =
  "usage: review-adventure-cases.ts --packet [--limit N] [--out <file.md>]\n"
  + "       review-adventure-cases.ts --apply <annotations.json> [--write-fixture]\n"
  + "\n"
  + "--packet renders a markdown review packet plus a sibling annotations JSON skeleton\n"
  + `--apply validates human verdicts and promotes "correct" cases to provenance review-annotated\n`
  + `--limit caps the packet at N cases (default: all; max ${MAX_REVIEW_LIMIT})\n`
  + "--write-fixture rewrites server/test/fixtures/system-one-harvested"
  + `/${REVIEW_FIXTURE_FILENAME} in place (requires --apply)\n`;

/** Absolute path of the harvested adventure-selection fixture; absent until a harvest run writes one. */
export function reviewFixturePath(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, REVIEW_FIXTURE_DIRECTORY, REVIEW_FIXTURE_FILENAME);
}

/** The annotations skeleton that belongs to a packet written at `packetPath` (a sibling file). */
export function annotationsSkeletonPath(packetPath: string): string {
  return packetPath.endsWith(".md")
    ? `${packetPath.slice(0, -".md".length)}.annotations.json`
    : `${packetPath}.annotations.json`;
}

// ---------------------------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------------------------

export const REVIEW_MODES = ["packet", "apply"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export interface ReviewCaseOptions {
  /** `packet` renders a review sheet; `apply` consumes fill-in verdicts. Defaults to `packet`. */
  mode: ReviewMode;
  /** Caps the packet to N ordered cases; null means every case. */
  limit: number | null;
  /** Packet output path, resolved; null means the default temp path. */
  out: string | null;
  /** Annotations file for `--apply`, resolved; null in packet mode. */
  applyPath: string | null;
  writeFixture: boolean;
  /** Set only when `--help`/`-h` was requested; the pure parser never exits. */
  help?: boolean;
}

/** Stable codepoint comparison: locale-independent so serialized output is reproducible. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseReviewCaseArgs(argv: readonly string[]): ReviewCaseOptions {
  let packetRequested = false;
  let applyRequested = false;
  let limit: number | null = null;
  let out: string | null = null;
  let applyPath: string | null = null;
  let writeFixture = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--packet") {
      packetRequested = true;
    } else if (arg === "--apply" || arg.startsWith("--apply=")) {
      const value = arg === "--apply" ? argv[index += 1] : arg.slice("--apply=".length);
      if (!value || value.trim() === "") throw new Error("--apply requires an annotations path");
      applyPath = path.resolve(value);
      applyRequested = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[index += 1] : arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--limit requires a number, received ${raw ?? "nothing"}`);
      limit = Math.max(1, Math.min(MAX_REVIEW_LIMIT, Math.trunc(parsed)));
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (!value || value.trim() === "") throw new Error("--out requires a path");
      out = path.resolve(value);
    } else if (arg === "--write-fixture") {
      writeFixture = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (help) {
    return { mode: "packet", limit, out, applyPath, writeFixture, help: true };
  }
  if (packetRequested && applyRequested) throw new Error("--packet and --apply cannot be combined");
  const mode: ReviewMode = applyRequested ? "apply" : "packet";
  if (writeFixture && mode !== "apply") throw new Error("--write-fixture requires --apply <annotations.json>");
  if (mode === "apply" && limit !== null) throw new Error("--limit only applies to --packet");
  if (mode === "apply" && out !== null) throw new Error("--out only applies to --packet");
  return { mode, limit, out, applyPath, writeFixture };
}

// ---------------------------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------------------------

export interface ReviewFixtureDocument {
  version: 1;
  lane: string;
  generatedAt: string;
  proposals: HarvestProposal[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a decoded fixture. A review must never proceed over a document whose cases would be
 * silently dropped, so malformed shapes (wrong lane, wrong version, missing proposal ids) throw.
 */
export function parseReviewFixtureDocument(document: unknown): ReviewFixtureDocument {
  if (!isRecord(document)) throw new Error("review fixture must be a JSON object");
  if (document.version !== 1) throw new Error(`unsupported review fixture version: ${String(document.version)}`);
  if (document.lane !== REVIEW_LANE) {
    throw new Error(`review fixture lane is ${String(document.lane)}, expected ${REVIEW_LANE}`);
  }
  if (typeof document.generatedAt !== "string") throw new Error("review fixture generatedAt must be a string");
  if (!Array.isArray(document.proposals)) throw new Error("review fixture proposals must be an array");
  document.proposals.forEach((proposal, index) => {
    if (!isRecord(proposal)) throw new Error(`review fixture proposal ${index} must be an object`);
    if (typeof proposal.proposalId !== "string" || proposal.proposalId.trim() === "") {
      throw new Error(`review fixture proposal ${index} is missing a proposalId`);
    }
    if (proposal.lane !== REVIEW_LANE) {
      throw new Error(`review fixture proposal ${proposal.proposalId} lane is ${String(proposal.lane)}, expected ${REVIEW_LANE}`);
    }
  });
  return document as unknown as ReviewFixtureDocument;
}

/** Serializes a fixture deterministically: two-space indent plus a trailing newline. */
export function serializeReviewFixture(document: ReviewFixtureDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Ordering and case projection
// ---------------------------------------------------------------------------------------------

/** Review order, cheapest-for-a-human first. */
export const REVIEW_TIERS = ["receipt-backed-pick", "corrected-pick", "no-expected-pick"] as const;
export type ReviewTier = (typeof REVIEW_TIERS)[number];

const RECORDED_CONFIRMED = /confirmed the recorded/i;
const RECORDED_REJECTED = /rejected the recorded/i;

/**
 * True when the review reason says the reviewer confirmed the recorded decision, i.e. the lane's
 * committed execution (and its receipt) is the expected outcome. A rejected-then-corrected reason
 * is explicitly excluded even though it also mentions the recorded decision.
 */
export function reasonConfirmsRecordedDecision(reason: unknown): boolean {
  return typeof reason === "string"
    && RECORDED_CONFIRMED.test(reason)
    && !RECORDED_REJECTED.test(reason);
}

export type ExpectedPick =
  | { kind: "pick"; candidateId: string }
  | { kind: "defer" }
  | { kind: "missing" };

/** Decodes `expected.candidateId`: a pick, an explicit confirmed defer (null), or unusable. */
export function expectedPickOf(proposal: Pick<HarvestProposal, "expected">): ExpectedPick {
  const expected = proposal.expected;
  if (!isRecord(expected) || !("candidateId" in expected)) return { kind: "missing" };
  const candidateId = expected.candidateId;
  if (candidateId === null) return { kind: "defer" };
  return typeof candidateId === "string" && candidateId.trim() !== ""
    ? { kind: "pick", candidateId }
    : { kind: "missing" };
}

/** Classifies one proposal into the human-review order tier. */
export function reviewTier(proposal: HarvestProposal): ReviewTier {
  if (expectedPickOf(proposal).kind !== "pick") return "no-expected-pick";
  return proposal.status === "confirmed" && reasonConfirmsRecordedDecision(proposal.reason)
    ? "receipt-backed-pick"
    : "corrected-pick";
}

/** Tier order first, then stable `proposalId` order; `limit` slices the ordered result. */
export function orderCasesForReview(proposals: readonly HarvestProposal[], limit?: number): HarvestProposal[] {
  const rank = new Map<ReviewTier, number>(REVIEW_TIERS.map((tier, index) => [tier, index]));
  const ordered = [...proposals].sort((left, right) => {
    const byTier = (rank.get(reviewTier(left)) ?? 0) - (rank.get(reviewTier(right)) ?? 0);
    return byTier !== 0 ? byTier : compareStrings(left.proposalId, right.proposalId);
  });
  return limit === undefined ? ordered : ordered.slice(0, limit);
}

export interface ReviewCandidate {
  candidateId: string;
  digest: string | null;
  kind: string;
  label: string;
}

export interface AdventureReviewState {
  declaration: string;
  candidates: ReviewCandidate[];
}

/** Projects `state` defensively: unusable entries are skipped, missing strings become empty. */
export function adventureReviewState(state: unknown): AdventureReviewState {
  const value = isRecord(state) ? state : {};
  const declaration = typeof value.declaration === "string" ? value.declaration : "";
  const rawCandidates = Array.isArray(value.candidates) ? value.candidates : [];
  const candidates: ReviewCandidate[] = [];
  for (const raw of rawCandidates) {
    if (!isRecord(raw)) continue;
    if (typeof raw.candidateId !== "string" || typeof raw.kind !== "string" || typeof raw.label !== "string") continue;
    candidates.push({
      candidateId: raw.candidateId,
      digest: typeof raw.digest === "string" ? raw.digest : null,
      kind: raw.kind,
      label: raw.label,
    });
  }
  return { declaration, candidates };
}

// ---------------------------------------------------------------------------------------------
// Packet rendering
// ---------------------------------------------------------------------------------------------

export const DECLARATION_PREVIEW_LENGTH = 160;
export const CANDIDATE_LABEL_PREVIEW_LENGTH = 120;
export const NOTE_PREVIEW_LENGTH = 240;
export const PROPOSAL_ID_PREVIEW_LENGTH = 12;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapses whitespace and truncates to `maxLength` characters, ending in an ellipsis. */
export function trimText(text: string, maxLength: number): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function shortProposalId(proposalId: string, length: number = PROPOSAL_ID_PREVIEW_LENGTH): string {
  return proposalId.slice(0, length);
}

export function shortCandidateId(candidateId: string, length: number = PROPOSAL_ID_PREVIEW_LENGTH): string {
  return candidateId.slice(0, length);
}

export interface ReviewCaseSummary {
  total: number;
  byTier: Array<{ tier: ReviewTier; count: number }>;
  byProvenance: Array<{ provenance: string; count: number }>;
}

/** Counts cases per tier (tier order) and per provenance (alphabetical). */
export function summarizeReviewCases(proposals: readonly HarvestProposal[]): ReviewCaseSummary {
  const tierCounts = new Map<ReviewTier, number>(REVIEW_TIERS.map((tier) => [tier, 0]));
  const provenanceCounts = new Map<string, number>();
  for (const proposal of proposals) {
    const tier = reviewTier(proposal);
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    provenanceCounts.set(proposal.provenance, (provenanceCounts.get(proposal.provenance) ?? 0) + 1);
  }
  return {
    total: proposals.length,
    byTier: REVIEW_TIERS.map((tier) => ({ tier, count: tierCounts.get(tier) ?? 0 })),
    byProvenance: [...provenanceCounts.entries()]
      .map(([provenance, count]) => ({ provenance, count }))
      .sort((left, right) => compareStrings(left.provenance, right.provenance)),
  };
}

function formatCounts(entries: ReadonlyArray<{ label: string; count: number }>): string {
  return entries.map((entry) => `${entry.label} ${entry.count}`).join(", ");
}

function renderExpectedLine(proposal: HarvestProposal): string {
  const expected = expectedPickOf(proposal);
  if (expected.kind === "defer") return "defer (no candidate expected)";
  if (expected.kind === "missing") return "none recorded";
  const candidate = adventureReviewState(proposal.state).candidates
    .find((entry) => entry.candidateId === expected.candidateId);
  if (!candidate) return `candidate \`${expected.candidateId}\` is NOT among the advertised candidates`;
  return `\`${candidate.kind}\` — ${trimText(candidate.label, CANDIDATE_LABEL_PREVIEW_LENGTH)}`
    + ` (${shortCandidateId(candidate.candidateId)})`;
}

export interface ReviewPacketInput {
  fixture: ReviewFixtureDocument;
  /** The ordered (and possibly limited) cases to render. */
  cases: readonly HarvestProposal[];
  generatedAt: string;
  /** Fixture path shown in the header; optional so tests can render without one. */
  source?: string | null;
}

/**
 * Renders the deterministic markdown packet. The renderer is pure: callers pass generatedAt, so
 * the same inputs always produce the same text.
 */
export function renderReviewPacket(input: ReviewPacketInput): string {
  const summary = summarizeReviewCases(input.cases);
  const lines: string[] = [];
  lines.push("# Adventure selection review packet");
  lines.push("");
  lines.push(`Generated: ${input.generatedAt}`);
  if (input.source) lines.push(`Fixture: ${input.source}`);
  lines.push(`Cases: ${input.fixture.proposals.length} total, ${summary.total} shown`);
  lines.push(`Tiers: ${formatCounts(summary.byTier.map((entry) => ({ label: entry.tier, count: entry.count })))}`);
  lines.push(`Provenance: ${formatCounts(summary.byProvenance.map((entry) => ({ label: entry.provenance, count: entry.count })))}`);
  lines.push("");
  lines.push("> Review order: receipt-backed picks first (the recorded decision is the label),"
    + " then corrected picks, then cases with no expected pick. Within a tier, `proposalId` order.");
  lines.push("");

  input.cases.forEach((proposal, index) => {
    const tier = reviewTier(proposal);
    const state = adventureReviewState(proposal.state);
    lines.push(`## ${index + 1}. \`${shortProposalId(proposal.proposalId)}\``);
    lines.push("");
    lines.push(`- lane: \`${proposal.lane}\``);
    lines.push(`- tier: ${tier}`);
    lines.push(`- provenance: \`${proposal.provenance}\``);
    lines.push(`- declaration: ${state.declaration ? trimText(state.declaration, DECLARATION_PREVIEW_LENGTH) : "(none)"}`);
    lines.push(`- expected pick: ${renderExpectedLine(proposal)}`);
    lines.push(`- candidates (${state.candidates.length}):`);
    if (state.candidates.length === 0) {
      lines.push("    - (none advertised)");
    } else {
      for (const candidate of state.candidates) {
        lines.push(`    - \`${candidate.kind}\` — ${trimText(candidate.label, CANDIDATE_LABEL_PREVIEW_LENGTH)}`);
      }
    }
    lines.push(`- note: ${proposal.note ? trimText(proposal.note, NOTE_PREVIEW_LENGTH) : "(none)"}`);
    lines.push("");
  });

  lines.push("## Decision");
  lines.push("");
  lines.push("Answer by index with `confirm`, `reject`, or `unsure` (example: `1 confirm; 2 unsure; 3 reject`).");
  lines.push("");
  lines.push(input.cases.map((_, index) => `${index + 1}:__`).join(" "));
  lines.push("");
  return `${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------------------------
// Annotations skeleton and parsing (mode 2 input)
// ---------------------------------------------------------------------------------------------

export const REVIEW_VERDICTS = ["correct", "incorrect", "unsure"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_REVIEWER = "human";

export interface ReviewAnnotation {
  verdict: ReviewVerdict;
  note?: string;
}

export interface ReviewAnnotationSkeletonEntry {
  verdict: "";
  reviewer: typeof REVIEW_REVIEWER;
  note: "";
}

export type ReviewAnnotationsSkeleton = Record<string, ReviewAnnotationSkeletonEntry>;

/** Skeleton keyed by proposalId in packet order, ready for the reviewer to fill in verdicts. */
export function buildAnnotationsSkeleton(proposals: readonly HarvestProposal[]): ReviewAnnotationsSkeleton {
  const skeleton: ReviewAnnotationsSkeleton = {};
  for (const proposal of proposals) {
    skeleton[proposal.proposalId] = { verdict: "", reviewer: "human", note: "" };
  }
  return skeleton;
}

export function serializeAnnotationsSkeleton(skeleton: ReviewAnnotationsSkeleton): string {
  return `${JSON.stringify(skeleton, null, 2)}\n`;
}

export interface ParsedReviewAnnotations {
  /** Filled verdicts, keyed by proposalId, in `proposalId` order. */
  annotations: Record<string, ReviewAnnotation>;
  /** Entries left blank by the skeleton (`verdict: ""` or missing); ignored by apply. */
  unfilled: string[];
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly unknown[]).includes(value);
}

/**
 * Validates the annotations document. Blank skeleton entries are collected as `unfilled`; anything
 * filled must be a human verdict with an allowed judgement, otherwise the whole run is rejected
 * with every problem listed at once (a wrong reviewer must never be promoted, even partially).
 */
export function parseReviewAnnotations(document: unknown): ParsedReviewAnnotations {
  if (!isRecord(document)) throw new Error("review annotations must be a JSON object");
  const annotations: Record<string, ReviewAnnotation> = {};
  const unfilled: string[] = [];
  const problems: string[] = [];
  for (const [proposalId, entry] of Object.entries(document)) {
    if (!isRecord(entry)) {
      problems.push(`${proposalId}: annotation must be an object`);
      continue;
    }
    const verdict = entry.verdict;
    if (verdict === "" || verdict === undefined) {
      unfilled.push(proposalId);
      continue;
    }
    if (!isReviewVerdict(verdict)) {
      problems.push(`${proposalId}: verdict must be correct, incorrect, or unsure, received ${JSON.stringify(verdict)}`);
      continue;
    }
    if (entry.reviewer !== REVIEW_REVIEWER) {
      problems.push(`${proposalId}: reviewer must be exactly "human", received ${JSON.stringify(entry.reviewer)}`);
      continue;
    }
    if (entry.note !== undefined && typeof entry.note !== "string") {
      problems.push(`${proposalId}: note must be a string when present`);
      continue;
    }
    const annotation: ReviewAnnotation = { verdict };
    if (typeof entry.note === "string" && entry.note.trim() !== "") annotation.note = entry.note;
    annotations[proposalId] = annotation;
  }
  if (problems.length > 0) {
    throw new Error(["review annotations are invalid:", ...problems.map((problem) => `- ${problem}`)].join("\n"));
  }
  const ordered: Record<string, ReviewAnnotation> = {};
  for (const proposalId of Object.keys(annotations).sort(compareStrings)) {
    ordered[proposalId] = annotations[proposalId]!;
  }
  return { annotations: ordered, unfilled: unfilled.sort(compareStrings) };
}

// ---------------------------------------------------------------------------------------------
// Promotion planning and application
// ---------------------------------------------------------------------------------------------

/**
 * Appends the human note to the existing case note, keeping the original text verbatim. An absent
 * or blank human note leaves the original untouched; an absent original note becomes the human
 * note alone, prefixed for traceability.
 */
export function appendHumanNote(existingNote: string | undefined, humanNote: string | undefined): string | undefined {
  const human = humanNote?.trim();
  if (!human) return existingNote;
  const original = existingNote?.trim();
  if (!original) return `Human review: ${human}`;
  return `${existingNote}\n\nHuman review: ${human}`;
}

export interface PlannedPromotion {
  proposalId: string;
  fromProvenance: HarvestProvenance;
  /** The human note to append; null when the annotation supplied none. */
  humanNote: string | null;
  /** The note the fixture will carry after promotion (undefined when there is no note at all). */
  note: string | undefined;
}

export interface PromotionPlan {
  totalCases: number;
  promoted: PlannedPromotion[];
  incorrect: string[];
  unsure: string[];
  unfilled: string[];
  /** Annotations for proposalIds that do not exist in the fixture; never promoted. */
  unknownIds: string[];
  /** Correct verdicts on cases already `review-annotated`; skipped so re-runs are idempotent. */
  alreadyReviewed: string[];
}

/**
 * Decides what an apply run will change. Pure and order-independent: every list is sorted by
 * proposalId, so repeated runs over the same inputs produce identical plans.
 */
export function planPromotions(
  fixture: ReviewFixtureDocument,
  parsed: Pick<ParsedReviewAnnotations, "annotations" | "unfilled">,
): PromotionPlan {
  const known = new Map(fixture.proposals.map((proposal) => [proposal.proposalId, proposal]));
  const promoted: PlannedPromotion[] = [];
  const incorrect: string[] = [];
  const unsure: string[] = [];
  const alreadyReviewed: string[] = [];
  const annotationIds = Object.keys(parsed.annotations).sort(compareStrings);
  for (const proposalId of annotationIds) {
    const annotation = parsed.annotations[proposalId]!;
    const proposal = known.get(proposalId);
    if (!proposal) continue;
    if (proposal.provenance === "review-annotated") {
      alreadyReviewed.push(proposalId);
      continue;
    }
    if (annotation.verdict === "incorrect") {
      incorrect.push(proposalId);
      continue;
    }
    if (annotation.verdict === "unsure") {
      unsure.push(proposalId);
      continue;
    }
    const humanNote = annotation.note?.trim() ? annotation.note : null;
    promoted.push({
      proposalId,
      fromProvenance: proposal.provenance,
      humanNote,
      note: appendHumanNote(proposal.note, humanNote ?? undefined),
    });
  }
  return {
    totalCases: fixture.proposals.length,
    promoted,
    incorrect,
    unsure,
    unfilled: [...parsed.unfilled].sort(compareStrings),
    unknownIds: annotationIds.filter((proposalId) => !known.has(proposalId)),
    alreadyReviewed,
  };
}

/**
 * Applies a plan: promoted cases switch provenance to `review-annotated` and get the appended
 * note; every other field (state, expected, status, reason, createdAt, sourceDecisionId...) is
 * preserved. Proposals are emitted sorted by proposalId, and `generatedAt` is intentionally left
 * alone so a second identical run is byte-identical.
 */
export function applyPromotionPlan(fixture: ReviewFixtureDocument, plan: PromotionPlan): ReviewFixtureDocument {
  const byId = new Map(plan.promoted.map((entry) => [entry.proposalId, entry]));
  const proposals = [...fixture.proposals]
    .sort((left, right) => compareStrings(left.proposalId, right.proposalId))
    .map((proposal): HarvestProposal => {
      const promotion = byId.get(proposal.proposalId);
      if (!promotion) return proposal;
      return {
        ...proposal,
        provenance: "review-annotated",
        ...(promotion.note === undefined ? {} : { note: promotion.note }),
      };
    });
  return { version: fixture.version, lane: fixture.lane, generatedAt: fixture.generatedAt, proposals };
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

export interface PacketReportInput {
  fixture: ReviewFixtureDocument;
  cases: readonly HarvestProposal[];
  source: string;
  packetPath: string;
  annotationsPath: string;
}

/** Stdout summary for `--packet`: totals, provenance and tier counts, and the two output paths. */
export function renderPacketReport(input: PacketReportInput): string {
  const summary = summarizeReviewCases(input.cases);
  return [
    "Adventure review packet",
    `Fixture: ${input.source}`,
    `Cases: ${input.fixture.proposals.length} total, ${summary.total} shown`,
    `Provenance: ${formatCounts(summary.byProvenance.map((entry) => ({ label: entry.provenance, count: entry.count })))}`,
    `Tiers: ${formatCounts(summary.byTier.map((entry) => ({ label: entry.tier, count: entry.count })))}`,
    `Packet: ${input.packetPath}`,
    `Annotations skeleton: ${input.annotationsPath}`,
    "",
  ].join("\n");
}

export interface ApplyReportInput {
  fixturePath: string;
  annotationsPath: string;
  plan: PromotionPlan;
  written: boolean;
}

/** Stdout summary for `--apply`: promoted count, ignored counts by verdict, unknown ids, total. */
export function renderApplyReport(input: ApplyReportInput): string {
  const lines: string[] = [];
  lines.push("Adventure review apply");
  lines.push(`Fixture: ${input.fixturePath}`);
  lines.push(`Annotations: ${input.annotationsPath}`);
  lines.push(`Cases: ${input.plan.totalCases}`);
  lines.push(`Promoted: ${input.plan.promoted.length}`);
  for (const entry of input.plan.promoted) {
    lines.push(`- ${entry.proposalId} (${entry.fromProvenance} -> review-annotated${entry.humanNote ? ", note appended" : ""})`);
  }
  lines.push(`Ignored incorrect: ${input.plan.incorrect.length} (not promoted)`);
  for (const proposalId of input.plan.incorrect) lines.push(`- ${proposalId}`);
  lines.push(`Ignored unsure: ${input.plan.unsure.length} (not promoted)`);
  for (const proposalId of input.plan.unsure) lines.push(`- ${proposalId}`);
  lines.push(`Ignored unfilled: ${input.plan.unfilled.length}`);
  for (const proposalId of input.plan.unfilled) lines.push(`- ${proposalId}`);
  lines.push(`Already human-reviewed: ${input.plan.alreadyReviewed.length} (skipped)`);
  for (const proposalId of input.plan.alreadyReviewed) lines.push(`- ${proposalId}`);
  lines.push(`Unknown proposalIds: ${input.plan.unknownIds.length} (ignored)`);
  for (const proposalId of input.plan.unknownIds) lines.push(`- ${proposalId}`);
  lines.push(input.written
    ? `Wrote ${input.fixturePath}`
    : `Dry run: nothing written (pass --write-fixture to update ${input.fixturePath})`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// File I/O wrapper
// ---------------------------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJsonFile(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`failed to read ${label} file ${filePath}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`failed to parse ${label} file ${filePath}: ${messageOf(error)}`);
  }
}

async function main(): Promise<void> {
  const options = parseReviewCaseArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const fixturePath = reviewFixturePath();
  const fixture = parseReviewFixtureDocument(readJsonFile(fixturePath, "review fixture"));

  if (options.mode === "packet") {
    const cases = orderCasesForReview(fixture.proposals, options.limit ?? undefined);
    const packetPath = options.out ?? DEFAULT_PACKET_PATH;
    const annotationsPath = annotationsSkeletonPath(packetPath);
    const packet = renderReviewPacket({
      fixture,
      cases,
      generatedAt: new Date().toISOString(),
      source: fixturePath,
    });
    mkdirSync(path.dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, packet, "utf8");
    writeFileSync(annotationsPath, serializeAnnotationsSkeleton(buildAnnotationsSkeleton(cases)), "utf8");
    process.stdout.write(renderPacketReport({ fixture, cases, source: fixturePath, packetPath, annotationsPath }));
    return;
  }

  const annotationsPath = options.applyPath;
  if (annotationsPath === null) throw new Error("--apply requires an annotations path");
  const parsed = parseReviewAnnotations(readJsonFile(annotationsPath, "annotations"));
  const plan = planPromotions(fixture, parsed);
  const applied = applyPromotionPlan(fixture, plan);
  if (options.writeFixture) writeFileSync(fixturePath, serializeReviewFixture(applied), "utf8");
  process.stdout.write(renderApplyReport({ fixturePath, annotationsPath, plan, written: options.writeFixture }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
