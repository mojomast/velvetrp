#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAMPAIGN_RECALL_MAX_BYTES } from "../server/src/repo/campaign/campaignRecallReadRepo.js";
import { closeRepo } from "../server/src/repo/index.js";
import { MEMORY_EVAL_CORPUS_VERSION, MEMORY_EVAL_DEVELOPMENT_CASES, type MemoryEvalCase } from "../server/test/fixtures/memory-evals/corpus.js";
import { createMemoryEvalFixture } from "../server/test/fixtures/memory-evals/fixture.js";
import { MEMORY_EVAL_HOLDOUTS, MEMORY_EVAL_HOLDOUTS_VERSION } from "../server/test/fixtures/memory-evals/holdouts.js";

export type RankedCase = { expected: readonly string[]; forbidden: readonly string[]; ranked: readonly string[]; supported: boolean; bytes: number; hydrated: boolean; latencyMs: number };
export type MetricReport = { recallAtK: number; recallAt8: number; mrr: number; ndcg: number; negativePassRate: number; packingPassRate: number; hydrationPassRate: number; maxSerializedBytes: number };
export type MemoryEvaluation = { version: 1; codeDigest: string; corpusDigest: string; budgetDigest: string; policyDigest: string; corpus: { development: string; holdouts: string }; k: number; metrics: { development: MetricReport; holdouts: MetricReport; privacyPassRate: number; latency: { distractions: 100 | 1000; p50Ms: number; p95Ms: number }[] }; };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (values: readonly number[], quantile: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0; };
export function scoreCases(cases: readonly RankedCase[], k = 3): MetricReport {
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error("K must be an integer from 1 to 8");
  const supported = cases.filter(item => item.supported), denominator = Math.max(1, supported.length);
  let relevant = 0, atK = 0, at8 = 0, reciprocal = 0, ndcg = 0;
  for (const item of supported) { const positions = item.expected.map(key => item.ranked.indexOf(key)).filter(index => index >= 0).sort((a, b) => a - b); relevant += item.expected.length; atK += positions.filter(position => position < k).length; at8 += positions.filter(position => position < 8).length; if (positions.length) reciprocal += 1 / (positions[0]! + 1); const dcg = positions.reduce((sum, position) => sum + 1 / Math.log2(position + 2), 0); const ideal = item.expected.reduce((sum, _key, index) => sum + 1 / Math.log2(index + 2), 0); ndcg += ideal ? dcg / ideal : 0; }
  return { recallAtK: atK / Math.max(1, relevant), recallAt8: at8 / Math.max(1, relevant), mrr: reciprocal / denominator, ndcg: ndcg / denominator,
    negativePassRate: cases.filter(item => item.forbidden.every(key => !item.ranked.includes(key))).length / Math.max(1, cases.length),
    packingPassRate: cases.filter(item => item.bytes <= CAMPAIGN_RECALL_MAX_BYTES).length / Math.max(1, cases.length),
    hydrationPassRate: cases.filter(item => item.hydrated).length / Math.max(1, cases.length), maxSerializedBytes: Math.max(0, ...cases.map(item => item.bytes)) };
}

function evaluateCase(fixture: Awaited<ReturnType<typeof createMemoryEvalFixture>>, item: MemoryEvalCase): RankedCase {
  const started = performance.now();
  const result = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors[item.actor] }, query: item.query, purpose: "public-narration" })!;
  const ranked = result.hits.map(hit => Object.entries(fixture.sourceIds).find(([, id]) => id === hit.sourceId)?.[0] ?? `unknown:${hit.digest}`);
  return { expected: item.requiredSourceKeys, forbidden: item.forbiddenSourceKeys, ranked, supported: item.baseline === "supported", bytes: Buffer.byteLength(JSON.stringify(result)), hydrated: result.hits.every(hit => Buffer.byteLength(hit.text) <= 2_048), latencyMs: performance.now() - started };
}

function addDistractions(fixture: Awaited<ReturnType<typeof createMemoryEvalFixture>>, from: number, to: number) {
  for (let index = from; index < to; index++) fixture.repo.createAdventureTurn("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id,
    timelineId: fixture.repo.getCampaign("local-owner", fixture.campaign.id)!.activeTimelineId, actorId: fixture.actors.aster,
    declaration: `memory evaluation distraction ${index}: unrelated harbor inventory note.`, expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision,
    idempotencyKey: `memory-eval:distraction:${index}` });
}

export async function evaluateCampaignMemory(output?: string): Promise<MemoryEvaluation> {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-memory-eval-"));
  const previousDataDir = process.env.VELVET_DATA_DIR;
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const fixture = await createMemoryEvalFixture(directory), development = MEMORY_EVAL_DEVELOPMENT_CASES.map(item => evaluateCase(fixture, item)), holdouts = MEMORY_EVAL_HOLDOUTS.map(item => evaluateCase(fixture, item));
    let materialized = 0;
    const latency = ([100, 1000] as const).map(distractions => {
      addDistractions(fixture, materialized, distractions); materialized = distractions;
      const samples = Array.from({ length: 20 }, () => evaluateCase(fixture, MEMORY_EVAL_DEVELOPMENT_CASES[0]!).latencyMs);
      return { distractions, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
    });
    const k = 3, all = [...development, ...holdouts];
    const artifact: MemoryEvaluation = { version: 1, codeDigest: digest(await readFile(fileURLToPath(import.meta.url), "utf8")), corpusDigest: digest({ development: MEMORY_EVAL_DEVELOPMENT_CASES, holdouts: MEMORY_EVAL_HOLDOUTS }), budgetDigest: digest({ maxBytes: CAMPAIGN_RECALL_MAX_BYTES, topK: 8, k }), policyDigest: digest({ audience: "player", purpose: "public-narration", activeTimeline: true, noPackets: true }), corpus: { development: MEMORY_EVAL_CORPUS_VERSION, holdouts: MEMORY_EVAL_HOLDOUTS_VERSION }, k, metrics: { development: scoreCases(development, k), holdouts: scoreCases(holdouts, k), privacyPassRate: all.filter(item => item.forbidden.every(key => !item.ranked.includes(key))).length / Math.max(1, all.length), latency } };
    fixture.repo.close(); if (output) await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 }); return artifact;
  } finally { closeRepo(); if (previousDataDir === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previousDataDir; await rm(directory, { recursive: true, force: true }); }
}

async function main() { const output = process.argv.slice(2).find(value => value.startsWith("--output="))?.slice(9); const artifact = await evaluateCampaignMemory(output ? path.resolve(output) : undefined); if (!output) process.stdout.write(`${JSON.stringify(artifact)}\n`); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
