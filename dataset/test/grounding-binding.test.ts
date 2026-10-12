/**
 * The three v1 defects were first reproduced against the live, unmodified gate.
 * Frozen predicates retain that evidence; all FIX/property tests use the live API.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authoritativeFacts, evaluateGroundedNarration, GroundingAdjudicationRequired,
  GroundingFailure, validateGroundedNarration, type GroundingReceipt,
} from "../src/grounding.js";

const CHECK = { kind: "check" as const, skill: "Investigation", total: 22, dc: 15, outcome: "success" };
const CONTRADICTION = "Your Investigation check comes to 22 against DC 15: success. The Investigation check failed.";
const SWAPPED = "The attack deals 30; the target has 5 HP remaining.";
const SURVIVAL = "The target survives at 10 HP.";

function legacyPolarity(text: string, subject: string): "absent" | "affirm" | "negate" {
  let result: "absent" | "affirm" | "negate" = "absent";
  for (const match of text.matchAll(new RegExp(subject, "gi"))) {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    result = /(?:no|not|never|fail(?:s|ed|ure)?|miss(?:es|ed)?|without|unable to|could not|couldn't)\b[^.!?]{0,40}$/i.test(prefix) ? "negate" : "affirm";
  }
  return result;
}
function legacyDamageProblems(text: string, applied: number, hpAfter: number): string[] {
  const problems: string[] = [];
  const has = (value: number): boolean => new RegExp(`(^|[^0-9.])${value}(?![0-9.])`).test(text);
  if (!has(applied) && !has(hpAfter)) problems.push("damage-ungrounded");
  if (/\b(?:kill(?:s|ed)?|slain|defeat(?:s|ed)?|dead|dies|died|falls|drop(?:s|ped)?)\b/i.test(text) && hpAfter > 0) problems.push("fabricated-outcome");
  if (/\b(?:surviv(?:es|ed)|wounds?|merely|only)\b/i.test(text) && applied >= hpAfter) problems.push("fabricated-outcome");
  return problems;
}

test("REPRODUCTION: v1 certified success followed by explicit failure", () => {
  assert.equal(legacyPolarity(CONTRADICTION, "Investigation"), "affirm");
  assert.match(CONTRADICTION, /comes to\D{0,24}22\b[\s\S]{0,40}?\bDC\b\D{0,12}15\b/i);
  assert.equal(legacyPolarity(CONTRADICTION, "success"), "affirm");
});
test("REPRODUCTION: v1 certified swapped applied damage and remaining HP", () => {
  assert.deepEqual(legacyDamageProblems(SWAPPED, 5, 30), []);
});
test("REPRODUCTION: v1 falsely rejected survival when damage exceeded remaining HP", () => {
  assert.deepEqual(legacyDamageProblems(SURVIVAL, 20, 10), ["fabricated-outcome"]);
});

function rejected(text: string, receipts: readonly GroundingReceipt[], code?: string): void {
  const result = evaluateGroundedNarration(text, receipts);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  assert.equal(result.ok, false);
  assert.throws(() => validateGroundedNarration(text, receipts), GroundingFailure);
  if (code && result.verdict === "rejected") assert.ok(result.violations.some((violation) => violation.code === code), JSON.stringify(result));
}
function verified(text: string, receipts: readonly GroundingReceipt[]): void {
  const result = evaluateGroundedNarration(text, receipts);
  assert.equal(result.verdict, "verified", JSON.stringify({ text, result }));
  assert.equal(result.ok, true);
  assert.equal(validateGroundedNarration(text, receipts).ok, true);
}

test("FIX: explicit self-contradiction is rejected", () => {
  rejected(CONTRADICTION, [CHECK], "check-outcome-contradicted");
});
test("FIX: damage and remaining HP bind to their roles", () => {
  const receipt = { kind: "combat-damage" as const, applied: 5, hitPointsAfter: 30 };
  rejected(SWAPPED, [receipt], "value-binding-mismatch");
  verified("The attack deals 5; the target has 30 HP remaining.", [receipt]);
});
test("FIX: positive remaining HP permits survival regardless of applied damage", () => {
  verified(SURVIVAL, [{ kind: "combat-damage", applied: 20, hitPointsAfter: 10 }]);
});

for (const contradictory of [
  "success. The Investigation check failed.",
  "The Investigation check failed. success.",
  "No success. success.",
  "success. No success.",
  "success but failure and success.",
  "success success no success success.",
  "The Investigation check was unsuccessful.",
  "The Investigation check did not succeed.",
]) {
  test(`every outcome occurrence is checked: ${contradictory}`, () => {
    rejected(`Your Investigation check comes to 22 against DC 15: ${contradictory}`, [CHECK], "check-outcome-contradicted");
  });
}
test("failure does not become success through an unsuccessful substring", () => {
  const failure = { ...CHECK, total: 8, outcome: "failure" };
  verified("Your Investigation check comes to 8 against DC 15: failure.", [failure]);
  verified("The Investigation check was unsuccessful.", [failure]);
  rejected("The Investigation check failed. The Investigation check succeeded.", [failure], "check-outcome-contradicted");
});
test("each occurrence of a labelled value must match, even after a correct mention", () => {
  rejected("Investigation total 22 against DC 15. Investigation total 15 against DC 22.", [CHECK], "value-binding-mismatch");
  rejected("The attack deals 5. The attack deals 30.", [{ kind: "combat-damage", applied: 5, hitPointsAfter: 30 }], "value-binding-mismatch");
});
test("unlabelled or unfamiliar numbers never become binding proof", () => {
  const result = evaluateGroundedNarration("Investigation: 22 and 15, a triumphant result.", [CHECK]);
  assert.equal(result.verdict, "adjudication-required");
  assert.equal(result.ok, false);
  assert.throws(() => validateGroundedNarration("Investigation: 22 and 15, a triumphant result.", [CHECK]), GroundingAdjudicationRequired);
});

test("unrelated authorized clauses cannot exempt a fabricated consequence", () => {
  for (const separator of [". ", "; ", " and ", " but "]) {
    const result = evaluateGroundedNarration(`Your Investigation check comes to 22 against DC 15: success. The door is blue${separator}the lock clicks open.`, [CHECK], {
      authorizedConsequences: ["the door is blue"],
    });
    assert.equal(result.verdict, "rejected");
    if (result.verdict === "rejected") assert.ok(result.violations.some((violation) => violation.code === "fabricated-consequence"));
  }
});
test("authorization must cover the entire specific clause", () => {
  const options = { authorizedConsequences: ["the door is blue", "the lock clicks open"] };
  const good = evaluateGroundedNarration("The door is blue. The lock clicks open.", [], options);
  assert.equal(good.verdict, "verified");
  assert.equal(good.bindings.length, 2);
  for (const binding of good.bindings) assert.ok(good.facts.some((fact) => fact.receiptId === binding.receiptId));
  for (const text of ["The lock clicks open because the door is blue.", "The lock clicks open and you find the hidden key."]) {
    assert.equal(evaluateGroundedNarration(text, [], options).verdict, "rejected");
  }
});
test("authorization never overrides a contradictory receipt or forbidden fact", () => {
  assert.equal(evaluateGroundedNarration("The Investigation check failed.", [CHECK], { authorizedConsequences: ["The Investigation check failed"] }).verdict, "rejected");
  assert.equal(evaluateGroundedNarration("The door is blue.", [], { authorizedConsequences: ["the door is blue"], forbiddenConsequences: ["blue"] }).verdict, "rejected");
});

for (const statusAfter of ["active", "stable", "unconscious", "defeated"] as const) {
  test(`zero HP does not establish death when statusAfter is ${statusAfter}`, () => {
    const receipt = { kind: "combat-damage" as const, applied: 30, hitPointsAfter: 0, statusAfter };
    rejected("The target dies.", [receipt], "fabricated-outcome");
    verified(`The target is ${statusAfter}.`, [receipt]);
  });
}
test("missing status at zero HP requires adjudication with an actionable resolution", () => {
  const receipts = [{ kind: "combat-damage" as const, applied: 30, hitPointsAfter: 0 }];
  const result = evaluateGroundedNarration("The target dies.", receipts);
  assert.equal(result.verdict, "adjudication-required");
  assert.equal(result.ok, false);
  if (result.verdict === "adjudication-required") {
    assert.equal(result.adjudications[0]?.code, "missing-status-after");
    assert.match(result.adjudications[0]?.resolution ?? "", /statusAfter.*zero HP does not imply death/);
  }
  assert.throws(() => validateGroundedNarration("The target dies.", receipts), (error: unknown) =>
    error instanceof GroundingAdjudicationRequired && error.violations.every((violation) => violation.code === "adjudication-required"));
});
test("explicit dead status and authoritative target permit death", () => {
  verified("The blade lands for 30 and the goblin dies.", [{ kind: "combat-damage", target: "goblin", applied: 30, hitPointsAfter: 0, statusAfter: "dead" }]);
});
test("statusAfter overrides HP-based guesses", () => {
  const receipt = { kind: "combat-damage" as const, applied: 5, hitPointsAfter: 30, statusAfter: "dead" as const };
  verified("The target is dead.", [receipt]);
  rejected("The target survives at 30 HP.", [receipt], "fabricated-outcome");
  rejected("The target is defeated.", [receipt], "fabricated-outcome");
});
test("nested production combat status remains authoritative", () => {
  const receipt: GroundingReceipt = { kind: "combat", action: "attack", roundBefore: 1, roundAfter: 1,
    outcome: { kind: "damage", requested: 20, applied: 20, hitPointsBefore: 30, hitPointsAfter: 10, statusAfter: "active", damageType: "slashing", hit: true, critical: false } };
  verified("The attack deals 20 slashing damage. The target survives at 10 HP.", [receipt]);
  rejected("The target is dead.", [receipt], "fabricated-outcome");
  const facts = authoritativeFacts([receipt]);
  assert.equal(facts[0]?.status, "active");
  assert.equal(facts[0]?.values.find((value) => value.role === "hp-before")?.value, 30);
  rejected("The attack deals 20 bludgeoning damage.", [receipt], "qualifier-binding-mismatch");
});
test("mechanical qualifiers and actions are bound too", () => {
  rejected("Your Investigation check comes to 22 against a Hard DC of 15.", [{ ...CHECK, difficulty: "Medium" }], "qualifier-binding-mismatch");
  assert.equal(evaluateGroundedNarration("The attack deals 5 slashing damage.", [{ kind: "combat-damage", applied: 5, hitPointsAfter: 30 }]).verdict, "adjudication-required");
  rejected("The attack deals 5.", [{ kind: "combat", action: "shove", outcome: { kind: "damage", applied: 5, hitPointsAfter: 30 } }], "action-binding-mismatch");
});
test("before and after HP are distinct roles, with no inferred pre-damage HP", () => {
  const receipt = { kind: "combat-damage" as const, applied: 20, hitPointsBefore: 30, hitPointsAfter: 10 };
  verified("The target had 30 HP before the attack. The target has 10 HP remaining.", [receipt]);
  rejected("The target had 10 HP before the attack.", [receipt], "value-binding-mismatch");
  rejected("The target had 30 HP before the attack.", [{ kind: "combat-damage", applied: 20, hitPointsAfter: 10 }], "temporal-state-unbound");
  verified("The target had 10 HP after the attack.", [receipt]);
  rejected("The target had 30 HP after the attack.", [receipt], "value-binding-mismatch");
  rejected("The target survives at 30 HP before the attack.", [receipt], "temporal-state-unbound");
});
test("outcome shorthand cannot change the actor to the player", () => {
  rejected("you succeed the check", [{ ...CHECK, actor: "Aria" }], "actor-binding-mismatch");
});
test("missing hit metadata requires adjudication rather than inferring a miss from zero damage", () => {
  assert.equal(evaluateGroundedNarration("The attack misses.", [{ kind: "combat-damage", applied: 0, hitPointsAfter: 30 }]).verdict, "adjudication-required");
  verified("The attack hits.", [{ kind: "combat-damage", applied: 0, hitPointsAfter: 30, hit: true }]);
  rejected("The attack misses.", [{ kind: "combat-damage", applied: 0, hitPointsAfter: 30, hit: true }], "combat-outcome-contradicted");
});

const UNIMPLEMENTED: Array<{ receipt: GroundingReceipt; text: string }> = [
  { receipt: { kind: "travel", destination: "Harbor" }, text: "You arrive at Harbor." },
  { receipt: { kind: "inventory", itemLabel: "Potion", quantity: 1, action: "consume" }, text: "You consume 1 Potion." },
  { receipt: { kind: "rest", restName: "Long rest" }, text: "You take a Long rest." },
  { receipt: { kind: "progression", className: "Fighter", levelAfter: 2 }, text: "Your Fighter level is now 2." },
  { receipt: { kind: "mechanic", event: { type: "actor_dice_rolled", data: { total: 8 } } }, text: "The die rolls 8." },
  { receipt: { kind: "combat", action: "flee", outcome: { kind: "status", statusAfter: "fled" }, roundBefore: 1, roundAfter: 1 }, text: "You flee." },
  { receipt: { kind: "journey", destination: "Harbor", currentLocation: "Bridge", status: "interrupted", interruption: "Flood", legs: 1, elapsedMinutes: 20 }, text: "The journey is interrupted at Bridge." },
  { receipt: { kind: "power", powerName: "Light", targets: ["Lantern"], costs: [], stateDeltas: [], concentration: false }, text: "You cast Light on Lantern." },
  { receipt: { kind: "commerce", action: "buy", vendorLabel: "Trader", shopLabel: "Market", itemLabel: "Potion", quantity: 1, currencyLabel: "Gold", priceMinorUnits: 5, balanceBefore: 10, balanceAfter: 5 }, text: "You buy 1 Potion from Trader." },
  { receipt: { kind: "quest", questTitle: "Rescue", objectiveDescription: "Find captive", progressBefore: 0, progressAfter: 1, targetProgress: 1, objectiveCompleted: true, questCompleted: true }, text: "The Rescue quest is complete." },
  { receipt: { kind: "quest-lifecycle", action: "accept", questTitle: "Rescue", statusBefore: "available", statusAfter: "active", reward: null }, text: "You accept the Rescue quest." },
];
for (const { receipt, text } of UNIMPLEMENTED) {
  test(`unsupported ${receipt.kind} binding requires adjudication, never admission`, () => {
    const result = evaluateGroundedNarration(text, [receipt]);
    assert.equal(result.verdict, "adjudication-required", JSON.stringify(result));
    assert.equal(result.ok, false);
    if (result.verdict === "adjudication-required") {
      assert.ok(result.adjudications.some((issue) => issue.code === "unsupported-receipt-family"));
      assert.ok(result.adjudications.every((issue) => issue.resolution.length > 0));
    }
    assert.throws(() => validateGroundedNarration(text, [receipt]), GroundingAdjudicationRequired);
  });
}
test("new runtime receipt families fail closed too", () => {
  const receipt = { kind: "future-family" } as unknown as GroundingReceipt;
  assert.equal(evaluateGroundedNarration("Something has changed.", [receipt]).verdict, "adjudication-required");
});
test("unsupported mechanical claims without any receipt are rejected", () => {
  rejected("You arrive at Harbor.", [], "unbound-mechanical-claim");
  rejected("The target has 30 HP remaining.", [], "unbound-mechanical-claim");
});
test("empty narration and non-finite receipt values cannot verify", () => {
  rejected("", [CHECK], "empty-narration");
  rejected("The Investigation check succeeded.", [{ ...CHECK, total: Number.NaN }], "invalid-receipt-value");
});
test("unknown suffixes and extra claims are never swallowed by a valid prefix", () => {
  for (const suffix of ["and all your wounds heal", "because the secret door opens", "with 99 bonus experience", "and you teleport to Harbor"]) {
    assert.notEqual(evaluateGroundedNarration(`Your Investigation check comes to 22 against DC 15: success ${suffix}.`, [CHECK]).verdict, "verified");
  }
});
test("hidden receipt facts cannot be certified as public narration", () => {
  rejected("Your Investigation check comes to 22 against DC 15: success.", [{ ...CHECK, visibility: "hidden" }], "forbidden-fact-disclosed");
});

interface CorpusFact {
  actor: string;
  target: string;
  receipt: GroundingReceipt;
  text: string;
  valueToken: string;
  wrongValueToken: string;
  outcomeToken: string;
  oppositeOutcome: string;
  temporalToken: string;
  wrongTemporalToken: string;
}
const corpus: CorpusFact[] = [
  { actor: "Aria", target: "Sentinel", skill: "Investigation", total: 22, dc: 15, outcome: "success" },
  { actor: "Bryn", target: "Warden", skill: "Athletics", total: 8, dc: 18, outcome: "failure" },
  { actor: "Cora", target: "Scout", skill: "Perception", total: 27, dc: 19, outcome: "success" },
  { actor: "Dara", target: "Sentry", skill: "Stealth", total: 6, dc: 17, outcome: "failure" },
].map(({ actor, target, skill, total, dc, outcome }) => ({
  actor, target, receipt: { kind: "check", actor, target, skill, total, dc, outcome },
  text: `${actor}'s ${skill} check against ${target} comes to ${total} against DC ${dc}: ${outcome}.`,
  valueToken: `comes to ${total}`, wrongValueToken: `comes to ${dc}`,
  outcomeToken: outcome, oppositeOutcome: outcome === "success" ? "failure" : "success",
  temporalToken: "comes to", wrongTemporalToken: "will come to",
}));
for (const [index, sample] of [
  { actor: "Eira", target: "Goblin", applied: 5, hp: 30, status: "active" },
  { actor: "Fenn", target: "Ogre", applied: 30, hp: 0, status: "unconscious" },
  { actor: "Gale", target: "Troll", applied: 7, hp: 0, status: "stable" },
  { actor: "Hale", target: "Wraith", applied: 40, hp: 0, status: "dead" },
].entries()) {
  const statusAfter = sample.status as "active" | "unconscious" | "stable" | "dead";
  corpus.push({
    actor: sample.actor, target: sample.target,
    receipt: { kind: "combat-damage", receiptId: `damage-${index}`, actor: sample.actor, target: sample.target,
      applied: sample.applied, hitPointsBefore: sample.applied + sample.hp, hitPointsAfter: sample.hp, statusAfter, hit: true },
    text: `${sample.actor} deals ${sample.applied} damage to ${sample.target}; ${sample.target} has ${sample.hp} HP remaining; ${sample.target} is ${sample.status}; ${sample.actor}'s attack hits ${sample.target}.`,
    valueToken: `deals ${sample.applied}`, wrongValueToken: `deals ${sample.hp}`,
    outcomeToken: `is ${sample.status}`, oppositeOutcome: sample.status === "dead" ? "is active" : "is dead",
    temporalToken: "HP remaining", wrongTemporalToken: "HP before the attack",
  });
}

// Dependency-free property testing: cross each admitted corpus fact with every
// alternate corpus actor/target and each semantic mutation operator. The truth
// receipt is held fixed. These are generated counterexamples, not snapshots of
// the implementation's regexes. Values/outcomes/time are mutated independently.
test("PROPERTY: every admitted corpus fact rejects actor, target, value, outcome and temporal mutations", async (context) => {
  assert.ok(corpus.length >= 8);
  let mutationsChecked = 0;
  for (const [index, sample] of corpus.entries()) {
    await context.test(`fact ${index + 1}: ${sample.actor} -> ${sample.target}`, () => {
      verified(sample.text, [sample.receipt]);
      for (const alternate of corpus) {
        if (alternate === sample) continue;
        const originalValue = Number(sample.valueToken.match(/\d+$/)?.[0]);
        const alternateValue = authoritativeFacts([alternate.receipt])[0]?.values.find((value) => value.value !== originalValue)?.value;
        assert.notEqual(alternateValue, undefined);
        const mutations = {
          actor: sample.text.replaceAll(sample.actor, alternate.actor),
          target: sample.text.replaceAll(sample.target, alternate.target),
          value: sample.text.replace(sample.valueToken, sample.valueToken.replace(/\d+$/, String(alternateValue))),
          outcome: sample.text.replace(sample.outcomeToken, sample.oppositeOutcome),
          temporal: sample.text.replace(sample.temporalToken, sample.wrongTemporalToken),
        };
        for (const [axis, mutation] of Object.entries(mutations)) {
          assert.notEqual(mutation, sample.text, `${axis} mutation must change the narrated claim`);
          rejected(mutation, [sample.receipt]);
          mutationsChecked++;
        }
      }
      // Also swap the receipt's own roles (total/DC or damage/remaining HP).
      rejected(sample.text.replace(sample.valueToken, sample.wrongValueToken), [sample.receipt], "value-binding-mismatch");
    });
  }
  assert.equal(mutationsChecked, corpus.length * (corpus.length - 1) * 5);
});
test("multiple receipts cannot authorize actor/target/value swaps between facts", () => {
  const first = corpus[4]!;
  const second = corpus[5]!;
  verified(`${first.text} ${second.text}`, [first.receipt, second.receipt]);
  rejected(`${first.text.replaceAll(first.actor, second.actor)} ${second.text}`, [first.receipt, second.receipt], "target-binding-mismatch");
  rejected(`${first.text.replace(first.valueToken, second.valueToken)} ${second.text}`, [first.receipt, second.receipt], "value-binding-mismatch");
});
test("ambiguous receipts cannot be chosen merely because their numbers match", () => {
  const receipts: GroundingReceipt[] = [
    { kind: "combat-damage", actor: "Aria", target: "Goblin", applied: 5, hitPointsAfter: 30 },
    { kind: "combat-damage", actor: "Bryn", target: "Ogre", applied: 30, hitPointsAfter: 5 },
  ];
  assert.equal(evaluateGroundedNarration("The attack deals 30; the target has 5 HP remaining.", receipts).verdict, "adjudication-required");
});
