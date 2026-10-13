import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createPublicContextDiagnosticManifest, planRun, PUBLIC_CONTEXT_OVERLAY_TEMPLATE_VERSION, runPipeline, scenarioSpec, twinSourceDigest, type PipelineOptions, type ScheduledTwinInput, type TokenizerPort } from "../src/generate.js";
import { parsePublicObservationSource, publicContextDiagnosticManifestBody, publicContextDiagnosticManifestDigest,
  publicObservationSourceDigest, type PublicContextDiagnosticManifest } from "../src/publicSceneFacts.js";
import { assertGeneratedSplits, loadGenerationPolicy } from "../src/generationPolicy.js";
import { openRunStore, RunLockError, type OpenRunStoreOptions } from "../src/runstore.js";
import { inspectPipelineCheckpoint, PipelineJournal, UncertainDispatchError } from "../src/pipelineJournal.js";
import { authoritativeFacts, PUBLIC_SCENE_GROUNDING_VALIDATOR_VERSION, type GroundingReceipt } from "../src/grounding.js";
import { anchorCandidates, type ProseQualityScorer } from "../src/twins.js";
import { selectAdmittedRecords } from "../src/selection.js";
import { verifyAdmissionCertificate, type ApprovedAdmissionRegistry } from "../src/admission.js";
import { createTeacherClient, sha256Hex, TeacherUncertainDispatchError, type TeacherClient, type TeacherCompletionRequest } from "../src/teacher.js";
import { stableStringify } from "../src/spec.js";
import { createTokenizerBridge, withMeasuredQwen3Template } from "../src/tokenizer.js";
import { fieldsForSections, WORLD_GENERATION_SECTIONS } from "../src/worldGeneration.js";
import { catalogReferenceIdentity } from "../src/worldGenerationTypes.js";
import { loadTeacherRights } from "../src/teacherRights.js";
import type { StoredToolCall } from "../src/spec.js";
import { exportTrainingJsonl } from "../src/export.js";
import { preprocessTrainingExport } from "../src/preprocessExport.js";

const ACCEPT = JSON.stringify({ characterization: 0.8, dialogueQuality: 0.8, coherence: 0.8, narrativeInitiative: 0.8,
  playerAgency: 0.9, nonRepetitive: 0.8, verdict: "accept", rationale: "independent test fixture review" });
const policy = loadGenerationPolicy();
const tokenizer: TokenizerPort = { name: "runner test only: whitespace counter", countSupervisedTokens: (example) =>
  example.targetSelection.supervisedAssistantIndices.reduce((sum, index) => sum + example.messages[index]!.content.split(/\s+/).filter(Boolean).length, 0)
  + example.targetSelection.supervisedToolCallIndices.reduce((sum, index) => sum + stableStringify(example.messages[index]!.tool_calls).split(/\s+/).length, 0) };
const proseScorer: ProseQualityScorer = { scorerId: "independent-fixture-grader", version: "fixture-rubric-v1",
  score: () => ({ rate: 0.75, graded: 2, measuredBy: "test:independent-fixture-grader" }) };

function client(model: string, answer: (request: TeacherCompletionRequest) => string | Promise<string>): TeacherClient {
  return { model, baseUrlDigest: "fixture-route-digest", identity: { provider: "test", model, baseUrlDigest: "fixture-route-digest", credentialSource: "env" },
    complete: async (request) => ({ content: await answer(request), toolCalls: [], finishReason: "stop", usage: null,
      responseId: null, attempts: 1, latencyMs: 0, requestDigest: sha256Hex(stableStringify(request)) }) };
}

function outputClient(answer: (request: TeacherCompletionRequest) => { content: string; toolCalls?: readonly StoredToolCall[] }): TeacherClient {
  const base = client("fixture-teacher", () => "");
  return { ...base, complete: async (request) => ({ ...await base.complete(request), ...answer(request) }) };
}

function publicWorldAnswer(request: TeacherCompletionRequest): Record<string, unknown> {
  const contract = JSON.parse(request.system.split("PUBLIC WORLD CONTRACT\n")[1]!.split("OUTPUT JSON SCHEMA\n")[0]!.trim()) as { sections: string[]; dependencies: { key: string; kind: string }[] };
  const locationKey = contract.dependencies.find((dependency) => dependency.kind === "location")!.key;
  const common = { description: "A bounded public campaign detail.", visibility: "public" };
  const candidates: Record<string, unknown> = {
    locations: [{ ...common, key: "new-location", name: "The Pier" }],
    factions: [{ ...common, key: "new-faction", name: "The Dock Guild" }],
    npcs: [{ ...common, key: "new-npc", name: "The Keeper", archetype: "clerk", locationKey }],
    quests: [{ ...common, key: "new-quest", title: "Find the Ledger", objectives: [{ key: "new-objective", description: "Locate the ledger at the pier.", visibility: "public", targetProgress: 1 }] }],
    encounters: [{ ...common, key: "new-encounter", title: "An Empty Office" }],
    lore: [{ key: "new-lore", title: "The Pier", summary: "The pier is publicly known.", visibility: "public" }],
    questItems: [{ ...common, key: "new-item", name: "A Ribbon", mechanics: { state: "inert", reason: "Decorative only." } }],
    monsterConcepts: [{ ...common, key: "new-monster", name: "A Harbour Hound", role: "watcher", mechanics: { state: "inert", reason: "No mechanics implemented." } }],
  };
  return Object.fromEntries(contract.sections.flatMap((section) => [...fieldsForSections([section])]).filter((field) => field !== "connections")
    .map((field) => [field, candidates[field]]));
}

function publicReceiptNarration(request: TeacherCompletionRequest): string {
  const receipts = JSON.parse(request.system.split("AUTHORITATIVE PUBLIC RECEIPTS\n")[1]!.split(" ADVERTISED")[0]!
    .split(" PUBLIC WORLD")[0]!.split(" NARRATION SUBMISSION CONTRACT\n")[0]!) as GroundingReceipt[];
  return receipts.map((receipt) => receipt.kind === "check"
    ? `Your ${receipt.skill} check comes to ${receipt.total} against DC ${receipt.dc}: ${receipt.outcome}.`
    : receipt.kind === "combat" && receipt.outcome.kind === "damage" ? `${receipt.target} has ${receipt.outcome.hitPointsAfter} HP remaining.` : "").join(" ");
}

/** Composed realization of the guided narration contract: one check sentence,
 * one attack sentence and one semicolon-bound HP/status sentence. The cadence is
 * a fixture for the transport and grounding gates, never a quality claim. */
function guidedReceiptNarration(request: TeacherCompletionRequest): string {
  const receipts = JSON.parse(request.system.split("AUTHORITATIVE PUBLIC RECEIPTS\n")[1]!.split(" ADVERTISED")[0]!.split(" NARRATION SUBMISSION CONTRACT\n")[0]!) as GroundingReceipt[];
  return receipts.map((receipt) => receipt.kind === "check"
    ? `You ${/^success/i.test(receipt.outcome) ? "succeeded" : "failed"} on the ${receipt.skill} check against DC ${receipt.dc}, with a total of ${receipt.total}.`
    : receipt.kind === "combat" && receipt.outcome.kind === "damage"
      ? `${receipt.actor} ${receipt.outcome.hit ? "hits" : "misses"} ${receipt.target} with a ${receipt.outcome.damageType} attack for ${receipt.outcome.applied} damage. ${receipt.target}'s hit points go from ${receipt.outcome.hitPointsBefore} to ${receipt.outcome.hitPointsAfter}; ${receipt.target} is ${receipt.outcome.statusAfter}.`
      : "").join(" ");
}

function setup(t: { after(fn: () => void): void }, overrides: Partial<PipelineOptions> = {}) {
  const root = mkdtempSync("/tmp/opencode/foundry-runner-");
  const calls: string[] = [];
  const generator = client("fixture-teacher", (request) => { calls.push(request.attemptId); return "The lantern gutters beside the closed ledger."; });
  const reviewer = client("fixture-reviewer", (request) => { calls.push(request.attemptId); return ACCEPT; });
  const options: PipelineOptions = { runId: "runner", seed: "runner-seed", units: 2, families: ["roleplay-conversation"],
    tokenizer, generator, reviewer, maxRepairs: 1, maxCompletionTokens: 128, gitCommit: null, execute: true, ...overrides };
  const plan = planRun({ seed: options.seed, units: options.units!, families: options.families!,
    realizationsPerScenario: options.realizationsPerScenario ?? 1, pairedTwins: options.pairedTwins ?? [],
    ...(options.publicContextDiagnostic ? { publicContextDiagnostic: options.publicContextDiagnostic } : {}) });
  const storeOptions: OpenRunStoreOptions = { runId: options.runId, seed: options.seed, artifactRoot: root, sourceDigest: "fixture-source-digest",
    corpusFreezeDigest: policy.corpusDigest, splitAssignmentDigest: plan.splitAssignmentDigest, totalUnits: plan.units.length,
    generator: { provider: options.generator.identity.provider, model: options.generator.model, baseUrlDigest: options.generator.baseUrlDigest,
      temperature: options.temperature ?? 0.7 }, gitCommit: null, durability: "fsync" };
  let store = openRunStore(storeOptions);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { options, plan, calls, root, storeOptions, get store() { return store; }, reopen() { store.close(); store = openRunStore(storeOptions); return store; } };
}

function twinInput(): ScheduledTwinInput {
  const receipts: GroundingReceipt[] = [{ kind: "check", receiptId: "roll", skill: "Investigation", total: 22, dc: 15,
    difficulty: "Medium", outcome: "success", visibility: "public" }];
  const candidates = anchorCandidates(authoritativeFacts(receipts));
  const numeric = candidates.find((anchor) => anchor.value === "22")!;
  const input: Omit<ScheduledTwinInput, "sourceDigest"> = { lineage: { characterFamily: "authored-runner-character", worldFamily: "authored-runner-world", scenarioFamily: "authored-runner-scenario" },
    spec: { caseId: "runner-twin", prompt: [{ role: "user", content: "Narrate the committed check." }], receipts,
    faithfulNarration: "Your Investigation check comes to 22 against a Medium DC of 15: success.",
    counterfactualNarration: "Your Investigation check comes to 24 against a Medium DC of 15: your Investigation check succeeds.",
    flip: { op: "set-value", factId: "roll", role: "total", value: 24 }, flipAnchor: numeric },
    counterfactualReceipts: [{ ...receipts[0]!, total: 24 } as GroundingReceipt],
    anchors: [candidates.find((anchor) => anchor.value === "Investigation")!, numeric, candidates.find((anchor) => anchor.value === "Medium")!],
    seed: "twin-seed", generator: { provider: "test", model: "fixture-teacher", baseUrlDigest: "fixture-route-digest", temperature: 0.7 } };
  return { ...input, sourceDigest: twinSourceDigest(input) };
}

test("K realizations retain scenario facts, lineage and split, while producing distinct contextual prompts", () => {
  const plan = planRun({ seed: "k-schedule", units: 8, realizationsPerScenario: 3 });
  assert.equal(plan.units.length, 24);
  assert.equal(plan.scenarioCount, 8);
  const grouped = new Map<string, typeof plan.units[number][]>();
  for (const unit of plan.units) { const group = grouped.get(unit.scenarioUnitId) ?? []; group.push(unit); grouped.set(unit.scenarioUnitId, group); }
  for (const group of grouped.values()) {
    assert.equal(group.length, 3);
    assert.equal(new Set(group.map((unit) => unit.realization.digest)).size, 3);
    assert.equal(new Set(group.map((unit) => stableStringify(unit.spec.lineage))).size, 1);
    assert.equal(new Set(group.map((unit) => unit.spec.split)).size, 1);
    for (const unit of group) {
      assert.equal(unit.realization.slots.npc, unit.spec.slots.npc);
      assert.ok(unit.realization.context[0]!.content.includes(unit.spec.slots.place!));
      if (unit.spec.oracle.receipts.length) assert.match(unit.realization.context[0]!.content, /AUTHORITATIVE PUBLIC RECEIPTS/);
    }
  }
  assert.deepEqual(planRun({ seed: "k-schedule", units: 8, realizationsPerScenario: 3 }), plan);
  assert.throws(() => planRun({ seed: "k-schedule", units: 8, realizationsPerScenario: 0 }), /K must/);
});

test("successful runs bind context, finalize every unit, and reproduce the complete report after reopen", async (t) => {
  const run = setup(t, { realizationsPerScenario: 3 });
  const first = await runPipeline({ ...run.options, store: run.store });
  assert.equal(first.units, 6);
  assert.equal(first.admitted, 6);
  assert.equal(first.complete, true);
  for (const outcome of first.unitOutcomes) {
    const stored = run.store.readAdmittedRecord(outcome.admittedAttemptId!)!;
    assert.deepEqual(stored.messages.slice(0, -1), run.plan.units.find((unit) => unit.unitId === outcome.unitId)!.realization.context);
    assert.deepEqual(stored.targetSelection.supervisedAssistantIndices, [stored.messages.length - 1]);
    assert.doesNotThrow(() => verifyAdmissionCertificate(stored));
    assert.equal(run.store.unit(outcome.unitId)!.completed, true);
    assert.equal(run.store.unit(outcome.unitId)!.finalizedAttemptId, outcome.admittedAttemptId);
  }
  assert.equal(run.store.state(), "complete");
  const calls = [...run.calls];
  const resumed = await runPipeline({ ...run.options, store: run.reopen() });
  assert.deepEqual(resumed, first);
  assert.deepEqual(run.calls, calls);
});

test("a crash after durable admission reuses the response, review and exact certificate", async (t) => {
  const run = setup(t);
  let admittedId = "";
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store, onEvent: (event) => {
    if (event.kind === "admitted") { admittedId = event.attemptId; throw new Error("simulated process exit after admission"); }
  } }), /simulated process exit/);
  const admitted = run.store.readAdmittedRecord(admittedId)!;
  assert.equal(run.calls.length, 2);
  const resumed = await runPipeline({ ...run.options, store: run.reopen() });
  assert.equal(resumed.complete, true);
  assert.equal(run.calls.length, 4);
  assert.equal(new Set(run.calls).size, 4);
  assert.deepEqual(run.store.readAdmittedRecord(admittedId), admitted);
  assert.equal(resumed.budget.supervisedTokens, run.store.candidates().reduce((sum, record) => sum + record.provenance.tokenCount!.tokens, 0));
  const calls = run.calls.length;
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen(), budget: { maxSupervisedAssistantTokens: 1 } }), /already observed durable spend/);
  assert.equal(run.calls.length, calls);
});

test("resume repairs the immutable failed attempt with its original RAW reason", async (t) => {
  const requests: TeacherCompletionRequest[] = [];
  const generator = client("fixture-teacher", (request) => { requests.push(request); return request.attemptId.endsWith("-a0")
    ? "You decide to open the sealed stair." : "The lantern gutters beside the closed ledger."; });
  const run = setup(t, { generator, units: 1 });
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store, onEvent: (event) => {
    if (event.kind === "rejected") throw new Error("crash after refusal");
  } }), /crash after refusal/);
  const initial = run.store.candidates()[0]!;
  const resumed = await runPipeline({ ...run.options, store: run.reopen() });
  assert.equal(requests.length, 2);
  assert.match(stableStringify(requests[1]!.messages), /RAW output that was refused/);
  assert.match(stableStringify(requests[1]!.messages), /You decide to open/);
  assert.equal(resumed.admitted, 1);
  const attempts = run.store.attempts(run.plan.units[0]!.unitId);
  assert.equal(attempts[0]!.superseded, true);
  assert.equal(attempts[1]!.parentAttemptId, attempts[0]!.attemptId);
  assert.deepEqual(run.store.readCandidate(attempts[0]!.attemptId), initial);
});

for (const lost of ["generator", "reviewer"] as const) test(`unknown ${lost} dispatch outcome refuses resume without redispatch`, async (t) => {
  let calls = 0;
  const uncertain = client(lost === "generator" ? "fixture-teacher" : "fixture-reviewer", () => {
    calls += 1; throw new Error("response lost after dispatch");
  });
  const run = setup(t, { [lost]: uncertain, units: 1 });
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store }), /response lost/);
  assert.equal(calls, 1);
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen() }), UncertainDispatchError);
  assert.equal(calls, 1);
});

test("review/admission refusals charge each measured attempt once, including on resume", async (t) => {
  const reviewer = client("fixture-reviewer", () => "unusable review");
  const run = setup(t, { reviewer, units: 1 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.attempts, 1, "unusable reviews cannot consume a generator-content repair");
  const expected = run.store.candidates().reduce((sum, record) => sum + record.provenance.tokenCount!.tokens, 0);
  assert.equal(report.budget.supervisedTokens, expected);
  assert.equal(report.unitOutcomes[0]!.supervisedTokens, expected);
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
});

test("malformed reviewer verdict is retried on the identical candidate without generator repair", async (t) => {
  const reviewed: TeacherCompletionRequest[] = [];
  const malformed = JSON.stringify({ ...JSON.parse(ACCEPT), verdict: "PASS" });
  const reviewer = client("fixture-reviewer", (request) => { reviewed.push(request); return request.attemptId.includes("review-contract") ? ACCEPT : malformed; });
  const run = setup(t, { units: 1, reviewer });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 1);
  assert.equal(report.attempts, 1);
  assert.equal(run.store.candidates().length, 1);
  assert.equal(reviewed.length, 2);
  assert.ok(reviewed[1]!.attemptId.endsWith("-review-contract-1"));
  assert.match(reviewed[0]!.system, /accept-with-notes/);
  assert.match(reviewed[1]!.system, /candidate is unchanged/);
  assert.ok(reviewed[1]!.system.includes(reviewed[0]!.system));
  const record = report.unitOutcomes[0]!.admittedRecord!;
  assert.equal(record.admission.review!.reviewerCount, 1, "output-contract attempts do not invent independent judges");
  assert.equal(record.admissionCertificate.reviews[0]!.reviewerPromptDigest, sha256Hex(reviewed[1]!.system));
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
  assert.equal(reviewed.length, 2, "both raw reviewer attempts are reused on resume");
});

test("unchanged generator repairs cannot shop a usable review verdict", async (t) => {
  let reviews = 0;
  const reviewer = client("fixture-reviewer", () => { reviews += 1; return reviews === 1
    ? JSON.stringify({ ...JSON.parse(ACCEPT), verdict: "revise", rationale: "A real candidate issue requires a changed answer." }) : ACCEPT; });
  const run = setup(t, { units: 1, reviewer, maxRepairs: 2 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.attempts, 3, "actual returned duplicate generator attempts are retained and charged");
  assert.equal(reviews, 1, "an unchanged answer already has its usable judgment");
  assert.equal(report.admitted, 0);
  assert.equal(report.unitOutcomes[0]!.refusedAt, "VALIDATED:unchanged-reviewed-candidate");
  const refusal = run.store.candidates().at(-1)!;
  assert.ok(refusal.admission.findings?.priorReviewedAttemptId);
  assert.match(String(refusal.admission.findings?.priorReviewRaw), /requires a changed answer/);
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
  assert.equal(reviews, 1);
});

test("changing only tool-call transport IDs cannot obtain another usable verdict", async (t) => {
  const seed = "tool-audit";
  const unit = planRun({ seed, units: 1, families: ["tool-selection"] }).units[0]!;
  const candidate = unit.spec.oracle.advertisedCandidates.find((entry) => unit.spec.oracle.allowedCandidateIds.includes(entry.candidateId))!;
  let generations = 0;
  let reviews = 0;
  const generator = outputClient(() => ({ content: "", toolCalls: [{ id: `id-${++generations}`, type: "function", function: { name: candidate.toolName,
    arguments: { candidateId: candidate.candidateId, digest: candidate.digest } } }] }));
  const reviewer = client("fixture-reviewer", () => { reviews += 1; return reviews === 1
    ? JSON.stringify({ ...JSON.parse(ACCEPT), verdict: "revise", rationale: "Change the selection, not transport metadata." }) : ACCEPT; });
  const run = setup(t, { seed, units: 1, families: ["tool-selection"], generator, reviewer, maxRepairs: 2 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.attempts, 3);
  assert.equal(reviews, 1);
  assert.equal(report.admitted, 0);
});

test("read-only advertised tool includes the explicit empty required array demanded upstream", async (t) => {
  const seed = "calibration-2026-10-13-v3-5";
  const unit = planRun({ seed, units: 20 }).units.find((unit) => unit.spec.oracle.toolFamily === "read-tool")!;
  assert.deepEqual(unit.spec.advertisedTools[0]!.function.parameters.required, []);
  let teacherRequest: TeacherCompletionRequest | null = null;
  const generator = outputClient((request) => { if (request.tools?.[0]?.function.name === "inspect_public_scene") teacherRequest = request; return { content: "", toolCalls: [{ id: "read", type: "function", function: { name: "inspect_public_scene", arguments: {} } }] }; });
  const run = setup(t, { seed, units: 20, families: ["grounded-narration", "roleplay-conversation", "tool-selection", "boundary-recovery", "world-generation"], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  const readUnit = run.plan.units.find((unit) => unit.spec.oracle.toolFamily === "read-tool")!;
  assert.ok(report.unitOutcomes.find((outcome) => outcome.unitId === readUnit.unitId)!.admittedRecord);
  assert.deepEqual(teacherRequest!.tools![0]!.function.parameters.required, []);
});

test("repair feedback retains the exact failed tool arguments and persistent submission contract", async (t) => {
  let repaired: TeacherCompletionRequest | null = null;
  const generator = outputClient((request) => {
    if (request.attemptId.endsWith("-a1")) repaired = request;
    return { content: "", toolCalls: [{ id: request.attemptId, type: "function", function: { name: "submit_adventure_narration",
      arguments: { narration: "The attacker invented an unsupported consequence." } } }] };
  });
  const run = setup(t, { units: 1, families: ["grounded-narration"], generator, maxRepairs: 1 });
  await runPipeline({ ...run.options, store: run.store });
  assert.match(repaired!.system, /exactly one native submit_adventure_narration/);
  assert.match(repaired!.messages.at(-1)!.content, /The attacker invented an unsupported consequence/);
  assert.match(repaired!.messages.at(-1)!.content, /toolCalls/);
});

test("world prompts expose compatible exact catalog identities and all narrative roster exclusions", () => {
  const unit = planRun({ seed: "catalog-contract", units: 1, families: ["world-generation"] }).units[0]!;
  const identity = unit.spec.oracle.catalogReferences[0]!;
  assert.equal(identity.kind, "enemy-template");
  assert.equal(identity.referenceIdentity, catalogReferenceIdentity(identity));
  assert.match(unit.realization.context[0]!.content, /empty participantNpcKeys, enemyReferences and monsterConceptKeys/);
  assert.match(unit.realization.context[0]!.content, /does not require you to bind it/);
});

for (const response of ["Not mine to open. Not yours either. The stair stays sealed.", "I don’t know why it is sealed. It stays closed."])
  test(`boundary recovery permits the question while respecting the closed barrier: ${response}`, async (t) => {
    const run = setup(t, { units: 1, families: ["boundary-recovery"], generator: client("fixture-teacher", () => response) });
    assert.match(run.plan.units[0]!.realization.context[0]!.content, /Asking .* is permitted/);
    assert.match(run.plan.units[0]!.realization.context[0]!.content, /does not know why it is sealed/);
    assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 1);
  });

for (const response of ["I abstain from narrating this interaction. I cannot provide Haug’s response.", "The sealed lower stair opens."])
  test(`boundary recovery refuses actual over-refusal or opening: ${response}`, async (t) => {
    const run = setup(t, { units: 1, families: ["boundary-recovery"], generator: client("fixture-teacher", () => response), maxRepairs: 0 });
    assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 0);
  });

test("budget pauses remain resumable, reconstruct spend and skip already completed calls", async (t) => {
  const run = setup(t, { budget: { maxSupervisedAssistantTokens: 128 } });
  const paused = await runPipeline({ ...run.options, store: run.store });
  assert.equal(paused.complete, false);
  assert.equal(paused.admitted, 1);
  assert.equal(paused.attempts, 1);
  assert.equal(run.calls.length, 2);
  const resumed = await runPipeline({ ...run.options, store: run.reopen(), budget: { maxSupervisedAssistantTokens: 256 } });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.admitted, 2);
  assert.equal(run.calls.length, 4);
  assert.equal(resumed.budget.supervisedTokens, run.store.candidates().reduce((sum, record) => sum + record.provenance.tokenCount!.tokens, 0));
});

test("mixed-family non-prefix resume reserves all known spend before filling earlier budget holes", async (t) => {
  const generator = client("fixture-teacher", () => "I cannot open it.");
  const run = setup(t, { seed: "budget-audit", units: 2, families: ["boundary-recovery", "roleplay-conversation"], generator,
    tokenizer: { name: "audit fixture count:15", countSupervisedTokens: () => 15 }, maxCompletionTokens: 20 });
  const target = run.plan.units[0]!.target;
  const first = await runPipeline({ ...run.options, store: run.store, budget: { maxSupervisedAssistantTokens: 20, perTarget: { [target]: 0 } } });
  assert.equal(first.admitted, 1);
  assert.equal(first.budget.supervisedTokens, 15);
  const calls = run.calls.length;
  const resumed = await runPipeline({ ...run.options, store: run.reopen(), budget: { maxSupervisedAssistantTokens: 20, perTarget: { [target]: 20 } } });
  assert.equal(resumed.admitted, 1);
  assert.equal(resumed.budget.supervisedTokens, 15);
  assert.equal(run.calls.length, calls, "known later spend must prevent an earlier new generation/review");
  assert.equal(resumed.complete, false);
});

for (const outcome of ["raw-response", "uncertain", "dispatch-only"] as const) test(`non-prefix resume reconciles ${outcome} before any new paid work`, async (t) => {
  let posts = 0;
  const real = createTeacherClient({ credentials: { providerId: "test", model: "fixture-teacher", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-secret-only", source: "env" },
    sleep: async () => {}, transport: async () => {
      posts += 1;
      if (outcome === "uncertain") throw new Error("fixture lost response");
      return { status: 200, body: JSON.stringify({ id: "fixture-response", choices: [{ message: { content: "I cannot open it." }, finish_reason: "stop" }] }), headers: {} };
    } });
  let interrupted = true;
  const generator: TeacherClient = { ...real, complete: async (request) => {
    if (interrupted && outcome === "dispatch-only") throw new Error("fixture crash before physical request");
    const completion = await real.complete(request);
    if (interrupted) throw new Error("fixture crash after raw outcome before logical response");
    return completion;
  } };
  const run = setup(t, { seed: "budget-audit", units: 2, families: ["boundary-recovery", "roleplay-conversation"], generator,
    tokenizer: { name: "audit fixture count:15", countSupervisedTokens: () => 15 }, maxCompletionTokens: 20, maxRepairs: 0 });
  const earlier = run.plan.units[0]!;
  const later = run.plan.units[1]!;
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store,
    budget: { maxSupervisedAssistantTokens: 20, perTarget: { [earlier.target]: 0 } } }), outcome === "uncertain" ? TeacherUncertainDispatchError : /fixture crash/);
  assert.equal(inspectPipelineCheckpoint(run.store, `response:${later.unitId}-a0`), null);
  const originalPosts = posts;
  interrupted = false;
  const resumed = run.reopen();
  const options = { ...run.options, store: resumed, budget: { maxSupervisedAssistantTokens: 20, perTarget: { [earlier.target]: 20 } } };
  if (outcome !== "raw-response") {
    await assert.rejects(() => runPipeline(options), UncertainDispatchError);
    assert.equal(posts, originalPosts);
    assert.equal(run.calls.length, 0);
  } else {
    const report = await runPipeline(options);
    assert.equal(report.budget.supervisedTokens, 15);
    assert.equal(report.admitted, 1);
    assert.equal(report.complete, false);
    assert.equal(posts, originalPosts, "raw response replay must reserve known spend before earlier new calls");
    assert.equal(run.calls.length, 1, "only the recovered candidate needs independent review");
    assert.ok(inspectPipelineCheckpoint(resumed, `response:${later.unitId}-a0`));
  }
});

test("world plan uses shared section identifiers and exposes schema/counts sufficient for public-only successful answers", async (t) => {
  const plan = planRun({ seed: "pilot-1", units: 175, realizationsPerScenario: 3 });
  for (const unit of plan.units.filter((entry) => entry.spec.family === "world-generation")) {
    assert.ok(unit.spec.oracle.sections.every((section) => (WORLD_GENERATION_SECTIONS as readonly string[]).includes(section)));
    assert.match(unit.realization.context[0]!.content, /OUTPUT JSON SCHEMA/);
    assert.ok(Object.values(unit.spec.oracle.desiredCounts).every((count) => count > 0));
  }
  const run = setup(t, { units: 8, families: ["world-generation"], generator: outputClient((request) => ({ content: JSON.stringify(publicWorldAnswer(request)) })) });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 8, JSON.stringify(run.store.candidates().map((record) => record.admission.findings)));
});

for (const defect of ["bad-reference", "omitted-section", "existing-key"] as const) test(`exact raw world target cannot be certified with ${defect}`, async (t) => {
  let seed = "world-negative";
  while (!planRun({ seed, units: 1, families: ["world-generation"] }).units[0]!.spec.oracle.sections.includes("npcs")) seed += "+";
  const generator = outputClient((request) => {
    const answer = publicWorldAnswer(request);
    const npc = (answer.npcs as Record<string, unknown>[])[0]!;
    if (defect === "bad-reference") npc.factionKeys = ["nonexistent-faction"];
    if (defect === "omitted-section") delete answer.npcs;
    if (defect === "existing-key") {
      const contract = JSON.parse(request.system.split("PUBLIC WORLD CONTRACT\n")[1]!.split("OUTPUT JSON SCHEMA\n")[0]!.trim());
      npc.key = contract.dependencies[0].key;
    }
    return { content: JSON.stringify(answer) };
  });
  const run = setup(t, { seed, units: 1, families: ["world-generation"], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 0);
  assert.match(report.unitOutcomes[0]!.refusedAt!, /requested-section-schema|reference-closure/);
  if (defect === "bad-reference") {
    const validation = inspectPipelineCheckpoint<{ runs: { validator: string; findings: { sanitizerChanges?: { path: string }[] } }[] }>(run.store, `validation:${run.plan.units[0]!.unitId}-a0`)!;
    assert.ok(validation.runs.find((run) => run.validator === "requested-section-schema")!.findings.sanitizerChanges?.some((change) => change.path.includes("factionKeys")));
  }
});

for (const defect of ["mixed-content", "unadvertised-tool", "extra-argument", "extra-call", "omitted-receipt"] as const) test(`grounded ${defect} cannot hide behind valid narration`, async (t) => {
  const generator = outputClient((request) => {
    let narration = publicReceiptNarration(request);
    if (defect === "omitted-receipt") narration = narration.split(". ")[0]! + ".";
    const call: StoredToolCall = { id: "grounded", type: "function", function: { name: defect === "unadvertised-tool" ? "unadvertised_admin_grant" : "submit_adventure_narration",
      arguments: { narration, ...(defect === "extra-argument" ? { amount: 999 } : {}) } } };
    return { content: defect === "mixed-content" ? "You gain 999 gold." : "", toolCalls: defect === "extra-call" ? [call, { ...call, id: "other" }] : [call] };
  });
  const run = setup(t, { units: 1, families: ["grounded-narration"], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 0);
  assert.match(report.unitOutcomes[0]!.refusedAt!, /narration-transport|receipt-provenance/);
});

test("public actor/target receipts support an on-request grounded happy path", async (t) => {
  const generator = outputClient((request) => ({ content: "", toolCalls: [{ id: "grounded", type: "function", function: {
    name: "submit_adventure_narration", arguments: { narration: publicReceiptNarration(request) } } }] }));
  const run = setup(t, { units: 1, families: ["grounded-narration"], generator });
  assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 1);
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /exactly one native submit_adventure_narration function call/);
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /Leave assistant content empty/);
});

test("value-free composed sentence guide yields fully bound targets across check outcomes and entity identities", async (t) => {
  const generator = outputClient((request) => ({ content: "", toolCalls: [{ id: request.attemptId, type: "function", function: {
    name: "submit_adventure_narration", arguments: { narration: guidedReceiptNarration(request) } } }] }));
  const run = setup(t, { seed: "guide-realization-matrix", units: 20, families: ["grounded-narration"], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 20);
  const outcomes = new Set(run.plan.units.map((unit) => unit.spec.oracle.receipts[0]!.kind === "check" ? unit.spec.oracle.receipts[0]!.outcome : null));
  assert.deepEqual(outcomes, new Set(["success", "failure"]));
  assert.ok(new Set(run.plan.units.map((unit) => unit.spec.slots.npc)).size > 1);
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /SUPPORTED COMPOSED SENTENCE GUIDE/);
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /bracketed terms below are value-free grammatical options/);
  // The composed options are alternatives, not a mandatory concatenation.
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /choose one applicable realization rather than both alternatives/);
  assert.match(run.plan.units[0]!.realization.context[0]!.content, /\[target\]'s hit points go from \[HP before\] to \[HP after\]; \[target\] is \[explicit status after\]/);
});

test("narration-submit tool selection admits the composed native-call surface and still refuses added prose", async (t) => {
  const seed = "composed-narration-submit";
  const planned = planRun({ seed, units: 2, families: ["tool-selection"] });
  const narrationUnit = planned.units.find((unit) => unit.spec.oracle.toolFamily === "narration-submit");
  assert.ok(narrationUnit, "the plan schedules a narration-submit decision");
  const candidateUnit = planned.units.find((unit) => unit.spec.oracle.toolFamily === "exact-candidate")!;
  const chosen = candidateUnit.spec.oracle.advertisedCandidates
    .find((candidate) => candidateUnit.spec.oracle.allowedCandidateIds.includes(candidate.candidateId))!;
  const surface = (request: TeacherCompletionRequest, narrationProse = ""): { content: string; toolCalls: StoredToolCall[] } => {
    const narration = request.system.includes("AUTHORITATIVE PUBLIC RECEIPTS");
    return { content: narration ? narrationProse : "", toolCalls: [{ id: request.attemptId, type: "function", function: narration
      ? { name: "submit_adventure_narration", arguments: { narration: guidedReceiptNarration(request) } }
      : { name: chosen.toolName, arguments: { candidateId: chosen.candidateId, digest: chosen.digest } } }] };
  };
  const run = setup(t, { seed, units: 2, families: ["tool-selection"], generator: outputClient((request) => surface(request)), maxRepairs: 0 });
  assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 2);
  assert.ok(run.plan.units.some((unit) => unit.unitId === narrationUnit.unitId));
  const context = run.plan.units.find((unit) => unit.unitId === narrationUnit.unitId)!.realization.context[0]!.content;
  assert.match(context, /SUPPORTED COMPOSED SENTENCE GUIDE/);
  assert.match(context, /exactly one native submit_adventure_narration function call/);
  assert.equal(narrationUnit.spec.oracle.receipts.length, 1, "the check-only receipt set composes into one sentence");
  const mixed = setup(t, { seed, units: 2, families: ["tool-selection"],
    generator: outputClient((request) => surface(request, "The turn is committed.")), maxRepairs: 0 });
  const refused = await runPipeline({ ...mixed.options, store: mixed.store });
  assert.equal(refused.admitted, 1);
  assert.match(refused.unitOutcomes.find((outcome) => outcome.unitId === narrationUnit.unitId)!.refusedAt!, /narration-transport/);
});

for (const correct of [false, true]) test(`tool selection independently checks intent for ${correct ? "correct" : "wrong but advertised"} candidates`, async (t) => {
  let seed = "tool-audit";
  while (planRun({ seed, units: 1, families: ["tool-selection"] }).units[0]!.spec.oracle.toolFamily !== "exact-candidate") seed += "+";
  const plan = planRun({ seed, units: 1, families: ["tool-selection"] });
  const unit = plan.units[0]!;
  const selected = unit.spec.oracle.advertisedCandidates.find((candidate) => unit.spec.oracle.allowedCandidateIds.includes(candidate.candidateId) === correct)!;
  const generator = outputClient(() => ({ content: "", toolCalls: [{ id: "choice", type: "function", function: {
    name: selected.toolName, arguments: { candidateId: selected.candidateId, digest: selected.digest } } }] }));
  const run = setup(t, { seed, units: 1, families: ["tool-selection"], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, Number(correct));
  const validation = inspectPipelineCheckpoint<{ runs: { validator: string; evidence: { selection: { finalOutcome: string; intentCorrect: boolean } } }[] }>(run.store, `validation:${unit.unitId}-a0`)!;
  const decision = validation.runs.find((entry) => entry.validator === "advertised-candidate-binding")!.evidence.selection;
  assert.equal(decision.intentCorrect, correct);
  assert.equal(decision.finalOutcome, "unknown", "choice is not a committed engine settlement");
});

for (const value of ["array", "object", "null"] as const) test(`exact candidate ${value} arguments never earn transport validity through coercion`, async (t) => {
  let seed = "tool-audit";
  while (planRun({ seed, units: 1, families: ["tool-selection"] }).units[0]!.spec.oracle.toolFamily !== "exact-candidate") seed += "+";
  const unit = planRun({ seed, units: 1, families: ["tool-selection"] }).units[0]!;
  const candidate = unit.spec.oracle.advertisedCandidates.find((entry) => unit.spec.oracle.allowedCandidateIds.includes(entry.candidateId))!;
  const invalid = (text: string): unknown => value === "array" ? [text] : value === "object" ? { value: text } : null;
  const generator = outputClient(() => ({ content: "", toolCalls: [{ id: "invalid", type: "function", function: {
    name: candidate.toolName, arguments: { candidateId: invalid(candidate.candidateId), digest: invalid(candidate.digest) } } }] }));
  const run = setup(t, { seed, units: 1, families: ["tool-selection"], generator, maxRepairs: 0 });
  assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 0);
  assert.deepEqual(run.store.candidates()[0]!.messages.at(-1)!.tool_calls![0]!.function.arguments.candidateId, invalid(candidate.candidateId));
});

for (const family of ["roleplay-conversation", "boundary-recovery"] as const) test(`no-tools ${family} refuses an unadvertised supervised action`, async (t) => {
  const generator = outputClient(() => ({ content: "The lantern gutters beside the closed ledger.", toolCalls: [{ id: "unadvertised", type: "function", function: {
    name: "unadvertised_admin_grant", arguments: { amount: 999 } } }] }));
  const run = setup(t, { units: 1, families: [family], generator, maxRepairs: 0 });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 0);
  const validation = inspectPipelineCheckpoint<{ runs: { validator: string; passed: boolean }[] }>(run.store, `validation:${run.plan.units[0]!.unitId}-a0`)!;
  assert.equal(validation.runs.find((run) => run.validator === "tool-envelope")!.passed, false);
});

test("dependencies are hash-bound and canonical serialization rejects unsupported objects", () => {
  const spec = scenarioSpec("dependency-binding", { family: "world-generation" });
  const digest = sha256Hex(stableStringify(spec));
  (spec.oracle.dependencies as Map<string, unknown>).set("new-hidden-dependency", { key: "new-hidden-dependency", kind: "faction", visibility: "gm" });
  assert.notEqual(sha256Hex(stableStringify(spec)), digest);
  assert.throws(() => stableStringify({ unsupported: new Set(["hidden"]) }), /unsupported non-JSON/);
});

test("unmeasurable candidate is durably quarantined, never assigned zero measured tokens or blindly replayed", async (t) => {
  const generator = client("fixture-teacher", () => "unmeasurable-candidate");
  const run = setup(t, { units: 2, generator, tokenizer: { name: "fixture-refusal-tokenizer", countSupervisedTokens: (example) => {
    if (example.messages.at(-1)?.content === "unmeasurable-candidate") throw new Error("test-only unsupported target");
    return 1;
  } } });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.complete, false);
  assert.equal(report.admitted, 0);
  assert.equal(report.unmeasuredAttemptIds.length, 1);
  assert.equal(run.store.candidates()[0]!.provenance.tokenCount, null);
  const resumed = await runPipeline({ ...run.options, store: run.reopen() });
  assert.deepEqual(resumed, report);
});

test("teacher/reviewer inference settings bind requests and reject resume drift", async (t) => {
  let generated: TeacherCompletionRequest | null = null;
  let reviewed: TeacherCompletionRequest | null = null;
  const generator = client("fixture-teacher", (request) => { generated = request; return "The lantern gutters beside the closed ledger."; });
  const reviewer = client("fixture-reviewer", (request) => { reviewed = request; return ACCEPT; });
  const run = setup(t, { units: 1, generator, reviewer, teacherThinking: "disabled", maxCompletionTokens: 2048,
    reviewerTemperature: null, reviewerReasoningEffort: "low", reviewerMaxCompletionTokens: 4096 });
  assert.equal((await runPipeline({ ...run.options, store: run.store })).admitted, 1);
  assert.equal(generated!.thinking, "disabled");
  assert.equal(generated!.maxTokens, 2048);
  assert.equal(reviewed!.temperature, undefined);
  assert.equal(reviewed!.reasoningEffort, "low");
  assert.equal(reviewed!.maxTokens, 4096);
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen(), teacherThinking: "enabled" }), /configuration\/plan drift/);
});

test("teacher rights provenance retains the matching inspected terms and exact source bytes", async (t) => {
  const rights = loadTeacherRights();
  const base = client(rights.teacher.model, () => "The lantern gutters beside the closed ledger.");
  const generator = { ...base, baseUrlDigest: rights.teacher.baseUrlDigest!, identity: { ...base.identity,
    provider: rights.teacher.provider, baseUrlDigest: rights.teacher.baseUrlDigest! } };
  const run = setup(t, { units: 1, generator, teacherRights: rights });
  const report = await runPipeline({ ...run.options, store: run.store });
  const record = report.unitOutcomes[0]!.admittedRecord!;
  assert.equal(record.provenance.license.status, "verified-permitted");
  assert.deepEqual(record.provenance.sourceDigests.teacherTrainingRights, rights.receiptDigest);
  for (const digest of Object.values(rights.sourceDigests)) assert.equal(sha256Hex(inspectPipelineCheckpoint<string>(run.store, `artifact:${digest}`)!), digest);
});

test("actual student-label overshoot refuses admission before review", async (t) => {
  const run = setup(t, { units: 1, tokenizer: { name: "test-only deliberately-large-mask", countSupervisedTokens: () => 200 },
    budget: { maxSupervisedAssistantTokens: 128 } });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 0);
  assert.equal(report.complete, false);
  assert.equal(run.calls.length, 1);
  assert.equal(report.budget.supervisedTokens, 200);
  assert.equal(run.store.candidates()[0]!.admission.findings.code, "measured-token-budget");
});

test("configuration and store split drift refuse before provider calls", async (t) => {
  const run = setup(t);
  await assert.rejects(() => runPipeline({ ...run.options, seed: "other", store: run.store }), /run-store config/);
  assert.equal(run.calls.length, 0);
  await runPipeline({ ...run.options, store: run.store });
  const calls = run.calls.length;
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen(), maxCompletionTokens: 129 }), /configuration\/plan drift/);
  assert.equal(run.calls.length, calls);
});

test("checkpoint heartbeats retain an active lease beyond its original age, and lost owners cannot dispatch", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const root = mkdtempSync("/tmp/opencode/foundry-heartbeat-");
  const options: OpenRunStoreOptions = { runId: "heartbeat", seed: "heartbeat", sourceDigest: "source",
    splitAssignmentDigest: "splits", corpusFreezeDigest: policy.corpusDigest, artifactRoot: root, gitCommit: null,
    clock: () => now, staleLockMs: 100, durability: "fsync" };
  const owner = openRunStore(options);
  const journal = new PipelineJournal(owner, { version: "heartbeat-test" });
  t.after(() => { owner.close(); rmSync(root, { recursive: true, force: true }); });
  now += 90;
  owner.renewLease();
  now += 90;
  assert.throws(() => openRunStore(options), RunLockError);
  now += 101;
  assert.throws(() => openRunStore(options), RunLockError, "age alone must not reclaim a live process");
  // Explicit lease loss is a test seam; production reclaims only a gone holder.
  rmSync(owner.paths.lockPath, { force: true });
  const replacement = openRunStore(options);
  assert.throws(() => owner.renewLease(), RunLockError);
  assert.throws(() => owner.addNote("lost holder write"), RunLockError);
  let calls = 0;
  await assert.rejects(() => journal.complete(client("fixture-teacher", () => { calls += 1; return "unexpected"; }),
    { attemptId: "lost-owner", system: "fixture", messages: [] }), RunLockError);
  assert.equal(calls, 0);
  owner.close();
  assert.throws(() => openRunStore(options), RunLockError, "old holder close must not remove its replacement's same-process lease");
  replacement.close();
});

test("a crash before provider dispatch still leaves an uncertain request that cannot be sent twice", async (t) => {
  const run = setup(t, { units: 1 });
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store, onEvent: (event) => {
    if (event.kind === "dispatched") throw new Error("crash between marker and network call");
  } }), /crash between marker/);
  assert.equal(run.calls.length, 0);
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen() }), UncertainDispatchError);
  assert.equal(run.calls.length, 0);
});

test("cluster and global record caps apply to actual admitted outputs, deterministically", async (t) => {
  const run = setup(t, { units: 12, realizationsPerScenario: 3, selectionPolicy: { maxRecordsPerCluster: 1, maxRecords: 4 } });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 36);
  assert.equal(report.selected, 4);
  assert.equal(report.diversity.afterSelection.count, 4);
  assert.ok(Object.values(report.selection.clusterCounts).every((count) => count <= 1));
  assert.ok(report.selection.excluded.length);
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
  const records = report.unitOutcomes.flatMap((outcome) => outcome.admittedRecord ? [outcome.admittedRecord] : []);
  assert.equal(selectAdmittedRecords(run.plan, [...records].reverse(), policy, run.options.selectionPolicy).digest, report.selection.digest);
});

test("runner export uses selected train records only and safely resumes a published bundle", async (t) => {
  // Deliberately require both training and held-out rows to reach the split gate.
  let seed = "export-splits";
  while (true) {
    const plan = planRun({ seed, units: 8, families: ["roleplay-conversation"] });
    if (plan.splitCounts.train > 0 && plan.splitCounts.train < 8) break;
    seed += "+";
  }
  const run = setup(t, { seed, units: 8 });
  const generated = await runPipeline({ ...run.options, store: run.store });
  const artifacts = new Map<string, string>();
  const certificates = new Map<string, string>();
  const validators: Record<string, { version: string; implementationDigest: string }> = {};
  // Independent test approval of inspected bytes; the runner never builds this registry.
  const implementation = readFileSync("dataset/src/generate.ts", "utf8");
  const implementationDigest = sha256Hex(implementation);
  artifacts.set(implementationDigest, implementation);
  for (const outcome of generated.unitOutcomes) {
    const record = outcome.admittedRecord!;
    certificates.set(record.recordId, record.admissionCertificate.certificateDigest);
    const validation = inspectPipelineCheckpoint<{ artifactDigests: string[] }>(run.store, `validation:${outcome.admittedAttemptId}`)!;
    for (const digest of validation.artifactDigests) {
      const bytes = inspectPipelineCheckpoint<string>(run.store, `artifact:${digest}`)!;
      assert.equal(sha256Hex(bytes), digest);
      artifacts.set(digest, bytes);
    }
    const review = inspectPipelineCheckpoint<{ request: TeacherCompletionRequest }>(run.store, `dispatch:${outcome.admittedAttemptId}-review`)!;
    artifacts.set(sha256Hex(review.request.system), review.request.system);
    for (const evidence of record.admissionCertificate.evidence) validators[evidence.validator] = { version: evidence.version, implementationDigest };
  }
  const approvedRegistry: ApprovedAdmissionRegistry = withMeasuredQwen3Template({ artifacts, certificates, validators, templateProfiles: [] });
  const outputDir = join(run.root, "export");
  const exported = await runPipeline({ ...run.options, store: run.reopen(), exportOptions: { outputDir, approvedRegistry } });
  const sidecar = JSON.parse(readFileSync(join(outputDir, "provenance.json"), "utf8")) as { records: { unitId: string; split: string }[] };
  assert.ok(sidecar.records.length > 0);
  assert.ok(sidecar.records.length < generated.admitted);
  assert.ok(sidecar.records.every((record) => record.split === "train" && generated.selection.selectedUnitIds.includes(record.unitId)));
  assert.deepEqual(exported, generated);
  const calls = run.calls.length;
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen(), exportOptions: { outputDir, approvedRegistry } }), exported);
  assert.equal(run.calls.length, calls);
});

test("both selective-fidelity arms are independently reviewed, admitted and selected atomically", async (t) => {
  const run = setup(t, { units: 1, pairedTwins: [twinInput()], proseQualityScorer: proseScorer });
  const report = await runPipeline({ ...run.options, store: run.store });
  const arms = report.unitOutcomes.filter((outcome) => outcome.unitId.startsWith("twins-"));
  assert.equal(arms.length, 2);
  assert.ok(arms.every((outcome) => outcome.admittedRecord));
  assert.equal(run.calls.filter((id) => id.startsWith("twins-")).length, 2, "prepared drafts dispatch reviews only");
  const original = arms.find((outcome) => outcome.unitId.endsWith("original"))!.admittedRecord!;
  const changed = arms.find((outcome) => outcome.unitId.endsWith("counterfactual"))!.admittedRecord!;
  assert.deepEqual(original.preference!.chosen, changed.preference!.rejected);
  assert.deepEqual(original.preference!.rejected, changed.preference!.chosen);
  assert.deepEqual(original.lineage, changed.lineage);
  assert.equal(original.split, changed.split);
  assert.ok(arms.every((outcome) => report.selection.selectedUnitIds.includes(outcome.unitId)));
  const all = report.unitOutcomes.flatMap((outcome) => outcome.admittedRecord ? [outcome.admittedRecord] : []);
  assert.equal(selectAdmittedRecords(run.plan, all.reverse(), policy).digest, report.selection.digest);
  for (const outcome of arms) {
    const record = outcome.admittedRecord!;
    assert.doesNotThrow(() => verifyAdmissionCertificate(record));
    const expected = [record.preference!.chosen, record.preference!.rejected].reduce((sum, branch) => sum + tokenizer.countSupervisedTokens({
      family: record.family, messages: [...record.preference!.prompt, ...branch], targetSelection: {
        supervisedAssistantIndices: [record.preference!.prompt.length], supervisedToolCallIndices: [] } }), 0);
    assert.equal(record.provenance.tokenCount!.tokens, expected);
    assert.ok(record.admissionCertificate.evidence.some((item) => item.validator === "prose-quality-retention"));
  }
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
});

test("prepared twin source IDs and authored lineages remain reserved and stable across run/realization seeds", () => {
  const input = twinInput();
  const first = planRun({ seed: "outer-1", units: 1, pairedTwins: [input] }).units.filter((unit) => unit.twinGroupId);
  const second = planRun({ seed: "outer-2", units: 1, pairedTwins: [{ ...input, seed: "changed-realization" }] }).units.filter((unit) => unit.twinGroupId);
  assert.equal(first[0]!.spec.split, second[0]!.spec.split);
  assert.deepEqual(first[0]!.spec.lineage, input.lineage);
  assert.deepEqual(second[0]!.spec.lineage, input.lineage);
  const reserved = { ...input, spec: { ...input.spec, caseId: policy.reservedCaseIds[0]! } };
  assert.throws(() => planRun({ seed: "outer", units: 1, pairedTwins: [{ ...reserved, sourceDigest: twinSourceDigest(reserved) }] }), /frozen-reserved/);
  const overlap = { ...input, lineage: policy.reservedLineages[0]! };
  assert.throws(() => planRun({ seed: "outer", units: 1, pairedTwins: [{ ...overlap, sourceDigest: twinSourceDigest(overlap) }] }), /frozen evaluation lineage/);
  const conflicting = { ...input, lineage: { ...input.lineage, worldFamily: "different-authored-world" } };
  assert.throws(() => planRun({ seed: "outer", units: 1, pairedTwins: [input, { ...conflicting, sourceDigest: twinSourceDigest(conflicting) }] }), /conflicting immutable source/);
});

test("a rejected or cap-limited twin arm cannot leave a single selected preference", async (t) => {
  const reviewer = client("fixture-reviewer", (request) => request.attemptId.includes("counterfactual")
    ? ACCEPT.replace('"accept"', '"reject"') : ACCEPT);
  const run = setup(t, { units: 1, pairedTwins: [twinInput()], proseQualityScorer: proseScorer, reviewer });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.ok(report.selection.excluded.some((entry) => entry.reason === "incomplete-twin"));
  assert.ok(report.selection.selectedUnitIds.every((id) => !id.startsWith("twins-")));
  const capped = setup(t, { units: 1, pairedTwins: [twinInput()], proseQualityScorer: proseScorer,
    selectionPolicy: { maxRecordsPerCluster: 1 } });
  const cappedReport = await runPipeline({ ...capped.options, store: capped.store });
  assert.equal(cappedReport.selection.excluded.filter((entry) => entry.reason === "cluster-cap").length, 2);
});

test("missing or below-stock prose measurement stops twin scheduling before any teacher call", async (t) => {
  const run = setup(t, { pairedTwins: [twinInput()] });
  await assert.rejects(() => runPipeline({ ...run.options, store: run.store }), /measured prose-quality scorer/);
  assert.equal(run.calls.length, 0);
  const low = setup(t, { pairedTwins: [twinInput()], proseQualityScorer: { ...proseScorer,
    score: () => ({ rate: 0.4, graded: 2, measuredBy: "test:independent-fixture-grader" }) } });
  await assert.rejects(() => runPipeline({ ...low.options, store: low.store }), /stock|regress/);
  assert.equal(low.calls.length, 0);
});

test("checkpoint corruption refuses before response replay", async (t) => {
  const run = setup(t, { units: 1 });
  await runPipeline({ ...run.options, store: run.store });
  const directory = join(run.store.paths.runDir, "pipeline");
  const file = readdirSync(directory).find((name) => JSON.parse(readFileSync(join(directory, name), "utf8")).key.startsWith("response:"))!;
  const path = join(directory, file);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  envelope.value.content = "changed output";
  writeFileSync(path, JSON.stringify(envelope));
  const calls = run.calls.length;
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen() }), /checkpoint checksum/);
  assert.equal(run.calls.length, calls);
});

test("generation policy loads with no case content and rejects forged attestations/lineage overlaps", (t) => {
  const root = mkdtempSync("/tmp/opencode/foundry-policy-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["freeze.json", "sealed-attestation.json"]) copyFileSync(join("dataset/eval/corpus", name), join(root, name));
  assert.deepEqual(loadGenerationPolicy(root), policy, "metadata-only verification must not need dev or sealed case files");
  const path = join(root, "sealed-attestation.json");
  const attestation = JSON.parse(readFileSync(path, "utf8"));
  attestation.sealedCaseCount -= 1;
  const { attestationDigest: _old, ...body } = attestation;
  attestation.attestationDigest = sha256Hex(stableStringify(body));
  writeFileSync(path, JSON.stringify(attestation));
  assert.throws(() => loadGenerationPolicy(root), /attestation does not verify/);
  copyFileSync(join("dataset/eval/corpus", "sealed-attestation.json"), path);
  const contentful = JSON.parse(readFileSync(path, "utf8"));
  contentful.expectedAnswers = ["forbidden"];
  writeFileSync(path, JSON.stringify(contentful));
  assert.throws(() => loadGenerationPolicy(root), /metadata only/);
  const plan = planRun({ seed: "lineage-probes", units: 2 });
  const unit = plan.units[0]!;
  assert.throws(() => assertGeneratedSplits([{ ...unit, spec: { ...unit.spec, lineage: {
    ...unit.spec.lineage, characterFamily: policy.reservedLineages[0]!.characterFamily } } }], policy), /frozen evaluation lineage/);
  assert.throws(() => assertGeneratedSplits([unit, { ...plan.units[1]!, spec: { ...plan.units[1]!.spec,
    split: unit.spec.split === "train" ? "dev" : "train", lineage: { ...plan.units[1]!.spec.lineage, worldFamily: unit.spec.lineage.worldFamily } } }], policy), /crosses splits/);
});

test("the real CPU tokenizer measures full runner context and both preference branches", { skip: !process.env.FOUNDRY_TOKENIZER_PYTHON }, async (t) => {
  const bridge = createTokenizerBridge({ python: process.env.FOUNDRY_TOKENIZER_PYTHON!,
    assetsDir: process.env.FOUNDRY_TOKENIZER_ASSETS ?? ".dataset/tokenizer/qwen3-8b" });
  const run = setup(t, { units: 1, tokenizer: bridge, pairedTwins: [twinInput()], proseQualityScorer: proseScorer });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 3);
  for (const outcome of report.unitOutcomes) {
    const record = outcome.admittedRecord!;
    if (record.preference) {
      let total = 0;
      for (const arm of ["chosen", "rejected"] as const) {
        const offset = record.preference.prompt.length;
        const branch = record.preference[arm];
        const measured = bridge.measure({ family: record.family, messages: [...record.preference.prompt, ...branch],
          targetSelection: { supervisedAssistantIndices: record.preferenceTargets![arm].supervisedAssistantIndices.map((index) => index + offset),
            supervisedToolCallIndices: record.preferenceTargets![arm].supervisedToolCallIndices.map((index) => index + offset) } });
        total += measured.labels.filter((label) => label !== -100).length;
      }
      assert.equal(record.provenance.tokenCount!.tokens, total);
    } else {
      const measured = bridge.measure({ family: record.family, messages: record.messages, targetSelection: record.targetSelection });
      assert.equal(measured.supervisedTokens, record.provenance.tokenCount!.tokens);
      const history = measured.assistantRanges.find((region) => !region.selected)!;
      assert.ok(history);
      assert.ok(measured.tokens.filter((token) => token.start < history.end && token.end > history.start).every((token) => token.label === -100));
    }
  }
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
  const artifacts = new Map<string, string>();
  const certificates = new Map<string, string>();
  const validators: Record<string, { version: string; implementationDigest: string }> = {};
  const implementation = readFileSync("dataset/src/generate.ts", "utf8");
  const implementationDigest = sha256Hex(implementation);
  artifacts.set(implementationDigest, implementation);
  const records = report.unitOutcomes.map((outcome) => outcome.admittedRecord!);
  for (const outcome of report.unitOutcomes) {
    const record = outcome.admittedRecord!;
    certificates.set(record.recordId, record.admissionCertificate.certificateDigest);
    const validation = inspectPipelineCheckpoint<{ artifactDigests: string[] }>(run.store, `validation:${outcome.admittedAttemptId}`)!;
    for (const digest of validation.artifactDigests) artifacts.set(digest, inspectPipelineCheckpoint<string>(run.store, `artifact:${digest}`)!);
    const review = inspectPipelineCheckpoint<{ request: TeacherCompletionRequest }>(run.store, `dispatch:${outcome.admittedAttemptId}-review`)!;
    artifacts.set(sha256Hex(review.request.system), review.request.system);
    for (const evidence of record.admissionCertificate.evidence) validators[evidence.validator] = { version: evidence.version, implementationDigest };
  }
  const approvedRegistry = withMeasuredQwen3Template({ artifacts, certificates, validators, templateProfiles: [] });
  const exported = exportTrainingJsonl(records, { outputDir: join(run.root, "real-tokenizer-export"), approvedRegistry });
  const checksumDigest = sha256Hex(readFileSync(exported.checksumPath, "utf8"));
  const prepared = preprocessTrainingExport({ outputDir: exported.outputDir, checksumDigest, approvedRegistry, tokenizer: bridge });
  assert.equal(prepared.sft.length, 1);
  assert.equal(prepared.preference.length, 2);
  const sftRecord = records.find((record) => !record.preference)!;
  const sftTrace = bridge.measure({ family: sftRecord.family, messages: sftRecord.messages, targetSelection: sftRecord.targetSelection });
  assert.deepEqual(prepared.sft[0]!.inputIds, sftTrace.inputIds);
  assert.deepEqual(prepared.sft[0]!.labels, sftTrace.labels);
  for (const row of prepared.preference) for (const arm of ["chosen", "rejected"] as const) {
    const record = records.find((entry) => entry.recordId === row.recordId)!;
    const offset = record.preference!.prompt.length;
    const trace = bridge.measure({ family: record.family, messages: [...record.preference!.prompt, ...record.preference![arm]],
      targetSelection: { supervisedAssistantIndices: record.preferenceTargets![arm].supervisedAssistantIndices.map((index) => index + offset), supervisedToolCallIndices: [] } });
    assert.deepEqual(row[arm].inputIds, trace.inputIds);
    assert.deepEqual(row[arm].labels, trace.labels);
    assert.deepEqual(arm === "chosen" ? row.chosenLogProbabilityMask : row.rejectedLogProbabilityMask, trace.labels.map((label) => label !== -100));
    assert.equal(row[arm].labels.filter((label) => label !== -100).at(-1), 151645, "the selected turn terminator survives export and preparation; trailing newlines stay masked");
  }
  const alternate = createTokenizerBridge({ python: process.env.FOUNDRY_TOKENIZER_PYTHON!, assetsDir: ".dataset/tokenizer/qwen3-8b", maxSequenceLength: 8192 });
  assert.notEqual(alternate.policyDigest, bridge.policyDigest);
  assert.throws(() => preprocessTrainingExport({ outputDir: exported.outputDir, checksumDigest, approvedRegistry, tokenizer: alternate }), /preprocessing policy/);
  writeFileSync(exported.trainingPath, "tampered\n");
  assert.throws(() => preprocessTrainingExport({ outputDir: exported.outputDir, checksumDigest, approvedRegistry, tokenizer: bridge }), /changed training/);
});

const DIAGNOSTIC_SEED = "public-context-runner-test-1";

interface ScenePayload {
  readonly sceneId: string;
  readonly turnId: string;
  readonly subjects: readonly { subjectId: string; kind: string; displayName: string }[];
  readonly observations: readonly { factId: string; subjectId: string; predicate: string; value: string }[];
}

/** The structured public scene input actually supplied to this attempt. */
function suppliedScene(request: TeacherCompletionRequest): ScenePayload | null {
  const match = / PUBLIC SCENE OBSERVATIONS\n(\{[\s\S]*?\}) NARRATION SUBMISSION CONTRACT/.exec(request.system);
  return match ? JSON.parse(match[1]!) as ScenePayload : null;
}

/** One complete observation sentence per supplied fact, using the registered labels. */
function sceneSentences(scene: ScenePayload): string[] {
  return scene.observations.map((observation) => {
    const subject = scene.subjects.find((entry) => entry.subjectId === observation.subjectId)!.displayName;
    return observation.predicate === "light-colour" ? `${subject} has an ${observation.value} hue.` : `${subject} are ${observation.value}.`;
  });
}

/** A narration fixture, not a quality claim: full mechanical coverage, plus the
 * supplied observations when this attempt was given them. */
function diagnosticNarration(request: TeacherCompletionRequest, options: { observationsOnly?: boolean } = {}): string {
  const scene = suppliedScene(request);
  const system = request.system.replace(/ PUBLIC SCENE OBSERVATIONS\n[\s\S]*?\} NARRATION SUBMISSION CONTRACT/, " NARRATION SUBMISSION CONTRACT");
  const beat = guidedReceiptNarration({ ...request, system });
  if (options.observationsOnly) {
    // Exactly what the arm was shown, and nothing mechanical: optional scene
    // usage must never stand in for a requested receipt.
    return scene && sceneSentences(scene).length > 0 ? sceneSentences(scene).join(" ") : beat.split(/ the attacker /i)[0]!;
  }
  return scene && sceneSentences(scene).length > 0 ? `${beat} ${sceneSentences(scene).join(" ")}` : beat;
}

// ---------------------------------------------------------------------------
// Opt-in public-context diagnostic: planning, runner forwarding and provenance
// ---------------------------------------------------------------------------
// The frozen ordinary inventories are pinned here: adding the diagnostic must
// not move one byte of the pilot or the matched v7 calibration plan.

const ORDINARY_PILOT_PLAN_DIGEST = "f633ead229d265f97da0420fd0583dc7f8b21e6349fb5e150e7968a8b05233c2";
const MATCHED_V7_PLAN_DIGEST = "4ba77018ff32497f1e431508f4ffc602f37179efac1782170fa9b78d29b38e04";

test("the ordinary and pilot plan digests are unchanged when the diagnostic option is absent", () => {
  assert.equal(planRun({ seed: "pilot-1", units: 175, realizationsPerScenario: 3 }).digest, ORDINARY_PILOT_PLAN_DIGEST);
  const matched = planRun({ seed: "calibration-grounding-2026-10-13-6", units: 13, realizationsPerScenario: 1,
    families: ["grounded-narration", "tool-selection"] });
  assert.equal(matched.digest, MATCHED_V7_PLAN_DIGEST);
  assert.equal(matched.publicContextDiagnostic, undefined);
  assert.deepEqual(stableStringify(matched.units[0]!.spec.oracle.publicSceneFacts ?? null), "null");
  assert.equal(matched.units[0]!.spec.oracle.publicSceneScope, undefined);
});

test("three frozen bases become six matched arms whose only public difference is the observation projection", () => {
  const manifest = createPublicContextDiagnosticManifest(DIAGNOSTIC_SEED);
  const option = { manifest, expectedManifestDigest: manifest.manifestDigest };
  const plan = planRun({ seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: option });
  assert.equal(plan.units.length, 6);
  assert.equal(plan.scenarioCount, 3, "three base scenarios expand to two context arms each");
  assert.equal(plan.realizationsPerScenario, 1, "the second arm is not a stochastic realization");
  assert.deepEqual(plan.splitCounts, { train: 6, dev: 0, "sealed-test": 0 });
  assert.equal(plan.publicContextDiagnostic!.manifestDigest, manifest.manifestDigest);
  assert.equal(plan.publicContextDiagnostic!.schedule.length, 6);
  assert.deepEqual(planRun({ seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: option }), plan, "the diagnostic plan is a pure function of its frozen inputs");

  const pairs = new Map<string, typeof plan.units>();
  for (const unit of plan.units) pairs.set(unit.scenarioUnitId, [...(pairs.get(unit.scenarioUnitId) ?? []), unit]);
  assert.equal(pairs.size, 3);
  const voices = new Map<string, string>();
  for (const [pairId, arms] of pairs) {
    assert.equal(arms.length, 2, pairId);
    const [control = arms[0]!, observed = arms[1]!] = [...arms].sort((left, right) => left.unitId.localeCompare(right.unitId));
    assert.equal(control.publicContext!.publicContext, "none");
    assert.equal(observed.publicContext!.publicContext, "observations");
    assert.equal(control.publicContext!.pairId, observed.publicContext!.pairId);
    assert.equal(control.publicContext!.sourceId, observed.publicContext!.sourceId);
    assert.equal(control.publicContext!.baseUnitId, observed.publicContext!.baseUnitId);
    assert.equal(control.realizationOrdinal, 0);
    assert.equal(observed.realizationOrdinal, 0);
    // Identical pair mechanics, voice, split, lineage and cluster.
    assert.equal(stableStringify(control.spec.oracle.receipts), stableStringify(observed.spec.oracle.receipts));
    assert.equal(stableStringify(control.spec.slots), stableStringify(observed.spec.slots));
    assert.equal(control.realization.slots.tone, observed.realization.slots.tone);
    assert.equal(stableStringify(control.spec.split), stableStringify(observed.spec.split));
    assert.equal(stableStringify(control.spec.lineage), stableStringify(observed.spec.lineage));
    assert.equal(control.realization.clusterId, observed.realization.clusterId);
    assert.deepEqual(control.spec.advertisedTools, observed.spec.advertisedTools);
    assert.equal(control.realization.context[1]!.content, observed.realization.context[1]!.content, "the task wording is identical");
    // A CONTEXT ABLATION: no preference and no twin group is fabricated.
    assert.equal(control.preference, undefined);
    assert.equal(observed.preference, undefined);
    assert.equal(control.twinGroupId, undefined);
    assert.equal(observed.twinGroupId, undefined);
    assert.equal(control.spec.oracle.authorizedConsequences.length, 0);
    assert.equal(observed.spec.oracle.authorizedConsequences.length, 0);
    // Only the supplied observation payload differs, and only in the observation arm.
    const strip = (system: string): string => system.replace(/ PUBLIC SCENE OBSERVATIONS\n[\s\S]*?\} /, " <scene> ");
    assert.equal(strip(control.realization.context[0]!.content), strip(observed.realization.context[0]!.content));
    assert.match(control.realization.context[0]!.content, /PUBLIC SCENE OBSERVATIONS\n\{"observations":\[\],"sceneId":"public-scene-/);
    assert.match(observed.realization.context[0]!.content, /"observations":\[\{"factId":"scene-fact-/);
    assert.equal(control.spec.oracle.publicSceneFacts!.length, 0);
    assert.equal(observed.spec.oracle.publicSceneFacts!.length, 2);
    assert.equal(observed.spec.oracle.publicSceneScope!.sceneId, control.spec.oracle.publicSceneScope!.sceneId);
    // Each overlay carries its own recomputed digest: copying the frozen base
    // digest after changing the oracle would leave the two equal.
    const baseSpec = scenarioSpec(control.spec.seed, { family: "grounded-narration" });
    assert.notEqual(control.spec.digest, observed.spec.digest);
    assert.notEqual(control.spec.digest, baseSpec.digest);
    assert.notEqual(observed.spec.digest, baseSpec.digest);
    assert.equal(control.spec.templateVersion, PUBLIC_CONTEXT_OVERLAY_TEMPLATE_VERSION);
    assert.notEqual(control.spec.specId, baseSpec.specId);
    voices.set(pairId, observed.realization.slots.tone!);
  }
  // The three frozen bases are the selected v6 voices, in frozen plan order.
  assert.deepEqual([...voices.values()], ["warm but evasive", "low-register and wary", "terse and procedural"]);
  assert.deepEqual(plan.units.map((unit) => unit.publicContext!.baseUnitId),
    ["unit-8c28b0ce238d1727", "unit-98bf7c802f569a5e", "unit-6b1501d2ec6a7a77"].flatMap((base) => [base, base]));
});

test("the diagnostic refuses conflicting units, K, families, twins, seeds, pins and mutated frozen bytes", () => {
  const manifest = createPublicContextDiagnosticManifest(DIAGNOSTIC_SEED);
  const option = { manifest, expectedManifestDigest: manifest.manifestDigest };
  const plan = (overrides: Partial<Parameters<typeof planRun>[0]>) => planRun({
    seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: option, ...overrides });
  assert.throws(() => plan({ units: 4 }), /units: 3/);
  assert.throws(() => plan({ realizationsPerScenario: 2 }), /realizationsPerScenario: 1/);
  assert.throws(() => plan({ families: ["grounded-narration", "tool-selection"] }), /only the grounded-narration family/);
  assert.throws(() => plan({ pairedTwins: [twinInput()] }), /paired twins are not part/);
  assert.throws(() => plan({ seed: "some-other-seed" }), /must be the manifest's diagnostic seed/);
  assert.throws(() => plan({ publicContextDiagnostic: { ...option, expectedManifestDigest: "0".repeat(64) } }),
    /manifest-pin-mismatch/);
  // A re-pinned manifest whose source bytes were edited never plans: the frozen
  // source is reconstructed from the resolved base slots and compared.
  const unsigned = manifest.sources[0]!.observations.map((observation) => (observation.predicate === "light-colour"
    ? { ...observation, value: "white" as const } : observation));
  const editedBody = { ...manifest.sources[0]!, observations: unsigned };
  const edited: PublicContextDiagnosticManifest = { ...manifest, sources: manifest.sources.map((source, index) => (index === 0
    ? parsePublicObservationSource({ ...editedBody, canonicalDigest: publicObservationSourceDigest(editedBody) }, "edited") : source)) };
  const resigned = { ...edited, manifestDigest: publicContextDiagnosticManifestDigest({ ...edited, manifestDigest: "" }) };
  assert.notEqual(resigned.manifestDigest, manifest.manifestDigest);
  assert.throws(() => planRun({ seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: { manifest: resigned as typeof manifest, expectedManifestDigest: resigned.manifestDigest } }),
    /frozen source reconstructed from its resolved base slots/);
  // The same edit left unsigned is refused by the source contract itself.
  const unsignedManifest = { ...edited, sources: [{ ...manifest.sources[0]!, observations: unsigned }, ...manifest.sources.slice(1)] };
  assert.throws(() => planRun({ seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: { manifest: unsignedManifest as PublicContextDiagnosticManifest,
      expectedManifestDigest: publicContextDiagnosticManifestDigest({ ...unsignedManifest, manifestDigest: "" }) } }),
    /source-digest-mismatch/);
  // A base whose retained mechanics no longer match is refused as well.
  const mutatedBase: PublicContextDiagnosticManifest = { ...manifest, bases: manifest.bases.map((base, index) => (index === 1
    ? { ...base, receiptsDigest: "0".repeat(64) } : base)) };
  const resignedBase = { ...mutatedBase, manifestDigest: publicContextDiagnosticManifestDigest({ ...mutatedBase, manifestDigest: "" }) };
  assert.throws(() => planRun({ seed: DIAGNOSTIC_SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
    publicContextDiagnostic: { manifest: resignedBase as typeof manifest, expectedManifestDigest: resignedBase.manifestDigest } }),
    /frozen mechanics, slots, split, lineage or cluster/);
});

test("runPipeline forwards the option: six arms, real source provenance, resolvable source bytes and a clean resume", async (t) => {
  const manifest = createPublicContextDiagnosticManifest(DIAGNOSTIC_SEED);
  const generated: string[] = [];
  const generator = outputClient((request) => {
    generated.push(request.attemptId);
    return { content: "", toolCalls: [{ id: request.attemptId, type: "function",
      function: { name: "submit_adventure_narration", arguments: { narration: diagnosticNarration(request) } } }] };
  });
  const run = setup(t, { seed: DIAGNOSTIC_SEED, units: 3, families: ["grounded-narration"], maxRepairs: 0, generator,
    publicContextDiagnostic: { manifest, expectedManifestDigest: manifest.manifestDigest } });
  assert.equal(run.plan.units.length, 6);
  assert.equal(run.store.config().totalUnits, 6);
  const first = await runPipeline({ ...run.options, store: run.store });
  assert.equal(first.units, 6);
  assert.equal(first.admitted, 6, JSON.stringify(first.unitOutcomes.map((outcome) => outcome.refusedAt)));
  assert.equal(first.complete, true);
  for (const outcome of first.unitOutcomes) {
    const unit = run.plan.units.find((entry) => entry.unitId === outcome.unitId)!;
    const record = run.store.readAdmittedRecord(outcome.admittedAttemptId!)!;
    assert.equal(record.provenance.sourceDigests.publicSceneManifest, manifest.manifestDigest);
    // Assert the derived constant rather than a hardcoded literal, so a future
    // intentional grounding-validator bump does not silently strand this pin.
    assert.equal(record.provenance.validatorVersions["binding-grounding"], PUBLIC_SCENE_GROUNDING_VALIDATOR_VERSION);
    const artifactDigests = inspectPipelineCheckpoint<{ artifactDigests: string[] }>(run.store, `validation:${outcome.admittedAttemptId}`)!.artifactDigests;
    const artifacts = new Map(artifactDigests.map((digest) => [digest, inspectPipelineCheckpoint<string>(run.store, `artifact:${digest}`)!]));
    assert.ok(artifacts.has(manifest.manifestDigest), "the frozen manifest bytes resolve for every arm");
    assert.equal(stableStringify(JSON.parse(artifacts.get(manifest.manifestDigest)!)), stableStringify(publicContextDiagnosticManifestBody(manifest)));
    if (unit.publicContext!.publicContext === "observations") {
      assert.equal(record.provenance.sourceDigests.publicSceneSource, unit.publicContext!.sourceCanonicalDigest);
      assert.ok(artifacts.has(unit.publicContext!.sourceCanonicalDigest), "the frozen source bytes resolve");
      assert.match(artifacts.get(unit.publicContext!.sourceCanonicalDigest)!, /light-colour/);
    } else {
      assert.equal(record.provenance.sourceDigests.publicSceneSource, undefined, "the control arm is bound to the manifest, not to a source it was never shown");
    }
    // The supplied payload reached the teacher, and the caption survived into the record.
    assert.match(record.messages[0]!.content, /PUBLIC SCENE OBSERVATIONS/);
  }
  const calls = [...run.calls];
  assert.deepEqual(generated, run.plan.units.map((unit) => `${unit.unitId}-a0`), "the option reached execution, not just preflight");
  assert.equal(run.calls.length, 6, "six independent reviews on the fixture reviewer");
  const resumed = await runPipeline({ ...run.options, store: run.reopen() });
  assert.deepEqual(resumed, first);
  assert.deepEqual(run.calls, calls, "resume replays the durable bytes and dispatches nothing new");
  assert.equal(generated.length, 6, "a resumed run sends no new generation");
});

test("observations cannot cover an omitted receipt in either arm, and refusals still retain the source bytes", async (t) => {
  const manifest = createPublicContextDiagnosticManifest(DIAGNOSTIC_SEED);
  const generator = outputClient((request) => ({ content: "", toolCalls: [{ id: request.attemptId, type: "function",
    function: { name: "submit_adventure_narration", arguments: { narration: diagnosticNarration(request, { observationsOnly: true }) } } }] }));
  const run = setup(t, { seed: DIAGNOSTIC_SEED, units: 3, families: ["grounded-narration"], maxRepairs: 0, generator,
    publicContextDiagnostic: { manifest, expectedManifestDigest: manifest.manifestDigest } });
  const report = await runPipeline({ ...run.options, store: run.store });
  assert.equal(report.admitted, 0);
  for (const outcome of report.unitOutcomes) {
    assert.match(outcome.refusedAt!, /receipt-provenance/, "a dropped damage receipt is refused even when observations are correct");
    const validation = inspectPipelineCheckpoint<{ artifactDigests: string[]; runs: { validator: string; passed: boolean }[] }>(
      run.store, `validation:${outcome.unitId}-a0`)!;
    assert.ok(validation.runs.some((run_) => run_.validator === "receipt-provenance" && !run_.passed));
    const artifacts = new Map(validation.artifactDigests.map((digest) => [digest, inspectPipelineCheckpoint<string>(run.store, `artifact:${digest}`)!]));
    assert.ok(artifacts.has(manifest.manifestDigest), "a refusal still carries the frozen manifest bytes");
    const record = run.store.readCandidate(`${outcome.unitId}-a0`)!;
    assert.equal(record.admission.status, "pending-review");
    assert.equal(record.provenance.sourceDigests.publicSceneManifest, manifest.manifestDigest);
  }
  // Any other diagnostic identity -- a different frozen seed here -- refuses
  // before a single dispatch, so this store can never be reused for it.
  const other = createPublicContextDiagnosticManifest(`${DIAGNOSTIC_SEED}-other`);
  await assert.rejects(() => runPipeline({ ...run.options, store: run.reopen(),
    publicContextDiagnostic: { manifest: other, expectedManifestDigest: other.manifestDigest } }),
    /public-context diagnostic refused: the plan seed must be the manifest's diagnostic seed/);
});
