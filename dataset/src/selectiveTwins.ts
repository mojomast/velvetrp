/**
 * Prompt-conditioned selective-fidelity twins.
 *
 * Each arm has its own authoritative receipts and a preference pair under THAT
 * prompt. A faithful response to the original facts becomes the rejected response
 * under the changed facts, and vice versa. This reversal teaches selective use of
 * evidence. The minimal contrast is in the facts, not a length/style label.
 *
 * These are candidates, not admitted records. Each arm still needs independent
 * review, certified admission, and the prose-quality regression gate. Both arms
 * must stay in the same lineage, split and selection cluster when scheduled.
 */
import { evaluateGroundedNarration, authoritativeFacts, type GroundingReceipt } from "./grounding.js";
import { stableStringify, type PreferencePair, type StoredMessage } from "./spec.js";
import {
  buildTwinPair, verifyTwinPair, narrationCarries, TwinError,
  type AnchorSpec, type TwinCaseSpec, type TwinInstrumentation,
} from "./twins.js";

const AUTHORITY_HEADER = "AUTHORITATIVE PUBLIC RECEIPTS\n";

export interface SelectiveFidelityTwins {
  readonly original: PreferencePair;
  readonly counterfactual: PreferencePair;
  /** Sidecar only; never rendered into a prompt or assistant target. */
  readonly instrumentation: TwinInstrumentation;
}

function promptWithReceipts(prompt: readonly StoredMessage[], receipts: readonly GroundingReceipt[]): StoredMessage[] {
  if (prompt.some((message) => message.content.includes(AUTHORITY_HEADER))) {
    throw new TwinError(["the common prompt scaffold already contains a receipt block"]);
  }
  if (receipts.some((receipt) => receipt.visibility !== undefined && receipt.visibility !== "public")) {
    throw new TwinError(["non-public receipts cannot be rendered in a training prompt"]);
  }
  return [
    { role: "system", content: AUTHORITY_HEADER + stableStringify(receipts) },
    ...prompt.map((message) => ({ ...message })),
  ];
}

/** Counterfactual receipts are supplied explicitly; no lossy inverse adapter is guessed. */
export function buildSelectiveFidelityTwins(
  spec: TwinCaseSpec,
  counterfactualReceipts: readonly GroundingReceipt[],
  anchors: readonly AnchorSpec[],
  seed: string,
): SelectiveFidelityTwins {
  const originalPrompt = promptWithReceipts(spec.prompt, spec.receipts);
  const counterfactualPrompt = promptWithReceipts(spec.prompt, counterfactualReceipts);
  const draft = buildTwinPair(spec, anchors, seed);
  const verified = verifyTwinPair({ pair: draft.pair, spec, instrumentation: draft.instrumentation });
  if (!verified.ok) throw new TwinError(verified.reasons.map((reason) => `${reason.code}: ${reason.detail}`));
  if (stableStringify(authoritativeFacts(counterfactualReceipts))
    !== stableStringify(draft.instrumentation.counterfactualFacts)) {
    throw new TwinError(["counterfactual receipts do not implement exactly the recorded fact flip"]);
  }
  if (!narrationCarries(spec.faithfulNarration, draft.instrumentation.flipAnchor)) {
    throw new TwinError(["original chosen response omits the flipped authoritative value"]);
  }
  // A preference must not encode a response that is already wrong under its OWN
  // prompt as chosen. Unrecognized prose fails closed, rather than being treated
  // as an implicit grounding pass.
  for (const [arm, text, receipts] of [
    ["original", spec.faithfulNarration, spec.receipts],
    ["counterfactual", spec.counterfactualNarration, counterfactualReceipts],
  ] as const) {
    const verdict = evaluateGroundedNarration(text, receipts);
    if (!verdict.ok) throw new TwinError([`${arm} chosen response needs grounded verification: ${verdict.verdict}`]);
  }
  // Demand a demonstrated source-sensitive error in both cross-prompt answers.
  // An incidental omission or an unrecognized clause is not enough evidence.
  for (const [text, receipts] of [
    [spec.counterfactualNarration, spec.receipts],
    [spec.faithfulNarration, counterfactualReceipts],
  ] as const) {
    if (evaluateGroundedNarration(text, receipts).verdict !== "rejected") {
      throw new TwinError(["cross-prompt response does not demonstrate a grounding violation"]);
    }
  }

  return {
    original: {
      ...draft.pair,
      prompt: originalPrompt,
      rationale: "The chosen response follows the original authoritative receipts; the rejected response changes a bound fact.",
    },
    counterfactual: {
      axis: draft.pair.axis,
      prompt: counterfactualPrompt,
      chosen: draft.pair.rejected,
      rejected: draft.pair.chosen,
      lengthRatio: draft.pair.lengthRatio,
      rationale: "The chosen response follows the changed authoritative receipts; the rejected response carries a stale value from the original scenario.",
    },
    instrumentation: draft.instrumentation,
  };
}
