import { providerCandidateLabelSchema, type ProviderCandidateLabel } from "@velvet/contracts";
import type { CompletionJsonValue } from "../provider/index.js";

export type LabeledCandidate<T extends { candidateId: string; digest: string }> = T & { semanticLabel: ProviderCandidateLabel };

const text = (values: readonly string[], fallback: string) => values.length ? values.join("; ") : fallback;

export function labelCandidate<T extends { candidateId: string; digest: string }>(candidate: T,
  label: ProviderCandidateLabel): LabeledCandidate<T> | null {
  const parsed = providerCandidateLabelSchema.safeParse(label);
  return parsed.success ? { ...candidate, semanticLabel: parsed.data } : null;
}

export function exactPairParameters(candidates: readonly LabeledCandidate<{ candidateId: string; digest: string }>[],
  idKey = "candidateId", digestKey = "digest"): Record<string, CompletionJsonValue> {
  return { type:"object",properties:{[idKey]:{type:"string",enum:candidates.map(candidate=>candidate.candidateId)},
    [digestKey]:{type:"string",enum:candidates.map(candidate=>candidate.digest)}},required:[idKey,digestKey],additionalProperties:false,
    oneOf: candidates.map((candidate) => ({
    type: "object",
    description: "Select this exact server-issued candidate binding.",
    properties: { [idKey]: { type: "string", const: candidate.candidateId }, [digestKey]: { type: "string", const: candidate.digest } },
    required: [idKey, digestKey],
    additionalProperties: false,
  })) };
}

export const candidateLabels = {
  questObjective: (candidate: any) => ({ action: "Advance quest objective", source: candidate.questTitle,
    target: candidate.objectiveDescription, cost: null,
    consequence: `Advance progress from ${candidate.progress} to ${Math.min(candidate.progress + 1, candidate.targetProgress)} of ${candidate.targetProgress}.` }),
  check: (candidate: any) => ({ action: "Resolve SRD check", source: candidate.label, target: null, cost: null,
    consequence: "Roll the advertised check and commit its success or failure outcome." }),
  inventory: (candidate: any) => ({ action: candidate.action, source: candidate.itemLabel, target: candidate.recipient ?? candidate.slot,
    cost: `${candidate.quantity} item`, consequence: candidate.action === "consume" ? "Remove the item without applying an item effect."
      : `${candidate.action} ${candidate.quantity} ${candidate.itemLabel}${candidate.recipient ? ` to ${candidate.recipient}` : ""}.` }),
  commerce: (candidate: any) => ({ action: candidate.action, source: `${candidate.itemLabel} at ${candidate.shopLabel}`,
    target: candidate.vendorLabel, cost: `${candidate.priceMinorUnits} ${candidate.currencyLabel}`, consequence: candidate.consequence }),
  power: (candidate: any) => ({ action: "Use power", source: candidate.powerName, target: candidate.targets.join(", "),
    cost: text(candidate.costs, "No limited-use cost"), consequence: `Apply ${candidate.effects.join(", ")}${candidate.concentration ? " with concentration" : ""}.` }),
  rest: (candidate: any) => ({ action: candidate.restName, source: candidate.restName, target: "Source actor",
    cost: "Rest time", consequence: `Recover ${candidate.recovery.map((item: any) => `${item.label} ${item.before} to ${item.after}`).join(", ")}.` }),
  combatConsumable: (candidate: any) => ({ action: "Use combat consumable", source: candidate.itemName, target: candidate.target,
    cost: `1 action and consume ${candidate.quantity} item`, consequence: candidate.consequences.map((item: any) => item.label).join("; ") }),
  combatPower: (candidate: any) => ({ action: "Use combat power", source: candidate.powerName, target: candidate.target,
    cost: text(["1 action", ...candidate.costs], "1 action"), consequence: candidate.consequences.map((item: any) => item.label).join("; ") }),
  questLifecycle: (candidate: any) => ({ action: candidate.action, source: candidate.questTitle,
    target: candidate.reward?.recipient ?? null, cost: null, consequence: candidate.reward
      ? `Claim ${candidate.reward.amount ?? "the"} ${candidate.reward.label} for ${candidate.reward.recipient}.`
      : `${candidate.action} quest ${candidate.questTitle}.` }),
  progression: (candidate: any) => ({ action: "Apply progression", source: candidate.className, target: "Source actor", cost: null,
    consequence: `Advance from level ${candidate.levelBefore} to ${candidate.levelAfter}; features: ${text(candidate.features, "none")}; resources: ${text(candidate.resources.map((item: any) => `${item.label} ${item.before} to ${item.after}`), "unchanged")}.` }),
} as const;

export function labeled<T extends { candidateId: string; digest: string }>(candidates: readonly T[],
  makeLabel: (candidate: T) => ProviderCandidateLabel): LabeledCandidate<T>[] {
  return candidates.slice(0,32).flatMap((candidate) => {
    const value = labelCandidate(candidate, makeLabel(candidate));
    return value ? [value] : [];
  });
}

export function stripCandidateLabels(projection: any): any {
  return { version: projection?.version, candidates: Array.isArray(projection?.candidates)
    ? projection.candidates.map(({ semanticLabel: _label, ...candidate }: any) => candidate) : [] };
}
