import assert from "node:assert/strict";
import { test } from "node:test";
import { beginAdventureEvidence } from "../system-one-evidence.js";
import { defaultSystemOneSettings } from "../../server/src/defaults.js";
import { matchesSystemOneBinding, systemOneEvaluationBinding } from "../../server/src/agent/systemOneBinding.js";

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
