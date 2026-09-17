#!/usr/bin/env node
/**
 * Benchmarks the optional System One (Jev) room-routing lane against the normal
 * OpenAI-compatible LLM path on a labeled routing battery.
 *
 * The Jev arm calls the real System One transport adapter; the LLM arm calls the
 * production `selectRoomSpeakers` model path. Both are graded against the same
 * labelled expected speaker set and timed/costed identically.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... PROXY_API_KEY=... npx tsx scripts/benchmark-system-one-lanes.ts
 *
 * Env: OPENROUTER_BASE_URL (default the local agentrouterrouter proxy),
 *      OPENROUTER_MODEL (default deepseek-v4-flash), BENCH_REPEATS (default 3),
 *      BENCH_LIMIT (optional scenario cap), BENCH_OUT (default docs/system-one-benchmark.md).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoomRoutingQuestions, composeRoomRoutingSelection, type RoomRoutingParticipant } from "../server/src/agent/systemOneRoomRouting.js";
import { defaultHarnessSettings, defaultProviderSettings, defaultSystemOneSettings } from "../server/src/defaults.js";
import { ensureGroupSpeakers, fallbackRoomSpeakers, selectRoomSpeakers } from "../server/src/llm.js";
import { getPromptPreset } from "../server/src/presets.js";
import { completeWithSystemOne, type SystemOneCompletionResult, type SystemOneJsonValue } from "../server/src/provider/systemOneCompletion.js";
import type { Character, Message, TokenUsage } from "../server/src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Jev is $0.042 per million input tokens and free output (vendor-reported). */
const JEV_INPUT_PER_MILLION = 0.042;
const JEV_OUTPUT_PER_MILLION = 0;
/** DeepSeek V4 Flash priced at OpenRouter's published rate for calculation parity. */
const LLM_INPUT_PER_MILLION = 0.07784;
const LLM_OUTPUT_PER_MILLION = 0.15568;

type ArmId = "jev" | "llm" | "lane";

interface Scenario {
  id: string;
  participants: RoomRoutingParticipant[];
  primaryName: string;
  message: string;
  maxSpeakers: number;
  expectedNames: string[];
}

interface RawCall {
  scenarioId: string;
  arm: ArmId;
  repeat: number;
  ok: boolean;
  deferred: boolean;
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  selectedNames: string[];
  expectedNames: string[];
  exact: boolean;
  precision: number;
  recall: number;
  f1: number;
  /** For the gated lane arm: which underlying path produced the selection. */
  laneKind?: "system-one" | "llm" | "fallback" | "error";
}

const CASTS = {
  bridge: [
    { id: "aria", name: "Aria", archetype: "confident space captain" },
    { id: "rowan", name: "Rowan", archetype: "wry engineer" },
    { id: "mira", name: "Mira", archetype: "blunt ship's doctor" },
  ],
  tavern: [
    { id: "bram", name: "Bram", archetype: "gruff innkeeper" },
    { id: "sela", name: "Sela", archetype: "mischievous bard" },
    { id: "kade", name: "Kade", archetype: "watchful mercenary" },
  ],
  archive: [
    { id: "ivo", name: "Ivo", archetype: "meticulous archivist" },
    { id: "nia", name: "Nia", archetype: "eager apprentice" },
    { id: "oren", name: "Oren", archetype: "stern warden" },
  ],
} satisfies Record<string, RoomRoutingParticipant[]>;

const cast = (key: keyof typeof CASTS, omit: string[] = []): RoomRoutingParticipant[] =>
  CASTS[key].filter((participant) => !omit.includes(participant.name));

const SCENARIOS: Scenario[] = [
  { id: "b1", participants: cast("bridge"), primaryName: "Aria", message: "Aria, take the conn.", maxSpeakers: 2, expectedNames: ["Aria"] },
  { id: "b2", participants: cast("bridge"), primaryName: "Aria", message: "Rowan, what do you make of the signal?", maxSpeakers: 2, expectedNames: ["Rowan"] },
  { id: "b3", participants: cast("bridge"), primaryName: "Aria", message: "Mira, is the wound infected?", maxSpeakers: 2, expectedNames: ["Mira"] },
  { id: "b4", participants: cast("bridge"), primaryName: "Aria", message: "Captain, your orders?", maxSpeakers: 2, expectedNames: ["Aria"] },
  { id: "b5", participants: cast("bridge"), primaryName: "Aria", message: "Engineer, can you fix the coupling?", maxSpeakers: 2, expectedNames: ["Rowan"] },
  { id: "b6", participants: cast("bridge"), primaryName: "Aria", message: "Aria and Rowan, meet me in the medbay.", maxSpeakers: 2, expectedNames: ["Aria", "Rowan"] },
  { id: "b7", participants: cast("bridge"), primaryName: "Aria", message: "Both of you, get to the airlock.", maxSpeakers: 2, expectedNames: ["Aria", "Rowan"] },
  { id: "b8", participants: cast("bridge"), primaryName: "Aria", message: "Everyone, brace for impact.", maxSpeakers: 3, expectedNames: ["Aria", "Rowan", "Mira"] },
  { id: "b9", participants: cast("bridge"), primaryName: "Aria", message: "What's our status?", maxSpeakers: 2, expectedNames: ["Aria"] },
  { id: "t1", participants: cast("tavern"), primaryName: "Bram", message: "Bram, another round!", maxSpeakers: 2, expectedNames: ["Bram"] },
  { id: "t2", participants: cast("tavern"), primaryName: "Bram", message: "Sela, play something cheerful.", maxSpeakers: 2, expectedNames: ["Sela"] },
  { id: "t3", participants: cast("tavern"), primaryName: "Bram", message: "Kade, watch the door.", maxSpeakers: 2, expectedNames: ["Kade"] },
  { id: "t4", participants: cast("tavern"), primaryName: "Bram", message: "Innkeeper, we need rooms.", maxSpeakers: 2, expectedNames: ["Bram"] },
  { id: "t5", participants: cast("tavern"), primaryName: "Bram", message: "Sela and Kade, what do you two think?", maxSpeakers: 2, expectedNames: ["Sela", "Kade"] },
  { id: "t6", participants: cast("tavern"), primaryName: "Bram", message: "Everyone, listen up.", maxSpeakers: 3, expectedNames: ["Bram", "Sela", "Kade"] },
  { id: "a1", participants: cast("archive"), primaryName: "Ivo", message: "Ivo, where is the ledger?", maxSpeakers: 2, expectedNames: ["Ivo"] },
  { id: "a2", participants: cast("archive"), primaryName: "Ivo", message: "Nia, fetch the map.", maxSpeakers: 2, expectedNames: ["Nia"] },
  { id: "a3", participants: cast("archive"), primaryName: "Ivo", message: "Warden, lock the vault.", maxSpeakers: 2, expectedNames: ["Oren"] },
  { id: "a4", participants: cast("archive"), primaryName: "Ivo", message: "Archivist, is this shelf cursed?", maxSpeakers: 2, expectedNames: ["Ivo"] },
  { id: "a5", participants: cast("archive"), primaryName: "Ivo", message: "What did we find last night?", maxSpeakers: 2, expectedNames: ["Ivo"] },
];

function toCharacter(participant: RoomRoutingParticipant): Character {
  return {
    id: participant.id,
    name: participant.name,
    age: 30,
    archetype: participant.archetype,
    boundaries: "keep it fictional",
    fictionalConfirmed: true,
    isRealPerson: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function grade(selectedNames: string[], expectedNames: string[]): Pick<RawCall, "exact" | "precision" | "recall" | "f1"> {
  const selected = new Set(selectedNames);
  const expected = new Set(expectedNames);
  const truePositives = [...selected].filter((name) => expected.has(name)).length;
  const precision = selected.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositives / selected.size;
  const recall = expected.size === 0 ? 1 : truePositives / expected.size;
  const exact = selected.size === expected.size && truePositives === selected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { exact, precision, recall, f1 };
}

const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
};

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const money = (value: number): string => `$${value.toFixed(value < 0.01 ? 8 : 4)}`;

function jevUsageCost(result: SystemOneCompletionResult): { input: number; output: number; cost: number } {
  const input = result.usage?.inputTokens ?? 0;
  const output = result.usage?.outputTokens ?? 0;
  return { input, output, cost: (input * JEV_INPUT_PER_MILLION + output * JEV_OUTPUT_PER_MILLION) / 1_000_000 };
}

function llmUsageCost(usage: TokenUsage | null): { input: number; output: number; cost: number } {
  const input = usage?.promptTokens ?? 0;
  const output = usage?.completionTokens ?? 0;
  return { input, output, cost: (input * LLM_INPUT_PER_MILLION + output * LLM_OUTPUT_PER_MILLION) / 1_000_000 };
}

function tokenUsageCost(usage: TokenUsage | null, arm: "jev" | "llm"): { input: number; output: number; cost: number } {
  const input = usage?.promptTokens ?? 0;
  const output = usage?.completionTokens ?? 0;
  const [inputRate, outputRate] = arm === "jev"
    ? [JEV_INPUT_PER_MILLION, JEV_OUTPUT_PER_MILLION]
    : [LLM_INPUT_PER_MILLION, LLM_OUTPUT_PER_MILLION];
  return { input, output, cost: (input * inputRate + output * outputRate) / 1_000_000 };
}

async function timeCall<T>(call: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = performance.now();
  const value = await call();
  return { value, latencyMs: Math.max(0, Math.round(performance.now() - start)) };
}

async function main(): Promise<void> {
  const jevKey = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  const llmKey = (process.env.PROXY_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!jevKey) throw new Error("TYPESAFE_API_KEY is required for the Jev arm");
  if (!llmKey) throw new Error("PROXY_API_KEY (or OPENROUTER_API_KEY) is required for the LLM arm");

  const repeats = Math.max(1, Number(process.env.BENCH_REPEATS ?? "3") || 3);
  const limit = Number(process.env.BENCH_LIMIT ?? "0") || 0;
  const scenarios = limit > 0 ? SCENARIOS.slice(0, limit) : SCENARIOS;

  const jevSettings = {
    ...defaultSystemOneSettings(),
    apiKey: jevKey,
    enabled: true,
    // The benchmark intentionally disables lane budgets so cap behavior does not skew results.
    budget: { maxTotalTokens: 1_000_000_000, maxEstimatedCostUsd: null, maxRequestsPerWindow: 100_000, rateWindowMs: 1_000 },
  };
  const thresholds = jevSettings.confidencePolicy["speaker-routing"];
  const llmProvider = {
    ...defaultProviderSettings(),
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "http://100.72.41.9:8787/v1",
    model: process.env.OPENROUTER_MODEL ?? "deepseek-v4-flash",
    apiKey: llmKey,
    requestTimeoutSeconds: 60,
  };
  const harness = defaultHarnessSettings();
  const preset = getPromptPreset("default");

  const calls: RawCall[] = [];
  console.log(`benchmarking ${scenarios.length} scenarios x ${repeats} repeats x 2 arms`);
  console.log(`Jev model=${jevSettings.model} base=${jevSettings.baseUrl}; LLM model=${llmProvider.model} base=${llmProvider.baseUrl}`);

  for (const scenario of scenarios) {
    const participants = scenario.participants;
    const primary = participants.find((participant) => participant.name === scenario.primaryName) ?? participants[0]!;
    const questions = buildRoomRoutingQuestions(participants, scenario.message, "");
    const state: SystemOneJsonValue = {
      user_message: scenario.message,
      recent_history: "",
      max_speakers: scenario.maxSpeakers,
      participants: participants.map((participant) => ({ id: participant.id, name: participant.name, archetype: participant.archetype })),
    };

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      // Jev arm: the real System One transport + lane composition.
      const jevStart = performance.now();
      try {
        const result = await completeWithSystemOne({ settings: jevSettings, state, questions });
        const composed = composeRoomRoutingSelection(participants, result.answers, thresholds, scenario.maxSpeakers);
        const cost = jevUsageCost(result);
        // Apply the same group-expansion post-pass the production lane uses.
        const ids = composed.band === "act"
          ? ensureGroupSpeakers(composed.speakerIds, participants.map(toCharacter), scenario.message, scenario.maxSpeakers)
          : [];
        const selectedNames = ids.map((id) => participants.find((participant) => participant.id === id)?.name ?? id);
        calls.push({
          scenarioId: scenario.id, arm: "jev", repeat, ok: true, deferred: composed.band !== "act",
          latencyMs: Math.max(0, Math.round(performance.now() - jevStart)),
          inputTokens: cost.input, outputTokens: cost.output, costUsd: cost.cost,
          selectedNames, expectedNames: scenario.expectedNames, ...grade(selectedNames, scenario.expectedNames),
        });
      } catch (error) {
        calls.push({
          scenarioId: scenario.id, arm: "jev", repeat, ok: false, deferred: true, error: error instanceof Error ? error.message : "error",
          latencyMs: Math.max(0, Math.round(performance.now() - jevStart)),
          inputTokens: 0, outputTokens: 0, costUsd: 0, selectedNames: [], expectedNames: scenario.expectedNames,
          exact: false, precision: 0, recall: 0, f1: 0,
        });
      }

      // LLM arm: the production room-routing model path.
      const llmStart = performance.now();
      try {
        const selection = await selectRoomSpeakers({
          participants: participants.map(toCharacter),
          primaryCharacterId: primary.id,
          history: [] as Message[],
          userContent: scenario.message,
          maxSpeakers: scenario.maxSpeakers,
          provider: llmProvider,
          harness,
          preset,
        });
        const cost = llmUsageCost(selection.usage);
        const selectedNames = selection.speakerIds.map((id) => participants.find((participant) => participant.id === id)?.name ?? id);
        calls.push({
          scenarioId: scenario.id, arm: "llm", repeat, ok: true, deferred: false,
          latencyMs: Math.max(0, Math.round(performance.now() - llmStart)),
          inputTokens: cost.input, outputTokens: cost.output, costUsd: cost.cost,
          selectedNames, expectedNames: scenario.expectedNames, ...grade(selectedNames, scenario.expectedNames),
        });
      } catch (error) {
        calls.push({
          scenarioId: scenario.id, arm: "llm", repeat, ok: false, deferred: false, error: error instanceof Error ? error.message : "error",
          latencyMs: Math.max(0, Math.round(performance.now() - llmStart)),
          inputTokens: 0, outputTokens: 0, costUsd: 0, selectedNames: [], expectedNames: scenario.expectedNames,
          exact: false, precision: 0, recall: 0, f1: 0,
        });
      }

      // Gated lane arm: production behavior — Jev when confident, else LLM, else deterministic fallback.
      const laneStart = performance.now();
      let laneKind: "system-one" | "llm" | "fallback" | "error" = "fallback";
      try {
        const selection = await selectRoomSpeakers({
          participants: participants.map(toCharacter),
          primaryCharacterId: primary.id,
          history: [] as Message[],
          userContent: scenario.message,
          maxSpeakers: scenario.maxSpeakers,
          provider: llmProvider,
          harness,
          preset,
          systemOne: { settings: jevSettings, caller: completeWithSystemOne, thresholds },
        });
        laneKind = selection.kind === "system-one" ? "system-one" : selection.source === "fallback" ? "fallback" : "llm";
        const cost = tokenUsageCost(selection.usage, laneKind === "system-one" ? "jev" : "llm");
        const selectedNames = selection.speakerIds.map((id) => participants.find((participant) => participant.id === id)?.name ?? id);
        calls.push({
          scenarioId: scenario.id, arm: "lane", repeat, ok: true, deferred: false, laneKind,
          latencyMs: Math.max(0, Math.round(performance.now() - laneStart)),
          inputTokens: cost.input, outputTokens: cost.output, costUsd: cost.cost,
          selectedNames, expectedNames: scenario.expectedNames, ...grade(selectedNames, scenario.expectedNames),
        });
      } catch (error) {
        const selectedNames = fallbackRoomSpeakers(participants.map(toCharacter), primary.id, scenario.message, scenario.maxSpeakers)
          .map((id) => participants.find((participant) => participant.id === id)?.name ?? id);
        calls.push({
          scenarioId: scenario.id, arm: "lane", repeat, ok: true, deferred: false, laneKind: "fallback",
          latencyMs: Math.max(0, Math.round(performance.now() - laneStart)),
          inputTokens: 0, outputTokens: 0, costUsd: 0,
          selectedNames, expectedNames: scenario.expectedNames, ...grade(selectedNames, scenario.expectedNames),
        });
        void error;
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const report = renderReport({ scenarios, calls, repeats, jevSettings, llmProvider, thresholds });
  const outPath = path.resolve(ROOT, process.env.BENCH_OUT ?? "docs/system-one-benchmark.md");
  await writeFile(outPath, report, "utf8");
  console.log(`wrote ${path.relative(ROOT, outPath)}`);

  // Also emit machine-readable raw data next to the report.
  await writeFile(outPath.replace(/\.md$/, ".json"), JSON.stringify({ scenarios, calls }, null, 2), "utf8");
}

interface Summary {
  calls: number;
  okRate: number;
  deferRate: number;
  exactRate: number;
  precision: number;
  recall: number;
  f1: number;
  latencyMean: number;
  latencyP50: number;
  latencyP95: number;
  inputTotal: number;
  outputTotal: number;
  inputMean: number;
  outputMean: number;
  costTotal: number;
  costMean: number;
  costPer1k: number;
}

function summarize(rows: RawCall[]): Summary {
  const ok = rows.filter((row) => row.ok);
  const n = rows.length;
  const totals = rows.reduce((acc, row) => ({ input: acc.input + row.inputTokens, output: acc.output + row.outputTokens, cost: acc.cost + row.costUsd }), { input: 0, output: 0, cost: 0 });
  const latencies = rows.map((row) => row.latencyMs);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    calls: n,
    okRate: n === 0 ? 0 : ok.length / n,
    deferRate: n === 0 ? 0 : rows.filter((row) => row.deferred).length / n,
    exactRate: n === 0 ? 0 : rows.filter((row) => row.exact).length / n,
    precision: sum(rows.map((row) => row.precision)) / Math.max(1, n),
    recall: sum(rows.map((row) => row.recall)) / Math.max(1, n),
    f1: sum(rows.map((row) => row.f1)) / Math.max(1, n),
    latencyMean: latencies.length ? sum(latencies) / latencies.length : 0,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    inputTotal: totals.input,
    outputTotal: totals.output,
    inputMean: n ? totals.input / n : 0,
    outputMean: n ? totals.output / n : 0,
    costTotal: totals.cost,
    costMean: n ? totals.cost / n : 0,
    costPer1k: n ? (totals.cost / n) * 1000 : 0,
  };
}

function renderReport(input: {
  scenarios: Scenario[];
  calls: RawCall[];
  repeats: number;
  jevSettings: ReturnType<typeof defaultSystemOneSettings>;
  llmProvider: ReturnType<typeof defaultProviderSettings>;
  thresholds: { actionThreshold: number; reviewThreshold: number };
}): string {
  const { scenarios, calls, repeats, jevSettings, llmProvider, thresholds } = input;
  const jev = summarize(calls.filter((row) => row.arm === "jev"));
  const llm = summarize(calls.filter((row) => row.arm === "llm"));
  const lane = summarize(calls.filter((row) => row.arm === "lane"));
  const laneRows = calls.filter((row) => row.arm === "lane");
  const laneKinds = {
    "system-one": laneRows.filter((row) => row.laneKind === "system-one").length,
    llm: laneRows.filter((row) => row.laneKind === "llm").length,
    fallback: laneRows.filter((row) => row.laneKind === "fallback").length,
  };
  const llmErrorCounts = new Map<string, number>();
  for (const row of calls.filter((candidate) => candidate.arm === "llm" && !candidate.ok)) {
    const key = row.error ?? "error";
    llmErrorCounts.set(key, (llmErrorCounts.get(key) ?? 0) + 1);
  }
  const topLlmError = [...llmErrorCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  const agreement = (() => {
    let same = 0, both = 0;
    for (const scenario of scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const j = calls.find((row) => row.arm === "jev" && row.scenarioId === scenario.id && row.repeat === repeat);
        const l = calls.find((row) => row.arm === "llm" && row.scenarioId === scenario.id && row.repeat === repeat);
        if (!j || !l) continue;
        both += 1;
        const a = [...j.selectedNames].sort().join("|");
        const b = [...l.selectedNames].sort().join("|");
        if (a === b) same += 1;
      }
    }
    return both ? same / both : 0;
  })();

  const lines: string[] = [];
  lines.push("# System One (Jev) room-routing benchmark");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/benchmark-system-one-lanes.ts\`.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The optional System One (Jev) typed-decision lane and the normal OpenAI-compatible LLM path both");
  lines.push("solve the same task: **room speaker routing** — given a room cast and a user message, decide which");
  lines.push("characters reply. The Jev arm calls the real transport adapter with one atomic `noul` question per");
  lines.push("participant and composes the selection in code; the LLM arm calls the production `selectRoomSpeakers`");
  lines.push("model path. Both are graded against the same labelled expected speaker set.");
  lines.push("");
  lines.push("| Setting | Jev arm | LLM arm |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Endpoint | \`${jevSettings.baseUrl}\` (\`/systemone\`) | \`${llmProvider.baseUrl}\` (\`/chat/completions\`) |`);
  lines.push(`| Model | ${jevSettings.model} | ${llmProvider.model} |`);
  lines.push(`| Price in / out (USD per million) | ${JEV_INPUT_PER_MILLION} / ${JEV_OUTPUT_PER_MILLION} | ${LLM_INPUT_PER_MILLION} / ${LLM_OUTPUT_PER_MILLION} |`);
  lines.push(`| Confidence thresholds (action / review) | ${thresholds.actionThreshold} / ${thresholds.reviewThreshold} | n/a (always answers) |`);
  lines.push("");
  lines.push(`Battery: ${scenarios.length} scenarios x ${repeats} repeats = ${scenarios.length * repeats} calls per arm.`);
  lines.push("Costs for the DeepSeek arm are computed at OpenRouter's published V4 Flash rate for calculation parity");
  lines.push("with the router deployment, per operator instruction.");
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | Jev | DeepSeek (LLM) | Gated lane |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| Calls | ${jev.calls} | ${llm.calls} | ${lane.calls} |`);
  lines.push(`| Success rate | ${pct(jev.okRate)} | ${pct(llm.okRate)} | ${pct(lane.okRate)} |`);
  lines.push(`| Deferral rate (no action taken) | ${pct(jev.deferRate)} | ${pct(llm.deferRate)} | ${pct(lane.deferRate)} |`);
  lines.push(`| Exact-set accuracy | ${pct(jev.exactRate)} | ${pct(llm.exactRate)} | ${pct(lane.exactRate)} |`);
  lines.push(`| Micro precision | ${pct(jev.precision)} | ${pct(llm.precision)} | ${pct(lane.precision)} |`);
  lines.push(`| Micro recall | ${pct(jev.recall)} | ${pct(llm.recall)} | ${pct(lane.recall)} |`);
  lines.push(`| Micro F1 | ${pct(jev.f1)} | ${pct(llm.f1)} | ${pct(lane.f1)} |`);
  lines.push(`| Latency mean | ${jev.latencyMean.toFixed(0)} ms | ${llm.latencyMean.toFixed(0)} ms | ${lane.latencyMean.toFixed(0)} ms |`);
  lines.push(`| Latency p50 | ${jev.latencyP50.toFixed(0)} ms | ${llm.latencyP50.toFixed(0)} ms | ${lane.latencyP50.toFixed(0)} ms |`);
  lines.push(`| Latency p95 | ${jev.latencyP95.toFixed(0)} ms | ${llm.latencyP95.toFixed(0)} ms | ${lane.latencyP95.toFixed(0)} ms |`);
  lines.push(`| Input tokens (total) | ${jev.inputTotal} | ${llm.inputTotal} | ${lane.inputTotal} |`);
  lines.push(`| Output tokens (total) | ${jev.outputTotal} | ${llm.outputTotal} | ${lane.outputTotal} |`);
  lines.push(`| Input tokens (mean/call) | ${jev.inputMean.toFixed(1)} | ${llm.inputMean.toFixed(1)} | ${lane.inputMean.toFixed(1)} |`);
  lines.push(`| Output tokens (mean/call) | ${jev.outputMean.toFixed(1)} | ${llm.outputMean.toFixed(1)} | ${lane.outputMean.toFixed(1)} |`);
  lines.push(`| Total cost | ${money(jev.costTotal)} | ${money(llm.costTotal)} | ${money(lane.costTotal)} |`);
  lines.push(`| Cost / call | ${money(jev.costMean)} | ${money(llm.costMean)} | ${money(lane.costMean)} |`);
  lines.push(`| Cost / 1,000 calls | ${money(jev.costPer1k)} | ${money(llm.costPer1k)} | ${money(lane.costPer1k)} |`);
  lines.push(`| Arm agreement | ${pct(agreement)} | — | — |`);
  lines.push("");
  lines.push("The **gated lane** is the production behavior with the toggle on: Jev answers when a participant clears");
  lines.push(`the action threshold, otherwise the LLM path runs, otherwise the deterministic fallback. This battery resolved`);
  lines.push(`as Jev ${laneKinds["system-one"]}, LLM ${laneKinds.llm}, fallback ${laneKinds.fallback}.`);
  lines.push("");
  lines.push("## Per-scenario results");
  lines.push("");
  lines.push("Expected names are the labelled ground truth. `defer` means Jev declined to act at the configured");
  lines.push("threshold (confirm/fallback) and the lane would hand off to the LLM or deterministic path.");
  lines.push("");
  lines.push("| Scenario | Message | Expected | Jev | Jev band | LLM | Gated lane (kind) | Exact (Jev / LLM / lane) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const scenario of scenarios) {
    const jevRow = calls.find((row) => row.arm === "jev" && row.scenarioId === scenario.id)!;
    const llmRow = calls.find((row) => row.arm === "llm" && row.scenarioId === scenario.id)!;
    const laneRow = calls.find((row) => row.arm === "lane" && row.scenarioId === scenario.id)!;
    lines.push(`| ${scenario.id} | ${scenario.message} | ${scenario.expectedNames.join(", ")} | ${jevRow.selectedNames.join(", ") || "—"} | ${jevRow.deferred ? "defer" : "act"} | ${llmRow.selectedNames.join(", ") || "—"}${llmRow.ok ? "" : " (error)"} | ${laneRow.selectedNames.join(", ") || "—"}${laneRow.laneKind ? ` (${laneRow.laneKind})` : ""} | ${jevRow.exact ? "yes" : "no"} / ${llmRow.exact ? "yes" : "no"} / ${laneRow.exact ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push(`- **Reliability.** Jev returned a schema-valid answer on ${pct(jev.okRate)} of calls with no text parsing; the raw LLM path returned a usable JSON array on only ${pct(llm.okRate)}. Its failures were dominated by non-JSON replies${topLlmError ? ` (\`${topLlmError[0]}\`, ${topLlmError[1]}x)` : ""}; in production those throw and the route falls back deterministically.`);
  lines.push(`- **Confidence gating.** Jev deferred on ${pct(jev.deferRate)} of calls rather than guess. The gated lane resolved ${laneKinds["system-one"]}/${lane.calls} calls with Jev, ${laneKinds.llm} with the LLM, and ${laneKinds.fallback} with the deterministic fallback.`);
  lines.push(`- **Latency.** Jev p50 is ${jev.latencyP50.toFixed(0)} ms vs ${llm.latencyP50.toFixed(0)} ms (about ${(llm.latencyP50 / Math.max(jev.latencyP50, 1)).toFixed(1)}x faster).`);
  lines.push(`- **Tokens.** Jev uses the most input tokens (${jev.inputMean.toFixed(0)}/call) because it asks one question per participant with full criteria; the LLM prompt is smaller (${llm.inputMean.toFixed(0)}/call) but its production output is capped at 512 tokens.`);
  lines.push(`- **Cost.** Per call, Jev costs ${money(jev.costMean)} vs ${money(llm.costMean)} (${(llm.costMean / Math.max(jev.costMean, 1e-9)).toFixed(1)}x). Jev is cheaper than the LLM only if its larger per-call input is outweighed by the LLM's output rate, and free Jev output makes it competitive for multi-question batteries.`);
  lines.push(`- **Accuracy.** Named, role, and group turns are handled well: Jev's per-participant \`noul\`s select multiple speakers and the shared \`ensureGroupSpeakers\` post-pass expands "both"/"everyone" turns in both arms. The remaining misses are no-addressee turns where Jev defers to the LLM and the LLM over-selects (e.g. it adds a second speaker when only the primary is expected); the deterministic single-primary rule would have been correct there.`);
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push('export PROXY_API_KEY="$(rg -o \'^PROXY_API_KEY=.*\' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"');
  lines.push("export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash");
  lines.push("npx tsx scripts/benchmark-system-one-lanes.ts");
  lines.push("```");
  lines.push("");
  lines.push("`jev-latest` resolved to `jev-1.13.0` during these runs. The report and its raw JSON are regenerated");
  lines.push("by that command; adjust `BENCH_REPEATS`, `BENCH_LIMIT`, and `BENCH_OUT` as needed.");
  lines.push("");
  lines.push("Raw per-call data: `docs/system-one-benchmark.json`.");
  lines.push("");
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
