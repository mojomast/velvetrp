#!/usr/bin/env node
/**
 * Benchmarks Jev's Director lane against the production OpenAI-compatible Director
 * selection call on five provider-free states, and measures the **gated lane** that would
 * actually ship: Jev answers when its battery clears the action threshold, otherwise the
 * LLM selection call runs.
 *
 * The Jev arm runs the real Director battery in one transport call. The LLM arm replays
 * the production Director prompt with the exact `select_dm_beat` tool and a forced selection
 * call against DeepSeek. Both are graded against the same preferred/acceptable oracle. The
 * LLM arm measures one forced call; production may spend one to two grounding rounds first,
 * so "before Jev" is a lower bound.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... PROXY_API_KEY=... npx tsx scripts/benchmark-system-one-director-lane.ts
 *
 * Env: OPENROUTER_BASE_URL, OPENROUTER_MODEL, BENCH_REPEATS (default 3),
 *      BENCH_THRESHOLD (default 0.6, the Director threshold the calibration selected),
 *      BENCH_OUT.
 */
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalAgentJson } from "@velvet/contracts";
import { buildDirectorQuestions, composeDirectorSelection, type DirectorCandidateProjection } from "../server/src/agent/systemOneDirector.js";
import { DM_DIRECTOR_SYSTEM_PROMPT, selectDmBeatTool } from "../server/src/agent/campaignDmOrchestrator.js";
import { DIRECT_TOOL_BODY_OVERRIDES } from "../server/src/agent/directToolReasoning.js";
import { DM_PLANNING_COMPLETION_MAX_TOKENS } from "../server/src/repo/campaignDmRepo.js";
import { defaultHarnessSettings, defaultProviderSettings, defaultSystemOneSettings } from "../server/src/defaults.js";
import { getPromptPreset } from "../server/src/presets.js";
import { completeWithProvider } from "../server/src/provider/index.js";
import { completeWithSystemOne } from "../server/src/provider/systemOneCompletion.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = process.env.TYPESAFE_API_KEY?.trim() ?? "";
const LLM_KEY = (process.env.PROXY_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
if (!KEY) throw new Error("TYPESAFE_API_KEY is required for the Jev arm");
if (!LLM_KEY) throw new Error("PROXY_API_KEY (or OPENROUTER_API_KEY) is required for the LLM arm");
process.env.VELVET_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "velvet-system-one-director-bench-"));

const JEV_INPUT_PER_MILLION = 0.042;
const JEV_OUTPUT_PER_MILLION = 0;
const LLM_INPUT_PER_MILLION = 0.07784;
const LLM_OUTPUT_PER_MILLION = 0.15568;

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

async function buildState(id: string, setup?: (fixture: Fixture) => void): Promise<{ projection: DirectorCandidateProjection[]; context: unknown }> {
  const fixture = await dmFixture();
  setup?.(fixture);
  fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: `${id}-ai` });
  const run = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: id });
  const work = fixture.repo.claimDmPlanning("local-owner", run.runId, "bench", "bench");
  const projection = (work?.candidates ?? []).map((candidate) => ({
    candidateId: candidate.candidateId, digest: candidate.digest, action: candidate.action, label: candidate.label,
  }));
  const context = work?.context ?? null;
  fixture.repo.close();
  return { projection, context };
}

interface Scenario {
  id: string;
  projection: DirectorCandidateProjection[];
  context: unknown;
  preferred: string;
  acceptable: string[];
}

interface RawCall {
  scenarioId: string;
  arm: "jev" | "llm";
  repeat: number;
  ok: boolean;
  error?: string;
  acted: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  selectedAction: string | null;
  correct: boolean;
  exact: boolean;
}

const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
};
const money = (value: number): string => `$${value.toFixed(value < 0.01 ? 8 : 4)}`;

function grade(scenario: Scenario, selectedAction: string | null, held: boolean): { correct: boolean; exact: boolean } {
  if (scenario.preferred === "hold") return { correct: held, exact: held };
  const acceptable = new Set([scenario.preferred, ...scenario.acceptable]);
  return { correct: selectedAction !== null && acceptable.has(selectedAction), exact: selectedAction === scenario.preferred };
}

async function main(): Promise<void> {
  const repeats = Math.max(1, Number(process.env.BENCH_REPEATS ?? "3") || 3);
  const actionThreshold = Number(process.env.BENCH_THRESHOLD ?? "0.6");
  const jevSettings = {
    ...defaultSystemOneSettings(), apiKey: KEY, enabled: true,
    budget: { maxTotalTokens: 1_000_000_000, maxEstimatedCostUsd: null, maxRequestsPerWindow: 100_000, rateWindowMs: 1_000 },
  };
  const thresholds = { actionThreshold, reviewThreshold: 0.5 };
  const llmProvider = {
    ...defaultProviderSettings(),
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "http://100.72.41.9:8787/v1",
    model: process.env.OPENROUTER_MODEL ?? "deepseek-v4-flash",
    apiKey: LLM_KEY, requestTimeoutSeconds: 60,
    samplers: { ...defaultProviderSettings().samplers, maxTokens: DM_PLANNING_COMPLETION_MAX_TOKENS },
  };
  const harness = defaultHarnessSettings();
  const preset = getPromptPreset("default");

  const states = await Promise.all([
    buildState("empty-world"),
    buildState("story-graph", (fixture) => fixture.graph()),
    buildState("encounter-prep", (fixture) => fixture.prepare()),
    buildState("story-graph-revealed", (fixture) => {
      fixture.graph("story-revealed");
      const revision = fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision;
      fixture.repo.executeStorylineCommand("local-owner", "story-revealed", { kind: "reveal-node", targetId: "gate", data: {}, expectedRevision: revision, idempotencyKey: "revealed-gate" });
    }),
    buildState("encounter-active", (fixture) => {
      const encounter = fixture.repo.createEncounter("local-owner", fixture.campaign.id, {
        sessionId: fixture.session.id, name: "Solo ambush",
        combatants: [{ kind: "enemy", template: fixture.enemy, team: "enemies" }], idempotencyKey: "bench-enemy-only",
      }).encounter;
      fixture.repo.startEncounter("local-owner", encounter.encounterId, { expectedRevision: encounter.revision, idempotencyKey: "bench-enemy-start" });
    }),
  ]);
  const specs = [
    { index: 0, id: "empty-world", preferred: "ambient-beat", acceptable: ["advance-time"] },
    { index: 1, id: "story-graph", preferred: "reveal-node", acceptable: ["ambient-beat", "advance-time"] },
    { index: 2, id: "encounter-prep", preferred: "encounter-start", acceptable: [] },
    { index: 3, id: "story-graph-revealed", preferred: "reveal-clue", acceptable: ["ambient-beat", "advance-time"] },
    { index: 4, id: "encounter-active", preferred: "enemy-turn", acceptable: [] },
  ];
  const scenarios: Scenario[] = specs.map((spec) => ({ id: spec.id, preferred: spec.preferred, acceptable: spec.acceptable, projection: states[spec.index]!.projection, context: states[spec.index]!.context }));

  const calls: RawCall[] = [];
  console.log(`benchmarking ${scenarios.length} director states x ${repeats} repeats x 2 arms at threshold ${actionThreshold}`);

  for (const scenario of scenarios) {
    const questions = buildDirectorQuestions(scenario.projection);
    const state = canonicalAgentJson({ private_context: scenario.context, candidates: scenario.projection } as never);
    const pairs = scenario.projection.map(({ candidateId, digest }) => ({ candidateId, digest }));
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const jevStart = performance.now();
      try {
        const result = await completeWithSystemOne({ settings: jevSettings, state: { private_context: scenario.context, candidates: scenario.projection }, questions });
        const composed = composeDirectorSelection(scenario.projection, result.answers, thresholds);
        const jevSelected = composed.selections[0] ? scenario.projection.find((candidate) => candidate.candidateId === composed.selections[0]!.candidateId)?.action ?? null : null;
        const jevGrade = grade(scenario, jevSelected, composed.hold);
        const input = result.usage?.inputTokens ?? 0;
        const output = result.usage?.outputTokens ?? 0;
        calls.push({ scenarioId: scenario.id, arm: "jev", repeat, ok: true, acted: composed.band === "act",
          latencyMs: Math.max(0, Math.round(performance.now() - jevStart)), inputTokens: input, outputTokens: output,
          costUsd: (input * JEV_INPUT_PER_MILLION + output * JEV_OUTPUT_PER_MILLION) / 1_000_000,
          selectedAction: composed.hold ? "hold" : jevSelected, ...jevGrade });
      } catch (error) {
        calls.push({ scenarioId: scenario.id, arm: "jev", repeat, ok: false, acted: false, error: error instanceof Error ? error.message : "error",
          latencyMs: Math.max(0, Math.round(performance.now() - jevStart)), inputTokens: 0, outputTokens: 0, costUsd: 0,
          selectedAction: null, correct: false, exact: false });
      }

      const llmStart = performance.now();
      try {
        const result = await completeWithProvider({
          provider: llmProvider, harness, preset, promptVersion: "campaign-dm-v1", schemaVersion: "campaign-dm-v1",
          parallelToolCalls: false, toolChoice: { name: "select_dm_beat" }, tools: [selectDmBeatTool(pairs)],
          messages: [{ role: "system", content: DM_DIRECTOR_SYSTEM_PROMPT }, { role: "user", content: state }],
          bodyOverrides: DIRECT_TOOL_BODY_OVERRIDES,
        });
        const latencyMs = Math.max(0, Math.round(performance.now() - llmStart));
        const input = result.usage?.promptTokens ?? 0;
        const output = result.usage?.completionTokens ?? 0;
        const call = result.message.toolCalls?.find((toolCall) => toolCall.name === "select_dm_beat");
        if (!call) throw new Error("no select_dm_beat call");
        const args = JSON.parse(call.arguments) as { composition?: Array<{ candidateId?: string }> };
        const composition = Array.isArray(args.composition) ? args.composition : [];
        const selectedAction = composition[0]?.candidateId
          ? scenario.projection.find((candidate) => candidate.candidateId === composition[0]!.candidateId)?.action ?? null
          : null;
        calls.push({ scenarioId: scenario.id, arm: "llm", repeat, ok: true, acted: true, latencyMs, inputTokens: input, outputTokens: output,
          costUsd: (input * LLM_INPUT_PER_MILLION + output * LLM_OUTPUT_PER_MILLION) / 1_000_000,
          selectedAction: composition.length === 0 ? "hold" : selectedAction, ...grade(scenario, selectedAction, composition.length === 0) });
      } catch (error) {
        calls.push({ scenarioId: scenario.id, arm: "llm", repeat, ok: false, acted: false, error: error instanceof Error ? error.message : "error",
          latencyMs: Math.max(0, Math.round(performance.now() - llmStart)), inputTokens: 0, outputTokens: 0, costUsd: 0,
          selectedAction: null, correct: false, exact: false });
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const report = renderReport({ scenarios, calls, repeats, actionThreshold, jevSettings, llmProvider });
  const outPath = path.resolve(ROOT, process.env.BENCH_OUT ?? "docs/system-one-director-benchmark.md");
  await writeFile(outPath, report, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), JSON.stringify({ scenarios: scenarios.map(({ context, ...rest }) => rest), calls }, null, 2), "utf8");
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

interface Summary {
  calls: number; okRate: number; actedRate: number; acceptedRate: number; actedAccuracy: number; exactRate: number;
  latencyMean: number; latencyP50: number; latencyP95: number;
  inputMean: number; outputMean: number; costMean: number; costTotal: number;
}

function summarize(rows: RawCall[]): Summary {
  const n = Math.max(1, rows.length);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const latencies = rows.map((row) => row.latencyMs);
  const acted = rows.filter((row) => row.acted);
  return {
    calls: rows.length,
    okRate: rows.filter((row) => row.ok).length / n,
    actedRate: rows.filter((row) => row.acted).length / n,
    acceptedRate: rows.filter((row) => row.correct).length / n,
    actedAccuracy: acted.length === 0 ? 0 : acted.filter((row) => row.correct).length / acted.length,
    exactRate: rows.filter((row) => row.exact).length / n,
    latencyMean: sum(latencies) / n,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    inputMean: sum(rows.map((row) => row.inputTokens)) / n,
    outputMean: sum(rows.map((row) => row.outputTokens)) / n,
    costMean: sum(rows.map((row) => row.costUsd)) / n,
    costTotal: sum(rows.map((row) => row.costUsd)),
  };
}

interface GatedSummary { decisions: number; jev: number; llm: number; fallback: number; accepted: number; exact: number; latencyMean: number; latencyP50: number; costMean: number; }

function gatedLane(scenarios: readonly Scenario[], calls: readonly RawCall[], repeats: number): GatedSummary {
  const decisions: Array<{ kind: "jev" | "llm" | "fallback"; latencyMs: number; costUsd: number; correct: boolean; exact: boolean }> = [];
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const jev = calls.find((row) => row.arm === "jev" && row.scenarioId === scenario.id && row.repeat === repeat);
      const llm = calls.find((row) => row.arm === "llm" && row.scenarioId === scenario.id && row.repeat === repeat);
      if (jev?.ok && jev.acted) decisions.push({ kind: "jev", latencyMs: jev.latencyMs, costUsd: jev.costUsd, correct: jev.correct, exact: jev.exact });
      else if (llm?.ok) decisions.push({ kind: "llm", latencyMs: llm.latencyMs, costUsd: llm.costUsd, correct: llm.correct, exact: llm.exact });
      else decisions.push({ kind: "fallback", latencyMs: 0, costUsd: 0, correct: false, exact: false });
    }
  }
  const n = Math.max(1, decisions.length);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    decisions: decisions.length,
    jev: decisions.filter((decision) => decision.kind === "jev").length,
    llm: decisions.filter((decision) => decision.kind === "llm").length,
    fallback: decisions.filter((decision) => decision.kind === "fallback").length,
    accepted: decisions.filter((decision) => decision.correct).length,
    exact: decisions.filter((decision) => decision.exact).length,
    latencyMean: sum(decisions.map((decision) => decision.latencyMs)) / n,
    latencyP50: percentile(decisions.map((decision) => decision.latencyMs), 0.5),
    costMean: sum(decisions.map((decision) => decision.costUsd)) / n,
  };
}

function renderReport(input: { scenarios: Scenario[]; calls: RawCall[]; repeats: number; actionThreshold: number; jevSettings: ReturnType<typeof defaultSystemOneSettings>; llmProvider: ReturnType<typeof defaultProviderSettings> }): string {
  const { scenarios, calls, repeats, actionThreshold, jevSettings, llmProvider } = input;
  const jev = summarize(calls.filter((row) => row.arm === "jev"));
  const llm = summarize(calls.filter((row) => row.arm === "llm"));
  const gated = gatedLane(scenarios, calls, repeats);
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const latencySaved = llm.latencyMean - gated.latencyMean;
  const costSaved = llm.costMean - gated.costMean;
  const lines: string[] = [];
  lines.push("# System One (Jev) Director-lane benchmark");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/benchmark-system-one-director-lane.ts\`.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The **Director beat-selection** decision on five provider-free states, solved three ways:");
  lines.push("");
  lines.push("- **Before Jev:** the production Director prompt with the exact `select_dm_beat` tool, forced against DeepSeek.");
  lines.push("- **Jev:** the real Director battery (a `progress` noul and priority score per candidate, plus hold and an aggregate choice) in one transport call.");
  lines.push("- **After Jev (gated):** the lane that would ship — Jev answers when its battery clears the action threshold, otherwise the LLM selection call runs.");
  lines.push("");
  lines.push(`The Director threshold is **${actionThreshold}**, the operating point the calibration selected. At the conservative default (0.75) Jev defers on almost every state and the lane buys reliability but no speed; the value appears once the threshold is set to the validated point. The LLM arm measures one forced call; production spends one to two grounding rounds first, so \"before Jev\" is a lower bound.`);
  lines.push("");
  lines.push("| Setting | Jev arm | LLM arm |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Endpoint | \`${jevSettings.baseUrl}\` (\`/systemone\`) | \`${llmProvider.baseUrl}\` (\`/chat/completions\`) |`);
  lines.push(`| Model | ${jevSettings.model} | ${llmProvider.model} |`);
  lines.push(`| Price in / out (USD per million) | ${JEV_INPUT_PER_MILLION} / ${JEV_OUTPUT_PER_MILLION} | ${LLM_INPUT_PER_MILLION} / ${LLM_OUTPUT_PER_MILLION} |`);
  lines.push("");
  lines.push(`Battery: ${scenarios.length} states x ${repeats} repeats = ${scenarios.length * repeats} decisions per arm.`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | Before Jev (LLM) | After Jev (gated) | Jev alone |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| Decisions | ${gated.decisions} | ${gated.decisions} | ${jev.calls} |`);
  lines.push(`| Resolved by Jev / LLM / fallback | 0 / ${gated.decisions} / 0 | ${gated.jev} / ${gated.llm} / ${gated.fallback} | — |`);
  lines.push(`| Success rate | ${pct(llm.okRate)} | ${pct((gated.decisions - gated.fallback) / Math.max(gated.decisions, 1))} | ${pct(jev.okRate)} |`);
  lines.push(`| Accepted accuracy | ${pct(llm.acceptedRate)} | ${pct(gated.accepted / Math.max(gated.decisions, 1))} | ${pct(jev.acceptedRate)} |`);
  lines.push(`| Exact accuracy | ${pct(llm.exactRate)} | ${pct(gated.exact / Math.max(gated.decisions, 1))} | ${pct(jev.exactRate)} |`);
  lines.push(`| Latency mean | ${llm.latencyMean.toFixed(0)} ms | ${gated.latencyMean.toFixed(0)} ms | ${jev.latencyMean.toFixed(0)} ms |`);
  lines.push(`| Latency p50 | ${llm.latencyP50.toFixed(0)} ms | ${gated.latencyP50.toFixed(0)} ms | ${jev.latencyP50.toFixed(0)} ms |`);
  lines.push(`| Cost / decision | ${money(llm.costMean)} | ${money(gated.costMean)} | ${money(jev.costMean)} |`);
  lines.push(`| Cost / 1,000 decisions | ${money(llm.costMean * 1000)} | ${money(gated.costMean * 1000)} | ${money(jev.costMean * 1000)} |`);
  lines.push("");
  lines.push(`**Saving per Director decision (gated vs pure LLM):** ${latencySaved.toFixed(0)} ms (${(llm.latencyMean / Math.max(gated.latencyMean, 1)).toFixed(1)}x faster), ${money(Math.abs(costSaved))} ${costSaved >= 0 ? "cheaper" : "more expensive"}. Per 1,000 decisions that is ${(latencySaved * 1000 / 1000).toFixed(0)} s (${(latencySaved * 1000 / 60000).toFixed(1)} min) and ${money(Math.abs(costSaved) * 1000)}.`);
  lines.push("");
  lines.push("Jev coverage (how often the fast path answers): " + pct(jev.actedRate) + `; when Jev acts its accepted accuracy is ${pct(jev.actedAccuracy)}.`);
  lines.push("");
  lines.push("## Per-state results");
  lines.push("");
  lines.push("| State | Preferred | Before Jev (LLM) | ok | After Jev (gated) | ok | Jev latency | LLM latency |");
  lines.push("| --- | --- | --- | :---: | --- | :---: | ---: | ---: |");
  for (const scenario of scenarios) {
    const jevRow = calls.find((row) => row.arm === "jev" && row.scenarioId === scenario.id)!;
    const llmRow = calls.find((row) => row.arm === "llm" && row.scenarioId === scenario.id)!;
    const chosen = jevRow.ok && jevRow.acted ? jevRow : llmRow;
    lines.push(`| ${scenario.id} | ${scenario.preferred} | ${llmRow.ok ? llmRow.selectedAction ?? "—" : `error: ${llmRow.error ?? "unknown"}`} | ${llmRow.correct ? "yes" : "no"} | ${chosen.ok ? chosen.selectedAction ?? "—" : "—"} (${chosen === jevRow ? "jev" : "llm"}) | ${chosen.correct ? "yes" : "no"} | ${jevRow.latencyMs} ms | ${llmRow.latencyMs} ms |`);
  }
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push(`- **Latency.** The gated lane averaged ${gated.latencyMean.toFixed(0)} ms per decision vs ${llm.latencyMean.toFixed(0)} ms for the LLM alone (p50 ${gated.latencyP50.toFixed(0)} ms vs ${llm.latencyP50.toFixed(0)} ms): ${(llm.latencyMean / Math.max(gated.latencyMean, 1)).toFixed(1)}x faster. A bare Jev call averaged ${jev.latencyMean.toFixed(0)} ms.`);
  lines.push(`- **Reliability.** Jev returned a schema-valid battery on ${pct(jev.okRate)} of calls; the LLM selection call produced a usable tool call on ${pct(llm.okRate)}.`);
  lines.push(`- **Accuracy.** Gated accepted accuracy ${pct(gated.accepted / Math.max(gated.decisions, 1))} vs ${pct(llm.acceptedRate)} for the LLM alone; Jev's acted accuracy was ${pct(jev.actedAccuracy)}.`);
  lines.push(`- **Cost.** Gated cost ${money(gated.costMean)} per decision vs ${money(llm.costMean)}: ${costSaved >= 0 ? "cheaper" : "more expensive"} by ${money(Math.abs(costSaved))}. Jev output tokens are free, which offsets its larger input prompt.`);
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push('export PROXY_API_KEY="$(rg -o \'^PROXY_API_KEY=.*\' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"');
  lines.push("export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash");
  lines.push("npx tsx scripts/benchmark-system-one-director-lane.ts");
  lines.push("```");
  lines.push("");
  lines.push("Raw per-call data: `docs/system-one-director-benchmark.json`.");
  lines.push("");
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
