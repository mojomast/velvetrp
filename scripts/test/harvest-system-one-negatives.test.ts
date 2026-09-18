import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { compareDirectorAuthority } from "../../server/src/agent/systemOneDisagreement.js";
import {
  buildHarvestProposals,
  summarizeHarvest,
} from "../../server/src/agent/systemOneHarvest.js";
import type { HarvestProposal } from "../../server/src/agent/systemOneHarvest.js";
import type { DirectorDecisionAuthority, SystemOneDecisionRecord } from "../../server/src/repo/index.js";
import {
  DEFAULT_LIMIT,
  HARVEST_LANES,
  authorityByDecisionId,
  buildFixtureDocument,
  buildHarvestOutput,
  filterProposalsByStatus,
  fixtureFilePath,
  harvestAnnotationFromEntry,
  mergeFixtureDocuments,
  parseAnnotationEntries,
  parseHarvestArgs,
  renderHarvestSummary,
  serializeFixture,
  serializeHarvestOutput,
} from "../harvest-system-one-negatives.js";
import type { HarvestFixtureDocument } from "../harvest-system-one-negatives.js";

const NOW = "2026-09-17T00:00:00.000Z";

function makeRecord(overrides: Partial<SystemOneDecisionRecord> = {}): SystemOneDecisionRecord {
  return {
    decisionId: "decision-1",
    lane: "guardrails",
    campaignId: null,
    sessionId: null,
    turnId: null,
    provider: "test",
    model: "test-model",
    confidencePolicyVersion: "v1",
    requestDigest: "request-1",
    questionsDigest: "questions-1",
    stateDigest: "state-1",
    request: { decisionId: "decision-1" },
    questions: [],
    state: { message: "I draw my sword." },
    answers: [],
    selection: { disposition: "pass" },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: true,
    usage: null,
    latencyMs: 1,
    createdAt: NOW,
    ...overrides,
  };
}

/** Two confirmed and one proposed guardrails proposal, all review-annotated. */
function guardrailProposals(): HarvestProposal[] {
  return buildHarvestProposals({
    records: [
      makeRecord({ decisionId: "d-confirmed", stateDigest: "state-confirmed" }),
      makeRecord({ decisionId: "d-proposed", stateDigest: "state-proposed", selection: { disposition: "block" } }),
      makeRecord({ decisionId: "d-corrected", stateDigest: "state-corrected", selection: { disposition: "review" } }),
    ],
    annotations: {
      "d-confirmed": { verdict: "correct" },
      "d-proposed": { verdict: "incorrect" },
      "d-corrected": { verdict: "incorrect", expected: { disposition: "block" } },
    },
  });
}

/** A literal fixture proposal, so merge tests can pin exact proposalIds and payloads. */
function makeProposal(overrides: Partial<HarvestProposal> = {}): HarvestProposal {
  return {
    proposalId: "proposal-1",
    lane: "guardrails",
    sourceDecisionId: "decision-1",
    createdAt: NOW,
    provenance: "review-annotated",
    status: "confirmed",
    state: { message: "I draw my sword." },
    expected: { disposition: "pass" },
    reason: "test fixture proposal",
    ...overrides,
  };
}

function makeFixtureDocument(
  lane: string,
  proposals: HarvestProposal[],
  generatedAt: string = NOW,
): HarvestFixtureDocument {
  return { version: 1, lane, generatedAt, proposals };
}

test("parseHarvestArgs applies defaults", () => {
  assert.deepEqual(parseHarvestArgs([]), {
    lane: null,
    limit: DEFAULT_LIMIT,
    annotations: null,
    disagreements: false,
    status: "all",
    out: null,
    writeFixture: false,
    mergeFixture: false,
    summary: false,
  });
});

test("parseHarvestArgs reads each value flag in both forms", () => {
  assert.equal(parseHarvestArgs(["--lane", "guardrails"]).lane, "guardrails");
  assert.equal(parseHarvestArgs(["--lane=director-selection"]).lane, "director-selection");

  assert.equal(parseHarvestArgs(["--limit", "7"]).limit, 7);
  assert.equal(parseHarvestArgs(["--limit=7"]).limit, 7);

  assert.equal(parseHarvestArgs(["--annotations", "review.json"]).annotations, "review.json");
  assert.equal(parseHarvestArgs(["--annotations=review.json"]).annotations, "review.json");

  assert.equal(parseHarvestArgs(["--status", "proposed"]).status, "proposed");
  assert.equal(parseHarvestArgs(["--status=proposed"]).status, "proposed");

  assert.equal(parseHarvestArgs(["--out", "out.json"]).out, path.resolve("out.json"));
  assert.equal(parseHarvestArgs(["--out=out.json"]).out, path.resolve("out.json"));
});

test("parseHarvestArgs toggles --disagreements and --summary", () => {
  assert.equal(parseHarvestArgs([]).disagreements, false);
  assert.equal(parseHarvestArgs(["--disagreements"]).disagreements, true);
  assert.equal(parseHarvestArgs([]).summary, false);
  assert.equal(parseHarvestArgs(["--summary"]).summary, true);
  assert.throws(() => parseHarvestArgs(["--disagreements=true"]), /unknown argument: --disagreements=true/);
});

test("parseHarvestArgs clamps --limit to 1..1000", () => {
  assert.equal(parseHarvestArgs(["--limit", "0"]).limit, 1);
  assert.equal(parseHarvestArgs(["--limit", "-5"]).limit, 1);
  assert.equal(parseHarvestArgs(["--limit", "9999"]).limit, 1000);
  assert.equal(parseHarvestArgs(["--limit", "2.9"]).limit, 2);
  assert.equal(parseHarvestArgs(["--limit", "1000"]).limit, 1000);
  assert.throws(() => parseHarvestArgs(["--limit", "abc"]), /--limit requires a number/);
  assert.throws(() => parseHarvestArgs(["--limit"]), /--limit requires a number/);
});

test("parseHarvestArgs accepts only harvestable lanes", () => {
  assert.deepEqual([...HARVEST_LANES], ["director-selection", "adventure-selection", "guardrails"]);
  assert.equal(parseHarvestArgs(["--lane", "adventure-selection"]).lane, "adventure-selection");
  assert.throws(() => parseHarvestArgs(["--lane", "cost-router"]), /unknown lane: cost-router/);
  assert.throws(() => parseHarvestArgs(["--lane=nope"]), /unknown lane: nope/);
  assert.throws(() => parseHarvestArgs(["--lane"]), /--lane requires a lane id/);
  assert.throws(() => parseHarvestArgs(["--lane="]), /--lane requires a lane id/);
});

test("parseHarvestArgs validates --status", () => {
  for (const status of ["confirmed", "proposed", "all"] as const) {
    assert.equal(parseHarvestArgs(["--status", status]).status, status);
  }
  assert.throws(() => parseHarvestArgs(["--status", "maybe"]), /--status requires confirmed, proposed, or all/);
  assert.throws(() => parseHarvestArgs(["--status"]), /--status requires confirmed, proposed, or all/);
});

test("parseHarvestArgs enforces the --write-fixture contract", () => {
  assert.throws(() => parseHarvestArgs(["--write-fixture"]), /--write-fixture requires --lane/);
  assert.equal(parseHarvestArgs(["--write-fixture", "--lane", "guardrails"]).status, "confirmed");
  assert.equal(
    parseHarvestArgs(["--write-fixture", "--lane=adventure-selection", "--status", "confirmed"]).status,
    "confirmed",
  );
  assert.throws(
    () => parseHarvestArgs(["--write-fixture", "--lane", "guardrails", "--status", "all"]),
    /--write-fixture requires a confirmed-only filter/,
  );
  assert.throws(
    () => parseHarvestArgs(["--write-fixture", "--lane", "guardrails", "--status=proposed"]),
    /--write-fixture requires a confirmed-only filter/,
  );
});

test("parseHarvestArgs requires --write-fixture for --merge-fixture", () => {
  assert.throws(() => parseHarvestArgs(["--merge-fixture"]), /--merge-fixture requires --write-fixture/);
  assert.throws(
    () => parseHarvestArgs(["--merge-fixture", "--lane", "guardrails"]),
    /--merge-fixture requires --write-fixture/,
  );
  assert.equal(parseHarvestArgs(["--write-fixture", "--lane", "guardrails"]).mergeFixture, false);
  const options = parseHarvestArgs(["--write-fixture", "--merge-fixture", "--lane", "guardrails"]);
  assert.equal(options.mergeFixture, true);
  assert.equal(options.writeFixture, true);
  assert.equal(options.status, "confirmed");
});

test("parseHarvestArgs rejects missing path values", () => {
  assert.throws(() => parseHarvestArgs(["--out"]), /--out requires a path/);
  assert.throws(() => parseHarvestArgs(["--out="]), /--out requires a path/);
  assert.throws(() => parseHarvestArgs(["--annotations"]), /--annotations requires a path/);
  assert.throws(() => parseHarvestArgs(["--annotations="]), /--annotations requires a path/);
});

test("parseHarvestArgs signals --help without exiting", () => {
  assert.equal(parseHarvestArgs(["--help"]).help, true);
  assert.equal(parseHarvestArgs(["-h"]).help, true);
  assert.equal(parseHarvestArgs([]).help, undefined);
});

test("parseHarvestArgs rejects unknown arguments", () => {
  assert.throws(() => parseHarvestArgs(["--bogus"]), /unknown argument: --bogus/);
  assert.throws(() => parseHarvestArgs(["--lane", "guardrails", "extra"]), /unknown argument: extra/);
});

test("parseAnnotationEntries accepts the review-CLI shorthand", () => {
  const parsed = parseAnnotationEntries({ d1: "correct", d2: "incorrect" });
  assert.deepEqual(parsed.annotations, {
    d1: { verdict: "correct" },
    d2: { verdict: "incorrect" },
  });
  assert.equal(parsed.applied, 2);
  assert.equal(parsed.skipped, 0);
});

test("parseAnnotationEntries accepts the extended form", () => {
  const parsed = parseAnnotationEntries({
    d1: { verdict: "incorrect", expected: { disposition: "block" }, note: "should have blocked" },
    d2: { verdict: "correct" },
  });
  assert.deepEqual(parsed.annotations, {
    d1: { verdict: "incorrect", expected: { disposition: "block" }, note: "should have blocked" },
    d2: { verdict: "correct" },
  });
  assert.equal(parsed.applied, 2);
  assert.equal(parsed.skipped, 0);
});

test("parseAnnotationEntries ignores invalid entries instead of failing", () => {
  const parsed = parseAnnotationEntries({
    a: "maybe",
    b: 7,
    c: null,
    d: [],
    e: { verdict: "perhaps" },
    f: { note: "no verdict" },
    g: true,
    good: "incorrect",
  });
  assert.deepEqual(parsed.annotations, { good: { verdict: "incorrect" } });
  assert.equal(parsed.applied, 1);
  assert.equal(parsed.skipped, 7);
});

test("harvestAnnotationFromEntry keeps only a string note and a known reviewer", () => {
  assert.deepEqual(harvestAnnotationFromEntry({ verdict: "correct", note: 42 }), { verdict: "correct" });
  assert.deepEqual(harvestAnnotationFromEntry({ verdict: "incorrect", expected: null }), {
    verdict: "incorrect",
    expected: null,
  });
  assert.equal(harvestAnnotationFromEntry({ verdict: "correct", note: "reviewed" })?.note, "reviewed");
  assert.equal(harvestAnnotationFromEntry({ verdict: "correct", reviewer: "agent" })?.reviewer, "agent");
  assert.equal(harvestAnnotationFromEntry({ verdict: "correct", reviewer: "robot" })?.reviewer, undefined);
});

test("parseAnnotationEntries treats a non-object document as empty", () => {
  assert.deepEqual(parseAnnotationEntries(null), { annotations: {}, applied: 0, skipped: 0 });
  assert.deepEqual(parseAnnotationEntries("correct"), { annotations: {}, applied: 0, skipped: 0 });
  assert.deepEqual(parseAnnotationEntries([{ verdict: "correct" }]), { annotations: {}, applied: 0, skipped: 0 });
});

test("parsed annotations drive harvest proposals", () => {
  const parsed = parseAnnotationEntries({ "d-confirmed": "correct", "d-missing": "incorrect" });
  assert.equal(parsed.applied, 2);
  const proposals = buildHarvestProposals({
    records: [makeRecord({ decisionId: "d-confirmed" })],
    annotations: parsed.annotations,
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.status, "confirmed");
  assert.equal(proposals[0]!.provenance, "review-annotated");
});

test("filterProposalsByStatus keeps only the requested status", () => {
  const proposals = guardrailProposals();
  assert.equal(proposals.filter((proposal) => proposal.status === "confirmed").length, 2);
  assert.equal(proposals.filter((proposal) => proposal.status === "proposed").length, 1);

  assert.equal(filterProposalsByStatus(proposals, "all").length, 3);
  assert.equal(filterProposalsByStatus(proposals, "confirmed").length, 2);
  assert.equal(filterProposalsByStatus(proposals, "proposed").length, 1);
  assert.deepEqual(filterProposalsByStatus(proposals, "all"), proposals);
  assert.ok(filterProposalsByStatus(proposals, "confirmed").every((proposal) => proposal.status === "confirmed"));
});

test("buildFixtureDocument keeps confirmed proposals only and sorts by proposalId", () => {
  const proposals = guardrailProposals();
  const document = buildFixtureDocument("guardrails", proposals, NOW);
  assert.equal(document.version, 1);
  assert.equal(document.lane, "guardrails");
  assert.equal(document.generatedAt, NOW);
  assert.equal(document.proposals.length, 2);
  assert.ok(document.proposals.every((proposal) => proposal.status === "confirmed"));
  const ids = document.proposals.map((proposal) => proposal.proposalId);
  assert.deepEqual(ids, [...ids].sort((left, right) => left.localeCompare(right)));
});

test("buildFixtureDocument is order-independent and idempotent for the same inputs", () => {
  const proposals = guardrailProposals();
  const first = buildFixtureDocument("guardrails", proposals, NOW);
  const reversed = buildFixtureDocument("guardrails", [...proposals].reverse(), NOW);
  assert.deepEqual(reversed, first);
  assert.equal(serializeFixture(reversed), serializeFixture(first));
  assert.deepEqual(buildFixtureDocument("guardrails", first.proposals, NOW), first);
});

test("buildFixtureDocument never carries another lane's proposals", () => {
  const director = buildHarvestProposals({
    records: [makeRecord({
      decisionId: "director-1",
      lane: "director-selection",
      stateDigest: "director-state",
      selection: { selections: [{ candidateId: "beat-a" }] },
    })],
    annotations: { "director-1": { verdict: "correct" } },
  });
  assert.equal(director.length, 1);
  const document = buildFixtureDocument("guardrails", [...guardrailProposals(), ...director], NOW);
  assert.equal(document.proposals.length, 2);
  assert.ok(document.proposals.every((proposal) => proposal.lane === "guardrails"));
});

test("mergeFixtureDocuments adds new proposals and keeps the existing ones", () => {
  const existing = makeFixtureDocument("guardrails", [
    makeProposal({ proposalId: "b", note: "existing b" }),
    makeProposal({ proposalId: "a", note: "existing a" }),
  ]);
  const incoming = makeFixtureDocument("guardrails", [
    makeProposal({ proposalId: "d", note: "incoming d" }),
    makeProposal({ proposalId: "c", note: "incoming c" }),
  ], "2026-09-17T01:00:00.000Z");
  const merged = mergeFixtureDocuments(existing, incoming, "2026-09-18T00:00:00.000Z");
  assert.equal(merged.version, 1);
  assert.equal(merged.lane, "guardrails");
  assert.equal(merged.generatedAt, "2026-09-18T00:00:00.000Z");
  assert.deepEqual(
    merged.proposals.map((proposal) => proposal.proposalId),
    ["a", "b", "c", "d"],
  );
  assert.equal(merged.proposals.find((proposal) => proposal.proposalId === "a")?.note, "existing a");
});

test("mergeFixtureDocuments lets incoming proposals win on proposalId collisions", () => {
  const existing = makeFixtureDocument("guardrails", [makeProposal({ proposalId: "same", note: "old" })]);
  const incoming = makeFixtureDocument("guardrails", [makeProposal({ proposalId: "same", note: "new" })]);
  const merged = mergeFixtureDocuments(existing, incoming, "2026-09-18T00:00:00.000Z");
  assert.equal(merged.proposals.length, 1);
  assert.equal(merged.proposals[0]!.note, "new");
  assert.equal(merged.proposals[0]!.proposalId, "same");
});

test("mergeFixtureDocuments sorts the merged proposals by proposalId", () => {
  const existing = makeFixtureDocument("guardrails", [
    makeProposal({ proposalId: "z" }),
    makeProposal({ proposalId: "m" }),
  ]);
  const incoming = makeFixtureDocument("guardrails", [
    makeProposal({ proposalId: "a" }),
    makeProposal({ proposalId: "b" }),
  ]);
  const merged = mergeFixtureDocuments(existing, incoming, NOW);
  const ids = merged.proposals.map((proposal) => proposal.proposalId);
  assert.deepEqual(ids, ["a", "b", "m", "z"]);
  assert.deepEqual(ids, [...ids].sort((left, right) => left.localeCompare(right)));
  assert.equal(serializeFixture(mergeFixtureDocuments(existing, incoming, NOW)), serializeFixture(merged));
});

test("mergeFixtureDocuments throws when the lanes differ", () => {
  const existing = makeFixtureDocument("guardrails", [makeProposal({ proposalId: "a" })]);
  const incoming = makeFixtureDocument("adventure-selection", [makeProposal({ proposalId: "b", lane: "adventure-selection" })]);
  assert.throws(
    () => mergeFixtureDocuments(existing, incoming, NOW),
    /cannot merge fixtures from different lanes: guardrails and adventure-selection/,
  );
});

test("mergeFixtureDocuments keeps the existing proposals when incoming is empty", () => {
  const existing = makeFixtureDocument("guardrails", [
    makeProposal({ proposalId: "a" }),
    makeProposal({ proposalId: "b", status: "proposed" }),
  ]);
  const merged = mergeFixtureDocuments(existing, makeFixtureDocument("guardrails", []), "2026-09-18T00:00:00.000Z");
  assert.deepEqual(merged.proposals, existing.proposals);
  assert.equal(merged.version, existing.version);
  assert.equal(merged.lane, existing.lane);
  assert.equal(merged.generatedAt, "2026-09-18T00:00:00.000Z");
});

test("fixtureFilePath anchors to the repo root", () => {
  assert.equal(
    fixtureFilePath("guardrails", path.join("/repo", "root")),
    path.join("/repo", "root", "server", "test", "fixtures", "system-one-harvested", "guardrails.json"),
  );
  assert.match(fixtureFilePath("director-selection"), /server[/\\]test[/\\]fixtures[/\\]system-one-harvested[/\\]director-selection\.json$/);
});

test("serializeFixture round-trips and ends with a newline", () => {
  const document = buildFixtureDocument("guardrails", guardrailProposals(), NOW);
  const serialized = serializeFixture(document);
  assert.ok(serialized.endsWith("\n"));
  assert.deepEqual(JSON.parse(serialized), document);
});

test("buildHarvestOutput and serializeHarvestOutput produce the versioned document", () => {
  const proposals = filterProposalsByStatus(guardrailProposals(), "confirmed");
  const document = buildHarvestOutput({ lanes: ["guardrails"], proposals, generatedAt: NOW });
  assert.deepEqual(document, { version: 1, generatedAt: NOW, lanes: ["guardrails"], proposals });
  const serialized = serializeHarvestOutput(document);
  assert.ok(serialized.endsWith("\n"));
  assert.deepEqual(JSON.parse(serialized), document);
});

test("authorityByDecisionId keys compared Director rows by decision id", () => {
  const rows = compareDirectorAuthority([
    {
      decision: makeRecord({
        decisionId: "director-1",
        lane: "director-selection",
        turnId: "turn-1",
        selection: { selections: [{ candidateId: "beat-a" }] },
      }),
      authoritativeCandidateIds: ["beat-b"],
      authoritativeMissing: false,
    },
    {
      decision: makeRecord({ decisionId: "director-2", lane: "director-selection" }),
      authoritativeCandidateIds: null,
      authoritativeMissing: true,
    },
  ]);
  assert.deepEqual(authorityByDecisionId(rows), {
    "director-1": { agreement: "disagree", authoritativeCandidateIds: ["beat-b"] },
    "director-2": { agreement: "unknown", authoritativeCandidateIds: null },
  });
});

test("authority rows feed provider-disagreement proposals", () => {
  const authorities: DirectorDecisionAuthority[] = [
    {
      decision: makeRecord({
        decisionId: "director-1",
        lane: "director-selection",
        selection: { selections: [] },
      }),
      authoritativeCandidateIds: ["beat-b"],
      authoritativeMissing: false,
    },
  ];
  const rows = compareDirectorAuthority(authorities);
  const proposals = buildHarvestProposals({
    records: authorities.map((entry) => entry.decision),
    authority: authorityByDecisionId(rows),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.provenance, "provider-disagreement");
  assert.equal(proposals[0]!.status, "proposed");
  assert.deepEqual(proposals[0]!.expected, { selections: ["beat-b"] });
});

test("renderHarvestSummary renders per-lane totals plus annotation and authority status", () => {
  const proposals = guardrailProposals();
  const input = {
    summary: summarizeHarvest(proposals),
    generatedAt: NOW,
    source: "/tmp/velvet.sqlite",
    lanes: ["guardrails"],
    annotationCounts: { applied: 2, skipped: 1 },
    annotationsSource: "review.json",
    authority: { rowsRead: 3, disagreements: 1 },
  };
  const rendered = renderHarvestSummary(input);
  assert.match(rendered, /System One harvest summary/);
  assert.match(rendered, /Lane +Confirmed +Proposed +Total/);
  assert.match(rendered, /guardrails +2 +1 +3/);
  assert.match(rendered, /Total +2 +1 +3/);
  assert.match(rendered, /By provenance: review-annotated 3/);
  assert.match(rendered, /Annotations: applied 2, skipped 1 \(review\.json\)/);
  assert.match(rendered, /Authority: read 3 Director decisions \(1 disagreement\)/);
  assert.equal(renderHarvestSummary(input), rendered);
});

test("renderHarvestSummary shows zero lanes, no annotations, and unread authority", () => {
  const rendered = renderHarvestSummary({
    summary: summarizeHarvest([]),
    generatedAt: NOW,
    source: "/tmp/velvet.sqlite",
    lanes: [...HARVEST_LANES],
  });
  assert.match(rendered, /Lanes read: director-selection, adventure-selection, guardrails/);
  assert.match(rendered, /director-selection +0 +0 +0/);
  assert.match(rendered, /adventure-selection +0 +0 +0/);
  assert.match(rendered, /guardrails +0 +0 +0/);
  assert.match(rendered, /Annotations: none/);
  assert.match(rendered, /Authority: not read/);
  assert.match(rendered, /Total +0 +0 +0/);
});
