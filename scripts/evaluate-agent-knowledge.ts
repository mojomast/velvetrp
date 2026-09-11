#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeRepo } from "../server/src/repo/index.js";
import {
  KNOWLEDGE_EVAL_CORPUS_VERSION,
  KNOWLEDGE_EVAL_DEVELOPMENT_CASES,
  type KnowledgeEvalCase,
} from "../server/test/fixtures/knowledge-evals/corpus.js";
import { createKnowledgeEvalFixture, type KnowledgeEvalFixture } from "../server/test/fixtures/knowledge-evals/fixture.js";
import { KNOWLEDGE_EVAL_HOLDOUTS, KNOWLEDGE_EVAL_HOLDOUTS_VERSION } from "../server/test/fixtures/knowledge-evals/holdouts.js";

const OWNER = "local-owner";
const AUTHORITY_QUERY = "harbor skirmish";

export type KnowledgeCaseResult = {
  id: string;
  present: boolean;
  attributionCorrect: boolean;
  negativeCorrect: boolean;
  privacyCorrect: boolean;
  negationCorrect: boolean;
  disclosureCorrect: boolean;
  authority: string | null;
  channel: string | null;
  relayer: string | null;
  text: string | null;
};
export type KnowledgeMetricReport = {
  cases: number;
  attributionPrecision: number;
  privacyPassRate: number;
  negativePassRate: number;
  negationTermPass: number;
  disclosurePassRate: number;
};
export type KnowledgeEvaluation = {
  version: 1;
  codeDigest: string;
  corpusDigest: string;
  holdoutDigest: string;
  policyDigest: string;
  authorityDigest: string;
  corpus: { development: string; holdouts: string };
  metrics: { development: KnowledgeMetricReport; holdouts: KnowledgeMetricReport; combined: KnowledgeMetricReport; authorityPassRate: number };
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rate = (numerator: number, denominator: number) => denominator === 0 ? 1 : numerator / denominator;

function resolveAgent(fixture: KnowledgeEvalFixture, item: KnowledgeEvalCase): string {
  if (item.agentKind === "town") return fixture.townAgentId;
  if (item.agentKind === "faction") return item.agentKey === "sharing" ? fixture.factions.sharing : fixture.factions.enemy;
  return (fixture.agents as Record<string, string | null>)[item.agentKey]!;
}

function resolveRelayer(fixture: KnowledgeEvalFixture, relayerKey: "knower" | "town" | null): string | null {
  if (relayerKey === null) return null;
  return relayerKey === "town" ? fixture.townAgentId : fixture.agents.knower;
}

export function evaluateKnowledgeCase(fixture: KnowledgeEvalFixture, item: KnowledgeEvalCase): KnowledgeCaseResult {
  const entries = fixture.repo.listAgentKnowledge(OWNER, {
    campaignId: fixture.campaign.id, agentKind: item.agentKind, agentId: resolveAgent(fixture, item),
    listenerActorId: fixture.listenerActorId, ...(item.query === undefined ? {} : { query: item.query }), limit: 24,
  });
  const matching = entries.filter(candidate => candidate.sourceCommandId === fixture.sources[item.sourceKey]);
  const entry = matching[0];
  const present = matching.length > 0;
  const expectedRelayer = item.expect.relayerKey === undefined ? undefined : resolveRelayer(fixture, item.expect.relayerKey);
  const attributionCorrect = item.expect.present && item.expect.channel !== undefined
    && matching.some(candidate => candidate.channel === item.expect.channel
      && (item.expect.relayerKey === undefined || candidate.relayerAgentId === expectedRelayer)
      && (item.expect.authority === undefined || candidate.authority === item.expect.authority));
  const negationCorrect = item.expect.negation ? matching.some(candidate => /(^|\s)(not|no|never)(\s|$)/i.test(candidate.text)) : true;
  const disclosureCorrect = item.expect.disclosable === undefined ? true : matching.some(candidate => candidate.disclosable === item.expect.disclosable);
  return {
    id: item.id, present,
    attributionCorrect, negativeCorrect: item.expect.present ? true : !present,
    privacyCorrect: item.category === "privacy" ? !present : true, negationCorrect, disclosureCorrect,
    authority: entry?.authority ?? null, channel: entry?.channel ?? null, relayer: entry?.relayerAgentId ?? null, text: entry?.text ?? null,
  };
}

export function scoreKnowledgeCases(results: readonly KnowledgeCaseResult[], cases: readonly KnowledgeEvalCase[]): KnowledgeMetricReport {
  const byId = new Map(results.map(result => [result.id, result]));
  const count = (items: readonly KnowledgeEvalCase[], key: keyof KnowledgeCaseResult) => items.filter(item => byId.get(item.id)?.[key]).length;
  const presentExpected = cases.filter(item => item.expect.present && item.expect.channel !== undefined);
  const privacy = cases.filter(item => item.category === "privacy");
  const negatives = cases.filter(item => !item.expect.present);
  const negations = cases.filter(item => item.expect.negation);
  const disclosure = cases.filter(item => item.expect.disclosable !== undefined);
  return {
    cases: cases.length,
    attributionPrecision: rate(count(presentExpected, "attributionCorrect"), presentExpected.length),
    privacyPassRate: rate(count(privacy, "privacyCorrect"), privacy.length),
    negativePassRate: rate(count(negatives, "negativeCorrect"), negatives.length),
    negationTermPass: rate(count(negations, "negationCorrect"), negations.length),
    disclosurePassRate: rate(count(disclosure, "disclosureCorrect"), disclosure.length),
  };
}

function authorityInvariant(fixture: KnowledgeEvalFixture) {
  const ordered = fixture.repo.listAgentKnowledge(OWNER, {
    campaignId: fixture.campaign.id, agentKind: "npc", agentId: fixture.agents.authority,
    listenerActorId: fixture.listenerActorId, query: AUTHORITY_QUERY, limit: 24,
  }).map(entry => ({ sourceId: entry.sourceCommandId, authority: entry.authority, channel: entry.channel, relayer: entry.relayerAgentId }));
  const verifiedIndex = ordered.findIndex(entry => entry.authority === "verified");
  const rumorIndex = ordered.findIndex(entry => entry.authority === "rumor");
  return { pass: verifiedIndex >= 0 && rumorIndex >= 0 && verifiedIndex < rumorIndex, digest: digest(ordered) };
}

export async function evaluateAgentKnowledge(output?: string): Promise<KnowledgeEvaluation> {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-knowledge-eval-"));
  const previousDataDir = process.env.VELVET_DATA_DIR;
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const fixture = await createKnowledgeEvalFixture(directory);
    const developmentResults = KNOWLEDGE_EVAL_DEVELOPMENT_CASES.map(item => evaluateKnowledgeCase(fixture, item));
    const holdoutResults = KNOWLEDGE_EVAL_HOLDOUTS.map(item => evaluateKnowledgeCase(fixture, item));
    const authority = authorityInvariant(fixture);
    const artifact: KnowledgeEvaluation = {
      version: 1,
      codeDigest: digest(await readFile(fileURLToPath(import.meta.url), "utf8")),
      corpusDigest: digest(KNOWLEDGE_EVAL_DEVELOPMENT_CASES),
      holdoutDigest: digest(KNOWLEDGE_EVAL_HOLDOUTS),
      policyDigest: digest({ owner: OWNER, listener: fixture.listenerActorId, authority: "verified>belief>rumor", sampling: "hash-parity", limit: 24 }),
      authorityDigest: authority.digest,
      corpus: { development: KNOWLEDGE_EVAL_CORPUS_VERSION, holdouts: KNOWLEDGE_EVAL_HOLDOUTS_VERSION },
      metrics: {
        development: scoreKnowledgeCases(developmentResults, KNOWLEDGE_EVAL_DEVELOPMENT_CASES),
        holdouts: scoreKnowledgeCases(holdoutResults, KNOWLEDGE_EVAL_HOLDOUTS),
        combined: scoreKnowledgeCases([...developmentResults, ...holdoutResults], [...KNOWLEDGE_EVAL_DEVELOPMENT_CASES, ...KNOWLEDGE_EVAL_HOLDOUTS]),
        authorityPassRate: authority.pass ? 1 : 0,
      },
    };
    fixture.repo.close();
    if (output) await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    return artifact;
  } finally {
    closeRepo();
    if (previousDataDir === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const output = process.argv.slice(2).find(value => value.startsWith("--output="))?.slice(9);
  const artifact = await evaluateAgentKnowledge(output ? path.resolve(output) : undefined);
  if (!output) process.stdout.write(`${JSON.stringify(artifact)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
