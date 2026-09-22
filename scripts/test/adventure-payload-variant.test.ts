import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdventureVariant, buildAdventureBenchmarkRequest, adventureRequestState } from "../evaluate-system-one-adventure-lane.js";
import { beginAdventureEvidence } from "../system-one-evidence.js";
import { ADVENTURE_EVAL_CASES } from "../../server/test/fixtures/adventure-evals/corpus.js";
import { ADVENTURE_SHARED_CONTEXT_VERSIONS, buildAdventureSelectionQuestions, buildAdventureSharedContextRequest } from "../../server/src/agent/systemOneAdventure.js";
import { defaultSystemOneSettings } from "../../server/src/defaults.js";

test("payload selection defaults safely and rejects invalid or missing values", () => {
  assert.equal(parseAdventureVariant([]), "legacy");
  assert.equal(parseAdventureVariant(["--payload=shared-context"]), "shared-context");
  assert.equal(parseAdventureVariant(["--payload", "legacy"]), "legacy");
  for (const args of [["--payload"], ["--payload="], ["--payload", "typo"]]) assert.throws(() => parseAdventureVariant(args));
});

test("both variants preserve identical corpus inputs and question keys", () => {
  for (const c of ADVENTURE_EVAL_CASES) {
    const before = JSON.stringify(c);
    const legacy = buildAdventureBenchmarkRequest(c, "legacy");
    const shared = buildAdventureBenchmarkRequest(c, "shared-context");
    assert.deepEqual(legacy, { state: adventureRequestState(c), questions: buildAdventureSelectionQuestions(c.declaration, c.candidates) });
    assert.deepEqual(shared, buildAdventureSharedContextRequest(c.declaration, c.candidates));
    assert.deepEqual(Object.keys(shared.questions), Object.keys(legacy.questions));
    assert.equal(JSON.stringify(c), before);
  }
});

test("experimental evidence cannot reuse legacy question/state bindings", () => {
  const c = ADVENTURE_EVAL_CASES.find(c => c.candidates.length > 0)!;
  const base = { settings: defaultSystemOneSettings(), caseId: c.id, repeat: 1, candidates: c.candidates, corpus: ADVENTURE_EVAL_CASES };
  const legacy = beginAdventureEvidence({ ...base, ...buildAdventureBenchmarkRequest(c, "legacy") })("model");
  const shared = beginAdventureEvidence({ ...base, ...buildAdventureBenchmarkRequest(c, "shared-context"), payloadVersions: ADVENTURE_SHARED_CONTEXT_VERSIONS })("model");
  assert.equal(shared.corpusDigest, legacy.corpusDigest);
  assert.notEqual(shared.requestDigest, legacy.requestDigest);
  assert.equal(shared.approvalEligible, false);
  assert.equal(legacy.approvalEligible, false);
  for (const binding of shared.bindings) {
    assert.equal(binding.questionVersion, ADVENTURE_SHARED_CONTEXT_VERSIONS.questionVersion);
    assert.equal(binding.stateVersion, ADVENTURE_SHARED_CONTEXT_VERSIONS.stateVersion);
    assert.equal(binding.candidateStrategy, "benchmark-curated-candidates-v1");
    assert.notEqual(binding.questionVersion, legacy.bindings[0]!.questionVersion);
  }
});
