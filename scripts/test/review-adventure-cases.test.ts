import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarvestProposal } from "../../server/src/agent/systemOneHarvest.js";
import {
  DEFAULT_ANNOTATIONS_PATH,
  DEFAULT_PACKET_PATH,
  REVIEW_TIERS,
  adventureReviewState,
  annotationsSkeletonPath,
  appendHumanNote,
  applyPromotionPlan,
  buildAnnotationsSkeleton,
  compareStrings,
  expectedPickOf,
  orderCasesForReview,
  parseReviewAnnotations,
  parseReviewCaseArgs,
  parseReviewFixtureDocument,
  planPromotions,
  renderApplyReport,
  renderPacketReport,
  renderReviewPacket,
  reviewTier,
  serializeAnnotationsSkeleton,
  serializeReviewFixture,
  shortProposalId,
  summarizeReviewCases,
  trimText,
} from "../review-adventure-cases.js";
import type { ReviewFixtureDocument } from "../review-adventure-cases.js";

const NOW = "2026-09-19T00:00:00.000Z";
const CONFIRMED_REASON = "agent review confirmed the recorded adventure-selection decision";
const CORRECTED_REASON =
  "agent review rejected the recorded adventure-selection decision and supplied the corrected answer";

function makeProposal(overrides: Partial<HarvestProposal> = {}): HarvestProposal {
  const proposalId = overrides.proposalId ?? "p-0001";
  return {
    proposalId,
    lane: "adventure-selection",
    sourceDecisionId: `decision-${proposalId}`,
    createdAt: NOW,
    provenance: "agent-review",
    status: "confirmed",
    state: {
      declaration: "I test the reviewed declaration.",
      candidates: [{
        candidateId: "candidate-1",
        digest: "digest-1",
        kind: "exact_srd_check.select",
        label: "Resolve SRD check: Wisdom (Wisdom), Medium difficulty, normal",
      }],
    },
    expected: { candidateId: "candidate-1" },
    note: "agent review note",
    reason: CONFIRMED_REASON,
    ...overrides,
  };
}

function makeProposalWithoutNote(overrides: Partial<HarvestProposal> = {}): HarvestProposal {
  const proposal = makeProposal(overrides);
  delete proposal.note;
  return proposal;
}

function makeFixture(proposals: HarvestProposal[], generatedAt: string = NOW): ReviewFixtureDocument {
  return { version: 1, lane: "adventure-selection", generatedAt, proposals };
}

// ---------------------------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------------------------

test("parseReviewCaseArgs defaults to packet mode", () => {
  assert.deepEqual(parseReviewCaseArgs([]), {
    mode: "packet",
    limit: null,
    out: null,
    applyPath: null,
    writeFixture: false,
  });
});

test("parseReviewCaseArgs reads each value flag in both forms", () => {
  assert.equal(parseReviewCaseArgs(["--packet"]).mode, "packet");

  assert.equal(parseReviewCaseArgs(["--limit", "7"]).limit, 7);
  assert.equal(parseReviewCaseArgs(["--limit=7"]).limit, 7);

  assert.equal(parseReviewCaseArgs(["--out", "packet.md"]).out, path.resolve("packet.md"));
  assert.equal(parseReviewCaseArgs(["--out=packet.md"]).out, path.resolve("packet.md"));

  const apply = parseReviewCaseArgs(["--apply=review.json"]);
  assert.equal(apply.mode, "apply");
  assert.equal(apply.applyPath, path.resolve("review.json"));
  assert.equal(parseReviewCaseArgs(["--apply", "review.json", "--write-fixture"]).writeFixture, true);
});

test("parseReviewCaseArgs clamps --limit", () => {
  assert.equal(parseReviewCaseArgs(["--limit", "0"]).limit, 1);
  assert.equal(parseReviewCaseArgs(["--limit", "-5"]).limit, 1);
  assert.equal(parseReviewCaseArgs(["--limit", "5000"]).limit, 1000);
  assert.equal(parseReviewCaseArgs(["--limit", "2.9"]).limit, 2);
  assert.throws(() => parseReviewCaseArgs(["--limit", "abc"]), /--limit requires a number/);
  assert.throws(() => parseReviewCaseArgs(["--limit"]), /--limit requires a number/);
});

test("parseReviewCaseArgs rejects conflicting or misplaced flags", () => {
  assert.throws(
    () => parseReviewCaseArgs(["--packet", "--apply", "review.json"]),
    /--packet and --apply cannot be combined/,
  );
  assert.throws(() => parseReviewCaseArgs(["--write-fixture"]), /--write-fixture requires --apply/);
  assert.throws(
    () => parseReviewCaseArgs(["--apply", "review.json", "--limit", "5"]),
    /--limit only applies to --packet/,
  );
  assert.throws(
    () => parseReviewCaseArgs(["--apply", "review.json", "--out", "packet.md"]),
    /--out only applies to --packet/,
  );
  assert.throws(() => parseReviewCaseArgs(["--apply"]), /--apply requires an annotations path/);
  assert.throws(() => parseReviewCaseArgs(["--apply="]), /--apply requires an annotations path/);
  assert.throws(() => parseReviewCaseArgs(["--bogus"]), /unknown argument: --bogus/);
});

test("parseReviewCaseArgs signals --help without exiting", () => {
  assert.equal(parseReviewCaseArgs(["--help"]).help, true);
  assert.equal(parseReviewCaseArgs(["-h"]).help, true);
  assert.equal(parseReviewCaseArgs([]).help, undefined);
});

test("default output paths live under the temp directory and stay siblings", () => {
  assert.ok(DEFAULT_PACKET_PATH.startsWith(tmpdir()));
  assert.ok(DEFAULT_ANNOTATIONS_PATH.startsWith(tmpdir()));
  assert.equal(annotationsSkeletonPath("/tmp/packet.md"), "/tmp/packet.annotations.json");
  assert.equal(annotationsSkeletonPath("/tmp/packet"), "/tmp/packet.annotations.json");
});

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

test("reviewTier classifies recorded commits, corrections, and no-pick cases", () => {
  const receipt = makeProposal({
    proposalId: "p-receipt",
    provenance: "review-annotated",
    reason: "human review confirmed the recorded adventure-selection decision",
  });
  const corrected = makeProposal({ proposalId: "p-corrected", reason: CORRECTED_REASON });
  const defer = makeProposal({ proposalId: "p-defer", expected: { candidateId: null } });
  const missing = makeProposal({ proposalId: "p-missing", expected: null });
  const proposed = makeProposal({ proposalId: "p-proposed", status: "proposed" });

  assert.equal(reviewTier(receipt), "receipt-backed-pick");
  assert.equal(reviewTier(corrected), "corrected-pick");
  assert.equal(reviewTier(defer), "no-expected-pick");
  assert.equal(reviewTier(missing), "no-expected-pick");
  assert.equal(reviewTier(proposed), "corrected-pick");
  assert.deepEqual(REVIEW_TIERS, ["receipt-backed-pick", "corrected-pick", "no-expected-pick"]);
});

test("orderCasesForReview orders tiers first, then proposalId, then the limit", () => {
  const receiptB = makeProposal({ proposalId: "p-b" });
  const receiptA = makeProposal({ proposalId: "p-a" });
  const corrected = makeProposal({ proposalId: "p-c", reason: CORRECTED_REASON });
  const defer = makeProposal({ proposalId: "p-d", expected: { candidateId: null } });

  const ordered = orderCasesForReview([defer, corrected, receiptB, receiptA]);
  assert.deepEqual(ordered.map((proposal) => proposal.proposalId), ["p-a", "p-b", "p-c", "p-d"]);
  assert.deepEqual(orderCasesForReview([receiptA, receiptB, corrected, defer], 2).map((entry) => entry.proposalId), ["p-a", "p-b"]);
  assert.deepEqual(["b", "a"].sort(compareStrings), ["a", "b"]);
});

test("summarizeReviewCases counts tiers and provenance", () => {
  const summary = summarizeReviewCases([
    makeProposal({ proposalId: "p-a" }),
    makeProposal({ proposalId: "p-b", provenance: "review-annotated" }),
    makeProposal({ proposalId: "p-c", reason: CORRECTED_REASON }),
    makeProposal({ proposalId: "p-d", expected: { candidateId: null } }),
  ]);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byTier, [
    { tier: "receipt-backed-pick", count: 2 },
    { tier: "corrected-pick", count: 1 },
    { tier: "no-expected-pick", count: 1 },
  ]);
  assert.deepEqual(summary.byProvenance, [
    { provenance: "agent-review", count: 3 },
    { provenance: "review-annotated", count: 1 },
  ]);
});

test("expectedPickOf decodes pick, defer, and unusable expectations", () => {
  assert.deepEqual(expectedPickOf(makeProposal({ expected: { candidateId: "c-1" } })), { kind: "pick", candidateId: "c-1" });
  assert.deepEqual(expectedPickOf(makeProposal({ expected: { candidateId: null } })), { kind: "defer" });
  assert.deepEqual(expectedPickOf(makeProposal({ expected: null })), { kind: "missing" });
  assert.deepEqual(expectedPickOf(makeProposal({ expected: { candidateId: 7 } })), { kind: "missing" });
});

test("adventureReviewState keeps only usable candidates", () => {
  const state = adventureReviewState({
    declaration: "I do the thing.",
    candidates: [
      { candidateId: "c-1", digest: "d-1", kind: "exact_srd_check.select", label: "Resolve a check" },
      { candidateId: "missing-fields" },
      7,
    ],
  });
  assert.deepEqual(state, {
    declaration: "I do the thing.",
    candidates: [{ candidateId: "c-1", digest: "d-1", kind: "exact_srd_check.select", label: "Resolve a check" }],
  });
  assert.deepEqual(adventureReviewState(null), { declaration: "", candidates: [] });
});

// ---------------------------------------------------------------------------------------------
// Packet rendering
// ---------------------------------------------------------------------------------------------

test("renderReviewPacket shows candidates and flags a missing expected candidate", () => {
  const fixture = makeFixture([
    makeProposal({
      proposalId: "p-missing",
      state: {
        declaration: "I drink the potion.",
        candidates: [{
          candidateId: "candidate-9",
          digest: "digest-9",
          kind: "exact_inventory_action.select",
          label: "Use item: potion of healing",
        }],
      },
      expected: { candidateId: "candidate-ghost" },
      note: "the lane missed a committed pick",
    }),
  ]);
  const input = {
    fixture,
    cases: orderCasesForReview(fixture.proposals),
    generatedAt: NOW,
    source: "/repo/adventure-selection.json",
  };
  const packet = renderReviewPacket(input);

  assert.match(packet, /# Adventure selection review packet/);
  assert.match(packet, /Generated: 2026-09-19T00:00:00\.000Z/);
  assert.match(packet, /Fixture: \/repo\/adventure-selection\.json/);
  assert.match(packet, /Cases: 1 total, 1 shown/);
  assert.match(packet, /Tiers: receipt-backed-pick 1, corrected-pick 0, no-expected-pick 0/);
  assert.match(packet, /Provenance: agent-review 1/);
  assert.match(packet, /## 1\. `p-missing`/);
  assert.match(packet, /- lane: `adventure-selection`/);
  assert.match(packet, /- tier: receipt-backed-pick/);
  assert.match(packet, /- provenance: `agent-review`/);
  assert.match(packet, /- declaration: I drink the potion\./);
  assert.match(packet, /- expected pick: candidate `candidate-ghost` is NOT among the advertised candidates/);
  assert.match(packet, /- candidates \(1\):/);
  assert.match(packet, /`exact_inventory_action.select` — Use item: potion of healing/);
  assert.match(packet, /- note: the lane missed a committed pick/);
  assert.match(packet, /## Decision/);
  assert.match(packet, /Answer by index with `confirm`, `reject`, or `unsure`/);
  assert.match(packet, /1:__/);
  assert.equal(packet, renderReviewPacket(input));
  assert.ok(packet.endsWith("\n"));
});

test("renderReviewPacket resolves expected labels and renders defers", () => {
  const fixture = makeFixture([
    makeProposal({ proposalId: "p-found" }),
    makeProposal({ proposalId: "p-defer", expected: { candidateId: null } }),
  ]);
  const packet = renderReviewPacket({ fixture, cases: orderCasesForReview(fixture.proposals), generatedAt: NOW });
  assert.match(
    packet,
    /- expected pick: `exact_srd_check\.select` — Resolve SRD check: Wisdom \(Wisdom\), Medium difficulty, normal \(candidate-1\)/,
  );
  assert.match(packet, /- expected pick: defer \(no candidate expected\)/);
  assert.match(packet, /2:__/);
});

test("renderReviewPacket trims long text deterministically", () => {
  const fixture = makeFixture([
    makeProposal({
      proposalId: "p-long",
      state: { declaration: "x".repeat(200), candidates: [] },
      note: "n".repeat(300),
    }),
  ]);
  const input = { fixture, cases: fixture.proposals, generatedAt: NOW };
  const packet = renderReviewPacket(input);

  assert.match(packet, /- declaration: x{159}…/);
  assert.match(packet, /- note: n{239}…/);
  assert.match(packet, /\(none advertised\)/);
  assert.equal(packet, renderReviewPacket(input));
  assert.equal(trimText("  a   b  ", 10), "a b");
  assert.equal(trimText("abcdefghij", 5), "abcd…");
  assert.equal(shortProposalId("0123456789abcdef"), "0123456789ab");
});

test("buildAnnotationsSkeleton keys entries in packet order and round-trips", () => {
  const skeleton = buildAnnotationsSkeleton([
    makeProposal({ proposalId: "p-a" }),
    makeProposal({ proposalId: "p-b" }),
  ]);
  assert.deepEqual(Object.keys(skeleton), ["p-a", "p-b"]);
  assert.deepEqual(skeleton["p-a"], { verdict: "", reviewer: "human", note: "" });
  const serialized = serializeAnnotationsSkeleton(skeleton);
  assert.ok(serialized.endsWith("\n"));
  assert.deepEqual(JSON.parse(serialized), skeleton);
});

// ---------------------------------------------------------------------------------------------
// Annotation parsing
// ---------------------------------------------------------------------------------------------

test("parseReviewAnnotations accepts filled human verdicts and collects unfilled entries", () => {
  const parsed = parseReviewAnnotations({
    "p-correct": { verdict: "correct", reviewer: "human", note: "  confirmed against the transcript  " },
    "p-incorrect": { verdict: "incorrect", reviewer: "human" },
    "p-unsure": { verdict: "unsure", reviewer: "human", note: "" },
    "p-blank": { verdict: "", reviewer: "human", note: "" },
    "p-legacy": { reviewer: "human", note: "" },
  });
  assert.deepEqual(parsed.annotations, {
    "p-correct": { verdict: "correct", note: "  confirmed against the transcript  " },
    "p-incorrect": { verdict: "incorrect" },
    "p-unsure": { verdict: "unsure" },
  });
  assert.deepEqual(parsed.unfilled, ["p-blank", "p-legacy"]);
});

test("parseReviewAnnotations rejects non-human reviewers with a clear error", () => {
  assert.throws(
    () => parseReviewAnnotations({ "p-1": { verdict: "correct", reviewer: "agent" } }),
    (error: unknown) => error instanceof Error
      && error.message.includes("p-1")
      && /reviewer must be exactly "human", received "agent"/.test(error.message),
  );
  assert.throws(
    () => parseReviewAnnotations({ "p-1": { verdict: "correct" } }),
    /reviewer must be exactly "human", received undefined/,
  );
});

test("parseReviewAnnotations rejects invalid verdicts and malformed entries", () => {
  assert.throws(
    () => parseReviewAnnotations({ "p-1": { verdict: "maybe", reviewer: "human" } }),
    /verdict must be correct, incorrect, or unsure/,
  );
  assert.throws(() => parseReviewAnnotations({ "p-1": null }), /p-1: annotation must be an object/);
  assert.throws(() => parseReviewAnnotations("nope"), /review annotations must be a JSON object/);
  assert.throws(
    () => parseReviewAnnotations({ "p-1": { verdict: "correct", reviewer: "human", note: 42 } }),
    /note must be a string when present/,
  );
});

// ---------------------------------------------------------------------------------------------
// Promotion planning and application
// ---------------------------------------------------------------------------------------------

test("planPromotions promotes correct human verdicts and ignores incorrect and unsure ones", () => {
  const fixture = makeFixture([
    makeProposal({ proposalId: "p-correct", note: "agent evidence" }),
    makeProposalWithoutNote({ proposalId: "p-no-note" }),
    makeProposal({ proposalId: "p-incorrect" }),
    makeProposal({ proposalId: "p-unsure" }),
  ]);
  const parsed = parseReviewAnnotations({
    "p-correct": { verdict: "correct", reviewer: "human", note: "  matches the transcript  " },
    "p-no-note": { verdict: "correct", reviewer: "human", note: "verified" },
    "p-incorrect": { verdict: "incorrect", reviewer: "human", note: "wrong binding" },
    "p-unsure": { verdict: "unsure", reviewer: "human" },
  });
  const plan = planPromotions(fixture, parsed);

  assert.equal(plan.totalCases, 4);
  assert.deepEqual(plan.promoted.map((entry) => entry.proposalId), ["p-correct", "p-no-note"]);
  assert.equal(plan.promoted[0]!.fromProvenance, "agent-review");
  assert.equal(plan.promoted[0]!.humanNote, "  matches the transcript  ");
  assert.equal(plan.promoted[0]!.note, "agent evidence\n\nHuman review: matches the transcript");
  assert.equal(plan.promoted[1]!.note, "Human review: verified");
  assert.deepEqual(plan.incorrect, ["p-incorrect"]);
  assert.deepEqual(plan.unsure, ["p-unsure"]);
  assert.deepEqual(plan.unknownIds, []);
  assert.deepEqual(plan.alreadyReviewed, []);
});

test("planPromotions reports unknown ids, unfilled entries, and already human-reviewed cases", () => {
  const fixture = makeFixture([
    makeProposal({ proposalId: "p-known" }),
    makeProposal({ proposalId: "p-human", provenance: "review-annotated" }),
  ]);
  const parsed = parseReviewAnnotations({
    "p-known": { verdict: "correct", reviewer: "human" },
    "p-human": { verdict: "correct", reviewer: "human", note: "already reviewed" },
    "p-ghost": { verdict: "correct", reviewer: "human" },
    "p-blank": { verdict: "", reviewer: "human", note: "" },
  });
  const plan = planPromotions(fixture, parsed);

  assert.deepEqual(plan.promoted.map((entry) => entry.proposalId), ["p-known"]);
  assert.deepEqual(plan.alreadyReviewed, ["p-human"]);
  assert.deepEqual(plan.unknownIds, ["p-ghost"]);
  assert.deepEqual(plan.unfilled, ["p-blank"]);
});

test("applyPromotionPlan preserves every other field and appends notes", () => {
  const proposal = makeProposal({
    proposalId: "p-1",
    note: "original note",
    state: { declaration: "drop the sword", candidates: [] },
    expected: { candidateId: null },
  });
  const fixture = makeFixture([proposal]);
  const parsed = parseReviewAnnotations({ "p-1": { verdict: "correct", reviewer: "human", note: "human note" } });
  const applied = applyPromotionPlan(fixture, planPromotions(fixture, parsed));
  const promoted = applied.proposals.find((entry) => entry.proposalId === "p-1")!;

  assert.equal(promoted.provenance, "review-annotated");
  assert.equal(promoted.note, "original note\n\nHuman review: human note");
  assert.deepEqual(promoted.state, proposal.state);
  assert.deepEqual(promoted.expected, proposal.expected);
  assert.equal(promoted.status, proposal.status);
  assert.equal(promoted.reason, proposal.reason);
  assert.equal(promoted.createdAt, proposal.createdAt);
  assert.equal(promoted.sourceDecisionId, proposal.sourceDecisionId);
  assert.equal(promoted.lane, proposal.lane);
  assert.equal(promoted.proposalId, proposal.proposalId);
  assert.equal(applied.version, fixture.version);
  assert.equal(applied.lane, fixture.lane);
  assert.equal(applied.generatedAt, fixture.generatedAt);
});

test("appendHumanNote keeps the original text and handles absent notes", () => {
  assert.equal(appendHumanNote("original", "human"), "original\n\nHuman review: human");
  assert.equal(appendHumanNote(undefined, "human"), "Human review: human");
  assert.equal(appendHumanNote("original", undefined), "original");
  assert.equal(appendHumanNote("original", "   "), "original");
  assert.equal(appendHumanNote(undefined, undefined), undefined);
});

test("applyPromotionPlan is deterministic and a second identical run is a no-op", () => {
  const fixture = makeFixture([
    makeProposal({ proposalId: "p-z", note: "z note" }),
    makeProposal({ proposalId: "p-a", note: "a note" }),
    makeProposal({ proposalId: "p-m", provenance: "review-annotated" }),
  ]);
  const annotations = {
    "p-z": { verdict: "correct", reviewer: "human", note: "keep" },
    "p-a": { verdict: "correct", reviewer: "human" },
  };
  const parsed = parseReviewAnnotations(annotations);
  const first = applyPromotionPlan(fixture, planPromotions(fixture, parsed));
  const second = applyPromotionPlan(fixture, planPromotions(fixture, parseReviewAnnotations(annotations)));

  assert.equal(serializeReviewFixture(first), serializeReviewFixture(second));
  assert.deepEqual(first.proposals.map((entry) => entry.proposalId), ["p-a", "p-m", "p-z"]);

  const rerunPlan = planPromotions(first, parseReviewAnnotations(annotations));
  assert.deepEqual(rerunPlan.promoted, []);
  assert.deepEqual(rerunPlan.alreadyReviewed, ["p-a", "p-z"]);
  assert.equal(serializeReviewFixture(applyPromotionPlan(first, rerunPlan)), serializeReviewFixture(first));
});

// ---------------------------------------------------------------------------------------------
// Reports and fixture validation
// ---------------------------------------------------------------------------------------------

test("renderApplyReport and renderPacketReport summarize the run", () => {
  const fixture = makeFixture([
    makeProposal({ proposalId: "p-correct" }),
    makeProposal({ proposalId: "p-defer", expected: { candidateId: null } }),
  ]);
  const parsed = parseReviewAnnotations({
    "p-correct": { verdict: "correct", reviewer: "human", note: "ok" },
    "p-defer": { verdict: "unsure", reviewer: "human" },
    "p-ghost": { verdict: "correct", reviewer: "human" },
  });
  const plan = planPromotions(fixture, parsed);

  const dryRun = renderApplyReport({
    fixturePath: "/repo/adventure-selection.json",
    annotationsPath: "/tmp/annotations.json",
    plan,
    written: false,
  });
  assert.match(dryRun, /Cases: 2/);
  assert.match(dryRun, /Promoted: 1/);
  assert.match(dryRun, /Ignored incorrect: 0 \(not promoted\)/);
  assert.match(dryRun, /Ignored unsure: 1 \(not promoted\)/);
  assert.match(dryRun, /Unknown proposalIds: 1 \(ignored\)/);
  assert.match(dryRun, /Dry run: nothing written \(pass --write-fixture to update/);

  const written = renderApplyReport({
    fixturePath: "/repo/adventure-selection.json",
    annotationsPath: "/tmp/annotations.json",
    plan,
    written: true,
  });
  assert.match(written, /Wrote \/repo\/adventure-selection\.json/);

  const report = renderPacketReport({
    fixture,
    cases: orderCasesForReview(fixture.proposals),
    source: "/repo/adventure-selection.json",
    packetPath: "/tmp/packet.md",
    annotationsPath: "/tmp/packet.annotations.json",
  });
  assert.match(report, /Cases: 2 total, 2 shown/);
  assert.match(report, /Provenance: agent-review 2/);
  assert.match(report, /Tiers: receipt-backed-pick 1, corrected-pick 0, no-expected-pick 1/);
  assert.match(report, /Annotations skeleton: \/tmp\/packet\.annotations\.json/);
});

test("parseReviewFixtureDocument validates the fixture shape", () => {
  const document = makeFixture([makeProposal({ proposalId: "p-1" })]);
  assert.deepEqual(parseReviewFixtureDocument(JSON.parse(JSON.stringify(document))), document);
  assert.throws(() => parseReviewFixtureDocument(null), /must be a JSON object/);
  assert.throws(() => parseReviewFixtureDocument({ ...document, version: 2 }), /unsupported review fixture version/);
  assert.throws(() => parseReviewFixtureDocument({ ...document, lane: "guardrails" }), /expected adventure-selection/);
  assert.throws(
    () => parseReviewFixtureDocument({ ...document, proposals: [{ lane: "adventure-selection" }] }),
    /missing a proposalId/,
  );
  assert.throws(
    () => parseReviewFixtureDocument({ ...document, proposals: [{ proposalId: "p-x", lane: "guardrails" }] }),
    /lane is guardrails, expected adventure-selection/,
  );
});
