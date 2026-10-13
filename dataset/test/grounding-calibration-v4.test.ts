import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";

// Verbatim surfaces and public oracle receipts from calibration-2026-10-13-v4's
// independent-grounding-audit.json. These offline expectations do not rewrite
// the historical refusals, or certify transport for plain assistant messages.
function receipts(checkId: string, damageId: string, skill: string, dc: number, total: number, outcome: string, target: string, applied: number, hpAfter: number): GroundingReceipt[] {
  return [
    { kind: "check", receiptId: checkId, actor: "you", skill, dc, total, outcome, visibility: "public" },
    { kind: "combat", receiptId: damageId, actor: "the attacker", target, action: "attack", visibility: "public",
      outcome: { kind: "damage", applied, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: hpAfter, statusAfter: "stable" } },
  ];
}
const ailsa = receipts("98d3529d19", "87ad223382", "Deception", 15, 17, "success", "Ailsa", 5, 19);
const maren = receipts("1a23f7bfc5", "03e0d15490", "Deception", 18, 14, "failure", "Maren", 5, 19);
const survival = receipts("e425e93f62", "c74db8473c", "Survival", 18, 11, "failure", "Ailsa", 5, 19);
const thrale = receipts("b64564fa11", "fabcbf9767", "Survival", 14, 16, "success", "Thrale", 9, 15);
const actual = [
  { id: "unit-3d418f3b557fea20-a0", receipts: ailsa, tool: false,
    text: "**Deception — you.** DC 15, total 17. Success.\n\n**Attack — the attacker → Ailsa.** Hit. 5 slashing damage. Ailsa: 24 HP → 19 HP. Status after: stable." },
  { id: "unit-3d418f3b557fea20-a1", receipts: ailsa, tool: true,
    text: "**Deception — you.** DC 15. Total 17. Success.\n\n**Attack — the attacker → Ailsa.** Hit. 5 slashing damage. Ailsa: 24 HP → 19 HP. Status after: stable." },
  { id: "unit-3d418f3b557fea20-a2", receipts: ailsa, tool: false,
    text: "You succeeded on the Deception check against DC 15, with a total of 17.\n\nThe attacker attacked Ailsa and hit, dealing 5 slashing damage. Ailsa's hit points went from 24 to 19, and Ailsa is stable." },
  { id: "unit-d47e7981d01b925c-a0", receipts: maren, tool: true, adjudication: "Two entries are on the record",
    text: "Two entries are on the record.\n\nFirst. Actor: you. Skill: Deception. Difficulty 18. Total 14. Outcome: failure.\n\nSecond. Actor: the attacker. Target: Maren. Attack roll: hit. Damage: 5, slashing. Maren's hit points: 24 before, 19 after. Status after: stable." },
  { id: "unit-d47e7981d01b925c-a1", receipts: maren, tool: true,
    text: "Receipt one. Actor: you. Skill: Deception. Difficulty: 18. Total: 14. Outcome: failure.\n\nReceipt two. Actor: the attacker. Target: Maren. Attack roll: hit. Damage: 5 slashing. Maren's hit points: 24 before, 19 after. Maren's status after: stable." },
  { id: "unit-d47e7981d01b925c-a2", receipts: maren, tool: false,
    text: "The check receipt 1a23f7bfc5 records actor you, skill Deception, difficulty 18, total 14, outcome failure.\n\nThe combat receipt 03e0d15490 records actor the attacker and target Maren, with attack hit true, applied 5 slashing damage, hit points before 24, hit points after 19, target status after stable." },
  { id: "unit-98ac79a4e925f1b6-a0", receipts: survival, tool: false,
    text: "**Receipt e425e93f62 — check.** Actor: you. Skill: Survival. DC 18. Total: 11. Outcome: failure.\n\n**Receipt c74db8473c — combat.** Actor: the attacker. Target: Ailsa. Attack: hit. Damage: 5 slashing. Hit points: 24 before, 19 after. Status after: stable." },
  { id: "unit-98ac79a4e925f1b6-a1", receipts: survival, tool: true,
    text: "**Receipt e425e93f62 — check.** Actor: you. Skill: Survival. DC 18. Total: 11. Outcome: failure.\n\n**Receipt c74db8473c — combat.** Actor: the attacker. Target: Ailsa. Attack: hit. Damage: 5 slashing. Hit points: 24 before, 19 after. Status after: stable." },
  { id: "unit-98ac79a4e925f1b6-a2", receipts: survival, tool: true,
    text: "Receipt e425e93f62. Actor: you. Skill: Survival. DC: 18. Total: 11. Outcome: failure. Visibility: public.\n\nReceipt c74db8473c. Actor: the attacker. Target: Ailsa. Action: attack. Hit: true. Damage: 5 slashing. Hit points before: 24. Hit points after: 19. Status after: stable. Visibility: public." },
  { id: "unit-9e6168afa185108d-a0", receipts: thrale, tool: false,
    text: "**Check — survival.** You. Survival, DC 14. Total 16. Success.\n\n**Attack — damage.** The attacker attacks Thrale. Hit. 9 slashing. Thrale: 24 hit points before, 15 after. Status: stable." },
  { id: "unit-9e6168afa185108d-a1", receipts: thrale, tool: true,
    text: "**Check — Survival.** Actor: you. Skill: Survival. DC 14. Total 16. Outcome: success.\n\n**Attack — damage.** Actor: the attacker. Target: Thrale. Hit. Damage applied: 9 slashing. Thrale's hit points: 24 before, 15 after. Status after: stable." },
  { id: "unit-9e6168afa185108d-a2", receipts: thrale, tool: false,
    text: "You succeeded on a Survival check against DC 14 with a total of 16.\n\nThe attacker hit Thrale with a slashing attack for 9 damage. Thrale's hit points fell from 24 to 15. Thrale's status after the attack was stable." },
];

for (const sample of actual) test(`v4 actual mechanical surface: ${sample.id}`, () => {
  const result = evaluateGroundedNarration(sample.text, sample.receipts);
  assert.equal(result.verdict, sample.adjudication ? "adjudication-required" : "verified", JSON.stringify(result));
  assert.equal(result.bindingsChecked, 2);
  for (const role of ["dc", "total", "outcome", "damage-applied", "hp-before", "hp-after", "status-after", "hit"]) {
    assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), role);
  }
  if (sample.adjudication && result.verdict === "adjudication-required") assert.deepEqual(result.adjudications.map((issue) => issue.excerpt), [sample.adjudication]);
});

function reject(text: string, source: readonly GroundingReceipt[], code?: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  if (code && result.verdict === "rejected") assert.ok(result.violations.some((issue) => issue.code === code), JSON.stringify(result));
}
function swap(text: string, first: number, second: number): string {
  return text.replace(new RegExp(`\\b(?:${first}|${second})\\b`, "g"), (value) => String(Number(value) === first ? second : first));
}
function oppositeHit(text: string): string {
  const natural = text.replace(/\band hit\b/i, "and missed").replace(/\bhit (?=[^.,;]+ with a )/i, "missed ");
  if (natural !== text) return natural;
  return text.replace(/\bhit(?::? true)?\b/i, (value) => /true/.test(value) ? value.replace("true", "false") : "miss");
}

test("v4's twelve actual surfaces reject 192 independent fact mutations", async (context) => {
  let count = 0;
  for (const sample of actual) await context.test(sample.id, () => {
    const check = sample.receipts[0]!;
    const damage = sample.receipts[1]!;
    if (check.kind !== "check" || damage.kind !== "combat" || damage.outcome.kind !== "damage") throw new Error("bad fixture");
    const mutations = {
      checkActor: sample.text.replace(/\byou\b/gi, "Neris"),
      attacker: sample.text.replace(/\bthe attacker\b/gi, "the defender"),
      target: sample.text.replaceAll(damage.target!, "Oswin"),
      skill: sample.text.replace(new RegExp(`\\b${check.skill}\\b`, "gi"), "Arcana"),
      dc: sample.text.replace(/(\b(?:DC|difficulty)\s*:?\s*)\d+/i, `$1${check.dc + 1}`),
      total: sample.text.replace(/(\btotal(?: of)?\s*:?\s*)\d+/i, `$1${check.total + 1}`),
      damage: sample.text.replace(new RegExp(`\\b${damage.outcome.applied}\\b`, "g"), String(damage.outcome.applied + 1)),
      hpBefore: sample.text.replace(/\b24\b/g, "23"),
      hpAfter: sample.text.replace(new RegExp(`\\b${damage.outcome.hitPointsAfter}\\b`, "g"), String(damage.outcome.hitPointsAfter - 1)),
      hpSwap: swap(sample.text, 24, damage.outcome.hitPointsAfter),
      status: sample.text.replace(/\bstable\b/g, "dead"),
      damageType: sample.text.replace(/\bslashing\b/g, "bludgeoning"),
      checkOutcome: sample.text.replace(/\b(success|succeeded|failure|failed)\b/gi, (value) => /^succeed/i.test(value) ? "failed" : /^success/i.test(value) ? "failure" : /^failed/i.test(value) ? "succeeded" : "success"),
      hitOutcome: oppositeHit(sample.text),
      dcTotalSwap: swap(sample.text, check.dc, check.total),
      damageHpSwap: swap(sample.text, damage.outcome.applied, damage.outcome.hitPointsAfter),
    };
    for (const [axis, mutation] of Object.entries(mutations)) {
      assert.notEqual(mutation, sample.text, `${sample.id}: ${axis} must change a fact`);
      reject(mutation, sample.receipts);
      count++;
    }
  });
  assert.equal(count, 192);
});

const toolReceipt: GroundingReceipt[] = [{ kind: "check", receiptId: "9c8657bf62", actor: "you", skill: "Deception", dc: 12, total: 21, outcome: "success", visibility: "public" }];
const toolNarrations = [
  { id: "unit-08f8cb9ae099023e-a0", text: "Deception check, DC 12. Total 21. Success. The lie holds.", unknown: /The lie holds/ },
  { id: "unit-08f8cb9ae099023e-a1", text: "The Deception holds. Your story lands as told — total 21 against DC 12, success. Whoever you sold it to takes it at face value. Nothing in Tallow Street contradicts you.", unknown: /takes it at face value|Nothing in Tallow Street/ },
  { id: "unit-08f8cb9ae099023e-a2", text: "Deception check resolved. Roll total 21 against DC 12. Outcome: success. The deception holds; nothing in the delivery betrays it. No further mechanical effect recorded.", unknown: /nothing in the delivery|No further mechanical effect/ },
];
for (const sample of toolNarrations) test(`v4 narration-submit extra consequences require adjudication: ${sample.id}`, () => {
  const result = evaluateGroundedNarration(sample.text, toolReceipt);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify(result));
  if (result.verdict === "adjudication-required") assert.ok(result.adjudications.some((issue) => sample.unknown.test(issue.excerpt)));
});

test("explicit receipt scopes survive adjacent period-separated records", () => {
  const sample = actual[8]!;
  const joined = sample.text.replace(/\n\n/g, " ");
  assert.equal(evaluateGroundedNarration(joined, survival).verdict, "verified");
  const boldJoined = actual[6]!.text.replace(/\n\n/g, " ");
  assert.equal(evaluateGroundedNarration(boldJoined, survival).verdict, "verified");
  reject(joined.replace("Receipt c74db8473c", "Receipt e425e93f62"), survival, "receipt-binding-mismatch");
  reject(boldJoined.replace("Receipt c74db8473c", "Receipt absent"), survival, "receipt-binding-mismatch");
});

test("full no-ID roles bind independently of paragraph or receipt-array order", () => {
  const sample = actual[4]!;
  const reversed = [...maren].reverse();
  const text = sample.text.split("\n\n").reverse().join("\n\n");
  assert.equal(evaluateGroundedNarration(text, reversed).verdict, "verified");
  const bare = sample.text.replace(/Receipt (?:one|two)\. /g, "");
  assert.equal(evaluateGroundedNarration(bare, reversed).verdict, "verified");
  const ambiguous: GroundingReceipt[] = [...maren, { ...maren[0]!, receiptId: "same-roles" }];
  assert.equal(evaluateGroundedNarration(sample.text, ambiguous).verdict, "adjudication-required");
  // A matching preceding fact or matching numbers cannot disambiguate a record.
  assert.equal(evaluateGroundedNarration(`Your Deception check failed. ${sample.text}`, ambiguous).verdict, "adjudication-required");
});

test("explicit citations and full role associations prohibit scope-splicing", () => {
  const other: GroundingReceipt = { kind: "combat-damage", receiptId: "other", actor: "the defender", target: "Oswin", applied: 5, damageType: "slashing", hit: true, hitPointsBefore: 24, hitPointsAfter: 19, statusAfter: "stable" };
  const source = [...survival, other];
  const text = actual[8]!.text;
  reject(text.replace("Target: Ailsa", "Target: Oswin"), source, "target-binding-mismatch");
  reject(text.replace("Actor: the attacker", "Actor: the defender"), source, "actor-binding-mismatch");
  reject(text.replace("Status after: stable.", "Oswin's status after: stable."), source, "target-binding-mismatch");
  reject(text.replace("Status after: stable.", "Status after: stable. Receipt other."), source, "receipt-binding-mismatch");
  const footer = text.replace("Receipt c74db8473c. ", "").replace("Hit: true.", "Hit: true. Receipt other.");
  reject(footer, source, "actor-binding-mismatch");
  // Even with both facts present, role-only headers cannot swap HP subjects.
  reject(actual[4]!.text.replace("Maren's hit points", "Oswin's hit points"), [...maren, other], "target-binding-mismatch");
});

test("duplicate fields reject conflicts; unknown metadata and prose cannot be ignored", () => {
  const sample = actual[8]!;
  for (const [from, to, code] of [
    ["Actor: you.", "Actor: you. Actor: Oswin.", "actor-binding-mismatch"],
    ["Target: Ailsa.", "Target: Ailsa. Target: Oswin.", "target-binding-mismatch"],
    ["Skill: Survival.", "Skill: Survival. Skill: Arcana.", "subject-binding-mismatch"],
    ["Total: 11.", "Total: 11. Total: 18.", "value-binding-mismatch"],
    ["Outcome: failure.", "Outcome: failure. Outcome: success.", "check-outcome-contradicted"],
    ["Hit: true.", "Hit: true. Hit: false.", "combat-outcome-contradicted"],
    ["Status after: stable.", "Status after: stable. Status after: defeated.", "fabricated-outcome"],
    ["Damage: 5 slashing.", "Damage: 5 slashing. Damage type: piercing.", "qualifier-binding-mismatch"],
  ]) reject(sample.text.replace(from!, to!), survival, code);
  for (const extra of ["Witness: the crowd believes you.", "The lie holds.", "No further mechanical effect recorded.", "Bonus experience: 99.", "**The target stays on her feet.**", "Confidence: unknown.", "Weather tomorrow: cloudy."]) {
    const result = evaluateGroundedNarration(`${sample.text} ${extra}`, survival);
    assert.equal(result.verdict, "adjudication-required", JSON.stringify(result));
    if (result.verdict === "adjudication-required") assert.ok(result.adjudications.some((issue) => issue.excerpt.includes(extra.replace(/\.$/, ""))));
    reject(`${sample.text.replace("Total: 11", "Total: 18")} ${extra}`, survival, "value-binding-mismatch");
  }
});

test("recognized outcome negations in a field remain contradictions, not unknown metadata", () => {
  const text = actual[8]!.text;
  for (const outcome of ["not failure", "no failure", "successful", "did not fail"]) {
    reject(text.replace("Outcome: failure", `Outcome: ${outcome}`), survival, "check-outcome-contradicted");
  }
});

test("an isolated role label without a mechanical family does not invent a damage contradiction", () => {
  assert.equal(evaluateGroundedNarration("Actor: you.", [survival[0]!]).verdict, "adjudication-required");
  assert.equal(evaluateGroundedNarration("Receipt e425e93f62. Actor: you.", [survival[0]!]).verdict, "adjudication-required");
});

test("incomplete records cannot infer omitted identities, statuses or hit outcomes", () => {
  const text = actual[8]!.text;
  for (const omitted of ["Actor: you. ", "Skill: Survival. ", "Target: Ailsa. ", "Hit: true. ", "Status after: stable. "]) {
    assert.equal(evaluateGroundedNarration(text.replace(omitted, ""), survival).verdict, "adjudication-required");
  }
  const noStatus: GroundingReceipt[] = survival.map((receipt) => receipt.kind === "combat" && receipt.outcome.kind === "damage"
    ? { ...receipt, outcome: { kind: "damage", applied: 5, hitPointsBefore: 24, hitPointsAfter: 19, hit: true, damageType: "slashing" } } : receipt);
  assert.equal(evaluateGroundedNarration(text, noStatus).verdict, "adjudication-required");
});

test("bounded natural grammar generalizes without authorizing adjacent fictional consequences", () => {
  const source = receipts("new-check", "new-damage", "Arcana", 20, 7, "failure", "Éloise", 4, 20).map((receipt) => receipt.kind === "check" ? { ...receipt, actor: "Neris" } : { ...receipt, actor: "Haug" });
  const text = "Neris failed on an Arcana check against DC 20, with a total of 7. Haug hit Éloise with a slashing attack for 4 damage. Éloise's HP fell from 24 to 20. Éloise's status after the attack was stable.";
  assert.equal(evaluateGroundedNarration(text, source).verdict, "verified");
  for (const suffix of ["The crowd believed it.", "Whatever was hidden, you found it.", "Éloise stays on her feet.", "Nothing in the room contradicts Neris."]) {
    assert.notEqual(evaluateGroundedNarration(`${text} ${suffix}`, source).verdict, "verified");
  }
  reject(text.replace("failed", "succeeded"), source, "check-outcome-contradicted");
  reject(text.replace("hit Éloise", "missed Éloise"), source, "combat-outcome-contradicted");
  reject(text.replace("24 to 20", "20 to 24"), source, "value-binding-mismatch");
});
