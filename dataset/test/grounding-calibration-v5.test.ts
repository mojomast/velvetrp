import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";

// Exact delivered v5 narration-tool arguments and their public oracle receipts.
// These are offline binding regressions, never rewritten live admissions.
function receipts(checkId: string, damageId: string, skill: string, dc: number, total: number, outcome: string, target: string, applied: number, after: number): GroundingReceipt[] {
  return [
    { kind: "check", receiptId: checkId, actor: "you", skill, dc, total, outcome, visibility: "public" },
    { kind: "combat", receiptId: damageId, actor: "the attacker", target, action: "attack", visibility: "public",
      outcome: { kind: "damage", applied, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: after, statusAfter: "stable" } },
  ];
}
const ailsa = receipts("98d3529d19", "87ad223382", "Deception", 15, 17, "success", "Ailsa", 5, 19);
const maren = receipts("1a23f7bfc5", "03e0d15490", "Deception", 18, 14, "failure", "Maren", 5, 19);
const survival = receipts("e425e93f62", "c74db8473c", "Survival", 18, 11, "failure", "Ailsa", 5, 19);
const thrale = receipts("b64564fa11", "fabcbf9767", "Survival", 14, 16, "success", "Thrale", 9, 15);
const actual = [
  { id: "unit-3d418f3b557fea20-a0", receipts: ailsa,
    text: "You attempt a Deception check against DC 15. You succeed, total 17. The attacker strikes Ailsa with an attack. It hits, dealing 5 slashing damage. Ailsa's hit points fall from 24 to 19. Ailsa is stable." },
  { id: "unit-3d418f3b557fea20-a1", receipts: ailsa,
    text: "You make a Deception check against DC 15. You succeed with a total of 17. The attacker attacks Ailsa. The attack hits and deals 5 slashing damage. Ailsa's hit points go from 24 to 19. Ailsa is stable." },
  { id: "unit-3d418f3b557fea20-a2", receipts: ailsa,
    text: "Actor: you. Check: Deception. DC: 15. Total: 17. Outcome: success. Actor: the attacker. Target: Ailsa. Attack: hit. Damage: 5 slashing. Ailsa hit points before: 24. Ailsa hit points after: 19. Ailsa status after: stable." },
  { id: "unit-d47e7981d01b925c-a0", receipts: maren, unknown: ["Two public entries", "No further settlement recorded"],
    text: "Two public entries. First: your Deception check, against difficulty 18. Total 14. Outcome: failure. Second: the attacker's attack, target Maren. Outcome: hit, 5 slashing damage, Maren's hit points 24 before, 19 after, status after: stable. No further settlement recorded." },
  { id: "unit-d47e7981d01b925c-a1", receipts: maren,
    text: "Your Deception check resolves against a DC of 18. Your total is 14. The check outcome is a failure. The attacker's attack targets Maren. The attack hits. The attack applies 5 slashing damage. Maren's hit points before the damage are 24. Maren's hit points after the damage are 19. Maren's status after the damage is stable." },
  { id: "unit-d47e7981d01b925c-a2", receipts: maren,
    text: "You make a Deception check against DC 18. Your total is 14. The outcome is a failure. The attacker makes an attack against Maren. The attack hits. The attack deals 5 slashing damage. Maren's hit points before the damage are 24. Maren's hit points after the damage are 19. Maren's status after the damage is stable." },
  { id: "unit-98ac79a4e925f1b6-a0", receipts: survival,
    text: "You made a Survival check against DC 18. You rolled a total of 11. The check failed. The attacker attacked Ailsa and hit. The attack dealt 5 slashing damage. Ailsa's hit points went from 24 to 19. Ailsa is stable." },
  { id: "unit-98ac79a4e925f1b6-a1", receipts: survival,
    text: "You — Survival check, DC 18, total 11, outcome failure. The attacker — attack against Ailsa, hit, 5 slashing damage, hit points 24 to 19, status stable." },
  { id: "unit-98ac79a4e925f1b6-a2", receipts: survival,
    text: "You make a Survival check against DC 18 and roll a total of 11. The check fails. The attacker attacks Ailsa and hits, dealing 5 slashing damage. Ailsa's hit points go from 24 to 19, and Ailsa is stable." },
  { id: "unit-9e6168afa185108d-a0", receipts: thrale, unknown: ["You read the ground"],
    text: "You read the ground. Survival, DC 14, total 16. Success. The attacker strikes Thrale. The blow lands, slashing, for 9 damage. Thrale goes from 24 hit points to 15. Thrale is stable." },
  { id: "unit-9e6168afa185108d-a1", receipts: thrale,
    text: "You make a Survival check against DC 14. The total is 16. The outcome is success. The attacker attacks Thrale. The attack hits. The damage applied is 9 slashing damage. Thrale's hit points go from 24 before to 15 after. Thrale's status after is stable." },
  { id: "unit-9e6168afa185108d-a2", receipts: thrale,
    text: "The check's actor is you; the check's skill is Survival; the check's DC is 14; the check's total is 16; the check's outcome is success. The attack's actor is the attacker; the attack's target is Thrale; the attack's hit is true; the attack's damage is 9 slashing; the target's hit points before is 24; the target's hit points after is 15; the target's status after is stable." },
];

function verify(text: string, source: readonly GroundingReceipt[], count?: number): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "verified", JSON.stringify({ text, result }));
  if (count !== undefined) assert.equal(result.bindingsChecked, count);
}
function reject(text: string, source: readonly GroundingReceipt[], code?: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  if (code && result.verdict === "rejected") assert.ok(result.violations.some((issue) => issue.code === code), JSON.stringify(result));
}
function adjudicate(text: string, source: readonly GroundingReceipt[], code?: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify({ text, result }));
  if (code && result.verdict === "adjudication-required") assert.ok(result.adjudications.some((issue) => issue.code === code));
}

for (const sample of actual) test(`v5 actual full delivered surface: ${sample.id}`, () => {
  const result = evaluateGroundedNarration(sample.text, sample.receipts);
  assert.equal(result.verdict, sample.unknown ? "adjudication-required" : "verified", JSON.stringify(result));
  if (sample.unknown && result.verdict === "adjudication-required") {
    const fragments = result.adjudications.filter((issue) => issue.detail !== "the entire clause is not covered by the binding grammar").map((issue) => issue.excerpt);
    assert.deepEqual(fragments, sample.unknown);
    // A separate hypothetical edit checks the mechanical facts without treating
    // the deleted prose as an authorized fact or changing the actual artifact.
    let mechanical = sample.text;
    for (const extra of sample.unknown) mechanical = mechanical.replace(`${extra}.`, "").trim();
    verify(mechanical, sample.receipts, 2);
  } else {
    assert.equal(result.bindingsChecked, 2);
    for (const role of ["dc", "total", "outcome", "hit", "damage-applied", "hp-before", "hp-after", "status-after"]) {
      assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), role);
    }
  }
});

function swap(text: string, first: number, second: number): string {
  return text.replace(new RegExp(`\\b(?:${first}|${second})\\b`, "g"), (value) => String(Number(value) === first ? second : first));
}
function oppositeOutcome(text: string): string {
  return text.replace(/\b(success|succeed|succeeds|succeeded|failure|fail|fails|failed)\b/gi, (value) => ({ success: "failure", succeed: "fail", succeeds: "fails", succeeded: "failed", failure: "success", fail: "succeed", fails: "succeeds", failed: "succeeded" })[value.toLowerCase()]!);
}
function oppositeHit(text: string): string {
  const natural = text.replace(/\band hit\b/i, "and missed");
  if (natural !== text) return natural;
  return text.replace(/\bhits\b|\bhit(?:(?:\s*:\s*|\s+is\s+|\s+)true)?\b/i, (value) => /true/.test(value) ? value.replace("true", "false") : /^hits$/i.test(value) ? "misses" : "miss");
}

test("v5's ten receipts-only surfaces reject 160 independent mutations", async (context) => {
  let count = 0;
  for (const sample of actual.filter((sample) => !sample.unknown)) await context.test(sample.id, () => {
    const check = sample.receipts[0]!;
    const damage = sample.receipts[1]!;
    if (check.kind !== "check" || damage.kind !== "combat" || damage.outcome.kind !== "damage") throw new Error("bad fixture");
    const mutations = {
      checkActor: sample.text.replace(/\byou\b/gi, "Neris").replace(/\byour\b/gi, "Neris's"),
      attacker: sample.text.replace(/\bthe attacker\b/gi, "the defender"),
      target: sample.text.replaceAll(damage.target!, "Oswin"),
      skill: sample.text.replace(new RegExp(`\\b${check.skill}\\b`, "gi"), "Arcana"),
      dc: sample.text.replace(/(\bDC(?:\s+(?:is|of))?\s*:?\s*)\d+/i, `$1${check.dc + 1}`),
      total: sample.text.replace(/(\btotal(?:\s+(?:is|of))?\s*:?\s*)\d+/i, `$1${check.total + 1}`),
      damage: sample.text.replace(new RegExp(`\\b${damage.outcome.applied}\\b`, "g"), String(damage.outcome.applied + 1)),
      hpBefore: sample.text.replace(/\b24\b/g, "23"),
      hpAfter: sample.text.replace(new RegExp(`\\b${damage.outcome.hitPointsAfter}\\b`, "g"), String(damage.outcome.hitPointsAfter - 1)),
      hpSwap: swap(sample.text, 24, damage.outcome.hitPointsAfter),
      status: sample.text.replace(/\bstable\b/g, "dead"),
      damageType: sample.text.replace(/\bslashing\b/g, "bludgeoning"),
      checkOutcome: oppositeOutcome(sample.text),
      hitOutcome: oppositeHit(sample.text),
      dcTotalSwap: swap(sample.text, check.dc, check.total),
      damageHpSwap: swap(sample.text, damage.outcome.applied, damage.outcome.hitPointsAfter),
    };
    for (const [axis, text] of Object.entries(mutations)) {
      assert.notEqual(text, sample.text, `${sample.id}: ${axis} must alter a stated fact`);
      reject(text, sample.receipts);
      count++;
    }
  });
  assert.equal(count, 160);
});

const toolReceipts: GroundingReceipt[] = [{ kind: "check", receiptId: "9c8657bf62", actor: "you", skill: "Deception", dc: 12, total: 21, outcome: "success", visibility: "public" }];
const toolNarrations = [
  "You attempt the deception. The roll is a success: Deception, DC 12, total 21.",
  "You work the deception. Deception against DC 12, total 21: success.",
  "You attempt the deception. Your Deception check comes in at a total of 21 against DC 12, and the result is a success.",
];
for (const [index, text] of toolNarrations.entries()) test(`v5 narration-submit a${index}: check action and outcome without fictional consequences`, () => {
  verify(text, toolReceipts, 1);
  for (const changed of [text.replace(/\byou\b/gi, "Neris").replace(/\byour\b/gi, "Neris's"), text.replace(/deception/gi, "Arcana"), swap(text, 12, 21), oppositeOutcome(text)]) reject(changed, toolReceipts);
  adjudicate(`${text} The lie holds.`, toolReceipts);
});

const checks: GroundingReceipt[] = [
  { kind: "check", receiptId: "arcana", actor: "Neris", skill: "Arcana", dc: 17, total: 20, outcome: "success" },
  { kind: "check", receiptId: "survival", actor: "Bryn", skill: "Survival", dc: 13, total: 8, outcome: "failure" },
];
const checkSequence = "Neris makes an Arcana check against DC 17. Neris succeeds with a total of 20. Bryn makes a Survival check against DC 13. The total is 8. The check fails.";
test("check declarations reset scope; continuations cannot redirect actors or borrow another check's numbers", () => {
  verify(checkSequence, checks, 2);
  verify(checkSequence, [...checks].reverse(), 2);
  const sameActor = checks.map((receipt) => ({ ...receipt, actor: "Neris" }));
  verify(checkSequence.replace("Bryn", "Neris"), sameActor, 2);
  reject(checkSequence.replace("Bryn", "Neris").replace("The total is 8", "The total is 20"), sameActor, "value-binding-mismatch");
  reject(checkSequence.replace("The total is 8", "The total is 20"), checks, "value-binding-mismatch");
  reject(checkSequence.replace("The check fails", "The check succeeds"), checks, "check-outcome-contradicted");
  reject(checkSequence.replace("The total is 8", "Neris's total is 20"), checks, "actor-binding-mismatch");
  reject("Neris makes an Arcana check against DC 17. Bryn succeeds with a total of 20.", checks, "actor-binding-mismatch");
  adjudicate("Neris succeeds with a total of 20.", checks, "unscoped-continuation");
});

const attacks: GroundingReceipt[] = [
  { kind: "combat-damage", receiptId: "thrale", actor: "Haug", target: "Thrale", applied: 9, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: 15, statusAfter: "stable" },
  { kind: "combat-damage", receiptId: "maren", actor: "Oswin", target: "Maren", applied: 5, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: 19, statusAfter: "stable" },
];
const attackSequence = "Haug strikes Thrale with an attack. It hits, dealing 9 slashing damage. Oswin strikes Maren with an attack. It hits, dealing 5 slashing damage.";
test("attack pronouns inherit only the current uniquely bound attack, never a target or unrelated family", () => {
  verify(attackSequence, attacks, 2);
  reject(attackSequence.replace("5 slashing", "9 slashing"), attacks, "value-binding-mismatch");
  reject(attackSequence.replace("Oswin strikes Maren", "Oswin strikes Thrale"), attacks, "target-binding-mismatch");
  for (const text of [
    "It hits.", "Haug strikes Thrale. Thrale is stable. It hits.",
    "Haug strikes Thrale. Thrale is stable, it hits.",
    "Haug strikes Thrale. The room waits. It hits.",
    "Haug strikes Thrale. Neris makes an Arcana check against DC 17. It hits.",
  ]) adjudicate(text, [...checks, ...attacks], "unscoped-continuation");
  adjudicate("It hits.", [attacks[0]!], "unscoped-continuation");
  adjudicate("Neris makes an Arcana check against DC 17. Haug strikes Thrale. The total is 20.", [...checks, ...attacks], "unscoped-continuation");
  verify("Haug strikes Thrale, it hits.", attacks, 1);
});

test("unknown and ambiguous claims clear continuation scope rather than supplying premises", () => {
  for (const middle of ["The hall waits.", "An inexplicable check changes everything."]) {
    adjudicate(`Neris makes an Arcana check against DC 17. ${middle} Neris succeeds with a total of 20.`, checks, "unscoped-continuation");
  }
  const ambiguous: GroundingReceipt[] = [...attacks, { ...attacks[0]!, receiptId: "another-thrale" }];
  adjudicate("Haug strikes Thrale. It hits.", ambiguous, "unscoped-continuation");
  for (const unknown of ["It seems to hit Thrale.", "Her hit points glitter at nineteen.", "The check somehow walks away successful.", "It failed.", "She succeeded.", "They will deal damage."]) {
    adjudicate(unknown, [...ailsa, ...attacks]);
  }
});

test("adjacent complete Actor records split structurally; duplicate or incomplete actors do not", () => {
  const text = actual[2]!.text;
  verify(text, [...ailsa].reverse(), 2);
  const combat = text.slice(text.indexOf("Actor: the attacker"));
  const check = text.slice(0, text.indexOf("Actor: the attacker"));
  verify(`${combat} ${check}`, ailsa, 2);
  reject(text.replace("Check: Deception.", "Actor: Oswin. Check: Deception."), ailsa, "actor-binding-mismatch");
  reject(text.replace("Outcome: success.", "Outcome: success. Actor: Oswin."), ailsa, "actor-binding-mismatch");
  reject(text.replace("Actor: the attacker.", "Actor: Oswin."), ailsa, "actor-binding-mismatch");
  const cited = `Receipt 98d3529d19. ${text}`;
  assert.notEqual(evaluateGroundedNarration(cited, ailsa).verdict, "verified", "a new uncited actor cannot escape an explicit citation");
  assert.notEqual(evaluateGroundedNarration(text.replace("Ailsa status after: stable.", ""), ailsa).verdict, "verified");
  const consecutiveChecks = "Actor: Neris. Skill: Arcana. DC: 17. Total: 20. Outcome: success. Actor: Bryn. Skill: Survival. DC: 13. Total: 8. Outcome: failure.";
  verify(consecutiveChecks, checks, 2);
  reject(consecutiveChecks.replace("DC: 13", "DC: 17"), checks, "value-binding-mismatch");
  reject(consecutiveChecks.replace("Actor: Bryn", "Actor: Neris"), checks, "actor-binding-mismatch");
});

test("ordinal/no-ID records cannot splice actor, target or HP subjects from other receipts", () => {
  const check = "First: Neris's Arcana check, against difficulty 17. Total 20. Outcome: success.";
  const damage = "Second: Haug's attack, target Thrale. Outcome: hit, 9 slashing damage, Thrale's hit points 24 before, 15 after, status after: stable.";
  verify(`${check} ${damage}`, [...checks, ...attacks], 2);
  verify(`${damage} ${check}`, [...attacks, ...checks].reverse(), 2);
  reject(damage.replace("Thrale's hit points", "Maren's hit points"), attacks, "target-binding-mismatch");
  reject(damage.replace("target Thrale", "target Maren"), attacks, "target-binding-mismatch");
  reject(check.replace("Total 20", "Total 8"), checks, "value-binding-mismatch");
  adjudicate(`${check} No settlement recorded. ${damage}`, [...checks, ...attacks]);
});

test("owned mechanical properties cannot exchange check, attack and target roles", () => {
  const text = actual[11]!.text;
  reject(text.replace("the attack's hit is true", "the attack's action is shove; the attack's hit is true"), thrale, "action-binding-mismatch");
  for (const [from, to] of [
    ["the target's hit points before", "the attack's hit points before"],
    ["the attack's damage", "the target's damage"],
    ["the attack's target", "the check's target"],
    ["the target's status after", "the check's status after"],
  ]) assert.notEqual(evaluateGroundedNarration(text.replace(from!, to!), thrale).verdict, "verified");
});

test("stable still needs explicit status and no complete mechanical paragraph authorizes extra prose", () => {
  for (const sample of actual.filter((sample) => !sample.unknown)) {
    for (const extra of ["Two public entries.", "You read the ground.", "No further settlement recorded.", "The crowd believes you.", "Ailsa stays on her feet."]) {
      assert.notEqual(evaluateGroundedNarration(`${sample.text} ${extra}`, sample.receipts).verdict, "verified");
    }
  }
  const damage: GroundingReceipt = { kind: "combat-damage", actor: "Haug", target: "Thrale", applied: 24, hitPointsBefore: 24, hitPointsAfter: 0, hit: true, damageType: "slashing" };
  for (const status of ["stable", "defeated", "dead"]) adjudicate(`Haug attacks Thrale. Thrale's status after the damage is ${status}.`, [damage], "missing-status-after");
});

test("canonical templates bind arbitrary fixture actors, compound skills and values without contextual shortcuts", () => {
  const subjects = [
    { actor: "Éloise", skill: "Animal Handling", dc: 13, total: 20, outcome: "success" },
    { actor: "Maren D'Or", skill: "Sleight of Hand", dc: 21, total: 7, outcome: "failure" },
  ];
  const source: GroundingReceipt[] = subjects.map((check, index) => ({ kind: "check", receiptId: `check-${index}`, ...check }));
  const checkText = subjects.map((check) => `${check.actor}'s ${check.skill} check comes to ${check.total} against DC ${check.dc}: ${check.outcome}.`).join(" ");
  verify(checkText, source, 2);
  const attack: GroundingReceipt = { kind: "combat-damage", receiptId: "combat", actor: "Maren D'Or", target: "Éloise", hit: true, applied: 4, damageType: "piercing", hitPointsBefore: 9, hitPointsAfter: 5, statusAfter: "stable" };
  const combatText = "Maren D'Or's attack hits Éloise. Maren D'Or deals 4 piercing damage to Éloise. Éloise had 9 HP before the attack. Éloise has 5 HP after the attack. Éloise is stable.";
  verify(`${checkText} ${combatText}`, [...source, attack], 3);
  reject(combatText.replace("4 piercing", "5 piercing"), [attack], "value-binding-mismatch");
});

test("v6 gate: target/status heads never authorize outgoing attack predicates", () => {
  const source = [attacks[0]!];
  for (const text of [
    "Haug attacks Thrale. Thrale is stable and deals 9 slashing damage.",
    "Haug attacks Thrale. Thrale is stable and hits.",
    "Thrale is stable and deals 9 slashing damage.",
    "Haug attacks Thrale. Thrale is stable. Deals 9 slashing damage.",
    "Haug attacks Thrale. Thrale is stable, it hits.",
  ]) adjudicate(text, source, "unscoped-continuation");
  reject("Haug attacks Thrale. Thrale is stable. Thrale deals 9 slashing damage.", source, "actor-binding-mismatch");
  reject("Thrale is stable and Thrale hits.", source, "actor-binding-mismatch");
});

const outgoing = ["deal", "deals", "dealt", "dealing", "apply", "applies", "applied", "applying"].map((verb) => `${verb} 9 slashing damage`);
outgoing.push("hit", "hits", "miss", "misses", "missed");
test("v6 target/outgoing matrix: 624 compound and standalone paths require an event referent", () => {
  const heads = [
    "Thrale is stable", "Thrale has 15 HP after the attack", "Thrale had 24 HP before the attack",
    "Thrale's hit points go from 24 to 15", "Thrale takes 9 damage", "Thrale takes 9 damage from Haug",
    "9 slashing damage is applied to Thrale", "9 slashing damage is applied to Thrale by Haug",
  ];
  let count = 0;
  for (const prefix of ["", "Haug attacks Thrale. "]) {
    for (const head of heads) for (const predicate of outgoing) for (const join of [" and ", ", ", ". "]) {
      adjudicate(`${prefix}${head}${join}${predicate}.`, [attacks[0]!], "unscoped-continuation");
      count++;
    }
  }
  assert.equal(count, 624);
});

test("v6 actorless actions cannot select a receipt from its numbers or bootstrap scope through a failed sibling", () => {
  for (const predicate of outgoing) adjudicate(`${predicate}.`, [attacks[0]!], "unscoped-continuation");
  const text = "Haug attacks Thrale. Thrale is stable, hits, dealing 9 slashing damage.";
  const result = evaluateGroundedNarration(text, [attacks[0]!]);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify(result));
  if (result.verdict === "adjudication-required") assert.equal(result.adjudications.filter((issue) => issue.code === "unscoped-continuation").length, 2);
  for (const reset of ["Thrale is stable", "The hall waits", "Neris makes an Arcana check against DC 17"]) {
    adjudicate(`Haug attacks Thrale. ${reset}. Hits, dealing 9 slashing damage.`, [...checks, ...attacks], "unscoped-continuation");
  }
  const ambiguous = [attacks[0]!, { ...attacks[0]!, receiptId: "duplicate-event" }];
  adjudicate("Haug attacks Thrale. Deals 9 slashing damage.", ambiguous, "unscoped-continuation");
  verify("Haug attacks Thrale. Thrale is stable. Haug attacks Thrale and deals 9 slashing damage.", attacks, 1);
  const record = "Actor: Haug. Target: Thrale. Action: attack. Hit: true. Damage: 9 slashing. Hit points before: 24. Hit points after: 15. Status: stable.";
  for (const predicate of outgoing) adjudicate(`${record} ${predicate}.`, [attacks[0]!], "unscoped-continuation");
});

test("v6 established event predicates verify and their damage/type/hit mutations reject", () => {
  for (const text of [
    "Haug attacks Thrale and deals 9 slashing damage.",
    "Haug attacks Thrale. The attack hits and deals 9 slashing damage.",
    "Haug attacks Thrale. It hits, dealing 9 slashing damage.",
    "Haug attacks Thrale, hits, dealing 9 slashing damage.",
    "Haug deals 9 slashing damage to Thrale and hits.",
  ]) {
    verify(text, attacks, 1);
    reject(text.replace("9 slashing", "8 slashing"), attacks, "value-binding-mismatch");
    reject(text.replace("slashing", "piercing"), attacks, "qualifier-binding-mismatch");
    if (/\bhits\b/.test(text)) reject(text.replace(/\bhits\b/, "misses"), attacks, "combat-outcome-contradicted");
  }
  for (const verb of ["deal", "deals", "dealt", "dealing", "apply", "applies", "applied", "applying"]) {
    for (const join of [" and ", ", ", ". "]) {
      const text = `Haug attacks Thrale${join}${verb} 9 slashing damage.`;
      verify(text, attacks, 1);
      reject(text.replace("9 slashing", "8 slashing"), attacks, "value-binding-mismatch");
    }
  }
  const miss: GroundingReceipt = { kind: "combat-damage", receiptId: "miss", actor: "Haug", target: "Thrale", applied: 0, damageType: "slashing", hit: false, hitPointsBefore: 24, hitPointsAfter: 24, statusAfter: "stable" };
  for (const verb of ["miss", "misses", "missed"]) {
    const text = `Haug attacks Thrale and ${verb}, dealing 0 slashing damage.`;
    verify(text, [miss], 1);
    reject(text.replace(verb, "hits"), [miss], "combat-outcome-contradicted");
    reject(text.replace("0 slashing", "9 slashing"), [miss], "value-binding-mismatch");
    adjudicate(`Haug attacks Thrale. Thrale is stable and ${verb}, dealing 0 slashing damage.`, [miss], "unscoped-continuation");
  }
});

// Public oracle receipts reproduced with the provider-free preregistered v6 plan:
// seed calibration-grounding-2026-10-13-6, 13 units, K=1, grounded/tool families;
// digest d07529276a23a5f1be1e3bea3a04c34226adfb7dfc4f995e19b117865fdf6b46.
// These guide-shaped test narrations are constructed, not delivered/live outputs.
const preregisteredV6 = [
  { id: "unit-8c28b0ce238d1727", receipts: receipts("bd1e8dbebe", "cd11fab0f8", "Perception", 15, 11, "failure", "Haug", 5, 19) },
  { id: "unit-45f400d219056232", receipts: receipts("bbb94f1315", "7c0508e5aa", "Deception", 15, 15, "success", "Maren", 10, 14) },
  { id: "unit-3296949d536b2210", receipts: receipts("afa9101da8", "d035118cb4", "Insight", 12, 10, "failure", "Maren", 10, 14) },
  { id: "unit-98bf7c802f569a5e", receipts: receipts("8e4b68fa75", "48141d7e60", "Survival", 15, 9, "failure", "Sable", 6, 18) },
  { id: "unit-740bf9a7f9ab06ed", receipts: receipts("ecd0d7074c", "57f1022544", "Perception", 14, 19, "success", "Ailsa", 4, 20) },
  { id: "unit-6b1501d2ec6a7a77", receipts: receipts("9e3bed0f75", "8be0a231fb", "Insight", 12, 15, "success", "Oswin", 4, 20) },
];
for (const sample of preregisteredV6) test(`v6 complete public oracle and wrong-actor continuation matrix: ${sample.id}`, () => {
  const [check, combat] = sample.receipts;
  if (check?.kind !== "check" || combat?.kind !== "combat" || combat.outcome.kind !== "damage") throw new Error("bad fixture");
  const damage = combat.outcome;
  const target = combat.target!;
  const prefix = `Your ${check.skill} check comes to ${check.total} against DC ${check.dc}: ${check.outcome}. ${combat.actor} attacks ${target}. The attack hits. ${combat.actor} deals ${damage.applied} slashing damage to ${target}. ${target}'s hit points go from 24 to ${damage.hitPointsAfter}.`;
  const text = `${prefix} ${target} is stable.`;
  const result = evaluateGroundedNarration(text, sample.receipts);
  assert.equal(result.verdict, "verified", JSON.stringify(result));
  assert.equal(result.bindingsChecked, 2);
  for (const [receiptId, roles] of [
    [check.receiptId, ["dc", "total", "outcome"]],
    [combat.receiptId, ["hit", "damage-applied", "hp-before", "hp-after", "status-after"]],
  ] as const) for (const role of roles) assert.ok(result.bindings.some((binding) => binding.receiptId === receiptId && binding.roles.includes(role)), `${receiptId}: ${role}`);

  for (const predicate of [`deals ${damage.applied} slashing damage`, `applies ${damage.applied} slashing damage`, `dealing ${damage.applied} slashing damage`, "hits", "misses"]) {
    // Every guide field is already present before the wrong outgoing predicate.
    for (const join of [" and ", ", ", ". "]) {
      adjudicate(`${prefix} ${target} is stable${join}${predicate}.`, sample.receipts, "unscoped-continuation");
    }
    adjudicate(`${text} ${target} has ${damage.hitPointsAfter} HP after the attack and ${predicate}.`, sample.receipts, "unscoped-continuation");
  }
  reject(`${text} ${target} deals ${damage.applied} slashing damage.`, sample.receipts, "actor-binding-mismatch");
  reject(text.replace(`deals ${damage.applied}`, `deals ${damage.applied + 1}`), sample.receipts, "value-binding-mismatch");
  reject(text.replace("The attack hits", "The attack misses"), sample.receipts, "combat-outcome-contradicted");
  reject(text.replace("slashing", "piercing"), sample.receipts, "qualifier-binding-mismatch");
  reject(text.replace(`DC ${check.dc}`, `DC ${check.dc + 1}`), sample.receipts, "value-binding-mismatch");
  reject(text.replace(`to ${check.total} against`, `to ${check.total + 1} against`), sample.receipts, "value-binding-mismatch");
  reject(oppositeOutcome(text), sample.receipts, "check-outcome-contradicted");
  reject(text.replace("from 24", "from 23"), sample.receipts, "value-binding-mismatch");
  reject(text.replace(`to ${damage.hitPointsAfter}.`, `to ${damage.hitPointsAfter - 1}.`), sample.receipts, "value-binding-mismatch");
  reject(text.replace("stable", "dead"), sample.receipts, "fabricated-outcome");

  const record = `Actor: ${combat.actor}. Target: ${target}. Action: attack. Hit: true. Damage: ${damage.applied} slashing. Hit points before: 24. Hit points after: ${damage.hitPointsAfter}. Status: stable.`;
  for (const heading of ["", "Second: ", `Receipt ${combat.receiptId}. `]) {
    verify(`${heading}${record}`, sample.receipts, 1);
    adjudicate(`${heading}${record} ${target} is stable and deals ${damage.applied} slashing damage.`, sample.receipts, "unscoped-continuation");
    adjudicate(`${heading}${record} Hits, dealing ${damage.applied} slashing damage.`, sample.receipts, "unscoped-continuation");
  }
});

test("v6 preregistered narration-submit retains check coverage without authorizing an outgoing attack", () => {
  const source: GroundingReceipt[] = [{ kind: "check", receiptId: "39d7114bc2", actor: "you", skill: "Deception", dc: 14, total: 15, outcome: "success", visibility: "public" }];
  const text = "Your Deception check comes to 15 against DC 14: success.";
  verify(text, source, 1);
  adjudicate(`${text} Deals 5 slashing damage.`, source, "unscoped-continuation");
  for (const changed of [text.replace("Your", "Haug's"), text.replace("15", "16"), text.replace("14", "13"), oppositeOutcome(text)]) reject(changed, source);
});
