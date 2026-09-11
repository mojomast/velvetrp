export const KNOWLEDGE_EVAL_CORPUS_VERSION = "knowledge-evals-v1" as const;

export type KnowledgeEvalAgentKey = "knower" | "arriving" | "authority" | "absent" | "bystander" | "herald" | "gossipRecipient" | "gossipNonRecipient" | "sharing" | "enemy" | "town";

export type KnowledgeEvalCase = Readonly<{
  id: string;
  category: "witnessed" | "told" | "faction" | "gossip" | "privacy" | "false-memory" | "negation";
  agentKind: "npc" | "faction" | "town";
  agentKey: KnowledgeEvalAgentKey;
  sourceKey: string;
  query?: string;
  expect: Readonly<{
    present: boolean;
    channel?: "witnessed" | "told" | "refuted";
    relayerKey?: "knower" | "town" | null;
    authority?: "rumor" | "verified" | "belief";
    disclosable?: boolean;
    negation?: boolean;
  }>;
}>;

export const KNOWLEDGE_EVAL_DEVELOPMENT_CASES: readonly KnowledgeEvalCase[] = [
  { id: "witnessed-knower-v1", category: "witnessed", agentKind: "npc", agentKey: "knower", sourceKey: "witnessed",
    expect: { present: true, channel: "witnessed", relayerKey: null, authority: "verified", disclosable: true } },
  { id: "told-arriving-v1", category: "told", agentKind: "npc", agentKey: "arriving", sourceKey: "told",
    expect: { present: true, channel: "told", relayerKey: "knower", authority: "rumor", disclosable: false } },
  { id: "faction-sharing-v1", category: "faction", agentKind: "faction", agentKey: "sharing", sourceKey: "witnessed",
    expect: { present: true, channel: "witnessed", relayerKey: null, authority: "verified", disclosable: true } },
  { id: "privacy-absent-v1", category: "privacy", agentKind: "npc", agentKey: "absent", sourceKey: "witnessed",
    expect: { present: false } },
  { id: "privacy-enemy-faction-v1", category: "privacy", agentKind: "faction", agentKey: "enemy", sourceKey: "witnessed",
    expect: { present: false } },
  { id: "town-gossip-pool-v1", category: "gossip", agentKind: "town", agentKey: "town", sourceKey: "gossip",
    expect: { present: true, channel: "witnessed", relayerKey: null, authority: "rumor", disclosable: false } },
  { id: "gossip-recipient-v1", category: "gossip", agentKind: "npc", agentKey: "gossipRecipient", sourceKey: "gossip",
    expect: { present: true, channel: "told", relayerKey: "town", authority: "rumor", disclosable: false } },
  { id: "privacy-gossip-nonrecipient-v1", category: "privacy", agentKind: "npc", agentKey: "gossipNonRecipient", sourceKey: "gossip",
    expect: { present: false } },
  { id: "negation-retrieval-v1", category: "negation", agentKind: "npc", agentKey: "knower", sourceKey: "negation",
    query: "promise passage", expect: { present: true, channel: "witnessed", relayerKey: null, authority: "verified", negation: true } },
  { id: "false-memory-unwitnessed-v1", category: "false-memory", agentKind: "npc", agentKey: "knower", sourceKey: "unwitnessed",
    expect: { present: false } },
] as const;

export function validateKnowledgeEvalCases(cases: readonly KnowledgeEvalCase[]): void {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id.trim() || ids.has(item.id)) throw new Error(`invalid knowledge evaluation id: ${item.id}`);
    ids.add(item.id);
    if (item.expect.present && !item.expect.channel) throw new Error(`present case requires a channel: ${item.id}`);
    if (item.expect.negation && item.category !== "negation") throw new Error(`negation flag requires the negation category: ${item.id}`);
  }
}

validateKnowledgeEvalCases(KNOWLEDGE_EVAL_DEVELOPMENT_CASES);
