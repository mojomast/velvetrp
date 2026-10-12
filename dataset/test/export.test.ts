import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openRunStore, type RunTransaction } from "../src/runstore.js";
import { stableStringify, type AdmissionCertificate, type CandidateRecord, type StoredMessage } from "../src/spec.js";
import {
  admitCandidate, assertExportable, computePayloadDigest, requiredValidatorsFor, verifyAdmissionCertificate,
  type AdmissionInput, type AdmittedRecordV1, type ApprovedAdmissionRegistry,
} from "../src/admission.js";
import { exportTrainingJsonl, type ExportChecksumManifest } from "../src/export.js";
import { FIXTURE_TEMPLATE, fixtureProfile } from "./template-contract.fixtures.js";

const digest = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const SOURCE = "export test inspected source";
const IMPLEMENTATION = "export test validator implementation";
const PROMPT = "export test independent reviewer prompt";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function rootFor(): string {
  const root = mkdtempSync(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "foundry-export-"));
  roots.push(root);
  return root;
}

function admitted(overrides: Partial<AdmissionInput> = {}): AdmittedRecordV1 {
  const input: AdmissionInput = {
    family: "tool-selection", recordId: "record", unitId: "unit", split: "train",
    splitAssignmentDigest: digest("split"), lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" },
    messages: [
      { role: "user", content: "Inspect the ledger." },
      { role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "inspect", arguments: { target: "ledger", count: 2 } } }] },
      { role: "tool", content: "The handwriting shifts.", name: "inspect", tool_call_id: "call" },
      { role: "assistant", content: "The handwriting shifts halfway down the page." },
    ],
    tools: [{ type: "function", function: { name: "inspect", description: "Inspect an object", parameters: { type: "object", properties: { target: { type: "string" }, count: { type: "integer" } } } } }],
    provenance: {
      datasetVersion: "foundry-v1", recordSchemaVersion: "training-record-v1", gitCommit: null,
      scenarioSeed: "seed", scenarioTemplate: "fixture", sourceFixture: "source",
      generator: { provider: "fixture", model: "generator", baseUrlDigest: null, temperature: 0 },
      reviewer: null, sourceDigests: { source: digest(SOURCE) }, tokenCount: null, syntheticOrigin: true,
      license: { status: "verified-permitted", note: "export test" },
    },
    evidence: [], reviews: [], generatorIdentity: "generator", ...overrides,
  };
  const payloadDigest = computePayloadDigest(input);
  input.evidence = requiredValidatorsFor(input).map((validator) => ({
    validator, version: "test-v1", payloadDigest, evidenceDigest: digest(SOURCE), passed: true,
  }));
  input.reviews = [{
    reviewerIdentity: "independent-reviewer", reviewerPromptDigest: digest(PROMPT), candidateDigest: payloadDigest,
    scores: { characterization: 0.8, dialogueQuality: 0.8, coherence: 0.8, narrativeInitiative: 0.8,
      playerAgency: 0.8, nonRepetitive: 0.8, verdict: "accept", rationale: "fixture review", reviewerCount: 1 },
  }];
  return admitCandidate(input);
}

function candidate(record: AdmittedRecordV1): CandidateRecord {
  const { createdAt: _createdAt, ...provenance } = record.provenance;
  return {
    schemaVersion: record.schemaVersion, recordId: record.recordId, family: record.family, lineage: record.lineage,
    scenarioSeed: provenance.scenarioSeed, contentDigest: record.contentDigest, provenance,
    messages: [...record.messages], ...(record.tools ? { tools: [...record.tools] } : {}),
    ...(record.preference ? { preference: record.preference } : {}),
    admission: { status: "pending-review", reasons: [], findings: {}, review: null, admittedAt: null },
  };
}

function registryFor(records: readonly AdmittedRecordV1[]): ApprovedAdmissionRegistry {
  const profile = fixtureProfile();
  return {
    validators: Object.fromEntries(records.flatMap((record) => record.admissionCertificate.evidence.map((gate) =>
      [gate.validator, { version: gate.version, implementationDigest: digest(IMPLEMENTATION) }]))),
    artifacts: new Map([[digest(SOURCE), SOURCE], [digest(IMPLEMENTATION), IMPLEMENTATION],
      [digest(PROMPT), PROMPT], [profile.templateDigest, FIXTURE_TEMPLATE]]),
    certificates: new Map(records.map((record) => [record.recordId, record.admissionCertificate.certificateDigest])),
    templateProfiles: [profile],
  };
}

function storeOptions(root: string) {
  return { runId: "export", artifactRoot: join(root, "store"), seed: "seed", sourceDigest: digest("source"),
    splitAssignmentDigest: digest("split"), corpusFreezeDigest: digest("freeze"), gitCommit: null, durability: "flush" as const };
}

test("REPRODUCTION: a certificate-free admission claim never reads back as admitted", (t) => {
  const root = rootFor();
  const options = {
    runId: "bypass", artifactRoot: join(root, "store"), seed: "fixture",
    sourceDigest: "source", splitAssignmentDigest: "split", corpusFreezeDigest: "freeze",
    gitCommit: null, durability: "flush" as const,
  };
  const record: CandidateRecord = {
    schemaVersion: "training-record-v1", recordId: "unreviewed", family: "roleplay-conversation",
    lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" }, scenarioSeed: "seed",
    messages: [{ role: "assistant", content: "The harbour is quiet." }], contentDigest: "claimed",
    provenance: {
      datasetVersion: "foundry-v1", recordSchemaVersion: "training-record-v1", gitCommit: null,
      scenarioSeed: "seed", scenarioTemplate: "fixture", sourceFixture: null, validators: [], validatorVersions: {},
      generator: { provider: "fixture", model: "generator", baseUrlDigest: null, temperature: 0 },
      reviewer: null, sourceDigests: {}, tokenCount: null, syntheticOrigin: true,
      license: { status: "verified-permitted", note: "fixture" },
    },
    admission: { status: "admitted", reasons: [], findings: {}, review: null, admittedAt: null },
  };
  const store = openRunStore(options);
  t.after(() => store.close());
  const result = store.commitCandidate({ unitId: "unit", attemptId: "attempt", record });
  assert.notEqual(result.status, "admitted");
  assert.notEqual(store.findAttempt("attempt")?.status, "admitted");
  assert.notEqual(store.ledger()[0]?.admissionStatus, "admitted");
  assert.notEqual(store.readCandidate("attempt")?.admission.status, "admitted");
  store.close();
  const resumed = openRunStore(options);
  t.after(() => resumed.close());
  assert.notEqual(resumed.unit("unit")?.effective?.status, "admitted");
  assert.notEqual(resumed.candidates()[0]?.admission.status, "admitted");
});

test("runstore admission updates require a certificate bound to the exact candidate and unit", (t) => {
  const store = openRunStore(storeOptions(rootFor()));
  t.after(() => store.close());
  const record = admitted();
  store.commitCandidate({ unitId: record.unitId, attemptId: "attempt", record: candidate(record) });
  assert.equal(store.updateAdmission("unit", "attempt", { status: "admitted" }).status, "pending-review");
  assert.equal(store.readAdmittedRecord("attempt"), null);
  const wrongRecord = admitted({ recordId: "another-record" });
  assert.equal(store.updateAdmission("unit", "attempt", { status: "admitted", admittedRecord: wrongRecord }).status, "pending-review");
  const updated = store.updateAdmission("unit", "attempt", { status: "admitted", admittedRecord: record });
  assert.equal(updated.status, "admitted");
  assert.deepEqual(store.readAdmittedRecord("attempt"), record);
  assert.equal(store.ledger()[0]?.admissionStatus, "admitted");
});

test("a certified commit survives resume and exports directly from the store", (t) => {
  const root = rootFor();
  const options = storeOptions(root);
  const record = admitted();
  const store = openRunStore(options);
  store.commitCandidate({ unitId: "unit", attemptId: "attempt", record: candidate(record),
    admission: { status: "admitted", admittedRecord: record }, finalize: true, completeUnit: true });
  store.close();
  const resumed = openRunStore(options);
  t.after(() => resumed.close());
  assert.equal(resumed.unit("unit")?.effective?.status, "admitted");
  assert.equal(resumed.hasCompletedUnit("unit"), true);
  const restored = resumed.readAdmittedRecord("attempt");
  assert.ok(restored);
  assert.deepEqual(restored, record);
  const result = exportTrainingJsonl([restored], { outputDir: join(root, "export"), approvedRegistry: registryFor([record]) });
  assert.equal(result.checksums.recordCount, 1);
});

test("a certificate altered after admission fails verification and cannot replay as admitted", (t) => {
  const root = rootFor();
  const options = storeOptions(root);
  const record = admitted();
  const certificate: AdmissionCertificate = record.admissionCertificate;
  const altered = { ...record, admissionCertificate: { ...certificate, generatorIdentity: "altered-generator" } };
  assert.throws(() => verifyAdmissionCertificate(altered), /certificate digest mismatch/);
  const store = openRunStore(options);
  store.commitCandidate({ unitId: "unit", attemptId: "attempt", record: candidate(record),
    admission: { status: "admitted", admittedRecord: record } });
  const eventsPath = store.paths.eventsPath;
  store.close();
  const transactions = readFileSync(eventsPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as RunTransaction);
  for (const tx of transactions) for (const event of tx.events) {
    if (event.type === "attempt.registered") event.admittedRecord = altered;
  }
  writeFileSync(eventsPath, transactions.map((tx) => stableStringify(tx) + "\n").join(""));
  const resumed = openRunStore(options);
  t.after(() => resumed.close());
  assert.equal(resumed.findAttempt("attempt")?.status, "pending-review");
  assert.equal(resumed.attempts("unit")[0]?.status, "pending-review");
  assert.equal(resumed.latestEligibleCandidate("unit")?.status, "pending-review");
  assert.equal(resumed.ledger()[0]?.admissionStatus, "pending-review");
  assert.equal(resumed.readAdmittedRecord("attempt"), null);
});

test("on-disk candidate tampering invalidates admission even if the claimed payload digest is unchanged", (t) => {
  const store = openRunStore(storeOptions(rootFor()));
  t.after(() => store.close());
  const record = admitted();
  const result = store.commitCandidate({ unitId: "unit", attemptId: "attempt", record: candidate(record),
    admission: { status: "admitted", admittedRecord: record } });
  const path = join(store.paths.attemptsDir, result.payloadFile);
  const payload = JSON.parse(readFileSync(path, "utf8")) as { record: CandidateRecord };
  payload.record.messages[0]!.content = "Changed after review";
  writeFileSync(path, stableStringify(payload));
  assert.equal(store.findAttempt("attempt")?.status, "pending-review");
  assert.equal(store.readAdmittedRecord("attempt"), null);
  assert.throws(() => store.readCandidate("attempt"), /record bytes/);
});

test("legacy admitted events without persisted certificates are quarantined on resume", (t) => {
  const root = rootFor();
  const options = storeOptions(root);
  const record = admitted();
  const store = openRunStore(options);
  store.commitCandidate({ unitId: "unit", attemptId: "attempt", record: candidate(record),
    admission: { status: "admitted", admittedRecord: record }, finalize: true });
  const eventsPath = store.paths.eventsPath;
  store.close();
  const transactions = readFileSync(eventsPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as RunTransaction);
  for (const tx of transactions) for (const event of tx.events) {
    if (event.type === "attempt.registered") delete event.admittedRecord;
  }
  writeFileSync(eventsPath, transactions.map((tx) => stableStringify(tx) + "\n").join(""));
  const resumed = openRunStore(options);
  t.after(() => resumed.close());
  assert.equal(resumed.finalizeUnit("unit").status, "pending-review");
  assert.equal(resumed.unit("unit")?.effective?.status, "pending-review");
  assert.equal(resumed.ledger()[0]?.admissionStatus, "pending-review");
  assert.equal(resumed.readAdmittedRecord("attempt"), null);
});

test("export refuses the whole batch before writing anything when the last certificate is invalid", () => {
  const root = rootFor();
  const first = admitted();
  const second = admitted({ recordId: "second" });
  const altered = { ...second, admissionCertificate: { ...second.admissionCertificate, certificateDigest: digest("altered") } };
  const outputDir = join(root, "not-created", "export");
  assert.throws(() => exportTrainingJsonl([first, altered], { outputDir, approvedRegistry: registryFor([first, second]) }), /certificate digest mismatch/);
  assert.deepEqual(readdirSync(root), [], "not even a temporary file or parent directory was created");
});

test("export requires approved certificate pins and template artifacts, not only self-consistent hashes", () => {
  const root = rootFor();
  const record = admitted();
  const approved = registryFor([record]);
  for (const registry of [
    { ...approved, certificates: new Map<string, string>() },
    { ...approved, artifacts: new Map<string, string>() },
    { ...approved, templateProfiles: [] },
  ]) {
    assert.throws(() => exportTrainingJsonl([record], { outputDir: join(root, "export"), approvedRegistry: registry }));
    assert.deepEqual(readdirSync(root), []);
  }
});

test("HF JSONL has messages and top-level tools with object arguments, with provenance exclusively in the sidecar", () => {
  const root = rootFor();
  const first = admitted();
  const second = admitted({ recordId: "second", tools: [], messages: [{ role: "assistant", content: "The room is quiet." }] });
  const result = exportTrainingJsonl([first, second], { outputDir: join(root, "export"), approvedRegistry: registryFor([first, second]) });
  const text = readFileSync(result.trainingPath, "utf8");
  assert.equal(text.endsWith("\n"), true);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const row = JSON.parse(lines[0]!) as { messages: StoredMessage[]; tools: unknown };
  assert.deepEqual(Object.keys(row).sort(), ["messages", "tools"]);
  assert.deepEqual(row.messages, first.messages);
  assert.deepEqual(row.tools, first.tools);
  assert.deepEqual(row.messages[1]?.tool_calls?.[0]?.function.arguments, { target: "ledger", count: 2 });
  assert.doesNotMatch(text, /provenance|scenarioSeed|certificateDigest|syntheticOrigin|reviewerIdentity|recordId|lineage/);
  const sidecar = JSON.parse(readFileSync(result.provenancePath, "utf8")) as {
    records: { line: number; recordId: string; provenance: unknown; certificateDigest: string; lineage: unknown }[];
  };
  assert.equal(sidecar.records[0]?.line, 1);
  assert.equal(sidecar.records[0]?.recordId, first.recordId);
  assert.deepEqual(sidecar.records[0]?.provenance, first.provenance);
  assert.deepEqual(sidecar.records[0]?.lineage, first.lineage);
  assert.equal(sidecar.records[0]?.certificateDigest, first.admissionCertificate.certificateDigest);
});

test("string, null and array tool arguments are refused even if a certificate was minted for them", () => {
  const root = rootFor();
  for (const args of ['{"target":"ledger"}', null, ["ledger"]]) {
    const messages = [{ role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "inspect", arguments: args } }] }] as unknown as StoredMessage[];
    const record = admitted({ messages });
    const approvedRegistry = registryFor([record]);
    assert.doesNotThrow(() => assertExportable(record, approvedRegistry));
    assert.throws(() => exportTrainingJsonl([record], { outputDir: join(root, "export"), approvedRegistry }), /OBJECT arguments/);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("nested message metadata cannot enter conversational JSONL", () => {
  const root = rootFor();
  const message = { role: "assistant" as const, content: "The handwriting shifts.", provenance: { scenarioSeed: "private" } };
  const record = admitted({ messages: [message] });
  assert.throws(() => exportTrainingJsonl([record], { outputDir: join(root, "export"), approvedRegistry: registryFor([record]) }), /unexpected metadata/);
  assert.deepEqual(readdirSync(root), []);
});

test("preference JSONL exports certified branches while keeping preference rationale in the sidecar", () => {
  const root = rootFor();
  const record = admitted({ preference: {
    axis: "grounding", rationale: "audit-only preference explanation", lengthRatio: 1.2,
    prompt: [{ role: "user", content: "What did you find?" }],
    chosen: [{ role: "assistant", content: "The ledger contains a different hand." }],
    rejected: [{ role: "assistant", content: "A secret treasure is yours." }],
  } });
  const result = exportTrainingJsonl([record], { outputDir: join(root, "export"), approvedRegistry: registryFor([record]) });
  const text = readFileSync(result.trainingPath, "utf8");
  const row = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(row.messages, record.preference?.prompt);
  assert.deepEqual(row.prompt, record.preference?.prompt);
  assert.deepEqual(row.chosen, record.preference?.chosen);
  assert.deepEqual(row.rejected, record.preference?.rejected);
  assert.doesNotMatch(text, /rationale|lengthRatio|axis|audit-only/);
  assert.match(readFileSync(result.provenancePath, "utf8"), /audit-only preference explanation/);
});

test("checksum manifests cover exact file bytes and are stable across identical exports", () => {
  const root = rootFor();
  const record = admitted();
  const options = { approvedRegistry: registryFor([record]) };
  const first = exportTrainingJsonl([record], { ...options, outputDir: join(root, "first") });
  const second = exportTrainingJsonl([record], { ...options, outputDir: join(root, "second") });
  assert.equal(readFileSync(first.checksumPath, "utf8"), readFileSync(second.checksumPath, "utf8"));
  const manifest = JSON.parse(readFileSync(first.checksumPath, "utf8")) as ExportChecksumManifest;
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) {
    assert.equal(digest(readFileSync(join(first.outputDir, file.path), "utf8")), file.sha256);
    assert.equal(readFileSync(join(first.outputDir, file.path), "utf8"), readFileSync(join(second.outputDir, file.path), "utf8"));
  }
  assert.equal(manifest.corpusDigest, digest(stableStringify(manifest.files)));
  assert.deepEqual(manifest, first.checksums);
  assert.throws(() => exportTrainingJsonl([record], { ...options, outputDir: first.outputDir }), /new or empty/);
  assert.equal(existsSync(first.trainingPath), true);
  assert.deepEqual(readdirSync(root).sort(), ["first", "second"], "no staging artifacts remain");
});

test("invalid export leaves an existing bundle byte-identical", () => {
  const root = rootFor();
  const record = admitted();
  const options = { outputDir: join(root, "export"), approvedRegistry: registryFor([record]) };
  exportTrainingJsonl([record], options);
  const before = readdirSync(options.outputDir).map((name) => [name, readFileSync(join(options.outputDir, name), "utf8")]);
  const { admissionCertificate: _certificate, ...uncertified } = record;
  assert.throws(() => exportTrainingJsonl([uncertified as AdmittedRecordV1], options), /no admission certificate/);
  assert.deepEqual(readdirSync(options.outputDir).map((name) => [name, readFileSync(join(options.outputDir, name), "utf8")]), before);
  assert.deepEqual(readdirSync(root), ["export"]);
});
