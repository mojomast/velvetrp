import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";

// Verbatim delivered surfaces and public receipt values from the independent
// 2026-10-13-v2 audit (source revision bee9893). These are offline regressions,
// not retrospective admissions. No generated answer is an authorized fact.
function receipts(checkId: string, damageId: string, skill: string, dc: number, total: number, target: string, applied: number): GroundingReceipt[] {
  return [
    { kind: "check", receiptId: checkId, actor: "you", skill, dc, total, outcome: "success", visibility: "public" },
    { kind: "combat", receiptId: damageId, actor: "the attacker", target, action: "attack", visibility: "public",
      outcome: { kind: "damage", applied, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: 24 - applied, statusAfter: "stable" } },
  ];
}
const survival = receipts("38b56187eb", "2ce4b03c11", "Survival", 14, 14, "Corbin", 11);
const sable = receipts("7f6f823019", "aab8c7aecb", "Deception", 10, 21, "Sable", 8);
const ivet = receipts("7e05b02cd2", "1a48c99b6b", "Perception", 12, 14, "Ivet", 11);
const corbin = receipts("515e25e820", "ff61a2d875", "Deception", 18, 21, "Corbin", 11);
const faithful = [
  { id: "unit-600e6263ab25efb8-a1", receipts: survival,
    text: "You — Survival check, DC 14, total 14: success.\n\nThe attacker hits Corbin. Damage: 11 slashing. Corbin's hit points: 24 before, 13 after. Corbin is stable." },
  { id: "unit-733097c9f4cb27aa-a0", receipts: sable,
    text: "You attempt the deception. The check resolves against DC 10 with a total of 21: success.\n\nThe attacker attacks Sable. The attack hits, dealing 8 slashing damage. Sable's hit points go from 24 to 16. Sable's status after the attack is stable." },
  { id: "unit-733097c9f4cb27aa-a1", receipts: sable,
    text: "You: Deception check, DC 10, total 21, outcome success. The attacker: attack against target Sable, hit, 8 slashing damage. Sable: hit points before 24, hit points after 16, status after stable." },
  { id: "unit-733097c9f4cb27aa-a2", receipts: sable,
    text: "Receipt 7f6f823019: actor you; kind check; skill Deception; dc 10; total 21; outcome success; visibility public.\n\nReceipt aab8c7aecb: actor the attacker; kind combat; action attack; target Sable; outcome hit true; damageType slashing; damage applied 8; hitPointsBefore 24; hitPointsAfter 16; statusAfter stable; visibility public." },
  { id: "unit-c2424c52018b74e7-a1", receipts: ivet,
    text: "You are the actor of a Perception check against DC 12. The outcome is success, total 14, receipt 7e05b02cd2.\n\nThe attacker is the actor of an attack against the target Ivet. The outcome is a hit. Damage applied is 11, damage type slashing. Ivet's hit points before are 24; Ivet's hit points after are 13; Ivet's status after is stable. Receipt 1a48c99b6b." },
  { id: "unit-c2424c52018b74e7-a2", receipts: ivet,
    text: "receiptId: 7e05b02cd2 — kind: check. actor: you. skill: Perception. dc: 12. total: 14. outcome: success. visibility: public.\n\nreceiptId: 1a48c99b6b — kind: combat. action: attack. actor: the attacker. target: Ivet. hit: true. applied: 11. damageType: slashing. hitPointsBefore: 24. hitPointsAfter: 13. statusAfter: stable." },
  { id: "unit-a8e6c1e088767521-a1", receipts: corbin,
    text: "You made a Deception check: total 21 against DC 18, outcome success. The attacker made an attack against Corbin: hit true, 11 slashing damage applied, Corbin's hit points 24 before and 13 after, status after stable." },
  { id: "unit-a8e6c1e088767521-a2", receipts: corbin,
    text: "You made a Deception check. The total was 21 against DC 18. The outcome was success.\n\nThe attacker made an attack against Corbin. The attack hit. 11 slashing damage was applied to Corbin. Corbin's hit points went from 24 before to 13 after. Corbin's status after was stable." },
];

for (const sample of faithful) {
  test(`calibration faithful full narration binds both receipts: ${sample.id}`, () => {
    const result = evaluateGroundedNarration(sample.text, sample.receipts);
    assert.equal(result.verdict, "verified", JSON.stringify(result));
    assert.equal(result.bindingsChecked, 2);
    const roles = new Set(result.bindings.flatMap((binding) => binding.roles));
    for (const role of ["dc", "total", "outcome", "damage-applied", "hp-before", "hp-after", "status-after", "hit"]) assert.ok(roles.has(role), role);
    assert.deepEqual(new Set(result.bindings.map((binding) => binding.receiptId)), new Set(sample.receipts.map((receipt) => receipt.receiptId)));
  });
}

function reject(text: string, source: readonly GroundingReceipt[], code?: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  if (code && result.verdict === "rejected") assert.ok(result.violations.some((issue) => issue.code === code), JSON.stringify(result));
}
function swap(text: string, first: number, second: number): string {
  return text.replace(new RegExp(`\\b(?:${first}|${second})\\b`, "g"), (value) => String(Number(value) === first ? second : first));
}

test("all eight actual faithful surfaces reject role, value, polarity and qualifier mutations", async (context) => {
  let mutations = 0;
  for (const sample of faithful) await context.test(sample.id, () => {
    const check = sample.receipts[0]!;
    const damage = sample.receipts[1]!;
    assert.equal(check.kind, "check");
    assert.equal(damage.kind, "combat");
    if (check.kind !== "check" || damage.kind !== "combat" || damage.outcome.kind !== "damage") throw new Error("bad fixture");
    const changed = [
      sample.text.replace(/\byou\b/i, "Maren"),
      sample.text.replace(/the attacker/gi, "the defender"),
      sample.text.replaceAll(damage.target!, "Oswin"),
      sample.text.replace(/(\bdc\s*:?\s*)\d+/i, `$1${check.dc + 1}`),
      sample.text.replace(/(\btotal(?: of| was| is)?\s*:?\s*)\d+/i, `$1${check.total + 1}`),
      sample.text.replace(new RegExp(`\\b${damage.outcome.applied}\\b`), String(damage.outcome.applied + 1)),
      swap(sample.text, 24, damage.outcome.hitPointsAfter),
      swap(sample.text, damage.outcome.applied, damage.outcome.hitPointsAfter),
      sample.text.replace(/\bsuccess\b/i, "failure"),
      sample.text.replace(/\battack hit\b|\bhit true\b|\bhit: true\b|\bhits\b|\bhit\b/i, (hit) => /true/.test(hit) ? hit.replace("true", "false") : hit === "attack hit" ? "attack missed" : hit === "hits" ? "misses" : "miss"),
      sample.text.replace(/\bstable\b/g, "dead"),
      sample.text.replace(/\bslashing\b/g, "bludgeoning"),
      ...(check.dc === check.total ? [] : [swap(sample.text, check.dc, check.total)]),
    ];
    for (const mutation of changed) {
      assert.notEqual(mutation, sample.text, "a mutation must alter a delivered fact");
      reject(mutation, sample.receipts);
      mutations++;
    }
  });
  assert.equal(mutations, 103); // 12 axes x 8, plus 7 non-degenerate DC/total swaps.
});

const extrapolated = [
  { id: "unit-600e6263ab25efb8-a0", receipts: survival,
    text: "You read the ground and the signs along it — Survival, and it holds. Whatever you were looking for, the Row gave it up.\n\nFurther down, the attacker's blade goes in on Corbin. Slashing. Corbin was at 24; the hit takes 11, and he drops to 13. He stays on his feet — stable.",
    unsupported: /Row gave it up|stays on his feet/ },
  { id: "unit-c2424c52018b74e7-a0", receipts: ivet,
    text: "You—the player—read the pier: Perception, success, total 14 against DC 12. Whatever is out there, you caught it.\n\nThe attacker strikes Ivet. Slashing damage, 11 applied, a hit. Ivet goes from 24 hit points to 13, and comes out of it stable.",
    unsupported: /you caught it/ },
  { id: "unit-a8e6c1e088767521-a0", receipts: corbin,
    text: "You hold the lie steady, and it holds — the Deception check comes off clean at 21 against a DC of 18. Whatever the room heard, it believed.\n\nThen the attacker lands one: a slashing hit on Corbin, 11 damage. Corbin drops from 24 hit points to 13, and comes out of it stable.",
    unsupported: /it believed/ },
];
for (const sample of extrapolated) test(`unsupported actual consequence stays visible: ${sample.id}`, () => {
  const result = evaluateGroundedNarration(sample.text, sample.receipts);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify(result));
  if (result.verdict === "adjudication-required") assert.ok(result.adjudications.some((issue) => sample.unsupported.test(issue.excerpt)));
});

test("the ninth faithful surface has grounding only; its missing tool is the transport gate's responsibility", () => {
  const text = "Receipt 38b56187eb — actor: you; skill: Survival; check DC: 14; total: 14; outcome: success.\n\nReceipt 2ce4b03c11 — actor: the attacker; target: Corbin; action: attack; outcome: hit; damage: 11 slashing; hitPointsBefore for target Corbin: 24; hitPointsAfter for target Corbin: 13; status after: stable.";
  assert.equal(evaluateGroundedNarration(text, survival).verdict, "verified");
  reject(text.replace("hitPointsBefore for target Corbin", "hitPointsBefore for target Oswin"), survival, "target-binding-mismatch");
});

test("new grammar generalizes to new names, values, punctuation and a failed check", () => {
  const source: GroundingReceipt[] = [
    { kind: "check", actor: "Neris", skill: "Arcana", total: 7, dc: 19, outcome: "failure" },
    { kind: "combat-damage", actor: "Haug", target: "Éloise", hit: true, applied: 3, damageType: "piercing", hitPointsBefore: 9, hitPointsAfter: 6, statusAfter: "unconscious" },
  ];
  const text = "Neris: Arcana check; DC 19; total 7; outcome failure. Haug: attack against target Éloise; hit; 3 piercing damage. Éloise’s hit points: 9 before, 6 after. Éloise’s status after the attack was unconscious.";
  assert.equal(evaluateGroundedNarration(text, source).verdict, "verified");
  assert.equal(evaluateGroundedNarration("3 piercing damage was applied to Éloise by Haug.", source).verdict, "verified");
  reject("3 piercing damage was applied to Haug by Éloise.", source, "actor-binding-mismatch");
});

test("compound role labels and receipt IDs cannot splice two otherwise valid facts", () => {
  const source: GroundingReceipt[] = [
    ...sable,
    { kind: "combat-damage", receiptId: "other", actor: "Maren", target: "Corbin", applied: 8, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: 16, statusAfter: "stable" },
  ];
  reject("The attacker: attack against target Sable, hit, 8 slashing damage, Corbin's hit points 24 before and 16 after.", source, "target-binding-mismatch");
  reject(faithful[3]!.text.replace("Receipt aab8c7aecb", "Receipt other"), source, "actor-binding-mismatch");
  reject(faithful[3]!.text.replace("target Sable", "target Corbin"), source, "target-binding-mismatch");
  reject(faithful[3]!.text.replace("Receipt aab8c7aecb", "Receipt missing"), source, "receipt-binding-mismatch");
  reject(faithful[4]!.text.replace("Receipt 1a48c99b6b", "Receipt 7e05b02cd2"), ivet, "receipt-binding-mismatch");
});

test("a duplicate wrong field is checked even after its correct occurrence", () => {
  reject(faithful[3]!.text.replace("total 21;", "total 21; total 10;"), sable, "value-binding-mismatch");
  reject(faithful[3]!.text.replace("target Sable;", "target Sable; target Corbin;"), sable, "target-binding-mismatch");
  reject(faithful[3]!.text.replace("outcome success;", "outcome success; outcome failure;"), sable, "check-outcome-contradicted");
  reject(faithful[3]!.text.replace("statusAfter stable;", "statusAfter stable; statusAfter dead;"), sable, "fabricated-outcome");
});

test("unknown field/value text and omitted required associations never certify a correct fragment", () => {
  for (const text of [
    faithful[3]!.text.replace("visibility public.", "visibility public; the crowd believes you."),
    faithful[3]!.text.replace("statusAfter stable", "statusAfter stable because the wound is healed"),
    faithful[3]!.text.replace("target Sable; ", ""),
    faithful[3]!.text.replace("actor you; ", ""),
    faithful[3]!.text.replace("hitPointsBefore 24; ", ""),
    faithful[3]!.text.replace("kind combat", "kind teleportation"),
  ]) assert.notEqual(evaluateGroundedNarration(text, sable).verdict, "verified", text);
  reject(faithful[3]!.text.replace("total 21", "total 10; the crowd believes you"), sable, "value-binding-mismatch");
  reject(faithful[3]!.text.replace("target Sable", "target Corbin; the lock clicks open"), sable, "target-binding-mismatch");
});

test("correct new forms never hide unknown connective or consequence clauses", () => {
  for (const sample of faithful) for (const suffix of [
    "Whatever is out there, you caught it.", "Whatever the room heard, it believed.", "He stays on his feet — stable.",
    "The lock clicks open.", "The target is stable because all wounds are healed.",
  ]) {
    const text = `${sample.text.slice(0, -1)}; ${suffix}`;
    assert.notEqual(evaluateGroundedNarration(text, sample.receipts).verdict, "verified", text);
  }
});

for (const text of [
  "Sable's hit points.", "Sable's hit points wander around 16.", "Sable's status after the attack somehow is stable.",
  "The hit takes 8.", "A slashing hit on Sable.", "Sable is stable because the crowd believes you.",
]) test(`unknown grammar is adjudication, not an invented role contradiction: ${text}`, () => {
  assert.equal(evaluateGroundedNarration(text, sable).verdict, "adjudication-required");
});

test("stable, defeated and death always need the receipt's own statusAfter, including at zero HP", () => {
  for (const hp of [0, 16]) for (const status of ["stable", "defeated", "dead"] as const) {
    const source: GroundingReceipt = { kind: "combat-damage", target: "Sable", applied: 24 - hp, hitPointsBefore: 24, hitPointsAfter: hp };
    const text = `Sable's status after the attack is ${status}.`;
    const result = evaluateGroundedNarration(text, [source]);
    assert.notEqual(result.verdict, "verified");
    if (hp === 0 || status !== "dead") assert.equal(result.verdict, "adjudication-required");
    assert.equal(evaluateGroundedNarration(text, [{ ...source, statusAfter: status }]).verdict, "verified");
    reject(text, [{ ...source, statusAfter: status === "dead" ? "stable" : "dead" }], "fabricated-outcome");
  }
});

test("passive damage, possessive HP, and compact fields retain receipt metadata requirements", () => {
  const damage: GroundingReceipt = { kind: "combat-damage", actor: "the attacker", target: "Sable", applied: 8, hitPointsAfter: 16 };
  assert.equal(evaluateGroundedNarration("8 slashing damage was applied to Sable.", [damage]).verdict, "adjudication-required");
  reject("Sable's hit points go from 24 to 16.", [damage], "temporal-state-unbound");
  assert.equal(evaluateGroundedNarration("The attacker: attack against target Sable, hit.", [damage]).verdict, "adjudication-required");
  reject(faithful[3]!.text.replace("visibility public", "visibility private"), sable, "visibility-binding-mismatch");
  reject(faithful[3]!.text, sable.map((receipt) => ({ ...receipt, visibility: "hidden" })), "forbidden-fact-disclosed");
});
