import assert from "node:assert/strict";
import { test } from "node:test";
import { beginAdventureEvidence, beginSpeakerEvidence } from "../system-one-evidence.js";
import { defaultSystemOneSettings } from "../../server/src/defaults.js";
import { matchesSystemOneBinding, systemOneEvaluationBinding } from "../../server/src/agent/systemOneBinding.js";

test("speaker evidence freezes settings and describes raw composition, not post-hoc calibration", () => {
  const input = fixture();
  input.settings.apiKey = "speaker-test-secret";
  input.settings.confidenceCalibration["speaker-routing"] = { a: 2, b: 3 };
  const expected = systemOneEvaluationBinding("speaker-routing", input.settings, "m", "speaker-selection");
  const finish = beginSpeakerEvidence(input);
  input.settings.model = "changed";
  input.settings.confidencePolicy["speaker-routing"].actionThreshold = 0.999;
  const row = finish("m");
  assert.equal(row.bindings[0]!.requestedModel, expected.requestedModel);
  assert.equal(row.bindings[0]!.actionThreshold, expected.actionThreshold);
  assert.equal(row.bindings[0]!.calibrationA, 1);
  assert.equal(row.bindings[0]!.calibrationB, 0);
  assert.equal(matchesSystemOneBinding(row.bindings[0]!, expected), false);
  assert.equal(row.approvalEligible, false);
  assert.equal(JSON.stringify(row).includes(input.settings.apiKey), false);
});

test("speaker observations do not inherit response metadata or mutable bindings", () => {
  const finish = beginSpeakerEvidence(fixture());
  const row = finish("model-a");
  row.bindings[0]!.requestedModel = "tampered";
  assert.equal(finish(undefined).bindings[0]!.responseModel, "");
  assert.equal(finish(null).bindings[0]!.responseModel, "");
  assert.notEqual(finish("model-b").bindings[0]!.requestedModel, "tampered");
});

test("speaker evidence identifies case, repeat, request and corpus independently", () => {
  const input = fixture();
  const first = beginSpeakerEvidence(input)("m");
  input.state.declaration = "another speaker";
  input.repeat = 2;
  const second = beginSpeakerEvidence(input)("m");
  assert.equal(second.caseId, input.caseId);
  assert.equal(second.repeat, 2);
  assert.notEqual(first.requestDigest, second.requestDigest);
  assert.equal(first.corpusDigest, second.corpusDigest);
  input.corpus[0]!.expected = "different";
  assert.notEqual(second.corpusDigest, beginSpeakerEvidence(input)("m").corpusDigest);
});

function fixture() {
  return { settings: defaultSystemOneSettings(), caseId: "case-1", repeat: 1,
    state: { declaration: "rest" }, questions: [{ key: "supported" }],
    candidates: [{ kind: "exact_actor_rest.select" }, { kind: "exact_actor_rest.select" }],
    corpus: [{ id: "case-1", expected: "rest" }] };
}

test("captures configuration before transport and never includes credentials", () => {
  const input = fixture();
  input.settings.apiKey = "test-secret-not-for-artifact";
  const originalModel = input.settings.model;
  const finish = beginAdventureEvidence(input);
  input.settings.model = "changed-after-request";
  input.settings.confidencePolicy["adventure-selection"].actionThreshold = 0.99;
  const evidence = finish("reported-model");
  assert.equal(evidence.bindings.length, 1);
  assert.equal(evidence.bindings[0]!.requestedModel, originalModel);
  assert.notEqual(evidence.bindings[0]!.actionThreshold, 0.99);
  assert.equal(evidence.bindings[0]!.responseModel, "reported-model");
  assert.equal(JSON.stringify(evidence).includes(input.settings.apiKey), false);
  assert.equal(evidence.approvalEligible, false);
});

test("missing metadata is not filled from another response; observations are independent", () => {
  const finish = beginAdventureEvidence(fixture());
  const first = finish("model-a");
  first.bindings[0]!.requestedModel = "tampered";
  assert.equal(finish(undefined).bindings[0]!.responseModel, "");
  assert.notEqual(finish("model-b").bindings[0]!.requestedModel, "tampered");
});

test("request and corpus hashes track their actual inputs", () => {
  const input = fixture();
  const first = beginAdventureEvidence(input)("m");
  assert.equal(first.requestDigest, beginAdventureEvidence(input)("m").requestDigest);
  input.state.declaration = "do not rest";
  const second = beginAdventureEvidence(input)("m");
  assert.notEqual(first.requestDigest, second.requestDigest);
  assert.equal(first.corpusDigest, second.corpusDigest);
  input.corpus[0]!.expected = "defer";
  assert.notEqual(second.corpusDigest, beginAdventureEvidence(input)("m").corpusDigest);
});

test("curated benchmark bindings cannot approve the production shortlist", () => {
  const input = fixture();
  const evidence = beginAdventureEvidence(input)("m");
  const active = systemOneEvaluationBinding("adventure-selection", input.settings, "m", input.candidates[0]!.kind);
  assert.equal(matchesSystemOneBinding(evidence.bindings[0]!, active), false);
});
