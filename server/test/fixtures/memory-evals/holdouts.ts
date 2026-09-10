import type { MemoryEvalCase } from "./corpus.js";

export const MEMORY_EVAL_HOLDOUTS_VERSION = "memory-evals-holdouts-v1" as const;

// Reviewed labels are frozen so evaluator work cannot mutate them while tuning retrieval.
export const MEMORY_EVAL_HOLDOUTS: readonly MemoryEvalCase[] = Object.freeze([
  Object.freeze({ id: "holdout-promise-negation-v1", category: "promise", query: "Did I promise passage to the island?", actor: "aster", requiredSourceKeys: Object.freeze(["holdout:passage"]), forbiddenSourceKeys: Object.freeze([]), supportedFacts: Object.freeze(["The source records a denial of a promise."]), forbiddenInferences: Object.freeze(["Passage was promised."]), baseline: "supported" }),
  Object.freeze({ id: "holdout-current-reversal-v1", category: "current-update", query: "What is the tide signal now?", actor: "aster", requiredSourceKeys: Object.freeze(["holdout:tide-current"]), forbiddenSourceKeys: Object.freeze([]), supportedFacts: Object.freeze(["The latest recap says the signal is green."]), forbiddenInferences: Object.freeze(["The earlier red signal is current."]), baseline: "supported" }),
  Object.freeze({ id: "holdout-private-name-v1", category: "private-match", query: "nightjar cipher", actor: "aster", requiredSourceKeys: Object.freeze([]), forbiddenSourceKeys: Object.freeze(["holdout:bryn-private"]), supportedFacts: Object.freeze(["Bryn's private source is unauthorized."]), forbiddenInferences: Object.freeze(["The cipher is disclosed."]), baseline: "supported" }),
  Object.freeze({ id: "holdout-alias-baseline-miss-v1", category: "alias", query: "the keeper's light", actor: "aster", requiredSourceKeys: Object.freeze(["promise:lantern"]), forbiddenSourceKeys: Object.freeze([]), supportedFacts: Object.freeze(["The reviewed source calls it a lantern."]), forbiddenInferences: Object.freeze(["Alias resolution is baseline behavior."]), baseline: "expected-miss" }),
  Object.freeze({ id: "holdout-pronoun-baseline-miss-v1", category: "pronoun", query: "Was it accepted?", actor: "aster", requiredSourceKeys: Object.freeze(["p2:p3-harbor-task-accepted-v1"]), forbiddenSourceKeys: Object.freeze([]), supportedFacts: Object.freeze(["The referent is intentionally unbound in the baseline."]), forbiddenInferences: Object.freeze(["An ambiguous pronoun authorizes a guess."]), baseline: "expected-miss" }),
]);
