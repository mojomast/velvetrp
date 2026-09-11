import type { KnowledgeEvalCase } from "./corpus.js";

export const KNOWLEDGE_EVAL_HOLDOUTS_VERSION = "knowledge-evals-holdouts-v1" as const;

// Reviewed ratings are frozen so evaluator work cannot mutate them while tuning.
export const KNOWLEDGE_EVAL_HOLDOUTS: readonly KnowledgeEvalCase[] = Object.freeze([
  Object.freeze({ id: "holdout-told-negation-v1", category: "told", agentKind: "npc", agentKey: "arriving", sourceKey: "negation",
    expect: Object.freeze({ present: true, channel: "told", relayerKey: "knower", authority: "rumor", disclosable: false }) }),
  Object.freeze({ id: "holdout-enemy-faction-v1", category: "privacy", agentKind: "faction", agentKey: "enemy", sourceKey: "negation",
    expect: Object.freeze({ present: false }) }),
  Object.freeze({ id: "holdout-gossip-pool-authority-v1", category: "gossip", agentKind: "town", agentKey: "town", sourceKey: "gossip",
    expect: Object.freeze({ present: true, channel: "witnessed", relayerKey: null, authority: "rumor", disclosable: false }) }),
  Object.freeze({ id: "holdout-absent-privacy-v1", category: "privacy", agentKind: "npc", agentKey: "absent", sourceKey: "gossip",
    expect: Object.freeze({ present: false }) }),
  Object.freeze({ id: "holdout-witnessed-authority-v1", category: "witnessed", agentKind: "npc", agentKey: "knower", sourceKey: "negation",
    expect: Object.freeze({ present: true, channel: "witnessed", relayerKey: null, authority: "verified", disclosable: true }) }),
]);
