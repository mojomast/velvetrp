import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  admitCandidate, assertExportable, computePayloadDigest, REQUIRED_VALIDATORS,
  requiredValidatorsFor, revalidateAdmitted, verifyAdmissionCertificate,
  type AdmissionInput, type AdmittedRecordV1, type ApprovedAdmissionRegistry,
} from "../src/admission.js";
import { stableStringify } from "../src/spec.js";
import { FIXTURE_TEMPLATE, fixtureProfile } from "./template-contract.fixtures.js";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const SOURCE = "inspected source fixture";
const IMPLEMENTATION = "validator implementation fixture";
const PROMPT = "independent reviewer prompt fixture";

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const candidate: AdmissionInput = {
    recordId: "certificate-test", unitId: "unit", family: "roleplay-conversation", split: "train",
    lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" },
    splitAssignmentDigest: digest("split"),
    messages: [{ role: "user", content: "Inspect" }, { role: "assistant", content: "The handwriting shifts." }],
    provenance: {
      datasetVersion: "foundry-v1", recordSchemaVersion: "training-record-v1", gitCommit: null,
      scenarioSeed: "seed", scenarioTemplate: "template", sourceFixture: "fixture",
      generator: { model: "generator", provider: "fixture", baseUrlDigest: null, temperature: 0 },
      reviewer: null, sourceDigests: { fixture: digest(SOURCE) }, tokenCount: null,
      syntheticOrigin: true, license: { status: "verified-permitted", note: "fixture" },
    },
    evidence: [], reviews: [], generatorIdentity: "generator", ...overrides,
  };
  const payloadDigest = computePayloadDigest(candidate);
  candidate.evidence = requiredValidatorsFor(candidate).map((validator) => ({
    validator, version: "test-v1", payloadDigest, evidenceDigest: digest(SOURCE), passed: true,
    findings: { inspected: ["source"] },
  }));
  candidate.reviews = [{
    reviewerIdentity: "reviewer-a", reviewerPromptDigest: digest(PROMPT), candidateDigest: payloadDigest,
    scores: { characterization: 0.8, dialogueQuality: 0.8, coherence: 0.8, narrativeInitiative: 0.8,
      playerAgency: 0.8, nonRepetitive: 0.8, verdict: "accept", rationale: "fixture", reviewerCount: 1 },
  }];
  return candidate;
}

function registry(record: AdmittedRecordV1): ApprovedAdmissionRegistry {
  const profile = fixtureProfile();
  return {
    validators: Object.fromEntries(record.admissionCertificate.evidence.map((gate) => [gate.validator, { version: gate.version, implementationDigest: digest(IMPLEMENTATION) }])),
    artifacts: new Map([[digest(SOURCE), SOURCE], [digest(IMPLEMENTATION), IMPLEMENTATION], [digest(PROMPT), PROMPT], [profile.templateDigest, FIXTURE_TEMPLATE]]),
    certificates: new Map([[record.recordId, record.admissionCertificate.certificateDigest]]), templateProfiles: [profile],
  };
}

// Frozen v1 probe: these checks never inspected any reviews or the original gate evidence.
function legacyRevalidate(record: AdmittedRecordV1): string[] {
  const problems: string[] = [];
  if (computePayloadDigest(record) !== record.payloadDigest) problems.push("payload changed");
  if (record.admission.status !== "admitted" || record.admission.reasons.length || !record.admission.admittedAt) problems.push("status");
  for (const gate of REQUIRED_VALIDATORS[record.family]) {
    if (!record.provenance.validators.includes(gate) || !record.provenance.validatorVersions[gate]) problems.push("gate missing");
  }
  return problems;
}

test("REPRODUCTION: v1 revalidation accepted a deleted review and unresolvable evidence assertions", () => {
  const record = admitCandidate(input());
  record.admission.review = null;
  assert.deepEqual(legacyRevalidate(record), []);
  assert.throws(() => verifyAdmissionCertificate(record), /review summary/);
});

test("REPRODUCTION: family-only gates missed grounded tool calls and rejected extra validators", () => {
  const candidate = input({ family: "grounded-narration", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "submit_adventure_narration", arguments: { narration: "A whisper." } } }] }] });
  assert.equal(REQUIRED_VALIDATORS[candidate.family].includes("tool-envelope"), false);
  assert.equal(REQUIRED_VALIDATORS[candidate.family].includes("boundary-leakage"), false);
  const legacyUnexpected = candidate.evidence.filter((gate) => !REQUIRED_VALIDATORS[candidate.family].includes(gate.validator));
  assert.deepEqual(legacyUnexpected.map((gate) => gate.validator), ["tool-envelope", "boundary-leakage"]);
  assert.doesNotThrow(() => admitCandidate(candidate));
});

test("FIX: every review and validator survives in a detached, deeply immutable certificate", () => {
  const candidate = input();
  candidate.reviews = [...candidate.reviews, { ...candidate.reviews[0]!, reviewerIdentity: "reviewer-b", scores: { ...candidate.reviews[0]!.scores, coherence: 0.6, rationale: "Less coherent" } }];
  const record = admitCandidate(candidate);
  const certificate = record.admissionCertificate;
  assert.deepEqual(certificate.evidence, candidate.evidence);
  assert.deepEqual(certificate.reviews, candidate.reviews);
  assert.equal(certificate.reviewerDisagreement, true);
  assert.equal(Object.isFrozen(certificate), true);
  assert.equal(Object.isFrozen(certificate.reviews[1]?.scores), true);
  assert.equal(Object.isFrozen(certificate.evidence[0]?.findings), true);
  candidate.reviews[1]!.scores.coherence = 0;
  assert.equal(certificate.reviews[1]?.scores.coherence, 0.6);
  assert.equal(verifyAdmissionCertificate(record), record);
});

test("FIX: deleting either the legacy summary or full review list fails revalidation", () => {
  const record = admitCandidate(input());
  assert.deepEqual(revalidateAdmitted(record), []);
  assert.ok(revalidateAdmitted({ ...record, admission: { ...record.admission, review: null } }).some((p) => /review/.test(p)));
  assert.throws(() => verifyAdmissionCertificate({ ...record, admissionCertificate: { ...record.admissionCertificate, reviews: [] } }), /independent review/);
});

test("FIX: refreshing payload hashes cannot refresh stale gate verdicts or reviews", () => {
  const record = admitCandidate(input());
  const messages = [{ role: "assistant" as const, content: "Mutated after review" }];
  const payloadDigest = computePayloadDigest({ messages });
  const altered = { ...record, messages, payloadDigest };
  assert.throws(() => verifyAdmissionCertificate(altered), /evidence is stale/);
  assert.ok(revalidateAdmitted(altered).some((p) => /different payload/.test(p)));
});

test("FIX: reviews are checked again for floors, identity, verdict and disagreement", () => {
  const record = admitCandidate(input());
  const review = record.admissionCertificate.reviews[0]!;
  for (const [mutated, error] of [
    [{ ...review, reviewerIdentity: "generator" }, /not independent/],
    [{ ...review, scores: { ...review.scores, playerAgency: 0.1 } }, /below the floor/],
    [{ ...review, scores: { ...review.scores, verdict: "reject" as const } }, /cannot admit/],
  ] as const) {
    assert.throws(() => verifyAdmissionCertificate({ ...record, admissionCertificate: { ...record.admissionCertificate, reviews: [mutated] } }), error);
  }
  assert.throws(() => verifyAdmissionCertificate({ ...record, admissionCertificate: { ...record.admissionCertificate, reviewerDisagreement: true } }), /disagreement/);
});

test("FIX: shape, visibility, authority and behaviour requirements add gates across families", () => {
  const candidate = input({ family: "world-generation", behaviourTags: ["abstention", "player-agency"], visibilityRequirements: ["GM-only facts must stay private"], authorityRequirements: ["no unsupported mutations"] });
  for (const gate of ["boundary-leakage", "authority-respected", "abstention-correctness", "player-agency"]) {
    assert.ok(requiredValidatorsFor(candidate).includes(gate));
    assert.throws(() => admitCandidate({ ...candidate, evidence: candidate.evidence.filter((item) => item.validator !== gate) }), /missing required validator/);
  }
  const record = admitCandidate(candidate);
  assert.throws(() => verifyAdmissionCertificate({ ...record, behaviourTags: [] }), /record binding/);
});

test("FIX: tool shape is inspected in preference branches and tool results too", () => {
  const candidate = input();
  assert.ok(requiredValidatorsFor({ ...candidate, messages: [{ role: "tool", content: "result" }] }).includes("tool-envelope"));
  assert.ok(requiredValidatorsFor({ ...candidate, preference: {
    axis: "fidelity", prompt: [], chosen: [{ role: "assistant", content: "", tool_calls: [] }], rejected: [], rationale: "fixture", lengthRatio: 1.1,
  } }).includes("tool-envelope"));
});

test("FIX: extra passing validators are accepted, preserved and subject to the same binding checks", () => {
  const candidate = input();
  const extra = { ...candidate.evidence[0]!, validator: "additional-audit" };
  const record = admitCandidate({ ...candidate, evidence: [...candidate.evidence, extra] });
  assert.ok(record.provenance.validators.includes(extra.validator));
  assert.equal(record.admissionCertificate.evidence.at(-1)?.validator, extra.validator);
  assert.throws(() => admitCandidate({ ...candidate, evidence: [...candidate.evidence, { ...extra, payloadDigest: digest("stale") }] }), /stale/);
  assert.throws(() => admitCandidate({ ...candidate, evidence: [...candidate.evidence, { ...extra, passed: false }] }), /did not pass/);
});

test("FIX: target selection is bound and defaults to the last assistant, masking history", () => {
  const candidate = input({ messages: [{ role: "assistant", content: "Unapproved history" }, { role: "user", content: "Now?" }, { role: "assistant", content: "Current target" }] });
  const record = admitCandidate(candidate);
  assert.deepEqual(record.targetSelection, { supervisedAssistantIndices: [2], supervisedToolCallIndices: [] });
  assert.throws(() => verifyAdmissionCertificate({ ...record, targetSelection: { supervisedAssistantIndices: [0, 2], supervisedToolCallIndices: [] } }), /target-selection digest/);
  assert.throws(() => admitCandidate({ ...candidate, targetSelection: { supervisedAssistantIndices: [1], supervisedToolCallIndices: [] } }), /invalid prose target/);
});

test("FIX: preference payload bindings cover tool-schema bytes as well as both branches", () => {
  const preference = { axis: "fidelity", prompt: [], chosen: [{ role: "assistant" as const, content: "one" }], rejected: [{ role: "assistant" as const, content: "two" }], rationale: "fixture", lengthRatio: 1.1 };
  const tools = [{ type: "function" as const, function: { name: "inspect", description: "Original", parameters: {} } }];
  assert.notEqual(computePayloadDigest({ messages: [], preference, tools }), computePayloadDigest({ messages: [], preference, tools: [{ ...tools[0]!, function: { ...tools[0]!.function, description: "Changed" } }] }));
});

test("FIX: export resolves every source and implementation artifact against approved versions", () => {
  const record = admitCandidate(input());
  const approved = registry(record);
  assert.equal(assertExportable(record, approved), record);
  assert.throws(() => assertExportable(record, { ...approved, artifacts: new Map() }), /artifact is absent/);
  const corrupted = new Map(approved.artifacts);
  corrupted.set(digest(SOURCE), "changed bytes");
  assert.throws(() => assertExportable(record, { ...approved, artifacts: corrupted }), /inspected source artifact/);
  assert.throws(() => assertExportable(record, { ...approved, validators: {} }), /version is not approved/);
  assert.throws(() => assertExportable(record, { ...approved, certificates: new Map() }), /not pinned/);
  assert.throws(() => assertExportable(record, { ...approved, templateProfiles: [] }), /template artifact/);
});

test("FIX: recomputing a certificate after dropping a disagreeing reviewer cannot bypass the approved pin", () => {
  const candidate = input();
  candidate.reviews = [...candidate.reviews, { ...candidate.reviews[0]!, reviewerIdentity: "reviewer-b", scores: { ...candidate.reviews[0]!.scores, coherence: 0.5 } }];
  const record = admitCandidate(candidate);
  const approved = registry(record);
  const { certificateDigest: _old, ...body } = record.admissionCertificate;
  const alteredBody = { ...body, reviews: [body.reviews[0]!], reviewerDisagreement: false };
  const altered = { ...record, admission: { ...record.admission, review: { ...body.reviews[0]!.scores, reviewerCount: 1 } },
    admissionCertificate: { ...alteredBody, certificateDigest: digest(stableStringify(alteredBody)) } };
  assert.equal(verifyAdmissionCertificate(altered), altered, "self-consistency alone cannot authenticate an artifact");
  assert.throws(() => assertExportable(altered, approved), /not pinned/);
});
