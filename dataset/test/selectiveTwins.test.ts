import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePreference } from "../src/admission.js";
import { authoritativeFacts, evaluateGroundedNarration, type GroundingReceipt } from "../src/grounding.js";
import { buildSelectiveFidelityTwins } from "../src/selectiveTwins.js";
import { anchorCandidates, TwinError, type TwinCaseSpec } from "../src/twins.js";

function fixture(skill = "Investigation", total = 22, changed = 24) {
  const receipts: GroundingReceipt[] = [{ kind: "check", receiptId: "roll", skill, total, dc: 15,
    difficulty: "Medium", outcome: "success" }];
  const counterfactualReceipts: GroundingReceipt[] = [{ ...receipts[0]!, total: changed } as GroundingReceipt];
  const candidates = anchorCandidates(authoritativeFacts(receipts));
  const numeric = candidates.find((anchor) => anchor.kind === "numeric" && anchor.value === String(total))!;
  const named = candidates.find((anchor) => anchor.kind === "named" && anchor.value === skill)!;
  const concrete = candidates.find((anchor) => anchor.kind === "concrete" && anchor.value === "Medium")!;
  const spec: TwinCaseSpec = {
    caseId: `case-${skill}-${total}`, receipts,
    prompt: [{ role: "user", content: "Narrate the committed check." }],
    faithfulNarration: `Your ${skill} check comes to ${total} against a Medium DC of 15: success.`,
    counterfactualNarration: `Your ${skill} check comes to ${changed} against a Medium DC of 15: your ${skill} check succeeds.`,
    flip: { op: "set-value", factId: "roll", role: "total", value: changed },
    flipAnchor: numeric,
  };
  return { spec, counterfactualReceipts, anchors: [named, numeric, concrete] };
}

test("the preference reverses under a one-fact prompt change", () => {
  const { spec, counterfactualReceipts, anchors } = fixture();
  const twins = buildSelectiveFidelityTwins(spec, counterfactualReceipts, anchors, "seed");
  assert.deepEqual(twins.original.chosen, twins.counterfactual.rejected);
  assert.deepEqual(twins.original.rejected, twins.counterfactual.chosen);
  assert.deepEqual(twins.original.prompt.slice(1), twins.counterfactual.prompt.slice(1));
  assert.notEqual(twins.original.prompt[0]!.content, twins.counterfactual.prompt[0]!.content);
  assert.match(twins.original.prompt[0]!.content, /"total":22/);
  assert.match(twins.counterfactual.prompt[0]!.content, /"total":24/);
  for (const [pair, receipts] of [[twins.original, spec.receipts], [twins.counterfactual, counterfactualReceipts]] as const) {
    assert.deepEqual(validatePreference(pair), []);
    assert.equal(evaluateGroundedNarration(pair.chosen[0]!.content, receipts).verdict, "verified");
    assert.equal(evaluateGroundedNarration(pair.rejected[0]!.content, receipts).verdict, "rejected");
    assert.doesNotMatch(JSON.stringify(pair.prompt), /factId|binding|anchors|substring|must include/);
  }
});

test("construction is deterministic and transfers to fresh skill names and numbers", () => {
  for (const [skill, total, changed] of [["Arcana", 18, 20], ["Survival", 27, 29]] as const) {
    const data = fixture(skill, total, changed);
    const build = () => buildSelectiveFidelityTwins(data.spec, data.counterfactualReceipts, data.anchors, "fresh-seed");
    assert.deepEqual(build(), build());
    assert.match(build().counterfactual.chosen[0]!.content, new RegExp(`${skill}.*${changed}`));
  }
});

test("unchanged or multi-fact counterfactual receipts refuse", () => {
  const data = fixture();
  assert.throws(() => buildSelectiveFidelityTwins(data.spec, data.spec.receipts, data.anchors, "seed"), /exactly the recorded fact flip/);
  const extra: GroundingReceipt[] = [{ ...data.counterfactualReceipts[0]!, dc: 16 } as GroundingReceipt];
  assert.throws(() => buildSelectiveFidelityTwins(data.spec, extra, data.anchors, "seed"), /exactly the recorded fact flip/);
});

test("a chosen response that violates an unchanged field cannot become a twin", () => {
  const data = fixture();
  const bad = { ...data.spec, counterfactualNarration: data.spec.counterfactualNarration.replace("DC of 15", "DC of 16") };
  assert.throws(() => buildSelectiveFidelityTwins(bad, data.counterfactualReceipts, data.anchors, "seed"), TwinError);
});

test("non-public receipts cannot enter either training prompt", () => {
  const data = fixture();
  const spec = { ...data.spec, receipts: data.spec.receipts.map((receipt) => ({ ...receipt, visibility: "hidden" as const })) };
  const counterfactual = data.counterfactualReceipts.map((receipt) => ({ ...receipt, visibility: "hidden" as const }));
  assert.throws(() => buildSelectiveFidelityTwins(spec, counterfactual, data.anchors, "seed"), /non-public receipts/);
});
