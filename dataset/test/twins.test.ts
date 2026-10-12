/**
 * Counterfactual-twin anchor machinery.
 *
 * These tests prove behaviour rather than restating the module: determinism is
 * checked by rebuilding from a seed, anchor provenance is checked against real
 * `authoritativeFacts()` output, and every rejection path is exercised with a
 * pair a weaker verifier would accept.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validatePreference } from "../src/admission.js";
import { authoritativeFacts, evaluateGroundedNarration, type BindingViolation, type GroundingReceipt } from "../src/grounding.js";
import {
  ANCHOR_KINDS,
  ANCHOR_KIND_WEIGHTS,
  MAX_ANCHORS_PER_CASE,
  MIN_ANCHORS_PER_CASE,
  MIN_STOCK_PROSE_QUALITY,
  ProseQualityError,
  TRAINING_FACING_KEYS_HAVE_NO_ANCHOR_SURFACE,
  TWINS_VERSION,
  TwinError,
  anchorCandidates,
  anchorHolds,
  anchorKey,
  anchorKindMix,
  anchorsInvalidatedBy,
  applyFlip,
  assertProseQualityGate,
  assertProseQualityMeasured,
  buildTwinPair,
  createSeededRandom,
  flipKey,
  flipTouches,
  selectAnchors,
  verifyTwinPair,
  type AnchorSpec,
  type FactFlip,
  type ProseQualityScorer,
  type TwinCaseSpec,
  type TwinInstrumentation,
  type TwinRejectionCode,
  type TwinVerification,
} from "../src/twins.js";
import type { PreferencePair, StoredMessage } from "../src/spec.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const LEDGER: GroundingReceipt[] = [
  { kind: "check", receiptId: "ledger-check", skill: "Investigation", total: 22, dc: 15, outcome: "success" },
];
const LEDGER_AND_DOOR: GroundingReceipt[] = [
  { kind: "check", receiptId: "ledger-check", skill: "Investigation", total: 22, dc: 15, outcome: "success" },
  { kind: "check", receiptId: "door-check", skill: "Arcana", total: 9, dc: 12, outcome: "failure" },
];

const PROMPT: StoredMessage[] = [
  { role: "system", content: "IMMUTABLE ADVENTURE NARRATION AUTHORITY\nWrite a bounded second-person DM response." },
  { role: "user", content: "I go through the night ledger for the fourteenth." },
];

function spec(overrides: Partial<TwinCaseSpec> = {}): TwinCaseSpec {
  return {
    caseId: "dev-ground-01",
    prompt: PROMPT,
    receipts: LEDGER,
    faithfulNarration: "PLACEHOLDER",
    counterfactualNarration: "PLACEHOLDER",
    ...overrides,
  };
}

/** The values the LEDGER receipts commit. Templates are filled from these. */
const BASE_VALUES = { total: "22", dc: "15", skill: "Investigation", difficulty: "Medium", outcome: "success" } as const;
type ArmValues = Record<keyof typeof BASE_VALUES, string>;

/** The values the FLIPPED facts commit: exactly one substitution, mechanically. */
function counterfactualValues(flip: FactFlip): ArmValues {
  const values: ArmValues = { ...BASE_VALUES };
  if (flip.op === "set-value") {
    if (flip.role === "total") values.total = String(flip.value);
    if (flip.role === "dc") values.dc = String(flip.value);
  } else if (flip.op === "set-field") {
    if (flip.field === "subject") values.skill = flip.value ?? "";
    if (flip.field === "difficulty") values.difficulty = flip.value ?? "";
    if (flip.field === "outcome") values.outcome = flip.value ?? "";
  }
  return values;
}

const fill = (template: string, values: ArmValues): string =>
  template.replace(/\{(total|dc|skill|difficulty|outcome)\}/g, (_match, key: keyof ArmValues) => values[key]);

/**
 * Independently worded arms. Each carries every value the receipts commit, so
 * whichever subset `selectAnchors` keeps is present in both; only the flip
 * distinguishes them. The lengths differ deliberately: `validatePreference`
 * refuses near-identical branches, so a twin whose arms differ only by a digit
 * would be refused for the wrong reason.
 */
const ARM_PAIRS: readonly { chosen: string; rejected: string }[] = [
  {
    chosen: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. The fourteenth is the night the page goes wrong, and it goes wrong quietly. Two entries share the same hand and one of them was written in a hurry.",
    rejected: "The ledger's fourteenth entry is the one that goes wrong. Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}, and two of the entries were written in the same hurried hand.",
  },
  {
    chosen: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. The lamp is low and the fourteenth entry sits in a hand you do not recognise.",
    rejected: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. You turn back to the fourteenth entry, and the hand that wrote it is not one you know at all from the whole ledger.",
  },
  {
    chosen: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. The fourteenth entry was written twice, once in a hurry and once in a steadier hand.",
    rejected: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. The fourteenth entry was written twice, once in a hurry, and once in a much steadier hand that pressed harder than the first.",
  },
  {
    chosen: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. You turn the page and the entry keeps its own counsel.",
    rejected: "Your {skill} check comes to {total} against a {difficulty} DC of {dc}: {outcome}. You turn the page again, and the entry keeps its own counsel as it did before.",
  },
];

interface Fixture {
  readonly caseSpec: TwinCaseSpec;
  readonly selected: readonly AnchorSpec[];
  readonly pair: PreferencePair;
  readonly instrumentation: TwinInstrumentation;
}

/**
 * Build a fixture from an EXPLICIT flip, so the anchor under test is pinned
 * rather than sampled. The counterfactual arm is filled from the flip's own
 * values: the narration is derived from the facts, never the other way round.
 */
function twinFor(
  armIndex: number,
  flip: FactFlip,
  seed: string,
  overrides: Partial<TwinCaseSpec> = {},
  receipts: readonly GroundingReceipt[] = LEDGER,
): Fixture {
  const arms = ARM_PAIRS[armIndex];
  assert.ok(arms, `no arm template at index ${String(armIndex)}`);
  const anchors = selectAnchors(authoritativeFacts(receipts), seed).anchors;
  const flipAnchor = anchors.find((anchor) => flipTouches(flip, anchor));
  assert.ok(flipAnchor, `seed "${seed}" selected no anchor bound to ${flipKey(flip)}; it selected ${JSON.stringify(anchors.map((anchor) => anchor.value))}`);
  const caseSpec = spec({
    receipts: [...receipts],
    faithfulNarration: fill(arms.chosen, BASE_VALUES),
    counterfactualNarration: fill(arms.rejected, counterfactualValues(flip)),
    flip,
    flipAnchor,
    ...overrides,
  });
  const built = buildTwinPair(caseSpec, anchors, seed);
  return { caseSpec, selected: anchors, pair: built.pair, instrumentation: built.instrumentation };
}

/** The four flips the batch exercises, one per anchor binding shape. */
const FLIPS = {
  total: { op: "set-value", factId: "ledger-check", role: "total", value: 28 } as const,
  dc: { op: "set-value", factId: "ledger-check", role: "dc", value: 17 } as const,
  subject: { op: "set-field", factId: "ledger-check", field: "subject", value: "Arcana" } as const,
  difficulty: { op: "set-field", factId: "ledger-check", field: "difficulty", value: "Hard" } as const,
};
/** One seed per flip, each chosen because its selection contains that anchor. */
const SEEDS = { total: "w0", dc: "t-0", subject: "w2", difficulty: "w2" } as const;
const BATCH = ["total", "dc", "subject", "difficulty"] as const;

const codes = (result: TwinVerification): TwinRejectionCode[] => result.reasons.map((reason) => reason.code);

function verify(twin: Fixture, pair: PreferencePair = twin.pair): TwinVerification {
  return verifyTwinPair({ pair, spec: twin.caseSpec, instrumentation: twin.instrumentation });
}

const wordList = (text: string): string[] => text.toLocaleLowerCase("en-US").match(/[a-z0-9']+/g) ?? [];

function jaccard(left: string, right: string): number {
  const a = new Set(wordList(left));
  const b = new Set(wordList(right));
  const union = new Set([...a, ...b]);
  const shared = [...a].filter((word) => b.has(word));
  return union.size === 0 ? 1 : shared.length / union.size;
}

/* -------------------------------------------------------------------------- */
/* 1. Determinism                                                              */
/* -------------------------------------------------------------------------- */

test("the same seed rebuilds a byte-identical anchor set and twin pair", () => {
  const facts = authoritativeFacts(LEDGER_AND_DOOR);
  // Validity is covered elsewhere; this test is about byte-stability, so the
  // flip target is left to the builder's own seeded choice.
  const narration = "Your Investigation check comes to 22 against a Medium DC of 15: success. The fourteenth entry keeps its own counsel.";
  for (const seed of ["alpha", "beta", "gamma"]) {
    const first = selectAnchors(facts, seed);
    const second = selectAnchors(facts, seed);
    assert.equal(JSON.stringify(first), JSON.stringify(second), `anchor set drifted for seed ${seed}`);
    assert.deepEqual(second.anchors, first.anchors);

    const caseSpec = spec({ receipts: LEDGER_AND_DOOR, faithfulNarration: narration, counterfactualNarration: narration });
    const builtA = buildTwinPair(caseSpec, first.anchors, seed);
    const builtB = buildTwinPair(caseSpec, second.anchors, seed);
    assert.equal(JSON.stringify(builtA.pair), JSON.stringify(builtB.pair), `twin pair drifted for seed ${seed}`);
    assert.equal(JSON.stringify(builtA.instrumentation), JSON.stringify(builtB.instrumentation));
  }
});

test("a different seed actually changes the selection, and no unseeded randomness exists", () => {
  const facts = authoritativeFacts(LEDGER_AND_DOOR);
  const rendered = new Set(Array.from({ length: 24 }, (_, index) =>
    JSON.stringify(selectAnchors(facts, `seed-${String(index)}`).anchors.map((anchor) => anchor.value))));
  assert.ok(rendered.size > 1, "the seed never changes the anchor set, so it is not being used");

  const random = createSeededRandom("repeatable");
  const draws = [random.next(), random.next(), random.int(10)];
  const again = createSeededRandom("repeatable");
  assert.deepEqual([again.next(), again.next(), again.int(10)], draws);
  assert.throws(() => createSeededRandom("x").int(0), TwinError);
  assert.throws(() => createSeededRandom("x").pick([]), TwinError);
});

/* -------------------------------------------------------------------------- */
/* 2. Selection: density, span, forced numeric                                 */
/* -------------------------------------------------------------------------- */

test("anchor selection is 2-3 per case, spans the three classes, and forces a numeric anchor", () => {
  const factSets = [
    authoritativeFacts(LEDGER),
    authoritativeFacts(LEDGER_AND_DOOR),
    authoritativeFacts([
      { kind: "combat-damage", receiptId: "haug-hit", actor: "Haug", target: "the salt barge", applied: 7, hitPointsAfter: 23, hitPointsBefore: 30, hit: true, damageType: "bludgeoning", statusAfter: "unconscious" },
    ]),
    authoritativeFacts([
      { kind: "check", receiptId: "no-numbers-a", skill: "Persuasion", total: 11, dc: 13, outcome: "success" },
      { kind: "combat-damage", receiptId: "no-numbers-b", actor: "Oswin", target: "Tallow Street", applied: 3, hitPointsAfter: 12, hit: true, statusAfter: "stable" },
    ]),
  ];
  const selections = factSets.flatMap((facts) => Array.from({ length: 6 }, (_, index) => selectAnchors(facts, `batch-${String(index)}`)));

  for (const selection of selections) {
    assert.ok(selection.anchors.length >= MIN_ANCHORS_PER_CASE && selection.anchors.length <= MAX_ANCHORS_PER_CASE,
      `expected ${MIN_ANCHORS_PER_CASE}-${MAX_ANCHORS_PER_CASE} anchors, got ${selection.anchors.length}`);
    for (const anchor of selection.anchors) assert.ok(ANCHOR_KINDS.includes(anchor.kind));
    // Every fact set here supplies a numeric value, so every selection must too.
    assert.equal(selection.forcedNumeric, true);
    assert.ok(selection.anchors.some((anchor) => anchor.kind === "numeric"), "a numeric value was available but no numeric anchor was demanded");
  }

  // Span: the batch must actually reach all three classes, and each target is non-zero.
  const mix = anchorKindMix(selections);
  assert.deepEqual(Object.keys(mix).sort(), [...ANCHOR_KINDS].sort());
  for (const kind of ANCHOR_KINDS) {
    assert.ok(mix[kind] > 0, `class ${kind} never appears in the batch`);
    assert.ok(ANCHOR_KIND_WEIGHTS[kind] > 0);
  }
});

test("a case with too few anchor candidates is refused rather than padded", () => {
  const sparse = authoritativeFacts([{ kind: "inventory", receiptId: "inv-1", itemLabel: "rope", quantity: 2, action: "stow" }]);
  assert.deepEqual(anchorCandidates(sparse), []);
  assert.throws(() => selectAnchors(sparse, "any"), TwinError);
});

/* -------------------------------------------------------------------------- */
/* 3. Provenance: a flipped fact invalidates exactly its own anchors           */
/* -------------------------------------------------------------------------- */

test("anchors are projected from authoritativeFacts, and a flipped fact invalidates exactly its own", () => {
  // Real Family B output, not a lookalike.
  const facts = authoritativeFacts(LEDGER_AND_DOOR);
  assert.deepEqual(facts.map((fact) => fact.receiptId), ["ledger-check", "door-check"]);

  const anchors = selectAnchors(facts, "provenance-seed").anchors;
  assert.ok(anchors.length >= MIN_ANCHORS_PER_CASE);
  for (const anchor of anchors) {
    assert.ok(facts.some((fact) => fact.receiptId === anchor.factId), `anchor ${anchor.value} names a fact that does not exist`);
    assert.equal(anchorHolds(anchor, facts), true, `anchor ${anchor.value} is not true of its own fact`);
  }

  const numeric = anchors.find((anchor) => anchor.kind === "numeric");
  assert.ok(numeric, "the receipts supply numbers, so a numeric anchor is required");
  assert.equal(numeric.binding.field, "value");
  const flip: FactFlip = { op: "set-value", factId: numeric.factId, role: numeric.binding.role, value: 27 };
  const flipped = applyFlip(facts, flip);

  assert.deepEqual(anchorsInvalidatedBy(flip, facts, flipped, anchors).map((anchor) => anchor.value), [numeric.value]);
  assert.equal(anchorHolds(numeric, flipped), false, "the flipped fact still asserts the old value");
  for (const anchor of anchors) {
    if (anchor.value === numeric.value) continue;
    assert.equal(anchorHolds(anchor, flipped), true, `anchor ${anchor.value} was collateral damage from an unrelated flip`);
  }

  // The kind is RE-RESOLVED against the new facts, not carried over.
  const reselected = selectAnchors(flipped, "provenance-seed").anchors;
  assert.ok(reselected.some((anchor) => anchor.kind === "numeric"));
  assert.ok(reselected.some((anchor) => anchor.value === "27"), "the new numeric value was never re-resolved");
  assert.ok(!reselected.some((anchor) => anchorKey(anchor) === anchorKey(numeric)), "the invalidated anchor survived re-selection");
  // Flips never mutate their input.
  assert.equal(anchorHolds(numeric, facts), true);
});

/* -------------------------------------------------------------------------- */
/* 4. Rejections                                                               */
/* -------------------------------------------------------------------------- */

test("REJECT length-only difference: one arm is far longer and says nothing new", () => {
  const twin = twinFor(0, FLIPS.total, SEEDS.total);
  assert.equal(verify(twin).ok, true, JSON.stringify(verify(twin).reasons));
  const padded: PreferencePair = { ...twin.pair, rejected: [{ role: "assistant", content: "It opens." }] };
  const result = verify(twin, padded);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("length-only-difference"), JSON.stringify(result.reasons));
  // The standard is the admission one, not a local invention.
  assert.ok(validatePreference(padded).some((problem) => /length-biased/.test(problem)));
});

test("REJECT style-only difference: both arms carry an identical anchor set", () => {
  const twin = twinFor(0, FLIPS.total, SEEDS.total);
  // The same facts and the same numbers, restyled. Nothing distinguishes these
  // two arms factually, so the pair would train register rather than fidelity.
  const restyled: PreferencePair = {
    ...twin.pair,
    rejected: [{
      role: "assistant",
      content: "It was the fourteenth entry of the ledger which was the one at fault. Your Investigation check comes to 22 against a Medium DC of 15: success, and a couple of the entries were penned by the same hurried hand.",
    }],
  };
  const result = verify(twin, restyled);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("style-only-difference"), JSON.stringify(result.reasons));
  // The diagnosis pairs with the specific fault it explains.
  assert.ok(codes(result).includes("rejected-arm-carries-invalidated-anchor"), JSON.stringify(result.reasons));
});

test("REJECT both-arms-identical-demand: the flip leaves every anchor established", () => {
  const twin = twinFor(0, FLIPS.total, SEEDS.total);
  assert.equal(verify(twin).ok, true, JSON.stringify(verify(twin).reasons));
  // The verifier re-derives the flip from the receipts, so tampering the claim
  // is detected rather than trusted: `damageType` carries no selected anchor,
  // so every anchor stays established and both arms demand the same behaviour.
  const nonBinding: FactFlip = { op: "set-field", factId: "ledger-check", field: "damageType", value: "fire" };
  const result = verifyTwinPair({
    pair: twin.pair,
    spec: twin.caseSpec,
    instrumentation: {
      ...twin.instrumentation,
      flip: nonBinding,
      counterfactualFacts: applyFlip(twin.instrumentation.facts, nonBinding),
      invalidated: [],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("anchor-not-invalidated"), JSON.stringify(result.reasons));

  // A tampered fact set is caught on its own: the verifier re-derives the
  // authoritative facts from the receipts rather than trusting the claim.
  const tampered = verifyTwinPair({
    pair: twin.pair,
    spec: twin.caseSpec,
    instrumentation: { ...twin.instrumentation, counterfactualFacts: twin.instrumentation.facts },
  });
  assert.ok(codes(tampered).includes("instrumentation-mismatch"), JSON.stringify(tampered.reasons));
});

test("REJECT failed lengthRatio: the declared guard field is not a measured number", () => {
  const twin = twinFor(0, FLIPS.total, SEEDS.total);
  for (const declared of [0, -1.2, Number.NaN, 9.9]) {
    const result = verify(twin, { ...twin.pair, lengthRatio: declared });
    assert.equal(result.ok, false, `declared ${String(declared)} was accepted`);
    assert.ok(codes(result).includes("length-ratio-guard-failed"), JSON.stringify(result.reasons));
  }
  // A declared ratio that disagrees with the measured one is untrustworthy
  // evidence, even when it is a positive number under the guard.
  const dishonest = verify(twin, { ...twin.pair, lengthRatio: 1.01 });
  assert.equal(dishonest.ok, false);
  assert.ok(codes(dishonest).includes("length-ratio-guard-failed"), JSON.stringify(dishonest.reasons));
});

/**
 * KNOWN LIMITATION, pinned deliberately.
 *
 * `multi-fact-divergence` is derived from grounding violations that are not
 * attributable to the flipped fact, so it is only as reliable as grounding's
 * clause-to-receipt binding. That binding currently under-reaches: given two
 * check receipts, `bindFact` inherits the previously bound receipt rather than
 * resolving the second clause to its own, so the second receipt is never bound
 * and a misstatement of it is never detected.
 *
 * This test asserts the CURRENT behaviour and therefore fails the moment
 * grounding is fixed. That is intended: it is the tripwire for the defect
 * reproduced below, which is tracked in CORRECTIONS_LOG.md.
 */
test("KNOWN LIMITATION: a second receipt is never bound, so its divergence is invisible", () => {
  const facts = authoritativeFacts(LEDGER_AND_DOOR);
  const anchors = selectAnchors(facts, "d3").anchors;
  const flip: FactFlip = { op: "set-value", factId: "ledger-check", role: "dc", value: 17 };
  const flipAnchor = anchors.find((anchor) => flipTouches(flip, anchor));
  assert.ok(flipAnchor);

  // `door-check` commits total 9. The narration says 14 and names the skill.
  const prose = "Your Investigation check comes to 22 against a Medium DC of 17: success."
    + " Your Arcana check comes to 14 against an Easy DC of 12: failure.";

  const verdict = evaluateGroundedNarration(prose, LEDGER_AND_DOOR);
  const bound = new Set(verdict.bindings.map((binding) => binding.receiptId));

  // The defect: the second receipt is never bound at all.
  assert.equal(bound.has("door-check"), false, "grounding now binds the second receipt; update this limitation test");
  assert.equal(verdict.bindingsChecked, 1, "grounding now checks both receipts; update this limitation test");
  // And the misstatement of it is therefore not reported against door-check.
  // `GroundingVerdict` is a discriminated union: violations exist only on the
  // rejected branch, so narrow before reading them rather than casting.
  assert.equal(verdict.verdict, "rejected", "this repro relied on the rejected branch");
  if (verdict.verdict !== "rejected") throw new Error("unreachable");
  assert.equal(
    verdict.violations.some((violation: BindingViolation) => violation.receiptId === "door-check"),
    false,
    "grounding now reports the second receipt; update this limitation test",
  );
  // A false violation is charged to the WRONG receipt instead.
  assert.ok(
    verdict.violations.some(
      (violation: BindingViolation) => violation.receiptId === "ledger-check" && violation.code === "check-outcome-contradicted",
    ),
    "the misattributed violation changed shape; re-derive this expectation",
  );

  // Consequence for the twin check: the second-receipt divergence is NOT
  // surfaced as `multi-fact-divergence`, because that code is derived from
  // grounding violations bound to a receipt other than the flipped one, and no
  // such binding exists. The pair is still rejected for an unrelated reason,
  // which is exactly what makes the gap easy to miss.
  const chosen = "Your Investigation check comes to 22 against a Medium DC of 15: success. Your Arcana check comes to 9 against an Easy DC of 12: failure.";
  const badSpec = spec({ receipts: LEDGER_AND_DOOR, faithfulNarration: chosen, counterfactualNarration: prose, flip, flipAnchor });
  const pair = buildTwinPair(badSpec, anchors, "divergence-seed");
  const result = verifyTwinPair({ pair: pair.pair, spec: badSpec, instrumentation: pair.instrumentation });
  assert.equal(
    codes(result).includes("multi-fact-divergence"),
    false,
    "multi-fact divergence became detectable; fold this case back into a positive rejection test",
  );
});

/* -------------------------------------------------------------------------- */
/* 5. The contrast is real                                                    */
/* -------------------------------------------------------------------------- */

test("the rejected arm is a plausible paraphrase, and length never identifies it", () => {
  const cases = BATCH.map((key, index) => twinFor(index, FLIPS[key], SEEDS[key]));

  for (const twin of cases) {
    const result = verify(twin);
    assert.equal(result.ok, true, JSON.stringify(result.reasons));

    const invalidated = result.measurements.invalidated;
    assert.equal(invalidated.length, 1);
    const dropped = invalidated[0]!;
    // The dropped anchor is genuinely false under the counterfactual facts.
    assert.equal(anchorHolds(dropped, twin.instrumentation.counterfactualFacts), false);

    const chosen = twin.pair.chosen[0]!.content;
    const rejected = twin.pair.rejected[0]!.content;
    // A plausible paraphrase, not an unrelated sentence.
    assert.ok(jaccard(chosen, rejected) > 0.4, `rejected arm is not a paraphrase (jaccard ${jaccard(chosen, rejected).toFixed(2)})`);
    assert.ok(rejected.trim().split(/\s+/).length > 20, "the rejected arm is a stub, which DPO would learn as brevity");
    // The shared anchors survive in BOTH arms: that is what makes the contrast
    // minimal rather than "the rejected text is vaguer".
    assert.deepEqual(result.measurements.sharedAnchors.map((anchor) => anchor.value).sort(),
      result.measurements.carriedByChosen.map((anchor) => anchor.value).sort().filter((value) => value !== dropped.value).sort());
    assert.equal(result.measurements.carriedByRejected.length, result.measurements.carriedByChosen.length - 1);
  }

  // No arm is identifiable by length: every rejected arm sits strictly between
  // the shortest and the longest chosen arm in the batch.
  const chosenLengths = cases.map((twin) => twin.pair.chosen[0]!.content.trim().split(/\s+/).length);
  const rejectedLengths = cases.map((twin) => twin.pair.rejected[0]!.content.trim().split(/\s+/).length);
  const shortest = Math.min(...chosenLengths);
  const longest = Math.max(...chosenLengths);
  for (const length of rejectedLengths) {
    assert.ok(length > shortest && length < longest,
      `a rejected arm is the ${length === shortest ? "shortest" : length === longest ? "longest" : "?"} in the batch (${String(length)} vs ${String(shortest)}..${String(longest)})`);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. Prose-quality gate: fail closed                                         */
/* -------------------------------------------------------------------------- */

test("the prose-quality gate holds the anchor work to the measured stock rate", () => {
  assert.equal(MIN_STOCK_PROSE_QUALITY, 4 / 8);
  // Exactly 4/8 passes; anything below it throws.
  assert.doesNotThrow(() => assertProseQualityGate(4 / 8));
  assert.doesNotThrow(() => assertProseQualityGate(1));
  for (const below of [0.4999, 0.25, 0]) {
    assert.throws(() => assertProseQualityGate(below), (error: unknown) =>
      error instanceof ProseQualityError && error.problems.some((problem) => /stock rate/.test(problem)));
  }
  assert.throws(() => assertProseQualityGate(Number.NaN), ProseQualityError);
  assert.throws(() => assertProseQualityGate(1.5), ProseQualityError);
});

test("an absent prose-quality scorer is unavailable, never a pass", () => {
  const request = { pairDigest: "a".repeat(64), armDigests: ["b".repeat(64)], rubricVersion: "prose-quality-stock-v1" };
  for (const absent of [undefined, null]) {
    assert.throws(() => assertProseQualityMeasured(request, absent), (error: unknown) =>
      error instanceof ProseQualityError && error.problems.some((problem) => /unavailable, not passed/.test(problem)));
  }
  // A scorer that graded nothing has not measured anything.
  const empty: ProseQualityScorer = {
    scorerId: "blind-pairwise",
    version: "1",
    score: () => ({ rate: 1, graded: 0, measuredBy: "reviewer-1" }),
  };
  assert.throws(() => assertProseQualityMeasured(request, empty), (error: unknown) =>
    error instanceof ProseQualityError && error.problems.some((problem) => /unmeasured rate is not a pass/.test(problem)));
  // And one below the stock rate still fails through the port.
  const degraded: ProseQualityScorer = {
    scorerId: "blind-pairwise",
    version: "1",
    score: () => ({ rate: 0.375, graded: 8, measuredBy: "reviewer-1" }),
  };
  assert.throws(() => assertProseQualityMeasured(request, degraded), (error: unknown) =>
    error instanceof ProseQualityError && error.problems.some((problem) => /stock rate/.test(problem)));
  const passing: ProseQualityScorer = {
    scorerId: "blind-pairwise",
    version: "1",
    score: () => ({ rate: MIN_STOCK_PROSE_QUALITY, graded: 8, measuredBy: "reviewer-1" }),
  };
  assert.equal(assertProseQualityMeasured(request, passing).graded, 8);
});

/* -------------------------------------------------------------------------- */
/* 7. Structural: anchors are instrumentation, never a training target         */
/* -------------------------------------------------------------------------- */

test("no training-facing type places the anchor list inside conversational message content", () => {
  assert.equal(TRAINING_FACING_KEYS_HAVE_NO_ANCHOR_SURFACE, true);

  const twin = twinFor(0, FLIPS.total, SEEDS.total);
  for (const messages of [twin.pair.prompt, twin.pair.chosen, twin.pair.rejected]) {
    for (const message of messages) {
      // No extra training-facing field smuggled onto a message.
      assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
      // No anchor instruction, list or label in conversational content.
      assert.doesNotMatch(message.content, /anchor|substring|must include|must contain|require these/i, message.content);
    }
  }
  // `rationale` is audit metadata and is not exported (the export projection is
  // prompt/chosen/rejected only), so the guarantee is about the training columns.
  const trainingColumns = { prompt: twin.pair.prompt, chosen: twin.pair.chosen, rejected: twin.pair.rejected };
  assert.doesNotMatch(JSON.stringify(trainingColumns), /anchor|substring|must include|must contain|require these/i);
  // The anchor VALUES must not be smuggled in as an instruction either: only the
  // prose that happens to mention them is fine.
  for (const anchor of twin.instrumentation.anchors) {
    assert.equal(Object.prototype.hasOwnProperty.call(twin.pair, anchor.kind), false, `${anchor.kind} leaked into the pair`);
  }
  // The instrumentation is where the anchors live, and it is not in the pair.
  assert.ok(twin.instrumentation.anchors.length > 0);
  assert.equal(twin.instrumentation.twinsVersion, TWINS_VERSION);
  assert.equal((twin.pair as unknown as Record<string, unknown>).anchors, undefined);

  // Source-level guard: no declared field can be both an anchor list and a
  // message. This fails if a future revision puts anchors into StoredMessage.
  const source = readFileSync(fileURLToPath(new URL("../src/twins.ts", import.meta.url)), "utf8");
  const offenders = source.split("\n").filter((line) => /AnchorSpec/.test(line) && /StoredMessage/.test(line));
  assert.deepEqual(offenders, [], "a declared field carries anchors and message content at once");
});
