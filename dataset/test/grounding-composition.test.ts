import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";

// The composed guide offers value-free ALTERNATIVES rather than a mandatory
// short-sentence script: a complete check resolution, two attack realizations,
// and an HP transition sharing one sentence with an explicit status. These are
// regressions for already-supported composed forms -- not new grammar, not a
// claim about how the teacher chooses between them, and not a quality measure.

/** One scenario's public receipt pair: a check you made and a committed attack. */
function beat(check: { receiptId: string; skill: string; dc: number; total: number; outcome: string },
  damage: { receiptId: string; applied: number; hit: boolean }): GroundingReceipt[] {
  return [
    { kind: "check", actor: "you", visibility: "public", ...check },
    { kind: "combat", receiptId: damage.receiptId, actor: "the attacker", target: "Ailsa", action: "attack", visibility: "public",
      outcome: { kind: "damage", applied: damage.applied, damageType: "slashing", hit: damage.hit,
        hitPointsBefore: 24, hitPointsAfter: damage.hit ? 24 - damage.applied : 24, statusAfter: "stable" } },
  ];
}
const landed = beat({ receiptId: "composed-check-hit", skill: "Deception", dc: 15, total: 17, outcome: "success" },
  { receiptId: "composed-damage-hit", applied: 5, hit: true });
const failed = beat({ receiptId: "composed-check-fail", skill: "Survival", dc: 18, total: 11, outcome: "failure" },
  { receiptId: "composed-damage-fail", applied: 5, hit: true });
const missed = beat({ receiptId: "composed-check-miss", skill: "Survival", dc: 18, total: 11, outcome: "failure" },
  { receiptId: "composed-damage-miss", applied: 0, hit: false });
// The recorded miss carries zero damage and an unchanged hit-point pair, so the
// guide's "go from" wording must not imply a decrease.

const successBeat = "You succeeded on the Deception check against DC 15, with a total of 17. The attacker hits Ailsa with a slashing attack for 5 damage. Ailsa's hit points go from 24 to 19; Ailsa is stable.";
const failureBeat = "You failed on a Survival check against DC 18, with a total of 11. The attacker attacks Ailsa and hits, dealing 5 slashing damage. Ailsa's hit points go from 24 to 19; Ailsa is stable.";
const missBeat = "You failed on a Survival check against DC 18, with a total of 11. The attacker misses Ailsa with a slashing attack for 0 damage. Ailsa's hit points go from 24 to 24; Ailsa is stable.";

function verify(text: string, source: readonly GroundingReceipt[], count: number): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "verified", JSON.stringify({ text, result }));
  assert.equal(result.bindingsChecked, count);
}
function reject(text: string, source: readonly GroundingReceipt[], code: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  assert.ok(result.violations.some((issue) => issue.code === code), JSON.stringify(result));
}
function adjudicate(text: string, source: readonly GroundingReceipt[], code: string): void {
  const result = evaluateGroundedNarration(text, source);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify({ text, result }));
  assert.ok(result.adjudications.some((issue) => issue.code === code), JSON.stringify(result));
}

test("composed check, attack and semicolon-bound HP/status verify for both recorded check outcomes", () => {
  verify(successBeat, landed, 2);
  verify(failureBeat, failed, 2);
  const result = evaluateGroundedNarration(successBeat, landed);
  for (const role of ["dc", "total", "outcome", "damage-applied", "hp-before", "hp-after", "status-after", "hit"]) {
    assert.ok(result.bindings.some((binding) => binding.roles.includes(role)), role);
  }
});

test("a recorded miss with zero damage and equal hit points composes and binds in both attack realizations", () => {
  verify(missBeat, missed, 2);
  verify(missBeat.replace("The attacker misses Ailsa with a slashing attack for 0 damage.",
    "The attacker attacks Ailsa and misses, dealing 0 slashing damage."), missed, 2);
});

test("composed clauses keep every receipt role: wrong identity, swapped values and changed outcomes reject", () => {
  reject(successBeat.replace("The attacker hits", "The defender hits"), landed, "actor-binding-mismatch");
  reject(successBeat.replaceAll("Ailsa", "Oswin"), landed, "target-binding-mismatch");
  reject(successBeat.replace("Deception", "Arcana"), landed, "subject-binding-mismatch");
  reject(successBeat.replace("against DC 15, with a total of 17", "against DC 17, with a total of 15"), landed, "value-binding-mismatch");
  reject(successBeat.replace("succeeded on", "failed on"), landed, "check-outcome-contradicted");
  reject(successBeat.replace("hits Ailsa", "misses Ailsa"), landed, "combat-outcome-contradicted");
  reject(successBeat.replace("for 5 damage", "for 4 damage"), landed, "value-binding-mismatch");
  reject(successBeat.replace("slashing", "piercing"), landed, "qualifier-binding-mismatch");
  reject(successBeat.replace("from 24 to 19", "from 19 to 24"), landed, "value-binding-mismatch");
  reject(successBeat.replace("Ailsa is stable", "Ailsa is dead"), landed, "fabricated-outcome");
  reject(missBeat.replace("misses Ailsa", "hits Ailsa"), missed, "combat-outcome-contradicted");
  reject(missBeat.replace("from 24 to 24", "from 24 to 20"), missed, "value-binding-mismatch");
});

test("an unsupported clause after the composed paragraph or its semicolon never verifies", () => {
  adjudicate(`${successBeat} Ailsa winces and keeps her footing.`, landed, "unrecognized-clause");
  adjudicate(successBeat.replace("24 to 19;", "24 to 19; the attacker has spent his last arrow;"), landed, "unrecognized-clause");
  adjudicate(`${successBeat} Nothing in the hall contradicts that.`, landed, "unrecognized-clause");
  // Two correctly reported receipts do not license an invented causal link.
  adjudicate(successBeat.replace("The attacker hits", "Because you distracted him, the attacker hits"), landed, "unrecognized-clause");
});
