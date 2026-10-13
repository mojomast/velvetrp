import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { computePayloadDigest } from "../src/admission.js";
import { createBlindParityPackets, createBlindProseInventory, loadMeasuredProseEvidence, proseArtifactDigest,
  type BlindProsePacket, type ProseInventory, type ProseMeasurementLedger, type ProsePairInput, type ProseSource, type RecordedProseJudgment } from "../src/proseMeasurement.js";
import type { PreferencePair, StoredMessage } from "../src/spec.js";

const prompt: readonly StoredMessage[] = [{ role: "user", content: "Narrate the public check." }];
const styleContext: readonly StoredMessage[] = [{ role: "user", content: "Narrate an investigation by lantern-light." }];
const chosenArm: readonly StoredMessage[] = [{ role: "assistant", content: "The lantern catches a thin line of dust: your Investigation check reaches 22." }];
const rejectedArm: readonly StoredMessage[] = [{ role: "assistant", content: "The lantern catches a thin line of dust: your Investigation check reaches 24." }];
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** Grader identity shared by fixture records; every judgment still needs its own session and time. */
const fixtureGrader = { provider: "test", model: "independent-fixture", revision: "fixture-v1" };
const passFields = { status: "graded", verdict: "pass", ratings: { voice: 1, clarity: 1, proportion: 1, naturalness: 1 },
  evidence: ["The lantern catches a thin line of dust"], rationale: "test fixture: concise readable prose" };

function fixture() {
  const pair: PreferencePair = { prompt: [...prompt], chosen: [...chosenArm], rejected: [...rejectedArm],
    axis: "entity-value-fidelity", rationale: "fixture only", lengthRatio: 1.1 };
  const input: ProsePairInput = { pair, chosenSourceId: "chosen-private", rejectedSourceId: "rejected-private", requestRubricVersion: "prose-retention-v1" };
  const sources: ProseSource[] = ["chosen", "rejected"].map((arm, index) => ({ sourceId: index ? input.rejectedSourceId : input.chosenSourceId,
    cohort: "generated-twin", generator: "test:fixture-teacher", prompt: [...prompt], answer: [...pair[arm as "chosen" | "rejected"]],
    styleContext: [...styleContext], extraction: { mode: "assistant-content" } }));
  const inventory = createBlindProseInventory(sources, [input], "private-seed");
  const judgments: RecordedProseJudgment[] = inventory.packets.map((packet, index) => ({ packetDigest: proseArtifactDigest(packet),
    grader: { ...fixtureGrader, sessionId: `fixture-individual-${packet.sampleId.slice(0, 8)}`, judgedAt: `2026-10-13T00:0${index}:00Z` },
    rawResponse: JSON.stringify({ sampleId: packet.sampleId, blindingCompromised: false, ...passFields }) }));
  const parity = createBlindParityPackets(inventory, judgments).map((packet) => ({ packetDigest: proseArtifactDigest(packet),
    grader: { ...fixtureGrader, sessionId: `fixture-parity-${packet.pairId.slice(0, 8)}`, judgedAt: "2026-10-13T00:10:00Z" }, rawResponse: JSON.stringify({
      pairId: packet.pairId, verdict: "equivalent", rationale: "test fixture: only a numeric fact differs", evidenceA: ["The lantern catches"], evidenceB: ["The lantern catches"] }) }));
  const ledger: ProseMeasurementLedger = { inventory, judgments, parity };
  const request = { pairDigest: computePayloadDigest({ messages: pair.prompt, preference: pair }),
    armDigests: [pair.chosen, pair.rejected].map(proseArtifactDigest), rubricVersion: input.requestRubricVersion };
  return { ledger, request };
}

function plainSource(sourceId: string, answer: readonly StoredMessage[] | null, overrides: Partial<ProseSource> = {}): ProseSource {
  return { sourceId, cohort: "generated-rp", generator: "test:teacher", prompt: [...prompt], answer,
    styleContext: [...styleContext], extraction: answer === null ? null : { mode: "assistant-content" }, ...overrides };
}

/** Opaque sample IDs follow the frozen seeded recipe, so fixtures can address their own packets. */
function packetOf(inventory: ProseInventory, sourceId: string): BlindProsePacket {
  return inventory.packets.find((packet) => packet.sampleId === sha256(`${inventory.seed}|opaque|${sourceId}`))!;
}
function rawSample(packet: BlindProsePacket, fields: Record<string, unknown>): string {
  return JSON.stringify({ sampleId: packet.sampleId, blindingCompromised: false, ...passFields, evidence: [], ...fields });
}
/** Single-cohort ledgers exercise availability rules without any pair/parity ceremony. */
function singleSourceLedger(source: ProseSource, fields: Record<string, unknown> = passFields) {
  const inventory = createBlindProseInventory([source], [], "availability-seed");
  const packet = packetOf(inventory, source.sourceId);
  const judgments: RecordedProseJudgment[] = [{ packetDigest: proseArtifactDigest(packet),
    grader: { ...fixtureGrader, sessionId: "fixture-single-session", judgedAt: "2026-10-13T00:00:00Z" }, rawResponse: rawSample(packet, fields) }];
  return { inventory, packet, ledger: { inventory, judgments, parity: [] } as ProseMeasurementLedger };
}

test("blinded packets are reproducible, display the whole captured surface and hide producer/preference instrumentation", () => {
  const { ledger } = fixture();
  const inventory = ledger.inventory;
  assert.deepEqual(createBlindProseInventory(inventory.sources, inventory.pairs, inventory.seed), inventory);
  const display = JSON.stringify(inventory.packets);
  assert.doesNotMatch(display, /chosen|rejected|fixture-teacher|lengthRatio|semanticSimilarity|sourceId|pairDigest/);
  assert.ok(inventory.packets.every((packet) => packet.objectiveStatus === "gradeable" && packet.availabilityReason === null
    && packet.proseSegments.length === 1 && packet.prose!.startsWith("The lantern catches")));
  assert.ok(inventory.packets.every((packet) => packet.prose === packet.proseSegments.join("\n\n")
    && packet.binding.proseDigest === sha256(packet.prose!) && packet.binding.answerDigest && packet.binding.extractionDigest));
  assert.equal(new Set(inventory.packets.map((packet) => packet.sampleId)).size, 2);
});

test("offline scorer resolves only exact independently pinned pair/ordered-arm/rubric evidence", () => {
  const { ledger, request } = fixture();
  const measured = loadMeasuredProseEvidence(ledger, proseArtifactDigest(ledger));
  assert.equal(measured.scorer.score(request).rate, 1);
  assert.equal(measured.scorer.score(request).graded, 2);
  assert.equal(measured.report.cohorts["generated-twin"]!.passed, 2);
  assert.equal(measured.report.styleCleanPairs, 1);
  assert.equal(measured.report.censusScope, "declared-inventory-only");
  assert.equal(measured.report.studentRetention, "unmeasured");
  for (const wrong of [{ ...request, pairDigest: "0".repeat(64) }, { ...request, armDigests: [...request.armDigests].reverse() },
    { ...request, rubricVersion: "historical-stock-rubric" }]) assert.throws(() => measured.scorer.score(wrong), /exact pair/);
  assert.throws(() => loadMeasuredProseEvidence(ledger, "0".repeat(64)), /inspected pin/);
});

test("stale packets, false excerpts, wrong dimensions and self-review fail verification", () => {
  for (const mutation of ["binding", "quote", "dimension", "producer", "verdict"] as const) {
    const { ledger } = fixture();
    const copy = JSON.parse(JSON.stringify(ledger));
    const row = copy.judgments[0];
    const response = JSON.parse(row.rawResponse);
    if (mutation === "binding") row.packetDigest = "0".repeat(64);
    if (mutation === "quote") response.evidence = ["This was never in the prose"];
    if (mutation === "dimension") response.ratings.anchorCount = 2;
    if (mutation === "producer") row.grader.model = "fixture-teacher";
    if (mutation === "verdict") response.ratings.voice = 0;
    row.rawResponse = JSON.stringify(response);
    assert.throws(() => loadMeasuredProseEvidence(copy, proseArtifactDigest(copy)), /stale|missing planned|excerpt|dimensions|independent|ratings/);
  }
});

test("one passing arm or a material style tell cannot certify a clean preference pair", () => {
  for (const reason of ["one-fail", "style-advantage", "contaminated"] as const) {
    const { ledger, request } = fixture();
    const copy = JSON.parse(JSON.stringify(ledger));
    if (reason !== "style-advantage") {
      const row = JSON.parse(copy.judgments[0].rawResponse);
      if (reason === "one-fail") { row.verdict = "fail"; row.ratings.proportion = 0; }
      else row.blindingCompromised = true;
      copy.judgments[0].rawResponse = JSON.stringify(row);
    }
    const packets = createBlindParityPackets(copy.inventory, copy.judgments);
    copy.parity[0].packetDigest = proseArtifactDigest(packets[0]);
    if (reason === "style-advantage") { const row = JSON.parse(copy.parity[0].rawResponse); row.verdict = "A-better"; copy.parity[0].rawResponse = JSON.stringify(row); }
    const measured = loadMeasuredProseEvidence(copy, proseArtifactDigest(copy));
    assert.equal(measured.report.styleCleanPairs, 0);
    assert.throws(() => measured.scorer.score(request), /both twin arms|style advantage/);
  }
});

test("complete inventory includes missing samples without inventing zeros or favorable denominators", () => {
  const { ledger, packet } = singleSourceLedger(plainSource("missing-attempt", null,
    { extraction: null, unavailableReason: "provider returned no captured response" }),
    { status: "incomplete", verdict: null, ratings: null, rationale: "no captured output", evidence: [] });
  assert.equal(packet.objectiveStatus, "incomplete");
  assert.match(packet.availabilityReason!, /no captured answer/);
  assert.equal(packet.binding.answerDigest, null);
  const measured = loadMeasuredProseEvidence(ledger, proseArtifactDigest(ledger));
  assert.deepEqual(measured.report.cohorts["generated-rp"], { planned: 1, graded: 0, passed: 0, failed: 0, incomplete: 1,
    abstained: 0, ungradeable: 0, compromised: 0, unassessed: 1, conditionalQuality: null, coverage: 0, acceptableYield: 0, floorState: "incomplete" });
  const empty = { ...ledger, judgments: [] };
  assert.throws(() => loadMeasuredProseEvidence(empty, proseArtifactDigest(empty)), /incomplete/);
});

test("projection/source tampering and parity judged before individual decisions are refused", () => {
  const { ledger } = fixture();
  const copy = JSON.parse(JSON.stringify(ledger));
  copy.inventory.packets[0].prose += " favorable extra prose";
  assert.throws(() => loadMeasuredProseEvidence(copy, proseArtifactDigest(copy)), /after freezing/);
  const early = JSON.parse(JSON.stringify(ledger));
  early.parity[0].grader.judgedAt = "2026-10-12T00:00:00Z";
  assert.throws(() => loadMeasuredProseEvidence(early, proseArtifactDigest(early)), /before locking/);
});

test("a hidden second assistant message or tool prose cannot be certified as a cherry-picked fragment", () => {
  const twoMessages = [{ role: "assistant", content: "The lantern steadies." } satisfies StoredMessage,
    { role: "assistant", content: "Cold wax spits once and dies." } satisfies StoredMessage];
  const shown = singleSourceLedger(plainSource("two-message", twoMessages),
    { ...passFields, evidence: ["The lantern steadies.", "Cold wax spits once and dies."] });
  assert.equal(shown.packet.objectiveStatus, "gradeable");
  assert.deepEqual(shown.packet.proseSegments, twoMessages.map((message) => message.content));
  assert.equal(shown.packet.prose, "The lantern steadies.\n\nCold wax spits once and dies.");
  assert.equal(shown.packet.binding.answerDigest, proseArtifactDigest(twoMessages));
  assert.doesNotThrow(() => loadMeasuredProseEvidence(shown.ledger, proseArtifactDigest(shown.ledger)));
  assert.notEqual(shown.packet.binding.answerDigest,
    singleSourceLedger(plainSource("two-message", [twoMessages[0]!])).packet.binding.answerDigest);
  const mixed = plainSource("mixed-surface", [{ role: "assistant", content: "The lantern steadies.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "narrate", arguments: { narration: "Cold wax spits once and dies." } } }] }]);
  const twoCalls = plainSource("two-calls", [{ role: "assistant", content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "narrate", arguments: { narration: "One." } } },
      { id: "call_2", type: "function", function: { name: "narrate", arguments: { narration: "Two." } } }] }], { extraction: { mode: "single-tool-narration" } });
  for (const source of [mixed, twoCalls]) {
    const { packet, ledger } = singleSourceLedger(source);
    assert.equal(packet.objectiveStatus, "ungradeable");
    assert.equal(packet.prose, null);
    assert.deepEqual(packet.proseSegments, []);
    assert.ok(packet.binding.answerDigest, "the real captured answer stays bound to the census");
    assert.match(packet.availabilityReason!, /ambiguous captured prose surface/);
    assert.throws(() => loadMeasuredProseEvidence(ledger, proseArtifactDigest(ledger)), /misattributes an objectively ungradeable capture/);
  }
});

test("unavailable style context, undeclared recipes and empty captures are kept but never graded", () => {
  const noContext = singleSourceLedger(plainSource("no-context", chosenArm, { styleContext: [], unavailableReason: "custodian projection was never reviewed" }),
    { status: "incomplete", verdict: null, ratings: null, rationale: "no public context", evidence: [] });
  assert.equal(noContext.packet.objectiveStatus, "incomplete");
  assert.deepEqual(noContext.packet.context, []);
  assert.equal(noContext.packet.prose, chosenArm[0]!.content);
  assert.match(noContext.packet.availabilityReason!, /no public style context/);
  assert.doesNotThrow(() => loadMeasuredProseEvidence(noContext.ledger, proseArtifactDigest(noContext.ledger)));
  for (const fields of [passFields, { status: "ungradeable", verdict: null, ratings: null, rationale: "judge abstained", evidence: [] }]) {
    const copy = { ...noContext.ledger, judgments: [{ ...noContext.ledger.judgments[0]!, rawResponse: rawSample(noContext.packet, fields) }] };
    assert.throws(() => loadMeasuredProseEvidence(copy, proseArtifactDigest(copy)), /misattributes an objectively incomplete capture/);
  }
  const noRecipe = singleSourceLedger(plainSource("no-recipe", chosenArm, { extraction: null, unavailableReason: "capture recipe was never declared" }),
    { status: "ungradeable", verdict: null, ratings: null, rationale: "ambiguous surface", evidence: [] });
  assert.equal(noRecipe.packet.objectiveStatus, "ungradeable");
  assert.match(noRecipe.packet.availabilityReason!, /extraction recipe/);
  const empty = singleSourceLedger(plainSource("empty-capture", [{ role: "assistant", content: "   \n " }]),
    { status: "abstained", verdict: null, ratings: null, rationale: "the capture delivered nothing", evidence: [] });
  assert.equal(empty.packet.objectiveStatus, "abstained");
  assert.ok(empty.packet.binding.answerDigest);
  const inventedQuote = { ...empty.ledger, judgments: [{ ...empty.ledger.judgments[0]!,
    rawResponse: rawSample(empty.packet, { status: "abstained", evidence: ["the lantern steadies"] }) }] };
  assert.throws(() => loadMeasuredProseEvidence(inventedQuote, proseArtifactDigest(inventedQuote)), /invented ratings\/verdicts/);
  const misreported = singleSourceLedger(plainSource("misreported-empty", [{ role: "assistant", content: "The lantern steadies." }]),
    { status: "abstained", verdict: null, ratings: null, rationale: "claims an empty capture", evidence: [] });
  assert.equal(misreported.packet.objectiveStatus, "gradeable");
  assert.throws(() => loadMeasuredProseEvidence(misreported.ledger, proseArtifactDigest(misreported.ledger)), /cannot be reported incomplete or abstained/);
  assert.throws(() => createBlindProseInventory([plainSource("silent-gap", null)], [], "seed"), /explicit inventory reason/);
  assert.throws(() => createBlindProseInventory([plainSource("silent-context", chosenArm, { styleContext: [] })], [], "seed"), /explicit inventory reason/);
});

test("objective statuses bind the grader and reports keep separate incomplete, abstained, ungradeable and compromised counts", () => {
  const plain = plainSource("planned-plain", chosenArm);
  const missing = plainSource("planned-missing", null, { extraction: null, unavailableReason: "transport error" });
  const empty = plainSource("planned-empty", [{ role: "assistant", content: "" }]);
  const surface = plainSource("planned-surface", [{ role: "assistant", content: "Delivered.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "narrate", arguments: { narration: "And a tool beat." } } }] }]);
  const sources = [plain, missing, empty, surface];
  const responses: Record<string, Record<string, unknown>> = {
    [plain.sourceId]: { ...passFields, blindingCompromised: true },
    [missing.sourceId]: { status: "incomplete", verdict: null, ratings: null, rationale: "nothing captured", evidence: [] },
    [empty.sourceId]: { status: "abstained", verdict: null, ratings: null, rationale: "no prose delivered", evidence: [] },
    [surface.sourceId]: { status: "ungradeable", verdict: null, ratings: null, rationale: "ambiguous surface", evidence: [] },
  };
  const inventory = createBlindProseInventory(sources, [], "status-seed");
  const judgments: RecordedProseJudgment[] = sources.map((source) => { const packet = packetOf(inventory, source.sourceId);
    return { packetDigest: proseArtifactDigest(packet), grader: { ...fixtureGrader, sessionId: `status-${source.sourceId}`, judgedAt: "2026-10-13T00:00:00Z" },
      rawResponse: rawSample(packet, responses[source.sourceId]!) }; });
  const ledger: ProseMeasurementLedger = { inventory, judgments, parity: [] };
  const measured = loadMeasuredProseEvidence(ledger, proseArtifactDigest(ledger));
  assert.deepEqual(measured.report.cohorts["generated-rp"], { planned: 4, graded: 0, passed: 0, failed: 0, incomplete: 1,
    abstained: 1, ungradeable: 1, compromised: 1, unassessed: 4, conditionalQuality: null, coverage: 0, acceptableYield: 0, floorState: "incomplete" });
  const graded = { ...ledger, judgments: [{ ...judgments[0]!, rawResponse: rawSample(packetOf(inventory, plain.sourceId), passFields) },
    ...judgments.slice(1)] };
  assert.deepEqual(loadMeasuredProseEvidence(graded, proseArtifactDigest(graded)).report.cohorts["generated-rp"],
    { planned: 4, graded: 1, passed: 1, failed: 0, incomplete: 1, abstained: 1, ungradeable: 1, compromised: 0, unassessed: 3,
      conditionalQuality: 1, coverage: 0.25, acceptableYield: 0.25, floorState: "incomplete" });
  for (const [sourceId, status] of [[missing.sourceId, "ungradeable"], [empty.sourceId, "incomplete"], [surface.sourceId, "graded"]] as const) {
    const packet = packetOf(inventory, sourceId);
    const copy = { ...ledger, judgments: ledger.judgments.map((entry) => entry.packetDigest === proseArtifactDigest(packet)
      ? { ...entry, rawResponse: rawSample(packet, { status, verdict: null, ratings: null, evidence: [] }) } : entry) };
    assert.throws(() => loadMeasuredProseEvidence(copy, proseArtifactDigest(copy)), /misattributes an objectively/);
  }
});

test("reused judging contexts are refused for individuals and for parity", () => {
  const { ledger } = fixture();
  const sharedIndividuals = JSON.parse(JSON.stringify(ledger));
  sharedIndividuals.judgments[1].grader = { ...sharedIndividuals.judgments[1].grader, sessionId: sharedIndividuals.judgments[0].grader.sessionId };
  assert.throws(() => createBlindParityPackets(sharedIndividuals.inventory, sharedIndividuals.judgments), /fresh, unique judging context/);
  const reusedByParity = JSON.parse(JSON.stringify(ledger));
  reusedByParity.parity[0].grader.sessionId = reusedByParity.judgments[0].grader.sessionId;
  assert.throws(() => loadMeasuredProseEvidence(reusedByParity, proseArtifactDigest(reusedByParity)), /fresh, unique judging context/);
  const sharedAcrossGraders = JSON.parse(JSON.stringify(ledger));
  sharedAcrossGraders.parity[0].grader = { ...sharedAcrossGraders.parity[0].grader, model: "second-fixture" };
  sharedAcrossGraders.parity[0].grader.sessionId = sharedAcrossGraders.judgments[0].grader.sessionId;
  assert.doesNotThrow(() => loadMeasuredProseEvidence(sharedAcrossGraders, proseArtifactDigest(sharedAcrossGraders)));
});

test("parity judged before a later inventory sample is refused", () => {
  const { ledger } = fixture();
  const early = JSON.parse(JSON.stringify(ledger));
  const lastIndividual = early.judgments.reduce((latest: { judgedAt: string }, entry: { grader: { judgedAt: string } }) => entry.grader.judgedAt > latest.judgedAt ? entry.grader : latest);
  early.parity[0].grader.judgedAt = new Date(Date.parse(lastIndividual.grader.judgedAt) - 60_000).toISOString();
  assert.throws(() => loadMeasuredProseEvidence(early, proseArtifactDigest(early)), /before locking the whole individual style ledger/);
  const sameInstant = JSON.parse(JSON.stringify(ledger));
  sameInstant.parity[0].grader.judgedAt = lastIndividual.grader.judgedAt;
  assert.throws(() => loadMeasuredProseEvidence(sameInstant, proseArtifactDigest(sameInstant)), /before locking the whole individual style ledger/);
  const beforeAll = JSON.parse(JSON.stringify(ledger));
  beforeAll.parity[0].grader.judgedAt = new Date(Date.parse(early.judgments[0].grader.judgedAt) - 60_000).toISOString();
  assert.throws(() => loadMeasuredProseEvidence(beforeAll, proseArtifactDigest(beforeAll)), /before locking the whole individual style ledger/);
});
