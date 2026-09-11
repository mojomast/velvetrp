import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_EVAL_DEVELOPMENT_CASES, type KnowledgeEvalCase } from "../../server/test/fixtures/knowledge-evals/corpus.js";
import { KNOWLEDGE_EVAL_HOLDOUTS } from "../../server/test/fixtures/knowledge-evals/holdouts.js";
import { evaluateAgentKnowledge, scoreKnowledgeCases, type KnowledgeCaseResult } from "../evaluate-agent-knowledge.js";

// Frozen reviewed digests; retrieval or corpus tuning must not move them silently.
const FROZEN_HOLDOUT_DIGEST = "e649d9161a9ac551da9f5aaa6de44cca8d5909ef5d268ebe1b274a4cbee28844";
const FROZEN_AUTHORITY_DIGEST = "c400ac7f44744e3deb8be7b94d72eac8b137c6baf27f93ed5885b4d58fa06ad8";

const result = (overrides: Partial<KnowledgeCaseResult>): KnowledgeCaseResult => ({
  id: "case", present: true, attributionCorrect: true, negativeCorrect: true, privacyCorrect: true,
  negationCorrect: true, disclosureCorrect: true, authority: null, channel: null, relayer: null, text: null, ...overrides,
});
const negationCase: KnowledgeEvalCase = { id: "n", category: "negation", agentKind: "npc", agentKey: "knower", sourceKey: "negation",
  query: "promise passage", expect: { present: true, channel: "witnessed", negation: true } };
const privacyCase: KnowledgeEvalCase = { id: "p", category: "privacy", agentKind: "npc", agentKey: "absent", sourceKey: "witnessed",
  expect: { present: false } };

test("scores attribution, privacy, negatives, negation, and disclosure separately", () => {
  const metrics = scoreKnowledgeCases(
    [result({ id: "n", negationCorrect: false }), result({ id: "p", present: false, privacyCorrect: false, negativeCorrect: false })],
    [negationCase, privacyCase],
  );
  assert.equal(metrics.negationTermPass, 0);
  assert.equal(metrics.privacyPassRate, 0);
  assert.equal(metrics.negativePassRate, 0);
  assert.equal(metrics.attributionPrecision, 1);
});

test("holds attribution, privacy, negation, authority, and frozen holdout gates", async () => {
  const artifact = await evaluateAgentKnowledge();
  for (const report of [artifact.metrics.development, artifact.metrics.holdouts, artifact.metrics.combined]) {
    assert.equal(report.attributionPrecision, 1, "attribution");
    assert.equal(report.privacyPassRate, 1, "privacy");
    assert.equal(report.negativePassRate, 1, "negative");
    assert.equal(report.negationTermPass, 1, "negation");
    assert.equal(report.disclosurePassRate, 1, "disclosure");
  }
  assert.equal(artifact.metrics.authorityPassRate, 1);
  assert.equal(artifact.holdoutDigest, FROZEN_HOLDOUT_DIGEST);
  assert.equal(artifact.authorityDigest, FROZEN_AUTHORITY_DIGEST);
  assert.equal(KNOWLEDGE_EVAL_DEVELOPMENT_CASES.length, artifact.metrics.development.cases);
  assert.equal(KNOWLEDGE_EVAL_HOLDOUTS.length, artifact.metrics.holdouts.cases);
});
