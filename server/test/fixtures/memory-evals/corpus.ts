import { PLAYABILITY_OBSERVATIONS } from "../playability-observations.js";

export const MEMORY_EVAL_CORPUS_VERSION = "memory-evals-v1" as const;

export type MemoryEvalCase = Readonly<{
  id: string;
  category: "p2-observation" | "promise" | "outcome" | "current-update" | "private-match" | "wrong-actor" | "wrong-timeline" | "false-premise" | "no-match" | "unicode" | "retry" | "oversize" | "packing" | "alias" | "pronoun";
  query: string;
  actor: "aster" | "bryn";
  requiredSourceKeys: readonly string[];
  forbiddenSourceKeys: readonly string[];
  supportedFacts: readonly string[];
  forbiddenInferences: readonly string[];
  baseline: "supported" | "expected-miss";
  sourceAuthority?: Readonly<{ sourceKind: string; authority: string }>;
}>;

const p2Cases: readonly MemoryEvalCase[] = PLAYABILITY_OBSERVATIONS.map(observation => ({
  id: observation.id,
  category: "p2-observation",
  query: observation.step.replace(/-/g, " "),
  actor: "aster",
  requiredSourceKeys: [`p2:${observation.id}`],
  forbiddenSourceKeys: [],
  supportedFacts: [observation.supportedFact],
  forbiddenInferences: [observation.forbiddenInference],
  baseline: "supported",
  sourceAuthority: { sourceKind: observation.sourceKind, authority: observation.authority },
}));

export const MEMORY_EVAL_DEVELOPMENT_CASES: readonly MemoryEvalCase[] = [
  ...p2Cases,
  { id: "promise-old-lantern-v1", category: "promise", query: "What did I promise Keeper Maren about the lantern?", actor: "aster", requiredSourceKeys: ["promise:lantern"], forbiddenSourceKeys: ["outcome:lantern"], supportedFacts: ["The declaration is an intent, not proof of completion."], forbiddenInferences: ["The lantern was restored."], baseline: "supported" },
  { id: "outcome-lantern-v1", category: "outcome", query: "Was the lantern restored?", actor: "aster", requiredSourceKeys: ["outcome:lantern"], forbiddenSourceKeys: [], supportedFacts: ["A completed presentation says the lantern remained dark."], forbiddenInferences: ["The promised work succeeded."], baseline: "supported" },
  { id: "current-beacon-update-v1", category: "current-update", query: "What is the beacon status now?", actor: "aster", requiredSourceKeys: ["current:beacon"], forbiddenSourceKeys: [], supportedFacts: ["The current public recap says the beacon is relit."], forbiddenInferences: ["The older dim status is current."], baseline: "supported" },
  { id: "private-other-actor-v1", category: "private-match", query: "cedarlight password", actor: "aster", requiredSourceKeys: [], forbiddenSourceKeys: ["private:bryn"], supportedFacts: ["No other actor's private declaration is available."], forbiddenInferences: ["Bryn's password is known."], baseline: "supported" },
  { id: "wrong-actor-v1", category: "wrong-actor", query: "who carries the ash compass", actor: "aster", requiredSourceKeys: [], forbiddenSourceKeys: ["private:bryn"], supportedFacts: ["The active actor has no matching source."], forbiddenInferences: ["A different actor's intent is shared."], baseline: "supported" },
  { id: "wrong-timeline-v1", category: "wrong-timeline", query: "old timeline cobalt bell", actor: "aster", requiredSourceKeys: [], forbiddenSourceKeys: ["timeline:alternate"], supportedFacts: ["A source outside the active timeline is not evidence."], forbiddenInferences: ["Inactive-timeline history is current."], baseline: "supported" },
  { id: "false-premise-v1", category: "false-premise", query: "When did the lantern explode?", actor: "aster", requiredSourceKeys: ["outcome:lantern"], forbiddenSourceKeys: [], supportedFacts: ["The recorded outcome says it remained dark."], forbiddenInferences: ["An explosion happened."], baseline: "supported" },
  { id: "no-match-v1", category: "no-match", query: "quartz zeppelin", actor: "aster", requiredSourceKeys: [], forbiddenSourceKeys: [], supportedFacts: ["No matching evidence was retrieved."], forbiddenInferences: ["No event ever happened."], baseline: "supported" },
  { id: "unicode-v1", category: "unicode", query: "cafe 漢字", actor: "aster", requiredSourceKeys: ["unicode:cafe"], forbiddenSourceKeys: [], supportedFacts: ["The UTF-8 source remains whole."], forbiddenInferences: ["Escaped text is a separate source."], baseline: "supported" },
  { id: "retry-v1", category: "retry", query: "violet compass", actor: "aster", requiredSourceKeys: ["retry:compass"], forbiddenSourceKeys: [], supportedFacts: ["The retry is tied to one root intent."], forbiddenInferences: ["A retry creates a second action."], baseline: "supported" },
  { id: "oversize-v1", category: "oversize", query: "oversized meteor", actor: "aster", requiredSourceKeys: [], forbiddenSourceKeys: ["oversize:meteor"], supportedFacts: ["Oversized records are excluded and mark coverage incomplete."], forbiddenInferences: ["A partial oversized record is evidence."], baseline: "supported" },
  { id: "packing-pressure-v1", category: "packing", query: "harbor ledger", actor: "aster", requiredSourceKeys: ["packing:00"], forbiddenSourceKeys: [], supportedFacts: ["Packing retains complete ranked records only."], forbiddenInferences: ["A source may be sliced to fit."], baseline: "supported" },
  { id: "alias-baseline-miss-v1", category: "alias", query: "Maren's beacon", actor: "aster", requiredSourceKeys: ["promise:lantern"], forbiddenSourceKeys: [], supportedFacts: ["Keeper Maren and the lantern occur in the source."], forbiddenInferences: ["Alias expansion is implemented."], baseline: "expected-miss" },
  { id: "pronoun-baseline-miss-v1", category: "pronoun", query: "Did she keep it?", actor: "aster", requiredSourceKeys: ["promise:lantern"], forbiddenSourceKeys: [], supportedFacts: ["The antecedent is deliberately not resolved by baseline retrieval."], forbiddenInferences: ["A pronoun may cross actor or source boundaries."], baseline: "expected-miss" },
] as const;

export function validateMemoryEvalCases(cases: readonly MemoryEvalCase[]): void {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id.trim() || ids.has(item.id)) throw new Error(`invalid memory evaluation id: ${item.id}`);
    ids.add(item.id);
    if (!item.query.trim() || !item.supportedFacts.length || !item.forbiddenInferences.length) throw new Error(`incomplete memory evaluation case: ${item.id}`);
    if (item.baseline === "expected-miss" && !["alias", "pronoun", "p2-observation"].includes(item.category)) throw new Error(`unexpected baseline miss: ${item.id}`);
  }
}

validateMemoryEvalCases(MEMORY_EVAL_DEVELOPMENT_CASES);
