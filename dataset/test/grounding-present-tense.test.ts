/**
 * The check-resolution verb alternation previously admitted only the past forms
 * (succeeded/failed) and the third-person present forms (succeeds/fails). A
 * narrator writing the plain present base form -- "You succeed on the Insight
 * check against DC 12, with a total of 15." -- produced a clause the gate could
 * not parse, so a factually correct answer was refused as an unrecognized clause
 * and sent to adjudication. These are regressions for the completed alternation:
 * the newly accepted surface is only a different inflection of the same bound
 * clause, so it must neither loosen actor/skill/DC/total/outcome/receipt binding
 * nor admit any claim the past forms would not have admitted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";

/** One committed check by the player, exactly as the pipeline records it. */
function check(receiptId: string, skill: string, dc: number, total: number, outcome: string): GroundingReceipt {
  return { kind: "check", receiptId, actor: "you", skill, dc, total, outcome, visibility: "public" };
}
/** One committed attack by an attacker on a named target, exactly as recorded. */
function combat(receiptId: string, target: string, applied: number): GroundingReceipt {
  return { kind: "combat", receiptId, actor: "the attacker", target, action: "attack", visibility: "public",
    outcome: { kind: "damage", applied, damageType: "slashing", hit: true, hitPointsBefore: 24,
      hitPointsAfter: 24 - applied, statusAfter: "stable" } };
}

// The two factually correct v7 answers that the v6 gate refused as unrecognized.
const insight = check("insight-check", "Insight", 12, 15, "success");
const survival = check("survival-check", "Survival", 15, 9, "failure");
const perception = check("perception-check", "Perception", 14, 19, "success");

const PRESENT_SUCCESS = "You succeed on the Insight check against DC 12, with a total of 15.";
const PRESENT_FAILURE = "You fail on the Survival check against DC 15, with a total of 9.";
const PAST_SUCCESS = "You succeeded on the Insight check against DC 12, with a total of 15.";
const PAST_FAILURE = "You failed on the Survival check against DC 15, with a total of 9.";
const THIRD_PERSON_SUCCESS = "You succeeds on the Insight check against DC 12, with a total of 15.";
const THIRD_PERSON_FAILURE = "You fails on the Survival check against DC 15, with a total of 9.";

function verify(text: string, receipts: readonly GroundingReceipt[], checked?: number): ReturnType<typeof evaluateGroundedNarration> {
  const result = evaluateGroundedNarration(text, receipts);
  assert.equal(result.verdict, "verified", JSON.stringify({ text, result }));
  if (checked !== undefined) assert.equal(result.bindingsChecked, checked, JSON.stringify({ text, result }));
  return result;
}
function reject(text: string, receipts: readonly GroundingReceipt[], code: string): void {
  const result = evaluateGroundedNarration(text, receipts);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  assert.ok(result.violations.some((violation) => violation.code === code),
    `${code} expected for ${JSON.stringify(text)}, got ${JSON.stringify(result.violations)}`);
}
function adjudicate(text: string, receipts: readonly GroundingReceipt[], code: string): void {
  const result = evaluateGroundedNarration(text, receipts);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify({ text, result }));
  assert.ok(result.adjudications.some((issue) => issue.code === code),
    `${code} expected for ${JSON.stringify(text)}, got ${JSON.stringify(result.adjudications)}`);
}

test("REPRODUCTION: the present-tense base forms are the only missing inflections of the bound clause", () => {
  // Every inflection carries the identical actor, skill, DC, total and outcome
  // roles, so all of them must bind to the same receipt, not just the old subset.
  const forms = [PAST_SUCCESS, THIRD_PERSON_SUCCESS, PRESENT_SUCCESS];
  for (const form of forms) {
    const result = verify(form, [insight], 1);
    assert.deepEqual(result.bindings.map((binding) => binding.receiptId), ["insight-check"]);
    for (const role of ["dc", "total", "outcome"]) {
      assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), `${role} in ${form}`);
    }
  }
  for (const form of [PAST_FAILURE, THIRD_PERSON_FAILURE, PRESENT_FAILURE]) {
    const result = verify(form, [survival], 1);
    assert.deepEqual(result.bindings.map((binding) => binding.receiptId), ["survival-check"]);
    for (const role of ["dc", "total", "outcome"]) {
      assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), `${role} in ${form}`);
    }
  }
});

test("POSITIVE: a present-tense success binds actor, skill, DC and total to its own receipt", () => {
  const result = verify(PRESENT_SUCCESS, [insight, perception], 1);
  const binding = result.bindings[0]!;
  assert.equal(binding.receiptId, "insight-check");
  assert.match(binding.clause, /succeed/);
  // Only the matching check binds; the unrelated Perception receipt is untouched.
  assert.ok(!result.bindings.some((entry) => entry.receiptId === "perception-check"));
});

test("POSITIVE: a present-tense failure binds actor, skill, DC and total to its own receipt", () => {
  const result = verify(PRESENT_FAILURE, [survival], 1);
  const binding = result.bindings[0]!;
  assert.equal(binding.receiptId, "survival-check");
  assert.match(binding.clause, /fail/);
});

test("REGRESSION: the past-tense and third-person present forms still bind unchanged", () => {
  verify(PAST_SUCCESS, [insight], 1);
  verify(PAST_FAILURE, [survival], 1);
  verify(THIRD_PERSON_SUCCESS, [insight], 1);
  verify(THIRD_PERSON_FAILURE, [survival], 1);
});

test("POSITIVE: a combined present-tense check plus damage binds both receipts and every required role", () => {
  const ailsa = combat("ailsa-damage", "Ailsa", 5);
  const text = "You succeed on the Perception check against DC 14, with a total of 19. "
    + "The attacker attacks Ailsa and hits, dealing 5 slashing damage. "
    + "Ailsa's hit points go from 24 to 19; Ailsa is stable.";
  const result = verify(text, [perception, ailsa], 2);
  assert.deepEqual(new Set(result.bindings.map((binding) => binding.receiptId)),
    new Set(["perception-check", "ailsa-damage"]));
  for (const role of ["dc", "total", "outcome", "damage-applied", "hp-before", "hp-after", "status-after", "hit"]) {
    assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), role);
  }
});

test("NEGATIVE: a present-tense check claimed for the wrong actor is refused", () => {
  reject("Ailsa succeeds on the Insight check against DC 12, with a total of 15.", [insight],
    "actor-binding-mismatch");
  reject("The attacker succeeds on the Insight check against DC 12, with a total of 15.", [insight],
    "actor-binding-mismatch");
});

test("NEGATIVE: a present-tense check claiming a mismatched skill is refused", () => {
  reject("You succeed on the Survival check against DC 12, with a total of 15.", [insight],
    "subject-binding-mismatch");
  reject("You succeed on a Perception check against DC 12, with a total of 15.", [insight],
    "subject-binding-mismatch");
});

test("NEGATIVE: swapped DC and total are refused under the present-tense form", () => {
  reject("You succeed on the Insight check against DC 15, with a total of 12.", [insight],
    "value-binding-mismatch");
  reject("You fail on the Survival check against DC 9, with a total of 15.", [survival],
    "value-binding-mismatch");
});

test("NEGATIVE: incorrect numeric values are refused under the present-tense form", () => {
  reject("You succeed on the Insight check against DC 13, with a total of 15.", [insight],
    "value-binding-mismatch");
  reject("You succeed on the Insight check against DC 12, with a total of 16.", [insight],
    "value-binding-mismatch");
  reject("You fail on the Survival check against DC 15, with a total of 10.", [survival],
    "value-binding-mismatch");
});

test("NEGATIVE: the opposite outcome is refused under the present-tense form", () => {
  reject("You succeed on the Survival check against DC 15, with a total of 9.", [survival],
    "check-outcome-contradicted");
  reject("You fail on the Insight check against DC 12, with a total of 15.", [insight],
    "check-outcome-contradicted");
});

test("NEGATIVE: an unsupported extra action or consequence appended to the sentence never verifies", () => {
  adjudicate(`${PRESENT_SUCCESS} The latch slides open behind you.`, [insight], "unrecognized-clause");
  adjudicate(`${PRESENT_SUCCESS} You draw your blade and step forward.`, [insight], "unrecognized-clause");
  // A trailing extra role on the very same check clause is not a bound check.
  adjudicate("You succeed on the Insight check against DC 12, with a total of 15, and the relic is yours.",
    [insight], "unrecognized-clause");
  // A correct check plus an invented consequence never reaches "verified".
  adjudicate(`${PRESENT_SUCCESS} You seize the relic.`, [insight], "unrecognized-clause");
  assert.equal(evaluateGroundedNarration(`${PRESENT_SUCCESS} You seize the relic.`, [insight]).verdict,
    "adjudication-required");
});

test("NEGATIVE: a present-tense check bound against receipts that do not include it never verifies", () => {
  // The only recorded check is a different skill: nothing binds the stated one.
  reject(PRESENT_SUCCESS, [survival], "subject-binding-mismatch");
  // No check receipt at all, only a combat receipt: no check receipt establishes this.
  reject(PRESENT_SUCCESS, [combat("ailsa-damage", "Ailsa", 5)], "unbound-mechanical-claim");
  // Correct skill and total, but scoped to a check whose DC was never recorded as 12.
  reject(PRESENT_SUCCESS, [check("other-dc", "Insight", 20, 15, "success")], "value-binding-mismatch");
});

test("NEGATIVE: negation does not verify as a success", () => {
  reject("You do not succeed on the Insight check against DC 12, with a total of 15.", [insight],
    "actor-binding-mismatch");
  reject("You do not fail on the Survival check against DC 15, with a total of 9.", [survival],
    "actor-binding-mismatch");
  // The double-negative spelling must not slip into the failure binding either.
  reject("You do not not succeed on the Insight check against DC 12, with a total of 15.", [insight],
    "actor-binding-mismatch");
});

test("NEGATIVE: an ambiguous or pronoun subject does not bind to actor \"you\"", () => {
  adjudicate("It succeeds on the Insight check against DC 12, with a total of 15.", [insight],
    "unrecognized-clause");
  adjudicate("He fails on the Survival check against DC 15, with a total of 9.", [survival],
    "unrecognized-clause");
  adjudicate("They succeed on the Insight check against DC 12, with a total of 15.", [insight],
    "unrecognized-clause");
  reject("The attacker succeeds on the Insight check against DC 12, with a total of 15.", [insight],
    "actor-binding-mismatch");
});