import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planRun, runPipeline, type PipelineOptions, type ScheduledTwinInput, type TokenizerPort } from "../src/generate.js";
import { assertGeneratedSplits, loadGenerationPolicy } from "../src/generationPolicy.js";
import { openRunStore, RunLockError, type OpenRunStoreOptions } from "../src/runstore.js";
import { inspectPipelineCheckpoint, PipelineJournal, UncertainDispatchError } from "../src/pipelineJournal.js";
import { authoritativeFacts, type GroundingReceipt } from "../src/grounding.js";
import { anchorCandidates, type ProseQualityScorer } from "../src/twins.js";
import { selectAdmittedRecords } from "../src/selection.js";
import { verifyAdmissionCertificate, type ApprovedAdmissionRegistry } from "../src/admission.js";
import { sha256Hex, type TeacherClient, type TeacherCompletionRequest } from "../src/teacher.js";
import { stableStringify } from "../src/spec.js";
import { createTokenizerBridge, withMeasuredQwen3Template } from "../src/tokenizer.js";

const ACCEPT = JSON.stringify({ characterization: 0.8, dialogueQuality: 0.8, coherence: 0.8, narrativeInitiative: 0.8,
  playerAgency: 0.9, nonRepetitive: 0.8, verdict: "accept", rationale: "independent test fixture review" });
const policy = loadGenerationPolicy();
const tokenizer: TokenizerPort = { name: "runner test only: whitespace counter", countSupervisedTokens: (example) =>
  example.targetSelection.supervisedAssistantIndices.reduce((sum, index) => sum + example.messages[index]!.content.split(/\s+/).filter(Boolean).length, 0) };
const proseScorer: ProseQualityScorer = { scorerId: "independent-fixture-grader", version: "fixture-rubric-v1",
  score: () => ({ rate: 0.75, graded: 2, measuredBy: "test:independent-fixture-grader" }) };

function client(model: string, answer: (request: TeacherCompletionRequest) => string | Promise<string>): TeacherClient {
  return { model, baseUrlDigest: "fixture-route-digest", identity: { provider: "test", model, baseUrlDigest: "fixture-route-digest", credentialSource: "env" },
    complete: async (request) => ({ content: await answer(request), toolCalls: [], finishReason: "stop", usage: null,
      responseId: null, attempts: 1, latencyMs: 0, requestDigest: sha256Hex(stableStringify(request)) }) };
}

function setup(t: { after(fn: () => void): void }, overrides: Partial<PipelineOptions> = {}) {
  const root = mkdtempSync("/tmp/opencode/foundry-runner-");
  const calls: string[] = [];
  const generator = client("fixture-teacher", (request) => { calls.push(request.attemptId); return "The lantern gutters beside the closed ledger."; });
  const reviewer = client("fixture-reviewer", (request) => { calls.push(request.attemptId); return ACCEPT; });
  const options: PipelineOptions = { runId: "runner", seed: "runner-seed", units: 2, families: ["roleplay-conversation"],
    tokenizer, generator, reviewer, maxRepairs: 1, maxCompletionTokens: 128, gitCommit: null, execute: true, ...overrides };
  const plan = planRun({ seed: options.seed, units: options.units!, families: options.families!,
    realizationsPerScenario: options.realizationsPerScenario ?? 1, pairedTwins: options.pairedTwins ?? [] });
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
  return { spec: { caseId: "runner-twin", prompt: [{ role: "user", content: "Narrate the committed check." }], receipts,
    faithfulNarration: "Your Investigation check comes to 22 against a Medium DC of 15: success.",
    counterfactualNarration: "Your Investigation check comes to 24 against a Medium DC of 15: your Investigation check succeeds.",
    flip: { op: "set-value", factId: "roll", role: "total", value: 24 }, flipAnchor: numeric },
    counterfactualReceipts: [{ ...receipts[0]!, total: 24 } as GroundingReceipt],
    anchors: [candidates.find((anchor) => anchor.value === "Investigation")!, numeric, candidates.find((anchor) => anchor.value === "Medium")!],
    seed: "twin-seed", generator: { provider: "test", model: "fixture-teacher", baseUrlDigest: "fixture-route-digest", temperature: 0.7 } };
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
  assert.equal(report.attempts, 2);
  const expected = run.store.candidates().reduce((sum, record) => sum + record.provenance.tokenCount!.tokens, 0);
  assert.equal(report.budget.supervisedTokens, expected);
  assert.equal(report.unitOutcomes[0]!.supervisedTokens, expected);
  assert.deepEqual(await runPipeline({ ...run.options, store: run.reopen() }), report);
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
  const replacement = openRunStore(options);
  assert.equal(replacement.snapshot().diagnostics.tookOverStaleLock, true);
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
});
