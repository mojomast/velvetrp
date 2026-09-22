import assert from "node:assert/strict";
import test from "node:test";
import { MECHANIC_FAMILIES } from "../synthetic-player-harness.js";
import {
  PRODUCTION_ACTION_KIND_FAMILIES,
  PRODUCTION_FAMILY_ORDER,
  PRODUCTION_FAMILY_SOURCE,
  PRODUCTION_FAMILY_UNKNOWN,
  PRODUCTION_PATH_DEFINITIONS,
  PRODUCTION_PATH_HONESTY_NOTES,
  buildProductionPathReport,
  buildProviderPicks,
  classifyPickCommit,
  computeAlignmentPairs,
  countAlignment,
  countConfirmations,
  defaultProductionJsonPath,
  familyForProductionKind,
  familyKeyForProductionKind,
  parseDecisionState,
  parseProductionPathArgs,
  parseProductionSelection,
  productionAnomalies,
  renderProductionPathMarkdown,
  resolveProductionWorldDatabasePath,
  serializeProductionPathReport,
  summarizeFamilyMetrics,
  summarizeProductionPath,
  toLaneExecution,
  toLaneProposal,
  toProductionDecision,
} from "../evaluate-system-one-production-path.js";
import type {
  LaneExecution,
  LaneProposal,
  ProviderCandidatePick,
  ProductionDecision,
  ProductionWorldDataset,
  ProviderCandidateCall,
  TurnSourceRow,
} from "../evaluate-system-one-production-path.js";

// -------------------------------------------------------------------------------------------------
// Synthetic row builders (the test suite needs no database fixture)
// -------------------------------------------------------------------------------------------------

interface CandidateSpec {
  candidateId: string;
  kind: string | null;
}

interface DecisionSpec {
  decisionId?: string;
  turnId?: string | null;
  band?: string;
  method?: string;
  pick?: string | null;
  topSignal?: number | null;
  candidates?: readonly CandidateSpec[];
  declaration?: string | null;
  turn?: TurnSourceRow | null;
  createdAt?: string;
  shadow?: boolean;
  stateJson?: string;
  selectionJson?: string;
}

const DEFAULT_CANDIDATES: readonly CandidateSpec[] = [
  { candidateId: "travel-candidate:1", kind: "exact_actor_travel.select" },
];

function makeDecision(spec: DecisionSpec = {}): ProductionDecision {
  const method = spec.method ?? "defer";
  const selectionJson = spec.selectionJson ?? JSON.stringify({
    method,
    selection: method === "choice" && spec.pick !== null && spec.pick !== undefined
      ? { candidateId: spec.pick, digest: "digest" }
      : null,
    topSignal: spec.topSignal ?? null,
  });
  const candidates = spec.candidates ?? DEFAULT_CANDIDATES;
  const stateJson = spec.stateJson ?? JSON.stringify({
    declaration: spec.declaration ?? "I make my move.",
    candidates: candidates.map((candidate) => ({ ...candidate, label: candidate.candidateId })),
  });
  const turn = spec.turn === undefined
    ? { declaration: spec.declaration ?? "I make my move.", state: "completed", mode: "exploration" }
    : spec.turn;
  return toProductionDecision("synthetic-world", {
    decisionId: spec.decisionId ?? "decision-1",
    turnId: spec.turnId ?? "turn-1",
    band: spec.band ?? "act",
    selectionJson,
    stateJson,
    shadow: spec.shadow ?? true,
    fallbackUsed: false,
    createdAt: spec.createdAt ?? "2026-01-01T00:00:00.000Z",
  }, turn);
}

interface ProposalSpec {
  proposalId?: string;
  turnId?: string | null;
  decisionId?: string | null;
  actionKind?: string;
  candidateId?: string | null;
  requiresConfirmation?: boolean | null;
  confirmation?: string | null;
  executed?: boolean;
}

function makeProposal(spec: ProposalSpec = {}): LaneProposal {
  return toLaneProposal("synthetic-world", {
    proposalId: spec.proposalId ?? "proposal-1",
    turnId: spec.turnId ?? "turn-1",
    decisionId: spec.decisionId === undefined ? "decision-1" : spec.decisionId,
    actionKind: spec.actionKind ?? "rest",
    candidateId: spec.candidateId === undefined ? "rest-candidate:1" : spec.candidateId,
    requiresConfirmation: spec.requiresConfirmation === undefined ? true : spec.requiresConfirmation,
    toolName: "exact_rest.select",
    confirmation: spec.confirmation === undefined ? null : spec.confirmation,
    executed: spec.executed ?? false,
    boundAt: "2026-01-01T00:00:00.000Z",
  });
}

interface ExecutionSpec {
  turnId?: string | null;
  decisionId?: string | null;
  actionKind?: string;
  candidateId?: string | null;
  commandId?: string | null;
  source?: "exact-action" | "check";
}

function makeExecution(spec: ExecutionSpec = {}): LaneExecution {
  return toLaneExecution("synthetic-world", spec.source ?? "exact-action", {
    turnId: spec.turnId ?? "turn-1",
    decisionId: spec.decisionId === undefined ? "decision-1" : spec.decisionId,
    actionKind: spec.actionKind ?? "rest",
    candidateId: spec.candidateId === undefined ? "rest-candidate:1" : spec.candidateId,
    commandId: spec.commandId ?? "command-1",
    occurredAt: null,
  });
}

function makeProviderPick(overrides: Partial<ProviderCandidatePick> = {}): ProviderCandidatePick {
  return {
    world: "synthetic-world",
    turnId: "turn-1",
    candidateId: "power-candidate:1",
    toolName: "exact_power_use.select",
    family: "power",
    source: "provider-response",
    additionalCalls: 0,
    ...overrides,
  };
}

function makeDataset(world: string, overrides: Partial<ProductionWorldDataset> = {}): ProductionWorldDataset {
  return {
    world,
    databasePath: `/tmp/${world}/velvet.sqlite`,
    decisions: [],
    laneExecutions: [],
    laneProposals: [],
    providerPicks: [],
    notices: [],
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------------
// Family mapping
// -------------------------------------------------------------------------------------------------

test("PRODUCTION_FAMILY_ORDER is the harness's 11 families plus unknown last", () => {
  assert.equal(PRODUCTION_FAMILY_ORDER.length, 12);
  assert.deepEqual(PRODUCTION_FAMILY_ORDER.slice(0, MECHANIC_FAMILIES.length), [...MECHANIC_FAMILIES]);
  assert.equal(PRODUCTION_FAMILY_ORDER.at(-1), PRODUCTION_FAMILY_UNKNOWN);
  assert.equal(PRODUCTION_FAMILY_UNKNOWN, "unknown");
});

test("familyForProductionKind maps candidate kinds, family ids, and v56 action kinds", () => {
  assert.equal(familyForProductionKind("exact_actor_travel.select"), "travel");
  assert.equal(familyForProductionKind("exact_srd_check.select"), "srd-check");
  assert.equal(familyForProductionKind("exact_inventory_action.select"), "inventory");
  assert.equal(familyForProductionKind("exact_vendor_commerce.select"), "commerce");
  assert.equal(familyForProductionKind("exact_quest_objective.select"), "quest-objective");
  assert.equal(familyForProductionKind("exact_progression_apply.select"), "progression");
  assert.equal(familyForProductionKind("travel"), "travel");
  assert.equal(familyForProductionKind("check"), "srd-check");
  assert.equal(familyForProductionKind("quest-accept"), "quest-lifecycle");
  assert.equal(familyForProductionKind("combat-power"), "combat-power");
  assert.equal(familyForProductionKind("mystery.kind"), null);
  assert.equal(familyForProductionKind(""), null);
  assert.equal(familyForProductionKind(null), null);
  assert.equal(familyForProductionKind(undefined), null);
  assert.equal(familyKeyForProductionKind("mystery.kind"), PRODUCTION_FAMILY_UNKNOWN);
  assert.equal(familyKeyForProductionKind(null), PRODUCTION_FAMILY_UNKNOWN);
  assert.equal(PRODUCTION_ACTION_KIND_FAMILIES["quest-reward"], "quest-lifecycle");
  assert.equal(PRODUCTION_ACTION_KIND_FAMILIES["progression"], "progression");
});

// -------------------------------------------------------------------------------------------------
// Tolerant parsing
// -------------------------------------------------------------------------------------------------

test("parseDecisionState tolerates malformed JSON, missing kinds, and skipped entries", () => {
  const malformed = parseDecisionState("{");
  assert.equal(malformed.malformed, true);
  assert.deepEqual(malformed.candidates, []);

  const empty = parseDecisionState(null);
  assert.equal(empty.malformed, false);
  assert.deepEqual(empty.candidates, []);

  const parsed = parseDecisionState(JSON.stringify({
    declaration: "I travel.",
    candidates: [
      { candidateId: "c1", kind: "exact_actor_travel.select", label: "Travel" },
      { candidateId: "c2", kind: null },
      { kind: "exact_rest.select" },
      "not-an-object",
    ],
  }));
  assert.equal(parsed.declaration, "I travel.");
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.candidateId), ["c1", "c2"]);
  assert.equal(parsed.candidates[0]!.kind, "exact_actor_travel.select");
  assert.equal(parsed.skippedCandidates, 2);
  assert.equal(parsed.malformed, false);
});

test("parseProductionSelection reads method, pick, and topSignal and tolerates malformed JSON", () => {
  const choice = parseProductionSelection(JSON.stringify({
    method: "choice",
    selection: { candidateId: "c1", digest: "d" },
    topSignal: 0.87,
  }));
  assert.deepEqual(choice, { method: "choice", candidateId: "c1", topSignal: 0.87, malformed: false });

  const defer = parseProductionSelection(JSON.stringify({ method: "defer", selection: null, topSignal: null }));
  assert.deepEqual(defer, { method: "defer", candidateId: null, topSignal: null, malformed: false });

  const odd = parseProductionSelection(JSON.stringify({ method: "defer", selection: null, topSignal: "high" }));
  assert.equal(odd.topSignal, null);

  assert.equal(parseProductionSelection("[").malformed, true);
  assert.equal(parseProductionSelection("{").candidateId, null);
});

test("toProductionDecision joins turn fields, resolves the pick family, and falls back to the state declaration", () => {
  const joined = makeDecision({
    decisionId: "d1",
    turnId: "t1",
    band: "confirm",
    method: "choice",
    pick: "travel-candidate:1",
    topSignal: 0.42,
    candidates: [
      { candidateId: "travel-candidate:1", kind: "exact_actor_travel.select" },
      { candidateId: "check-candidate:1", kind: "exact_srd_check.select" },
    ],
  });
  assert.equal(joined.turnJoined, true);
  assert.equal(joined.turnState, "completed");
  assert.equal(joined.turnMode, "exploration");
  assert.equal(joined.band, "confirm");
  assert.deepEqual(joined.families, ["travel", "srd-check"]);
  assert.deepEqual(joined.pick, {
    candidateId: "travel-candidate:1",
    family: "travel",
    resolution: "shortlist-kind",
    kind: "exact_actor_travel.select",
  });

  const unjoined = makeDecision({
    declaration: "I rest by the fire.",
    turn: null,
    method: "defer",
  });
  assert.equal(unjoined.turnJoined, false);
  assert.equal(unjoined.declaration, "I rest by the fire.");
  assert.equal(unjoined.pick, null);
});

test("a pick outside the shortlist and an unmapped kind both resolve to unknown", () => {
  const outside = makeDecision({
    method: "choice",
    pick: "ghost-candidate:1",
    candidates: [{ candidateId: "travel-candidate:1", kind: "exact_actor_travel.select" }],
  });
  assert.equal(outside.pick!.family, PRODUCTION_FAMILY_UNKNOWN);
  assert.equal(outside.pick!.resolution, "missing-from-shortlist");

  const unmapped = makeDecision({
    method: "choice",
    pick: "odd-candidate:1",
    candidates: [{ candidateId: "odd-candidate:1", kind: "mystery.kind" }],
  });
  assert.equal(unmapped.pick!.family, PRODUCTION_FAMILY_UNKNOWN);
  assert.equal(unmapped.pick!.resolution, "unmapped-kind");
});

// -------------------------------------------------------------------------------------------------
// Reach, bands, defer rate, picks, and signals
// -------------------------------------------------------------------------------------------------

test("summarizeFamilyMetrics counts reach, bands, defer rate, picks, and signal statistics", () => {
  const decisions = [
    makeDecision({
      decisionId: "d1",
      turnId: "t1",
      band: "act",
      method: "choice",
      pick: "travel-candidate:1",
      topSignal: 0.9,
      candidates: [
        { candidateId: "travel-candidate:1", kind: "exact_actor_travel.select" },
        { candidateId: "check-candidate:1", kind: "exact_srd_check.select" },
      ],
    }),
    makeDecision({
      decisionId: "d2",
      turnId: "t2",
      band: "confirm",
      method: "choice",
      pick: "travel-candidate:2",
      topSignal: 0.6,
      candidates: [{ candidateId: "travel-candidate:2", kind: "exact_actor_travel.select" }],
    }),
    makeDecision({
      decisionId: "d3",
      turnId: "t3",
      band: "fallback",
      method: "defer",
      candidates: [{ candidateId: "check-candidate:3", kind: "exact_srd_check.select" }],
    }),
  ];
  const rows = summarizeFamilyMetrics({
    decisions,
    laneExecutions: [],
    laneProposals: [],
    alignmentPairs: [],
  });
  assert.equal(rows.length, 12);
  const byFamily = new Map(rows.map((row) => [row.family, row]));

  const travel = byFamily.get("travel")!;
  assert.equal(travel.decisionsTotal, 3);
  assert.equal(travel.advertised, 2);
  assert.equal(travel.reachRate, 2 / 3);
  assert.equal(travel.act, 1);
  assert.equal(travel.confirm, 1);
  assert.equal(travel.fallback, 0);
  assert.equal(travel.defer, 0);
  assert.equal(travel.deferRate, 0);
  assert.equal(travel.picks, 2);
  assert.equal(travel.signalMean, 0.75);
  assert.equal(travel.signalMedian, 0.75);

  const srd = byFamily.get("srd-check")!;
  assert.equal(srd.advertised, 2);
  assert.equal(srd.act, 1);
  assert.equal(srd.confirm, 0);
  assert.equal(srd.fallback, 1);
  assert.equal(srd.defer, 1);
  assert.equal(srd.deferRate, 0.5);
  assert.equal(srd.picks, 0);
  assert.equal(srd.signalMean, null);
  assert.equal(srd.signalMedian, null);

  const inventory = byFamily.get("inventory")!;
  assert.equal(inventory.advertised, 0);
  assert.equal(inventory.reachRate, 0);
  assert.equal(inventory.deferRate, 0);
  assert.equal(inventory.unknownBand, 0);
});

test("median uses the average of the middle pair for an even sample", () => {
  const candidate = (id: string, signal: number): DecisionSpec => ({
    decisionId: id,
    method: "choice",
    pick: `${id}-candidate`,
    topSignal: signal,
    candidates: [{ candidateId: `${id}-candidate`, kind: "exact_actor_travel.select" }],
  });
  const rows = summarizeFamilyMetrics({
    decisions: [
      makeDecision(candidate("d1", 0.2)),
      makeDecision(candidate("d2", 0.8)),
      makeDecision(candidate("d3", 0.5)),
      makeDecision(candidate("d4", 0.4)),
    ],
    laneExecutions: [],
    laneProposals: [],
    alignmentPairs: [],
  });
  const travel = rows.find((row) => row.family === "travel")!;
  assert.equal(travel.picks, 4);
  assert.equal(travel.signalMean, 0.475);
  assert.equal(travel.signalMedian, 0.45);
});

// -------------------------------------------------------------------------------------------------
// Commit classification
// -------------------------------------------------------------------------------------------------

test("classifyPickCommit separates committed, advisory act, awaiting confirm, and other", () => {
  const committedDecision = makeDecision({
    decisionId: "d-committed",
    band: "act",
    method: "choice",
    pick: "rest-candidate:1",
    candidates: [{ candidateId: "rest-candidate:1", kind: "exact_rest.select" }],
  });
  const committedExecution = makeExecution({ decisionId: "d-committed", actionKind: "rest", candidateId: "rest-candidate:1" });
  assert.equal(classifyPickCommit(committedDecision, [committedExecution]), "committed");

  // A candidate-id match commits even when the execution's action kind resolves to unknown.
  const idMatchExecution = makeExecution({
    decisionId: "d-committed",
    actionKind: "mystery-action",
    candidateId: "rest-candidate:1",
  });
  assert.equal(classifyPickCommit(committedDecision, [idMatchExecution]), "committed");

  const advisory = makeDecision({
    decisionId: "d-advisory",
    band: "act",
    method: "choice",
    pick: "travel-candidate:1",
  });
  assert.equal(classifyPickCommit(advisory, [committedExecution]), "advisory-act");

  const awaiting = makeDecision({
    decisionId: "d-awaiting",
    band: "confirm",
    method: "choice",
    pick: "travel-candidate:1",
  });
  assert.equal(classifyPickCommit(awaiting, []), "awaiting-confirm");

  const other = makeDecision({ decisionId: "d-other", band: "fallback", method: "choice", pick: "travel-candidate:1" });
  assert.equal(classifyPickCommit(other, []), "other-uncommitted");

  const defer = makeDecision({ decisionId: "d-defer", method: "defer" });
  assert.equal(classifyPickCommit(defer, [committedExecution]), null);

  const mismatchedDecision = makeExecution({ decisionId: "d-someone-else", actionKind: "rest" });
  assert.equal(classifyPickCommit(advisory, [mismatchedDecision]), "advisory-act");
});

test("summarizeFamilyMetrics counts committed and advisory picks per family", () => {
  const decisions = [
    makeDecision({ decisionId: "d1", method: "choice", pick: "rest-candidate:1", candidates: [{ candidateId: "rest-candidate:1", kind: "exact_rest.select" }] }),
    makeDecision({ decisionId: "d2", method: "choice", pick: "rest-candidate:2", candidates: [{ candidateId: "rest-candidate:2", kind: "exact_rest.select" }] }),
    makeDecision({ decisionId: "d3", method: "choice", pick: "travel-candidate:3", candidates: [{ candidateId: "travel-candidate:3", kind: "exact_actor_travel.select" }] }),
  ];
  const executions = [makeExecution({ decisionId: "d1", actionKind: "rest", candidateId: "rest-candidate:1" })];
  const rest = summarizeFamilyMetrics({ decisions, laneExecutions: executions, laneProposals: [], alignmentPairs: [] })
    .find((row) => row.family === "rest")!;
  assert.equal(rest.picks, 2);
  assert.equal(rest.committed, 1);
  assert.equal(rest.advisoryAct, 1);
  assert.equal(rest.laneExecutions, 1);
  assert.equal(rest.awaitingConfirm, 0);
});

// -------------------------------------------------------------------------------------------------
// Provider alignment
// -------------------------------------------------------------------------------------------------

test("buildProviderPicks keeps the first call in source precedence and counts extras", () => {
  const calls: ProviderCandidateCall[] = [
    { turnId: "t1", candidateId: "check-candidate:1", toolName: "exact_srd_check.select", source: "provider-response", order: 0 },
    { turnId: "t1", candidateId: "travel-candidate:1", toolName: "exact_actor_travel.select", source: "provider-response", order: 1 },
    { turnId: "t1", candidateId: "power-candidate:1", toolName: "exact_power_use.select", source: "tool-call", order: 9 },
    { turnId: "t2", candidateId: "rest-candidate:1", toolName: null, source: "provider-binding", order: 0, actionKind: "rest" },
    { turnId: "t2", candidateId: "rest-candidate:0", toolName: null, source: "provider-binding", order: 0, actionKind: "mystery" },
  ];
  const picks = buildProviderPicks("synthetic-world", calls);
  assert.equal(picks.length, 2);
  const t1 = picks.find((pick) => pick.turnId === "t1")!;
  assert.equal(t1.candidateId, "power-candidate:1");
  assert.equal(t1.source, "tool-call");
  assert.equal(t1.family, "power");
  assert.equal(t1.additionalCalls, 2);
  const t2 = picks.find((pick) => pick.turnId === "t2")!;
  assert.equal(t2.family, "rest");
  assert.equal(t2.additionalCalls, 1);
});

test("computeAlignmentPairs classifies same id, same family, divergence, and unknowns", () => {
  const decisions = [
    makeDecision({ decisionId: "d-same-id", turnId: "t1", method: "choice", pick: "rest-candidate:1", candidates: [{ candidateId: "rest-candidate:1", kind: "exact_rest.select" }] }),
    makeDecision({ decisionId: "d-same-family", turnId: "t2", method: "choice", pick: "rest-candidate:2", candidates: [{ candidateId: "rest-candidate:2", kind: "exact_rest.select" }] }),
    makeDecision({ decisionId: "d-divergent", turnId: "t3", method: "choice", pick: "travel-candidate:1" }),
    makeDecision({ decisionId: "d-unknown-lane", turnId: "t4", method: "choice", pick: "odd-candidate:1", candidates: [{ candidateId: "odd-candidate:1", kind: "mystery.kind" }] }),
    makeDecision({ decisionId: "d-no-provider", turnId: "t5", method: "choice", pick: "travel-candidate:2" }),
    makeDecision({ decisionId: "d-defer", turnId: "t6", method: "defer", candidates: [{ candidateId: "travel-candidate:3", kind: "exact_actor_travel.select" }] }),
  ];
  const picks = [
    makeProviderPick({ turnId: "t1", candidateId: "rest-candidate:1", family: "rest" }),
    makeProviderPick({ turnId: "t2", candidateId: "rest-candidate:other", family: "rest" }),
    makeProviderPick({ turnId: "t3", candidateId: "check-candidate:1", toolName: "exact_srd_check.select", family: "srd-check" }),
    makeProviderPick({ turnId: "t4", candidateId: "travel-candidate:9", family: "travel" }),
    makeProviderPick({ turnId: "t6", candidateId: "travel-candidate:3", family: "travel" }),
  ];
  const pairs = computeAlignmentPairs(decisions, picks);
  assert.equal(pairs.length, 4);
  assert.deepEqual(
    pairs.map((pair) => [pair.decisionId, pair.relation]),
    [
      ["d-same-id", "same-id"],
      ["d-same-family", "same-family"],
      ["d-divergent", "divergent"],
      ["d-unknown-lane", "unknown-family"],
    ],
  );
  assert.deepEqual(countAlignment(pairs), {
    compared: 4,
    sameId: 1,
    sameFamily: 1,
    divergent: 1,
    unknownFamily: 1,
  });

  const rows = summarizeFamilyMetrics({ decisions, laneExecutions: [], laneProposals: [], alignmentPairs: pairs });
  const rest = rows.find((row) => row.family === "rest")!;
  assert.deepEqual(rest.alignment, { compared: 2, sameId: 1, sameFamily: 1, divergent: 0, unknownFamily: 0 });
  const travel = rows.find((row) => row.family === "travel")!;
  assert.deepEqual(travel.alignment, { compared: 1, sameId: 0, sameFamily: 0, divergent: 1, unknownFamily: 0 });
  const unknown = rows.find((row) => row.family === PRODUCTION_FAMILY_UNKNOWN)!;
  assert.deepEqual(unknown.alignment, { compared: 1, sameId: 0, sameFamily: 0, divergent: 0, unknownFamily: 1 });
});

// -------------------------------------------------------------------------------------------------
// Confirmation outcomes
// -------------------------------------------------------------------------------------------------

test("countConfirmations counts approved, rejected, pending, not-required, unknown, and other", () => {
  const proposals = [
    makeProposal({ proposalId: "p-approved-executed", confirmation: "approved", executed: true }),
    makeProposal({ proposalId: "p-approved-pending-execution", confirmation: "approved", executed: false }),
    makeProposal({ proposalId: "p-rejected", confirmation: "rejected" }),
    makeProposal({ proposalId: "p-pending", confirmation: null }),
    makeProposal({ proposalId: "p-not-required", requiresConfirmation: false, confirmation: "approved" }),
    makeProposal({ proposalId: "p-no-join", requiresConfirmation: null }),
    makeProposal({ proposalId: "p-expired", confirmation: "expired" }),
  ];
  assert.deepEqual(countConfirmations(proposals), {
    approved: 2,
    rejected: 1,
    pending: 1,
    other: 1,
    unknown: 1,
    notRequired: 1,
    approvedNotExecuted: 1,
    executed: 1,
  });
});

test("summarizeFamilyMetrics attributes proposals and confirmations to the action-kind family", () => {
  const decisions = [
    makeDecision({ decisionId: "d1", method: "choice", pick: "rest-candidate:1", candidates: [{ candidateId: "rest-candidate:1", kind: "exact_rest.select" }] }),
    makeDecision({ decisionId: "d2", method: "choice", pick: "quest-candidate:1", candidates: [{ candidateId: "quest-candidate:1", kind: "exact_quest_lifecycle.select" }] }),
  ];
  const proposals = [
    makeProposal({ proposalId: "p1", decisionId: "d1", actionKind: "rest", confirmation: "approved", executed: true }),
    makeProposal({ proposalId: "p2", decisionId: "d1", actionKind: "rest", confirmation: null }),
    makeProposal({ proposalId: "p3", decisionId: "d2", actionKind: "quest-accept", candidateId: "quest-candidate:1", confirmation: "rejected" }),
  ];
  const rows = summarizeFamilyMetrics({ decisions, laneExecutions: [], laneProposals: proposals, alignmentPairs: [] });
  const rest = rows.find((row) => row.family === "rest")!;
  assert.equal(rest.laneProposals, 2);
  assert.equal(rest.confirmations.approved, 1);
  assert.equal(rest.confirmations.pending, 1);
  assert.equal(rest.confirmations.approvedNotExecuted, 0);
  const quest = rows.find((row) => row.family === "quest-lifecycle")!;
  assert.equal(quest.laneProposals, 1);
  assert.equal(quest.confirmations.rejected, 1);
});

// -------------------------------------------------------------------------------------------------
// World summary and anomalies
// -------------------------------------------------------------------------------------------------

test("summarizeProductionPath rolls up totals and recomputes rates over the scope", () => {
  const decisions = [
    makeDecision({ decisionId: "d1", turnId: "t1", method: "choice", pick: "travel-candidate:1", shadow: true }),
    makeDecision({ decisionId: "d2", turnId: "t1", method: "defer", candidates: [] }),
    makeDecision({ decisionId: "d3", turnId: "t2", method: "choice", pick: "ghost-candidate:1", candidates: [], turn: null }),
  ];
  const summary = summarizeProductionPath({
    world: "synthetic-world",
    decisions,
    laneExecutions: [makeExecution({ decisionId: "d1", actionKind: "rest", candidateId: "rest-candidate:99" })],
    laneProposals: [makeProposal({ proposalId: "p1", decisionId: "d1", candidateId: "rest-candidate:99" })],
    providerPicks: [makeProviderPick({ turnId: "t1", candidateId: "travel-candidate:1", family: "travel" })],
  });
  assert.equal(summary.world, "synthetic-world");
  assert.equal(summary.totals.decisions, 3);
  assert.equal(summary.totals.shadowDecisions, 3);
  assert.equal(summary.totals.decisionsWithCandidates, 1);
  assert.equal(summary.totals.decisionsWithoutCandidates, 2);
  assert.equal(summary.totals.decisionsWithUnjoinedTurns, 1);
  assert.equal(summary.totals.distinctTurns, 2);
  assert.equal(summary.totals.multiDecisionTurns, 1);
  assert.equal(summary.totals.picks, 2);
  assert.equal(summary.totals.picksMissingFromShortlist, 1);
  assert.equal(summary.totals.picksUnknownFamily, 1);
  assert.equal(summary.totals.laneProposals, 1);
  assert.equal(summary.totals.laneExecutions, 1);
  assert.equal(summary.totals.proposalCandidateMismatches, 1);
  assert.equal(summary.totals.executionCandidateMismatches, 1);
  assert.equal(summary.totals.alignment.compared, 1);
  assert.equal(summary.totals.alignment.sameId, 1);
});

test("productionAnomalies reports unjoined turns, malformed rows, out-of-shortlist picks, and mismatches", () => {
  const decisions = [
    makeDecision({ decisionId: "d1", method: "choice", pick: "ghost-candidate:1", candidates: [], turn: null }),
    makeDecision({ decisionId: "d2", stateJson: "{" }),
    makeDecision({ decisionId: "d3", selectionJson: "[" }),
  ];
  const anomalies = productionAnomalies({
    decisions,
    laneExecutions: [],
    laneProposals: [],
    providerPicks: [makeProviderPick({ turnId: "t9", candidateId: "odd:1", toolName: null, family: PRODUCTION_FAMILY_UNKNOWN })],
  });
  const joined = anomalies.join("\n");
  assert.match(joined, /no joined adventure_turns row/);
  assert.match(joined, /malformed state_json/);
  assert.match(joined, /malformed selection_json/);
  assert.match(joined, /shortlist did not advertise/);
  assert.match(joined, /no canonical family/);
});

// -------------------------------------------------------------------------------------------------
// Report document, rendering, and CLI
// -------------------------------------------------------------------------------------------------

test("buildProductionPathReport aggregates across worlds and keeps world sections in order", () => {
  const worldA = makeDataset("world-a", {
    decisions: [makeDecision({ decisionId: "a1", turnId: "a-t1", method: "choice", pick: "travel-candidate:1" })],
    providerPicks: [makeProviderPick({ turnId: "a-t1", candidateId: "travel-candidate:1", family: "travel" })],
    notices: ["table nope_v99 is absent; treating it as empty"],
  });
  const worldB = makeDataset("world-b", {
    decisions: [
      makeDecision({ decisionId: "b1", turnId: "b-t1", method: "defer", candidates: [] }),
      makeDecision({ decisionId: "b2", turnId: "b-t2", method: "choice", pick: "rest-candidate:1", candidates: [{ candidateId: "rest-candidate:1", kind: "exact_rest.select" }] }),
    ],
  });
  const report = buildProductionPathReport({ worlds: [worldA, worldB], generatedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(report.version, 1);
  assert.equal(report.generatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(report.aggregate.totals.decisions, 3);
  assert.equal(report.aggregate.totals.picks, 2);
  assert.equal(report.aggregate.totals.alignment.compared, 1);
  assert.deepEqual(report.worlds.map((world) => world.summary.world), ["world-a", "world-b"]);
  assert.equal(report.worlds[0]!.notices.length, 1);
  assert.equal(report.worlds[0]!.alignmentPairs.length, 1);
  assert.equal(report.worlds[1]!.summary.totals.decisions, 2);
});

test("renderProductionPathMarkdown is deterministic and carries the definitions, honesty notes, and per-family rows", () => {
  const dataset = makeDataset("synthetic-world", {
    decisions: [
      makeDecision({ decisionId: "d1", method: "choice", pick: "travel-candidate:1", topSignal: 0.5 }),
      makeDecision({ decisionId: "d2", method: "defer", candidates: [] }),
    ],
    laneProposals: [makeProposal({ proposalId: "p1", confirmation: "approved" })],
    notices: ["table nope_v99 is absent; treating it as empty"],
  });
  const report = buildProductionPathReport({ worlds: [dataset], generatedAt: "2026-01-02T03:04:05.000Z" });
  const first = renderProductionPathMarkdown(report);
  const second = renderProductionPathMarkdown(report);
  assert.equal(first, second);
  assert.match(first, /# System One production-path evaluation — adventure-selection/);
  assert.match(first, /## Definitions/);
  assert.match(first, /## Honesty notes/);
  assert.match(first, /## Aggregate \(all worlds\)/);
  assert.match(first, /## World: `synthetic-world`/);
  assert.match(first, /### Notices/);
  assert.match(first, /table nope_v99 is absent/);
  assert.match(first, /\| Family \| Advertised \|/);
  for (const family of PRODUCTION_FAMILY_ORDER) assert.ok(first.includes(`| ${family} |`), `missing row ${family}`);
  for (const note of PRODUCTION_PATH_HONESTY_NOTES) assert.ok(first.includes(note), `missing honesty note: ${note}`);
  for (const definition of PRODUCTION_PATH_DEFINITIONS) assert.ok(first.includes(definition), `missing definition: ${definition}`);
  assert.ok(first.includes(PRODUCTION_FAMILY_SOURCE));
  assert.match(first, /Provider alignment: compared 0/);
});

test("serializeProductionPathReport emits stable JSON with the same aggregate as the report", () => {
  const dataset = makeDataset("synthetic-world", {
    decisions: [makeDecision({ decisionId: "d1", method: "defer", candidates: [] })],
  });
  const report = buildProductionPathReport({ worlds: [dataset], generatedAt: "2026-01-02T03:04:05.000Z" });
  const serialized = serializeProductionPathReport(report);
  assert.equal(serialized, serializeProductionPathReport(report));
  assert.ok(serialized.endsWith("\n"));
  const parsed = JSON.parse(serialized) as typeof report;
  assert.equal(parsed.version, 1);
  assert.equal(parsed.aggregate.totals.decisions, 1);
  assert.equal(parsed.worlds[0]!.summary.world, "synthetic-world");
});

test("parseProductionPathArgs accepts repeated worlds, equals forms, and defaults the JSON sidecar", () => {
  assert.deepEqual(parseProductionPathArgs(["--world", ".velvet/a", "--world=.velvet/b"]), {
    worlds: [".velvet/a", ".velvet/b"],
    out: "docs/system-one-production-path-evaluation.md",
    json: "docs/system-one-production-path-evaluation.json",
    help: false,
  });
  assert.deepEqual(parseProductionPathArgs(["--world", ".velvet/a", "--out", "docs/x.md", "--json", "docs/y.json"]).json, "docs/y.json");
  assert.equal(defaultProductionJsonPath("docs/x.md"), "docs/x.json");
  assert.equal(defaultProductionJsonPath("docs/x.txt"), "docs/x.txt.json");
  assert.throws(() => parseProductionPathArgs([]), /--world is required/);
  assert.throws(() => parseProductionPathArgs(["--world", "a", "--nope"]), /unknown argument/);
  assert.throws(() => parseProductionPathArgs(["--world"]), /--world requires a path/);
  assert.deepEqual(parseProductionPathArgs(["--help"]).help, true);
});

test("resolveProductionWorldDatabasePath appends velvet.sqlite for directories only", () => {
  assert.equal(resolveProductionWorldDatabasePath(".velvet/x", "/root"), "/root/.velvet/x/velvet.sqlite");
  assert.equal(resolveProductionWorldDatabasePath("/abs/world.sqlite", "/root"), "/abs/world.sqlite");
});
