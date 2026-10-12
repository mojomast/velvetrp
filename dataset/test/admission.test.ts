/**
 * Tests for the admission constructor and the semantic grounding validator.
 *
 * The grounding tests encode attacks reproduced against production's own
 * `providerNarrationMatchesReceipts`, which accepts them. If production ever
 * tightens, these still hold; if the foundry ever loosens, they fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { providerNarrationMatchesReceipts } from "../../server/src/routes/rpg/v1/adventureTurns.js";
import { AdmissionError, admitCandidate, computePayloadDigest, revalidateAdmitted, type AdmissionInput } from "../src/admission.js";
import { GroundingFailure, validateGroundedNarration } from "../src/grounding.js";
import {
  RPMax_PUBLISHED_TEMPLATE,
  QWEN3_8B_TEMPLATE_PROFILE,
  assertTemplateCanTrain,
  publishedTemplateDropsToolCalls,
  templateProfileFor,
  type ToolPrecondition,
} from "../src/templateProfiles.js";

const OWNER_DIGEST = "a".repeat(64);
const EVIDENCE_DIGEST = "b".repeat(64);

function baseInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const messages = [
    { role: "system" as const, content: "You are the Keeper." },
    { role: "user" as const, content: "Inspect the ledger." },
    { role: "assistant" as const, content: "The handwriting shifts." },
  ];
  const payloadDigest = computePayloadDigest({ messages, ...(overrides.tools ? { tools: overrides.tools } : {}) });
  return {
    family: "roleplay-conversation",
    recordId: "rec-1",
    unitId: "unit-1",
    lineage: { characterFamily: "c1", worldFamily: "w1", scenarioFamily: "s1" },
    split: "train",
    splitAssignmentDigest: "c".repeat(64),
    messages,
    provenance: {
      datasetVersion: "foundry-v1",
      recordSchemaVersion: "training-record-v1",
      gitCommit: "d".repeat(40),
      scenarioSeed: "seed-1",
      scenarioTemplate: "tpl-1",
      sourceFixture: null,
      generator: { provider: "openai-compatible", model: "deepseek-v4-flash", baseUrlDigest: "e".repeat(64), temperature: 0.9 },
      reviewer: { provider: "openai-compatible", model: "kimi:k3", promptVersion: "review-v1" },
      sourceDigests: {},
      tokenCount: { tokenizer: "cl100k_base", tokens: 40 },
      syntheticOrigin: true,
      license: { status: "verified-permitted", note: "test" },
    },
    evidence: [
      { validator: "boundary-leakage", version: "1", payloadDigest, evidenceDigest: EVIDENCE_DIGEST, passed: true },
      { validator: "player-agency", version: "1", payloadDigest, evidenceDigest: EVIDENCE_DIGEST, passed: true },
    ],
    reviews: [{
      reviewerIdentity: "reviewer-1",
      reviewerPromptDigest: "f".repeat(64),
      candidateDigest: payloadDigest,
      scores: {
        characterization: 0.8, dialogueQuality: 0.8, coherence: 0.9, narrativeInitiative: 0.7,
        playerAgency: 0.9, nonRepetitive: 0.8, verdict: "accept", rationale: "ok", reviewerCount: 1,
      },
    }],
    generatorIdentity: "deepseek-v4-flash",
    ...overrides,
  } as AdmissionInput;
}

test("admitCandidate returns an admitted record with recomputed digests", () => {
  const record = admitCandidate(baseInput());
  assert.equal(record.admission.status, "admitted");
  assert.deepEqual(record.admission.reasons, []);
  assert.ok(record.admission.admittedAt);
  // payloadDigest is the admission binding; contentDigest is the dedup identity.
  // They are intentionally different digests over the same SFT bytes.
  assert.match(record.payloadDigest, /^[0-9a-f]{64}$/);
  assert.match(record.contentDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(record.payloadDigest, record.contentDigest);
  assert.deepEqual(record.provenance.validators, ["boundary-leakage", "player-agency"]);
});

test("content digest is stable for the same conversation across families", () => {
  const a = admitCandidate(baseInput());
  // Switching family requires that family's own validators; the admission gate
  // refuses a mismatched evidence set, so supply the boundary-recovery set.
  const bInput = baseInput({ family: "boundary-recovery", recordId: "rec-2" });
  const bPayload = computePayloadDigest({ messages: bInput.messages });
  const b = admitCandidate({
    ...bInput,
    evidence: ["boundary-leakage", "abstention-correctness", "authority-respected"].map((validator) => ({
      validator, version: "1", payloadDigest: bPayload, evidenceDigest: EVIDENCE_DIGEST, passed: true,
    })),
    reviews: bInput.reviews.map((r) => ({ ...r, candidateDigest: bPayload })),
  });
  assert.equal(a.contentDigest, b.contentDigest, "dedup identity must not depend on which family produced the bytes");
  // Both digests cover training bytes only. Family specificity is enforced by the
  // required-evidence sets, which is why `b` needed a different evidence set.
  assert.equal(a.payloadDigest, b.payloadDigest);
  assert.deepEqual(a.provenance.validators, ["boundary-leakage", "player-agency"]);
  assert.deepEqual(b.provenance.validators, ["boundary-leakage", "abstention-correctness", "authority-respected"]);
});

test("a rejected validator cannot be admitted", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({
    ...input,
    evidence: input.evidence.map((e) => e.validator === "player-agency" ? { ...e, passed: false } : e),
  }), AdmissionError);
});

test("missing required validator is refused", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({ ...input, evidence: [input.evidence[0]!] }), AdmissionError);
});

test("stale evidence bound to a different payload is refused", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({
    ...input,
    evidence: input.evidence.map((e) => ({ ...e, payloadDigest: "9".repeat(64) })),
  }), /stale/);
});

test("unreviewed or self-reviewed candidates are refused", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({ ...input, reviews: [] }), /independent review/);
  assert.throws(() => admitCandidate({
    ...input,
    reviews: input.reviews.map((r) => ({ ...r, reviewerIdentity: input.generatorIdentity })),
  }), /not independent/);
});

test("a revise verdict cannot admit", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({
    ...input,
    reviews: input.reviews.map((r) => ({ ...r, scores: { ...r.scores, verdict: "revise" as const } })),
  }), /cannot admit/);
});

test("low review floors refuse admission even with an accept verdict", () => {
  const input = baseInput();
  assert.throws(() => admitCandidate({
    ...input,
    reviews: input.reviews.map((r) => ({ ...r, scores: { ...r.scores, playerAgency: 0.2 } })),
  }), /below the floor/);
});

test("recompute detects post-admission mutation", () => {
  const record = admitCandidate(baseInput());
  assert.deepEqual(revalidateAdmitted(record), []);
  const mutated = { ...record, messages: [...record.messages, { role: "user" as const, content: "smuggled" }] };
  assert.ok(revalidateAdmitted(mutated).some((p) => /digest does not match/.test(p)));
});

test("preference digest covers prompt/chosen/rejected", () => {
  const prompt = [{ role: "user" as const, content: "hi" }];
  const base = computePayloadDigest({ messages: [], preference: { axis: "a", prompt, chosen: [{ role: "assistant" as const, content: "one" }], rejected: [{ role: "assistant" as const, content: "two" }], rationale: "r", lengthRatio: 1.1 } });
  const mutated = computePayloadDigest({ messages: [], preference: { axis: "a", prompt, chosen: [{ role: "assistant" as const, content: "ONE" }], rejected: [{ role: "assistant" as const, content: "two" }], rationale: "r", lengthRatio: 1.1 } });
  assert.notEqual(base, mutated);
});

test("length-biased and near-identical preference pairs are refused at admission", () => {
  const prompt = [{ role: "user" as const, content: "hi" }];
  const pair = (chosen: string, rejected: string, lengthRatio = 1) => ({
    axis: "fidelity", prompt,
    chosen: [{ role: "assistant" as const, content: chosen }],
    rejected: [{ role: "assistant" as const, content: rejected }],
    rationale: "chosen is grounded, rejected fabricates an outcome", lengthRatio,
  });
  const family = "grounded-narration" as const;
  const evidenceFor = (input: AdmissionInput) => input.evidence.map((e) =>
    e.validator === "boundary-leakage"
      ? { validator: "receipt-provenance" as const, version: "1", payloadDigest: computePayloadDigest(input), evidenceDigest: EVIDENCE_DIGEST, passed: true }
      : e);
  const reviewFor = (input: AdmissionInput) => input.reviews.map((r) => ({
    ...r, candidateDigest: computePayloadDigest(input),
  }));

  const longPair = pair(
    "The ledger shows the handwriting shifts on the fourteenth entry and the clerk admits the alteration.",
    "It opens.",
  );
  const input = { ...baseInput({ family, preference: longPair }), evidence: [], reviews: [] };
  const wired = { ...input, evidence: evidenceFor(input as AdmissionInput), reviews: reviewFor(input as AdmissionInput) };
  assert.throws(() => admitCandidate(wired as AdmissionInput), (error: unknown) =>
    (error as AdmissionError).problems.some((p) => /length-biased/.test(p)));

  const nearIdentical = pair("The clerk admits the ledger was altered last week.", "The clerk admits the ledger was altered last night.");
  const input2 = { ...baseInput({ family, preference: nearIdentical }), evidence: [], reviews: [] };
  const wired2 = { ...input2, evidence: evidenceFor(input2 as AdmissionInput), reviews: reviewFor(input2 as AdmissionInput) };
  assert.throws(() => admitCandidate(wired2 as AdmissionInput), (error: unknown) =>
    (error as AdmissionError).problems.some((p) => /too similar/.test(p)));
});

// --- grounding ---

const CHECK = { kind: "check" as const, skill: "Investigation", total: 22, dc: 15, outcome: "success" };

test("correct narration is grounded", () => {
  assert.equal(validateGroundedNarration("Your Investigation check comes to 22 against a Medium DC of 15: success.", [CHECK]).ok, true);
});

test("swapped total and DC are rejected by the foundry gate (production accepts them)", () => {
  const swapped = "Your Investigation check comes to 15 against a Medium DC of 22: success.";
  assert.equal(providerNarrationMatchesReceipts(swapped, [CHECK as never], null), true, "production accepts the swapped pair (the audit finding)");
  assert.throws(() => validateGroundedNarration(swapped, [CHECK]), GroundingFailure);
});

test("opposite verdict is rejected (production accepts it)", () => {
  const wrong = "Investigation total 22 against DC 15. No success: you fail the check.";
  assert.equal(providerNarrationMatchesReceipts(wrong, [CHECK as never], null), true);
  assert.throws(() => validateGroundedNarration(wrong, [CHECK]), GroundingFailure);
});

test("fabricated consequence is rejected", () => {
  const text = "Your Investigation check comes to 22 against a Medium DC of 15: success. The lock clicks open and you find the hidden key.";
  assert.throws(() => validateGroundedNarration(text, [CHECK]), (error: unknown) =>
    (error as GroundingFailure).violations.some((v) => v.code === "fabricated-consequence"));
});

test("fabricated death against surviving HP is rejected", () => {
  const receipt = { kind: "combat-damage" as const, applied: 5, hitPointsAfter: 30 };
  assert.throws(() => validateGroundedNarration("The blade lands for 5 and the goblin dies.", [receipt]), (error: unknown) =>
    (error as GroundingFailure).violations.some((v) => v.code === "fabricated-outcome"));
});

test("authorized consequence is permitted", () => {
  // Death requires explicit status, never an inference from zero HP: production
  // carries `statusAfter` separately from hit points.
  const receipt = { kind: "combat-damage" as const, applied: 30, hitPointsAfter: 0, statusAfter: "dead" as const, target: "goblin" };
  assert.equal(validateGroundedNarration("The blade lands for 30 and the goblin dies.", [receipt]).ok, true);
});

test("zero hit points alone never authorize a death claim", () => {
  const receipt = { kind: "combat-damage" as const, applied: 30, hitPointsAfter: 0, target: "goblin" };
  assert.throws(() => validateGroundedNarration("The blade lands for 30 and the goblin dies.", [receipt]), GroundingFailure);
});

// --- templates ---

test("the RPMax published template really does drop tool calls", () => {
  assert.equal(publishedTemplateDropsToolCalls(), true);
  assert.ok(!/tool_calls/.test(RPMax_PUBLISHED_TEMPLATE));
});

test("RPMax cannot train tool calls without a template override and a parser", () => {
  const profile = templateProfileFor("ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3")!;
  const needs: ToolPrecondition = { advertisesTools: true, hasToolCalls: true, wantsToolCallSupervision: true };
  // Shipped profile is usable, but ONLY because it supplies both remedies.
  assert.equal(profile.requiredTemplateOverride !== null, true);
  assert.equal(profile.toolCallParser !== null, true);
  assert.doesNotThrow(() => assertTemplateCanTrain(profile, needs));
  // Strip either remedy and tool training becomes impossible.
  assert.throws(() => assertTemplateCanTrain({ ...profile, requiredTemplateOverride: null }, needs));
  assert.throws(() => assertTemplateCanTrain({ ...profile, toolCallParser: null }, needs));
  // Pure-conversation use needs no remedy and must stay permitted.
  assert.doesNotThrow(() => assertTemplateCanTrain(profile, { advertisesTools: false, hasToolCalls: false, wantsToolCallSupervision: false }));
});

test("tokenizer revisions are pinned to a 40-hex sha", () => {
  for (const profile of [templateProfileFor("ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3")!, QWEN3_8B_TEMPLATE_PROFILE]) {
    assert.match(profile.tokenizerRevision, /^[0-9a-f]{40}$/);
    assert.doesNotThrow(() => assertTemplateCanTrain(profile, { advertisesTools: false, hasToolCalls: false, wantsToolCallSupervision: false }));
  }
});

test("a profile that supervises tool results is rejected", () => {
  assert.throws(() => assertTemplateCanTrain(
    { ...QWEN3_8B_TEMPLATE_PROFILE, supervisedSpans: ["assistant-prose", "tool-results"] },
    { advertisesTools: false, hasToolCalls: false, wantsToolCallSupervision: false },
  ), /tool-results must never be supervised/);
});