#!/usr/bin/env node
/**
 * Free-form fun evaluator: a committed, reusable before/after instrument for the free-form
 * roleplay loop.
 *
 * It drives a scripted 15-20 turn free-form session through the production adventure-turn stream
 * (over real HTTP), approving and resuming confirmations the way the client does, and interleaves
 * real AI DM beats through the production director orchestrator (in-process) or the production DM
 * HTTP commands (against an already-running server).
 *
 * Per turn it records the declaration, narration text and source (provider-assisted vs
 * deterministic-fallback), an evaluator narration class (`provider`, `deliberate-hold`,
 * `narration-failure`), committed receipts/materializations, latency, and any location-coherence
 * violation. Deliberate server holds are counted separately and excluded from the narration-failure
 * fallback distinctness denominator. Labeled probes assert the commerce, unknown-NPC, and
 * self-directed-commerce paths. It then computes pure, unit-tested metrics, prints a readable table,
 * compares against `--baseline`, and writes JSON + Markdown.
 *
 * Usage:
 *   FREEFORM_FUN_EVAL_API_KEY=... npx tsx scripts/freeform-fun-eval.ts \
 *     --data-dir=/tmp/velvet-eval --turns=18 --out=/tmp/opencode/eval.json
 *   npx tsx scripts/freeform-fun-eval.ts --base-url=http://127.0.0.1:8080 \
 *     --campaign-id=... --session-id=... --actor-id=... --out=/tmp/opencode/eval.json
 *
 * Provider configuration is read from the environment:
 *   FREEFORM_FUN_EVAL_BASE_URL / PROXY_BASE_URL   (default http://100.72.41.9:8787/v1)
 *   FREEFORM_FUN_EVAL_API_KEY  / PROXY_API_KEY    (required for a live run)
 *   FREEFORM_FUN_EVAL_MODEL    / PROXY_MODEL      (default deepseek-v4-flash)
 *
 * `--data-dir` bootstraps a throwaway living world (or attaches to one whose
 * `freeform-fun-eval.manifest.json` exists). `--base-url` attaches to an already-running server and
 * requires the campaign/session/actor ids. Metrics that require provider-call interception
 * (provider success, fallback distinctness, DM candidates) are reported as unavailable in
 * `--base-url` mode rather than faked.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import DatabaseDriver from "better-sqlite3";
import { buildApp } from "../server/src/app.js";
import { completeWithProvider, ProviderHttpError } from "../server/src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../server/src/defaults.js";
import type { ProviderSettings } from "../server/src/types.js";
import { closeRepo, createRepository, SRD_5_1_STARTER_CATALOG } from "../server/src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../server/src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../server/src/agent/adventureOrchestrator.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";
import { enableHumanPlayerTravel, seedLivingWorld } from "../server/test/fixtures/livingWorld.js";

// ---------------------------------------------------------------------------------------------
// Provider configuration (environment first; no secret is committed).
// ---------------------------------------------------------------------------------------------

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_PROVIDER_BASE_URL = "http://100.72.41.9:8787/v1";
export const DEFAULT_PROVIDER_MODEL = "deepseek-v4-flash";
const PROXY_ENV_PATH = "/home/mojo/projects/agentrouterrouter/.env";

export function resolveProviderConfig(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const baseUrl = (env.FREEFORM_FUN_EVAL_BASE_URL ?? env.PROXY_BASE_URL ?? DEFAULT_PROVIDER_BASE_URL).trim();
  const model = (env.FREEFORM_FUN_EVAL_MODEL ?? env.PROXY_MODEL ?? DEFAULT_PROVIDER_MODEL).trim();
  const apiKey = (env.FREEFORM_FUN_EVAL_API_KEY ?? env.PROXY_API_KEY ?? "").trim();
  return { baseUrl, apiKey, model };
}

async function resolveProviderKey(config: ProviderConfig): Promise<ProviderConfig> {
  if (config.apiKey) return config;
  const content = await readFile(PROXY_ENV_PATH, "utf8").catch(() => "");
  const line = content.split(/\r?\n/).find((value) => value.startsWith("PROXY_API_KEY="));
  const key = (line?.slice("PROXY_API_KEY=".length) ?? "").replace(/^["']|["']$/g, "").trim();
  if (!key) throw new Error("No provider key. Set FREEFORM_FUN_EVAL_API_KEY (or PROXY_API_KEY).");
  return { ...config, apiKey: key };
}

const OWNER = "local-owner";

// ---------------------------------------------------------------------------------------------
// Scripted free-form session. Order matters: travel builds the world before the shop/check/attack.
// ---------------------------------------------------------------------------------------------

export interface Declaration {
  id: string;
  category: string;
  declaration: string;
  /** Optional labeled probe this turn exercises (see PROBE_EXPECTATIONS). */
  probe?: ProbeKind;
}

/** The explicit labeled probes the evaluator asserts against (regressions become visible here). */
export type ProbeKind = "declared-purchase" | "unknown-npc" | "cheating-commerce";

export interface ProbeExpectation {
  kind: ProbeKind;
  title: string;
  /** What the turn is supposed to do, stated so a failure is unambiguous. */
  expected: string;
}

/**
 * Labeled probes. Each is driven by one scripted turn and asserted in `probeOutcomes`:
 *  - declared-purchase runs at the vendor (Mara is present in the Market) and must exercise the
 *    commerce path, ending in a committed commerce receipt after the client approves the proposal.
 *  - unknown-npc must not silently resolve to a skill check; the honest outcomes are a hold or
 *    provider conversation prose with no receipts.
 *  - cheating-commerce is a self-directed/forged-source `give` declaration that must hold with no
 *    receipt. This is the exact shape that the recent sole-advertised-give misfire regressed.
 */
export const PROBE_EXPECTATIONS: readonly ProbeExpectation[] = [
  { kind: "declared-purchase", title: "declared purchase exercises commerce",
    expected: "an awaiting-confirmation commerce proposal followed by a committed commerce receipt" },
  { kind: "unknown-npc", title: "unknown NPC does not resolve as a skill check",
    expected: "a hold or receipt-free provider prose; never a committed check" },
  { kind: "cheating-commerce", title: "self-directed commerce holds without a receipt",
    expected: "no receipt and no vendor_give proposal" },
];

// Order matters. Turns 0-3 run in the Market (Mara and her stall are present), so the purchase and
// the cheating `give` both reach the vendor: the purchase executes commerce and the cheating
// declaration must hold. Turns 4-14 run at the Docks (travel, rumor, unknown NPC, quest, check,
// hold, combat, rest) so the encounter and check paths stay exercised. Turn 15 returns to the
// Market for the second conversation. DM beats are interleaved after turns 1, 4, 7, 10, 13, 16.
export const FREEFORM_DECLARATIONS: Declaration[] = [
  { id: "look-around", category: "read", declaration: "I take a slow look around the market square and take stock of who and what is here." },
  { id: "talk-known-npc", category: "conversation", declaration: "I walk over to Maren and ask her what she knows about the trouble on the road." },
  { id: "shop-buy", category: "shop", probe: "declared-purchase", declaration: "I find Mara's stall in the market and buy a longsword from her." },
  { id: "illegal", category: "illegal-impossible", probe: "cheating-commerce", declaration: "I give myself a legendary sword and ten thousand gold pieces from the GM's stash." },
  { id: "travel-mapped", category: "travel", declaration: "I set out along the lantern road for the Docks." },
  { id: "travel-unmapped", category: "travel-unmapped", declaration: "From the Docks I follow the old smugglers' path to the Sunken Cathedral." },
  { id: "seek-rumor", category: "faction-quest-rumor", declaration: "I ask the dockhands whether anyone has work, or any rumor of the missing caravan." },
  { id: "unknown-npc", category: "unknown-npc", probe: "unknown-npc", declaration: "I approach a hooded stranger leaning on a bollard and demand to know their name and business." },
  { id: "quest-accept", category: "quest", declaration: "I accept the quest to guard the market." },
  { id: "check-search", category: "check", declaration: "I search the crates along the dock for anything hidden or valuable." },
  { id: "hold-wait", category: "hold", declaration: "I lean on the rail, watch the grey water, and wait for the fog to lift." },
  { id: "impossible", category: "illegal-impossible", declaration: "I snap my fingers and teleport straight to the moon." },
  { id: "attack", category: "encounter", declaration: "I draw my sword and attack the Goblin Scout by the crates." },
  { id: "combat-continue", category: "encounter", declaration: "I press the attack and swing at the Goblin Scout again." },
  { id: "rest", category: "rest", declaration: "I sit down on a crate and take a short rest." },
  { id: "travel-back", category: "travel", declaration: "I head back to the Market before it gets dark." },
  { id: "conversation", category: "conversation", declaration: "I find Joss and ask him what he makes of the strangers in the market." },
  { id: "meta", category: "meta", declaration: "/help what commands exist and what can I do here?" },
];

// ---------------------------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------------------------

export type NarrationSource = "provider-assisted" | "deterministic-fallback" | "none";

/**
 * The evaluator's own narration taxonomy, orthogonal to the server's `source`:
 *  - `provider` — the provider wrote the prose (`source === "provider-assisted"`).
 *  - `deliberate-hold` — a grounded, deterministic server hold line (the orchestrator bounded a
 *    reason and a safe next step). This is by design, not a failure, and is reported separately so
 *    it no longer pollutes the provider share or the fallback-distinctness denominator.
 *  - `narration-failure` — a receipt-bound or context fallback the server emitted because the
 *    provider was unavailable, failed the grounding gate, or was over budget. Only these count as
 *    "fallbacks" for distinctness.
 */
export type NarrationClass = "provider" | "deliberate-hold" | "narration-failure";

/**
 * Deliberate-hold marker. `holdNarration()` always renders a bounded reason plus a
 * "Suggested next step:" when the orchestrator proposed one, and always closes with
 * "Nothing is resolved; ...". Either phrase identifies a by-design hold rather than a failure.
 */
export const DELIBERATE_HOLD_MARKER = /\bsuggested next step:|\bnothing is resolved;/iu;

/** Classifies one narration event. The empty/`none` case never reaches an event. */
export function classifyNarration(text: string, source: NarrationSource): NarrationClass {
  if (source === "provider-assisted") return "provider";
  return DELIBERATE_HOLD_MARKER.test(text) ? "deliberate-hold" : "narration-failure";
}

export interface ProviderCallRecord {
  seq: number;
  lane: string;
  ok: boolean;
  finishReason: string;
  detail: string;
  tools: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  dmCandidates: string[] | null;
}

export interface NarrationEvent {
  phase: "initial" | "resume";
  source: NarrationSource;
  /** The evaluator taxonomy derived from `source` + text. */
  class: NarrationClass;
  text: string;
}

export interface TravelDestination { id: string | null; name: string }
export interface ActionLocation { id: string; name: string }
export interface KnownLocation { id: string | null; name: string }

export interface CoherenceProbe {
  index: number;
  turnId: string;
  declaration: string;
  actorBeforeId: string | null;
  actorAfterId: string | null;
  travelDestinations: TravelDestination[];
  actionLocations: ActionLocation[];
  /** The world gazetteer, so a declaration naming a known place can be compared to the receipt. */
  knownLocations?: KnownLocation[];
}

export interface TurnRecord {
  index: number;
  id: string;
  category: string;
  declaration: string;
  /** Labeled probe this turn drives, or null. */
  probe: ProbeKind | null;
  status: number;
  finalState: string | null;
  outcome: string | null;
  narration: string;
  narrationSource: NarrationSource;
  narrationClass: NarrationClass | "none";
  narrationEvents: NarrationEvent[];
  committed: boolean;
  receiptKinds: string[];
  receiptCommandIds: string[];
  /** Tool names of any server proposals surfaced for confirmation this turn. */
  proposalToolNames: string[];
  confirmed: boolean;
  dmBeatIndex: number | null;
  providerCalls: number;
  latencyMs: number;
  coherence: string[];
  error?: string;
}

/** A labeled probe's observed outcome, with the pass/fail verdict and the reason. */
export interface ProbeOutcome {
  kind: ProbeKind;
  title: string;
  turnIndex: number | null;
  turnId: string | null;
  expected: string;
  observed: string;
  passed: boolean;
}

export interface DmBeatRecord {
  index: number;
  intent: string;
  state: string;
  receipts: string[];
  candidatesOffered: string[];
  narration: string;
  blockers: string[];
  latencyMs: number;
  success: boolean;
}

export interface FreeformMetrics {
  turns: number;
  turnsWithNarration: number;
  providerCalls: number;
  providerOk: number;
  providerFailed: number;
  providerSuccessRate: number;
  narrationEventsTotal: number;
  narrationsProvider: number;
  narrationsTotal: number;
  narrationProviderShare: number;
  deliberateHoldEvents: number;
  deliberateHoldTurns: number;
  /** Deliberate-hold turns / all scripted turns. Disjoint from the failure fallback count. */
  deliberateHoldRate: number;
  narrationFailureTurns: number;
  /** Narration-failure fallback events only (deliberate holds are excluded). */
  fallbackCount: number;
  fallbackDistinct: number;
  fallbackIdentical: number;
  fallbackDistinctness: number;
  materializedTurns: number;
  materializationRate: number;
  dmBeats: number;
  dmBeatsSucceeded: number;
  dmBeatSuccessRate: number;
  coherenceViolations: number;
  coherenceViolationTurns: number;
  latencyAvgMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  // Labeled probes (0/1 unless noted). See PROBE_EXPECTATIONS.
  commerceExercised: number;
  commerceCommitted: number;
  unknownNpcResolvedAsCheck: number;
  unknownNpcHeld: number;
  cheatingCommerceHeld: number;
  cheatingCommerceGiveMisfire: number;
  cheatingCommerceReceipts: number;
}

export interface BaselineMetrics {
  label: string;
  turns?: number;
  narrationsProvider?: number;
  narrationsTotal?: number;
  narrationProviderShare?: number;
  deliberateHoldRate?: number;
  fallbackCount?: number;
  fallbackDistinct?: number;
  fallbackIdentical?: number;
  materializedTurns?: number;
  materializationRate?: number;
  dmBeatSuccessRate?: number;
  latencyAvgMs?: number;
  coherenceViolations?: number;
  commerceCommitted?: number;
  unknownNpcResolvedAsCheck?: number;
  cheatingCommerceGiveMisfire?: number;
}

/**
 * Pre-split baseline for main@671241c, kept as the honest "confounded" reference. Its
 * `fallbackCount: 14` counts every deterministic-fallback narration event, so it includes
 * by-design deliberate holds; the new `fallbackCount` counts narration-failure events only and is
 * therefore NOT directly comparable. `narrationProviderShare`, `materializedTurns`, and latency
 * remain comparable.
 */
export const DOCUMENTED_BASELINE_OLD: BaselineMetrics = {
  label: "reported-main-671241c-pre-split",
  turns: 18,
  narrationsProvider: 7,
  narrationsTotal: 18,
  narrationProviderShare: 7 / 18,
  fallbackCount: 14,
  fallbackIdentical: 7,
  materializedTurns: 8,
  materializationRate: 8 / 18,
  latencyAvgMs: 7100,
};

/**
 * The comparison baseline for the new scripted session and metric split. Populated from the
 * calibration live run recorded in docs/freeform-fun-eval.md; single runs vary with provider luck,
 * so this is a reference point, not a threshold. `--baseline=<artifact.json>` overrides it.
 */
export const DOCUMENTED_BASELINE: BaselineMetrics = {
  label: "calibrated-classified-v2",
  turns: 18,
  narrationsProvider: 12,
  narrationsTotal: 18,
  narrationProviderShare: 12 / 18,
  deliberateHoldRate: 2 / 18,
  fallbackCount: 4,
  fallbackIdentical: 0,
  materializedTurns: 9,
  materializationRate: 9 / 18,
  latencyAvgMs: 9868,
  commerceCommitted: 1,
  unknownNpcResolvedAsCheck: 0,
  cheatingCommerceGiveMisfire: 0,
};

export interface EvalArtifact {
  version: number;
  generatedAt: string;
  mode: "in-process" | "base-url";
  provider: { baseUrl: string; model: string };
  seed: number;
  dataDir: string | null;
  baseUrl: string | null;
  world: { campaignId: string; sessionId: string; actorId: string } | null;
  declarations: number;
  narrationClassification: {
    classes: NarrationClass[];
    deliberateHoldMarker: string;
    fallbackDistinctnessScope: string;
    probes: ProbeExpectation[];
  };
  reliability: {
    providerCalls: boolean;
    dmCandidates: boolean;
    coherence: boolean;
    notes: string[];
  };
  probes: ProbeOutcome[];
  metrics: FreeformMetrics;
  turns: TurnRecord[];
  dmBeats: DmBeatRecord[];
  providerCalls: ProviderCallRecord[];
}

// ---------------------------------------------------------------------------------------------
// Pure metric + scoring functions (unit-tested in scripts/test/freeform-fun-eval.test.ts)
// ---------------------------------------------------------------------------------------------

export function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Distinct fallback strings over the fallback count: 1 means every fallback is unique, ~0 means they collapse. */
export function fallbackDistinctness(strings: readonly string[]): { count: number; distinct: number; ratio: number } {
  const nonEmpty = strings.filter((value) => value.trim().length > 0);
  const distinct = new Set(nonEmpty).size;
  return { count: nonEmpty.length, distinct, ratio: nonEmpty.length === 0 ? 0 : distinct / nonEmpty.length };
}

export function providerSuccess(calls: readonly { ok: boolean }[]): { total: number; ok: number; failed: number; rate: number } {
  const total = calls.length;
  const ok = calls.filter((call) => call.ok).length;
  return { total, ok, failed: total - ok, rate: total === 0 ? 0 : ok / total };
}

export function latencyStats(values: readonly number[]): { avgMs: number; p50Ms: number; p95Ms: number; maxMs: number } {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((left, right) => left - right);
  if (sorted.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const pick = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return {
    avgMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50Ms: Math.round(pick(0.5)),
    p95Ms: Math.round(pick(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1]!),
  };
}

/**
 * Heuristic location coherence. A location-bound action that resolves against a place other than
 * the declared/current one is reported. The rules are deliberately conservative: they only fire
 * when the declaration names a known location or the receipt pins an exact location.
 */
export function detectCoherenceViolations(probe: CoherenceProbe): string[] {
  const violations: string[] = [];
  const declared = normalize(probe.declaration);
  const mentions = (name: string) => {
    const needle = normalize(name);
    return needle.length > 0 && declared.includes(needle);
  };
  const known = probe.knownLocations ?? [];
  const mentionedKnown = known.filter((location) => mentions(location.name));
  if (probe.travelDestinations.length > 0) {
    for (const destination of probe.travelDestinations) {
      const destinationNamed = mentions(destination.name);
      const destinationResolved = mentionedKnown.some((location) => normalize(location.name) === normalize(destination.name));
      // Only flag a mismatch when the declaration named a *known* place that is not the destination.
      if (!destinationNamed && !destinationResolved && mentionedKnown.length > 0) {
        violations.push(`travel-target-mismatch:declared=${mentionedKnown.map((location) => location.name).join("|")};actual=${destination.name}`);
      }
      if (destination.id && probe.actorAfterId && probe.actorAfterId !== destination.id) {
        violations.push(`travel-destination-not-reached:actual=${probe.actorAfterId};claimed=${destination.id}`);
      }
    }
    return [...new Set(violations)];
  }
  for (const action of probe.actionLocations) {
    if (probe.actorAfterId && action.id !== probe.actorAfterId) {
      violations.push(`action-location-mismatch:action=${action.name};actor=${probe.actorAfterId}`);
    }
  }
  return [...new Set(violations)];
}

const COMMERCE_PROPOSAL_TOOLS = new Set(["vendor_buy", "vendor_sell", "vendor_give"]);

/** Self-describing JSON record of the narration taxonomy, so the artifact documents the split. */
export function narrationClassificationDescriptor(): EvalArtifact["narrationClassification"] {
  return {
    classes: ["provider", "deliberate-hold", "narration-failure"],
    deliberateHoldMarker: DELIBERATE_HOLD_MARKER.source,
    fallbackDistinctnessScope: "narration-failure narration events only (deliberate-hold excluded)",
    probes: [...PROBE_EXPECTATIONS],
  };
}

/** True when this turn either surfaced a commerce proposal or committed a commerce receipt. */
export function turnExercisesCommerce(turn: Pick<TurnRecord, "proposalToolNames" | "receiptKinds">): boolean {
  return turn.receiptKinds.includes("commerce")
    || turn.proposalToolNames.some((name) => COMMERCE_PROPOSAL_TOOLS.has(name));
}

/**
 * Labeled-probe verdicts. Each probe is bound to one scripted turn by `TurnRecord.probe`; a missing
 * labeled turn fails the probe explicitly instead of silently passing.
 */
export function probeOutcomes(turns: readonly TurnRecord[]): ProbeOutcome[] {
  return PROBE_EXPECTATIONS.map((expectation) => {
    const turn = turns.find((candidate) => candidate.probe === expectation.kind) ?? null;
    let observed = "no labeled turn ran";
    let passed = false;
    if (turn) {
      const receipts = `[${turn.receiptKinds.join(",")}]`;
      if (expectation.kind === "declared-purchase") {
        const committed = turn.receiptKinds.includes("commerce");
        const exercised = turnExercisesCommerce(turn);
        observed = committed ? "committed commerce receipt"
          : exercised ? `commerce proposal surfaced (${turn.proposalToolNames.join(",") || receipts})`
          : `no commerce: receipts=${receipts} state=${turn.finalState ?? "-"} narration=${turn.narrationClass}`;
        passed = committed;
      } else if (expectation.kind === "unknown-npc") {
        const check = turn.receiptKinds.includes("check");
        observed = check ? `resolved as a skill check: receipts=${receipts}`
          : `held / receipt-free: receipts=${receipts} narration=${turn.narrationClass}`;
        passed = !check;
      } else {
        const misfire = turn.receiptKinds.includes("commerce") || turn.receiptKinds.includes("inventory")
          || turn.proposalToolNames.includes("vendor_give");
        observed = misfire
          ? `give misfire: receipts=${receipts} proposals=[${turn.proposalToolNames.join(",")}]`
          : `held without a receipt: receipts=${receipts} narration=${turn.narrationClass}`;
        passed = !misfire && turn.receiptCommandIds.length === 0;
      }
    }
    return { kind: expectation.kind, title: expectation.title, turnIndex: turn?.index ?? null,
      turnId: turn?.id ?? null, expected: expectation.expected, observed, passed };
  });
}

export function computeMetrics(
  turns: readonly TurnRecord[],
  beats: readonly DmBeatRecord[],
  providerCalls: readonly ProviderCallRecord[],
): FreeformMetrics {
  const provider = providerSuccess(providerCalls);
  const narrationEvents = turns.flatMap((turn) => turn.narrationEvents);
  const narrationsProvider = turns.filter((turn) => turn.narrationClass === "provider").length;
  const turnsWithNarration = turns.filter((turn) => turn.narrationClass !== "none").length;
  const deliberateHoldEvents = narrationEvents.filter((event) => event.class === "deliberate-hold").length;
  const deliberateHoldTurns = turns.filter((turn) => turn.narrationClass === "deliberate-hold").length;
  const narrationFailureTurns = turns.filter((turn) => turn.narrationClass === "narration-failure").length;
  // Fallback distinctness is measured over narration-failure events only. Deliberate holds are
  // excluded so a stable by-design hold line can no longer masquerade as fallback collapse.
  const fallbackEvents = narrationEvents.filter((event) => event.class === "narration-failure");
  const fallback = fallbackDistinctness(fallbackEvents.map((event) => event.text));
  const materializedTurns = turns.filter((turn) => turn.committed).length;
  const beatSuccess = beats.filter((beat) => beat.success).length;
  const violationTurns = turns.filter((turn) => turn.coherence.length > 0).length;
  const latency = latencyStats(turns.map((turn) => turn.latencyMs));
  const purchase = turns.find((turn) => turn.probe === "declared-purchase");
  const commerceCommitted = purchase?.receiptKinds.includes("commerce") ? 1 : 0;
  const commerceExercised = purchase && turnExercisesCommerce(purchase) ? 1 : 0;
  const unknownNpc = turns.find((turn) => turn.probe === "unknown-npc");
  const unknownNpcResolvedAsCheck = unknownNpc?.receiptKinds.includes("check") ? 1 : 0;
  const unknownNpcHeld = unknownNpc && !unknownNpc.committed && unknownNpcResolvedAsCheck === 0 ? 1 : 0;
  const cheating = turns.find((turn) => turn.probe === "cheating-commerce");
  const cheatingCommerceReceipts = cheating?.receiptCommandIds.length ?? 0;
  const cheatingCommerceGiveMisfire = cheating && (cheating.receiptKinds.includes("commerce")
    || cheating.receiptKinds.includes("inventory") || cheating.proposalToolNames.includes("vendor_give")) ? 1 : 0;
  const cheatingCommerceHeld = cheating && !cheating.committed && cheatingCommerceGiveMisfire === 0 ? 1 : 0;
  return {
    turns: turns.length,
    turnsWithNarration,
    providerCalls: provider.total,
    providerOk: provider.ok,
    providerFailed: provider.failed,
    providerSuccessRate: provider.rate,
    narrationEventsTotal: narrationEvents.length,
    narrationsProvider,
    narrationsTotal: turns.length,
    narrationProviderShare: turns.length === 0 ? 0 : narrationsProvider / turns.length,
    deliberateHoldEvents,
    deliberateHoldTurns,
    deliberateHoldRate: turns.length === 0 ? 0 : deliberateHoldTurns / turns.length,
    narrationFailureTurns,
    fallbackCount: fallback.count,
    fallbackDistinct: fallback.distinct,
    fallbackIdentical: fallback.count - fallback.distinct,
    fallbackDistinctness: fallback.ratio,
    materializedTurns,
    materializationRate: turns.length === 0 ? 0 : materializedTurns / turns.length,
    dmBeats: beats.length,
    dmBeatsSucceeded: beatSuccess,
    dmBeatSuccessRate: beats.length === 0 ? 0 : beatSuccess / beats.length,
    coherenceViolations: turns.reduce((sum, turn) => sum + turn.coherence.length, 0),
    coherenceViolationTurns: violationTurns,
    latencyAvgMs: latency.avgMs,
    latencyP50Ms: latency.p50Ms,
    latencyP95Ms: latency.p95Ms,
    latencyMaxMs: latency.maxMs,
    commerceExercised,
    commerceCommitted,
    unknownNpcResolvedAsCheck,
    unknownNpcHeld,
    cheatingCommerceHeld,
    cheatingCommerceGiveMisfire,
    cheatingCommerceReceipts,
  };
}

export interface MetricDiff {
  key: string;
  baseline: number;
  current: number;
  delta: number;
  /** true when a smaller value is better (failure/fallback/latency/violation counts). */
  lowerIsBetter: boolean;
}

const LOWER_IS_BETTER = new Set([
  "providerFailed", "fallbackCount", "fallbackIdentical", "narrationFailureTurns",
  "unknownNpcResolvedAsCheck", "cheatingCommerceGiveMisfire", "cheatingCommerceReceipts",
  "coherenceViolations", "latencyAvgMs", "latencyP50Ms", "latencyP95Ms", "latencyMaxMs",
]);

/** Numeric diff of the baseline keys that also exist in the current metrics. */
export function diffMetrics(
  current: Record<string, number>,
  baseline: Partial<Record<string, number>>,
): MetricDiff[] {
  const diffs: MetricDiff[] = [];
  for (const [key, value] of Object.entries(baseline)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const now = current[key];
    if (typeof now !== "number" || !Number.isFinite(now)) continue;
    diffs.push({ key, baseline: value, current: now, delta: now - value, lowerIsBetter: LOWER_IS_BETTER.has(key) });
  }
  return diffs;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMetricValue(key: string, value: number): string {
  if (key.endsWith("Rate") || key.endsWith("Share") || key.endsWith("Distinctness")) return formatPercent(value);
  if (key.endsWith("Ms")) return `${Math.round(value)} ms`;
  return String(Number.isInteger(value) ? value : Number(value.toFixed(3)));
}

export function diffVerdict(diff: MetricDiff): string {
  if (diff.delta === 0) return "=";
  const improved = diff.lowerIsBetter ? diff.delta < 0 : diff.delta > 0;
  return `${improved ? "better" : "worse"} (${diff.delta > 0 ? "+" : ""}${Number(diff.delta.toFixed(3))})`;
}

export function renderMarkdown(artifact: EvalArtifact, baseline: BaselineMetrics | null): string {
  const lines: string[] = [];
  lines.push("# Free-form fun evaluator");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}  `);
  lines.push(`Mode: ${artifact.mode}  |  Model: ${artifact.provider.model}  |  Seed: ${artifact.seed}  |  Turns: ${artifact.declarations}`);
  if (artifact.world) lines.push(`World: campaign=${artifact.world.campaignId} session=${artifact.world.sessionId} actor=${artifact.world.actorId}`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  const baselineRecord = baseline as unknown as Record<string, number> | null;
  const diffs = baselineRecord ? diffMetrics(artifact.metrics as unknown as Record<string, number>, baselineRecord) : [];
  const diffByKey = new Map(diffs.map((diff) => [diff.key, diff]));
  lines.push("| Metric | Current | Baseline | Verdict |");
  lines.push("| --- | --- | --- | --- |");
  const metricKeys = Object.keys(artifact.metrics) as Array<keyof FreeformMetrics>;
  for (const key of metricKeys) {
    const value = artifact.metrics[key];
    const diff = diffByKey.get(key as string);
    lines.push(`| ${key} | ${formatMetricValue(key as string, value)} | ${diff ? formatMetricValue(key as string, diff.baseline) : "-"} | ${diff ? diffVerdict(diff) : "-"} |`);
  }
  lines.push("");
  if (!artifact.reliability.providerCalls || !artifact.reliability.coherence) {
    lines.push("## Reliability limits");
    lines.push("");
    for (const note of artifact.reliability.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("## Labeled probes");
  lines.push("");
  lines.push("| probe | turn | passed | expected | observed |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const probe of artifact.probes) {
    lines.push(`| ${probe.kind} | ${probe.turnIndex ?? "-"} (${probe.turnId ?? "-"}) | ${probe.passed ? "yes" : "NO"} | ${probe.expected} | ${probe.observed} |`);
  }
  lines.push("");
  if (artifact.metrics.coherenceViolationTurns > 0) {
    lines.push("## Location-coherence violations");
    lines.push("");
    for (const turn of artifact.turns.filter((value) => value.coherence.length > 0)) {
      lines.push(`- turn ${turn.index} (${turn.id}): ${turn.coherence.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("## Turns");
  lines.push("");
  lines.push("| # | id | category | state | narration class | source | committed | receipt kinds | latency | coherence |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const turn of artifact.turns) {
    lines.push(`| ${turn.index} | ${turn.id} | ${turn.category} | ${turn.finalState ?? "-"} | ${turn.narrationClass} | ${turn.narrationSource} | ${turn.committed ? "yes" : "no"} | ${turn.receiptKinds.join(",") || "-"} | ${Math.round(turn.latencyMs)} ms | ${turn.coherence.length || "-"} |`);
  }
  lines.push("");
  if (artifact.dmBeats.length > 0) {
    lines.push("## DM beats");
    lines.push("");
    lines.push("| # | intent | state | receipts | candidates | latency |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const beat of artifact.dmBeats) {
      lines.push(`| ${beat.index} | ${beat.intent} | ${beat.state} | ${beat.receipts.join(", ") || "-"} | ${beat.candidatesOffered.length} | ${Math.round(beat.latencyMs)} ms |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Shared HTTP helpers
// ---------------------------------------------------------------------------------------------

interface HttpResponse { status: number; headers: Record<string, any>; body: string }
type Requester = (method: "GET" | "POST", pathname: string, payload?: Record<string, unknown>) => Promise<HttpResponse>;

function makeRequester(hostname: string, port: number, prefix = ""): Requester {
  return (method, pathname, payload) => new Promise<HttpResponse>((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const request = http.request({ host: hostname, port, path: `${prefix}${pathname}`, method,
      headers: data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (response) => {
        let body = ""; response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
    request.on("error", reject);
    if (data !== undefined) request.write(data);
    request.end();
  });
}

export function parseSse(body: string): Array<{ type: string; payload: any }> {
  const events: Array<{ type: string; payload: any }> = [];
  for (const frame of body.split("\n\n")) {
    const typeLine = frame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!typeLine || !dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice(6));
      events.push({ type: typeLine.slice(7).trim(), payload: parsed?.payload ?? parsed });
    } catch { /* ignore malformed frame */ }
  }
  return events;
}

const terminalOf = (events: Array<{ type: string; payload: any }>) => events.find((event) => event.type === "terminal")?.payload ?? null;

interface StreamResult {
  status: number;
  turnId: string | undefined;
  state: string | null;
  outcome: string | null;
  narration: string;
  narrationSource: NarrationSource;
  confirmationRequired: any;
}

function streamOf(response: HttpResponse): StreamResult {
  const events = parseSse(response.body);
  const terminal = terminalOf(events);
  const narration = events.filter((event) => event.type === "narration_delta").map((event) => event.payload.text).join("");
  return {
    status: response.status,
    turnId: (response.headers["x-adventure-turn-id"] as string | undefined) ?? terminal?.turn?.turnId,
    state: terminal?.turn?.state ?? null,
    outcome: terminal?.outcome ?? null,
    narration,
    narrationSource: terminal?.narrationStatus?.source ?? (narration ? "deterministic-fallback" : "none"),
    confirmationRequired: events.find((event) => event.type === "confirmation_required")?.payload ?? null,
  };
}

/** Serializes phase-level narration so distinctness spans resume boundaries. */
function narrationEventsOf(phases: Array<{ phase: "initial" | "resume"; narration: string; narrationSource: NarrationSource }>): NarrationEvent[] {
  return phases
    .filter((phase) => phase.narrationSource !== "none" && phase.narration.trim().length > 0)
    .map((phase) => ({ phase: phase.phase, source: phase.narrationSource,
      class: classifyNarration(phase.narration, phase.narrationSource), text: phase.narration }));
}

// ---------------------------------------------------------------------------------------------
// Driver (in-process)
// ---------------------------------------------------------------------------------------------

export interface EvalOptions {
  dataDir?: string | undefined;
  turns: number;
  seed: number;
  port: number;
  out: string;
  baseline: BaselineMetrics | null;
  keep: boolean;
  quiet: boolean;
}

interface Manifest { campaignId: string; sessionId: string; actorId: string }

interface ReceiptProbe {
  kinds: string[];
  travelDestinations: TravelDestination[];
  actionLocations: ActionLocation[];
}

export async function runFreeformFunEval(options: EvalOptions): Promise<{ artifact: EvalArtifact; markdown: string; output: string; markdownPath: string }> {
  const providerConfig = await resolveProviderKey(resolveProviderConfig());
  const provider: ProviderSettings = {
    ...defaultProviderSettings(),
    providerType: "openai-compatible",
    baseUrl: providerConfig.baseUrl,
    model: providerConfig.model,
    apiKey: providerConfig.apiKey,
    pricing: { promptPerMillion: 0.1, completionPerMillion: 0.3 },
    adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null },
  };

  const createdDir = !options.dataDir;
  const directory = options.dataDir ?? await mkdtemp(path.join(tmpdir(), "velvet-freeform-"));
  process.env.VELVET_DATA_DIR = directory;
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
  closeRepo();

  let repo: any = null;
  let clockNow: () => Date = () => new Date();
  const providerCalls: ProviderCallRecord[] = [];
  const deps: AdventureAgentDependencies = {
    complete: async (input) => {
      const started = Date.now();
      const seq = providerCalls.length + 1;
      try {
        const result = await completeWithProvider(input);
        const usage = result.usage;
        const price = provider.pricing;
        let dmCandidates: string[] | null = null;
        if (input.promptVersion === "campaign-dm-v1") {
          try {
            const parsed = JSON.parse(String(input.messages[1]?.content ?? "{}"));
            dmCandidates = Array.isArray(parsed.candidates) ? parsed.candidates.map((candidate: any) => String(candidate.action)) : [];
          } catch { /* not a candidate round */ }
        }
        providerCalls.push({
          seq, lane: input.promptVersion ?? "unknown", ok: true,
          finishReason: result.provenance?.finishReason ?? "unknown",
          detail: result.message.content === null && !result.message.toolCalls?.length ? "empty-message" : "",
          tools: result.message.toolCalls?.map((call) => call.name) ?? [], dmCandidates,
          promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          costUsd: usage && price.promptPerMillion !== null && price.completionPerMillion !== null
            ? (usage.promptTokens * price.promptPerMillion + usage.completionTokens * price.completionPerMillion) / 1_000_000 : 0,
          latencyMs: Date.now() - started,
        });
        return result;
      } catch (error) {
        const message = error instanceof ProviderHttpError
          ? `HTTP ${error.status}: ${(error as Error).message.slice(0, 200)}` : (error as Error).message.slice(0, 200);
        providerCalls.push({
          seq, lane: input.promptVersion ?? "unknown", ok: false, finishReason: (error as Error).name,
          detail: message, tools: [], dmCandidates: null,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: Date.now() - started,
        });
        throw error;
      }
    },
    getProvider: async () => provider,
    getHarness: async () => defaultHarnessSettings(),
    // Fixture clock: real-time `now` overflows the planning AbortSignal.timeout.
    now: () => clockNow(),
  };

  const manifestPath = path.join(directory, "freeform-fun-eval.manifest.json");
  const worldPath = path.join(directory, "freeform-fun-eval.world.json");
  let manifest: Manifest | null = null;
  {
    const existing = await readFile(manifestPath, "utf8").catch(() => null);
    if (existing) { try { manifest = JSON.parse(existing) as Manifest; } catch { manifest = null; } }
  }
  let npcLocations = new Map<string, string>();
  let shopLocations = new Map<string, string>();

  if (manifest) {
    // Attach: open the existing world without reseeding.
    repo = createRepository({ dataDir: directory });
    clockNow = () => new Date();
    const persisted = await readFile(worldPath, "utf8").catch(() => null);
    if (persisted) {
      const parsed = JSON.parse(persisted) as { npcLocations?: Record<string, string>; shopLocations?: Record<string, string> };
      npcLocations = new Map(Object.entries(parsed.npcLocations ?? {}));
      shopLocations = new Map(Object.entries(parsed.shopLocations ?? {}));
    }
  } else {
    const fixture = await dmFixture(true, { dataDir: directory });
    repo = fixture.repo;
    clockNow = () => fixture.options.clock.now();
    const seed = options.seed;
    seedLivingWorld(fixture, seed);
    enableHumanPlayerTravel(fixture, seed);

    const srd = SRD_5_1_STARTER_CATALOG.manifest;
    const freshRead = <T>(source: string, ...params: unknown[]): T | undefined => {
      const connection = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
      try { return connection.prepare(source).get(...params) as T | undefined; } finally { connection.close(); }
    };
    const narrativeRevision = () => fixture.repo.listCampaignNpcs(OWNER, fixture.campaign.id)?.revision ?? 0;
    // Presence revision is not re-read after each write on a separate connection (WAL read lag);
    // track it as a cursor, exactly as server/test/npc-presence-repository.test.ts does.
    let presenceCursor: number | null = null;
    const nextPresenceRevision = () => {
      if (presenceCursor === null) {
        presenceCursor = freshRead<{ revision: number }>("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?",
          fixture.campaign.id, fixture.session.id)?.revision ?? 0;
      }
      return presenceCursor;
    };
    const makeNpc = (name: string, description: string, locationId: string) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const persona = fixture.repo.createCharacter({ name, age: 33, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
      const npc = fixture.repo.createCampaignNpc(OWNER, fixture.campaign.id, {
        personaId: persona.id, publicState: { name, description },
        privateState: { goals: "SECRET_GOAL", gmNotes: "SECRET_GM_NOTE", merchantState: null },
        expectedRevision: narrativeRevision(), idempotencyKey: `ff-npc-${slug}`,
      }).npc;
      const expectedPresence = nextPresenceRevision();
      fixture.repo.mutateNpcPresence(OWNER, { campaignId: fixture.campaign.id, sessionId: fixture.session.id, npcId: npc.npcId,
        expectedRevision: expectedPresence, idempotencyKey: `ff-place-${slug}`, mutation: { kind: "place", locationId } });
      presenceCursor = expectedPresence + 1;
      npcLocations.set(name.toLocaleLowerCase("en-US"), locationId);
      return npc;
    };
    const mara = makeNpc("Mara", "A broad-shouldered merchant in a waxed coat, tallying stock behind a cluttered stall.", `s${seed}-market`);
    makeNpc("Goblin Scout", "A wiry goblin scout with a notched scimitar, crouched by the crates.", `s${seed}-docks`);

    // Vendor plumbing copied from server/test/adventure-commerce-action.test.ts, SRD-flavoured.
    try {
      const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
      db.pragma("foreign_keys=ON");
      const item = { packId: srd.packId, packVersion: srd.packVersion, kind: "item", definitionId: "srd-5.1:item:longsword" };
      const currency = { packId: srd.packId, packVersion: srd.packVersion, kind: "currency", definitionId: "srd-5.1:currency:gp" };
      for (const reference of [item, currency]) {
        db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25 VALUES(?,?,?,?,?)")
          .run(fixture.campaign.id, reference.packId, reference.packVersion, reference.kind, reference.definitionId);
      }
      db.prepare("INSERT OR REPLACE INTO rpg_currency_references_v25 VALUES(?,?,?,?,?,?)")
        .run(fixture.campaign.id, "GP", currency.packId, currency.packVersion, "currency", currency.definitionId);
      db.prepare("INSERT OR REPLACE INTO rpg_wallets_v25 VALUES(?,?,?,?,?)")
        .run(fixture.campaign.id, fixture.actorId, "GP", 5000, new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO rpg_shop_definitions_v25 VALUES('mara-shop',?,?,?)")
        .run(fixture.campaign.id, "Mara's Goods", new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO rpg_shop_stock_v25 VALUES('mara-stock',?,'mara-shop',?,?, 'item',?,3,15,'GP')")
        .run(fixture.campaign.id, item.packId, item.packVersion, item.definitionId);
      db.close();
      fixture.repo.associateNpcShop(OWNER, fixture.campaign.id, mara.npcId, "mara-shop");
      fixture.repo.setShopBuyPolicy(OWNER, fixture.campaign.id, "mara-shop", "mara-stock", 8);
      shopLocations.set("mara's goods", `s${seed}-market`);
    } catch (error) {
      process.stderr.write(`vendor seed failed: ${(error as Error).message}\n`);
    }

    manifest = { campaignId: fixture.campaign.id, sessionId: fixture.session.id, actorId: fixture.actorId };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`).catch(() => undefined);
    await writeFile(worldPath, `${JSON.stringify({ npcLocations: Object.fromEntries(npcLocations), shopLocations: Object.fromEntries(shopLocations) }, null, 2)}\n`).catch(() => undefined);
  }

  const campaignId = manifest.campaignId;
  const sessionId = manifest.sessionId;
  const actorId = manifest.actorId;

  // ---- in-process app over real HTTP ----
  const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: deps });
  await app.listen({ host: "127.0.0.1", port: options.port });
  const request = makeRequester("127.0.0.1", options.port, "/api/rpg/v1");

  const worldSnapshot = () => repo.getCampaignWorld(OWNER, campaignId, sessionId);
  const gazetteer = (): Array<{ id: string; name: string }> => {
    try { return (worldSnapshot()?.visibleLocations ?? []).map((location: any) => ({ id: location.locationId, name: location.name })); }
    catch { return []; }
  };
  const actorLocationId = (): string | null => {
    try { return worldSnapshot()?.currentLocations.find((entry: any) => entry.actorId === actorId)?.locationId ?? null; }
    catch { return null; }
  };
  const resolveLocationId = (name: string): string | null => {
    const needle = normalize(name);
    return gazetteer().find((location) => normalize(location.name) === needle)?.id ?? null;
  };

  const receiptProbe = (turnId: string, commandId: string): ReceiptProbe => {
    const probe: ReceiptProbe = { kinds: [], travelDestinations: [], actionLocations: [] };
    const probes: Array<[string, () => any]> = [
      ["travel", () => repo.getExactCandidateTravelNarrationReceipt(OWNER, turnId, commandId)],
      ["inventory", () => repo.getAdventureInventoryNarrationReceipt(OWNER, turnId, commandId)],
      ["commerce", () => repo.getAdventureCommerceNarrationReceipt(OWNER, turnId, commandId)],
      ["quest-progression", () => repo.getAdventureQuestProgressionNarrationReceipt(OWNER, turnId, commandId)],
      ["quest", () => repo.getAdventureQuestNarrationReceipt(OWNER, turnId, commandId)],
      ["check", () => repo.getAdventureCheckNarrationReceipt(OWNER, turnId, commandId)],
      ["power-rest", () => repo.getAdventurePowerRestNarrationReceipt(OWNER, turnId, commandId)],
      ["combat", () => repo.getAgentCombatReceipt(OWNER, campaignId, commandId)],
    ];
    for (const [kind, probeFn] of probes) {
      let value: any;
      try { value = probeFn(); } catch { value = null; }
      if (!value) continue;
      probe.kinds.push(kind);
      if (kind === "travel" && typeof value.destination === "string") {
        probe.travelDestinations.push({ id: resolveLocationId(value.destination), name: value.destination });
      }
      if (kind === "commerce" && typeof value.shopLabel === "string") {
        const locationId = shopLocations.get(value.shopLabel.toLocaleLowerCase("en-US"));
        if (locationId) probe.actionLocations.push({ id: locationId, name: value.shopLabel });
      }
    }
    if (probe.kinds.length === 0) {
      try {
        const generic = repo.getCommandReceipt(OWNER, campaignId, commandId);
        if (generic) probe.kinds.push(`mechanic:${generic.events.map((event: any) => event.type).join(",")}`);
      } catch { /* ignore */ }
    }
    return probe;
  };

  const turnRecords: TurnRecord[] = [];
  const dmBeats: DmBeatRecord[] = [];

  const runPlayerTurn = async (entry: Declaration, index: number): Promise<TurnRecord> => {
    const before = providerCalls.length;
    const actorBefore = actorLocationId();
    const turnStarted = Date.now();
    const revision = repo.getCampaignAdministration(OWNER, campaignId)!.revision;
    const record: TurnRecord = {
      index, id: entry.id, category: entry.category, declaration: entry.declaration, probe: entry.probe ?? null,
      status: 0, finalState: null, outcome: null, narration: "", narrationSource: "none", narrationClass: "none",
      narrationEvents: [], committed: false, receiptKinds: [], receiptCommandIds: [], proposalToolNames: [],
      confirmed: false, dmBeatIndex: null, providerCalls: 0, latencyMs: 0, coherence: [],
    };
    const phases: Array<{ phase: "initial" | "resume"; narration: string; narrationSource: NarrationSource }> = [];
    let turnId: string | undefined;
    let lastState: string | null = null;
    let lastOutcome: string | null = null;
    try {
      const first = streamOf(await request("POST", "/adventure-turns/stream", {
        campaignId, sessionId, actorId, declaration: entry.declaration,
        expectedRevision: revision, idempotencyKey: `ff-${options.seed}-${index}`,
      }));
      turnId = first.turnId;
      lastState = first.state; lastOutcome = first.outcome;
      record.status = first.status;
      phases.push({ phase: "initial", narration: first.narration, narrationSource: first.narrationSource });
      if (first.confirmationRequired?.proposalIds?.length && turnId) {
        const view = JSON.parse((await request("GET", `/adventure-turns/${turnId}`)).body);
        record.confirmed = true;
        record.proposalToolNames = (view.proposals ?? []).map((proposal: any) => String(proposal.toolName));
        const confirmed = await request("POST", `/adventure-turns/${turnId}/confirm`, {
          proposalIds: first.confirmationRequired.proposalIds, decision: "approve",
          expectedRevision: view.turn.revision, idempotencyKey: `ff-confirm-${options.seed}-${index}`,
        });
        const parsed = confirmed.status >= 200 && confirmed.status < 300 ? JSON.parse(confirmed.body) : {};
        const token = parsed.resumeToken ?? view.resumeToken;
        if (token) {
          const resumed = streamOf(await request("POST", "/adventure-turns/stream", { resumeToken: token }));
          record.status = resumed.status;
          lastState = resumed.state; lastOutcome = resumed.outcome;
          phases.push({ phase: "resume", narration: resumed.narration, narrationSource: resumed.narrationSource });
        }
      }
      record.finalState = lastState;
      record.outcome = lastOutcome;
      const finalPhase = phases[phases.length - 1]!;
      record.narration = finalPhase.narration;
      record.narrationSource = finalPhase.narrationSource;
      record.narrationClass = finalPhase.narrationSource === "none" || finalPhase.narration.trim().length === 0
        ? "none" : classifyNarration(finalPhase.narration, finalPhase.narrationSource);
      record.narrationEvents = narrationEventsOf(phases);
      if (turnId) {
        const view = JSON.parse((await request("GET", `/adventure-turns/${turnId}`)).body);
        record.receiptCommandIds = (view.receipts ?? []).map((receipt: any) => receipt.commandId as string);
        record.receiptKinds = record.receiptCommandIds.flatMap((commandId) => receiptProbe(turnId!, commandId).kinds);
        record.committed = record.receiptCommandIds.length > 0;
        if (record.proposalToolNames.length === 0 && Array.isArray(view.proposals)) {
          record.proposalToolNames = view.proposals.map((proposal: any) => String(proposal.toolName));
        }
      }
    } catch (error) {
      record.error = (error as Error).message.slice(0, 300);
    }
    record.providerCalls = providerCalls.length - before;
    record.latencyMs = Date.now() - turnStarted;
    // Coherence: resolve travel destinations and location-bound action locations from receipts.
    const travelDestinations: TravelDestination[] = [];
    const actionLocations: ActionLocation[] = [];
    if (turnId) {
      for (const commandId of record.receiptCommandIds) {
        const probe = receiptProbe(turnId, commandId);
        travelDestinations.push(...probe.travelDestinations);
        actionLocations.push(...probe.actionLocations);
      }
    }
    record.coherence = detectCoherenceViolations({
      index, turnId: turnId ?? "", declaration: entry.declaration,
      actorBeforeId: actorBefore, actorAfterId: actorLocationId(), travelDestinations, actionLocations,
      knownLocations: gazetteer(),
    });
    turnRecords.push(record);
    return record;
  };

  const runDmBeat = async (index: number, intent: "open" | "continue"): Promise<DmBeatRecord> => {
    const started = Date.now();
    const control = repo.getDmControl(OWNER, campaignId);
    const run = repo.openDmBeat(OWNER, campaignId, sessionId, { intent,
      expectedModeRevision: control.revision, idempotencyKey: `ff-dm-${options.seed}-${index}` });
    const planningCallsBefore = providerCalls.length;
    await orchestrateCampaignDmBeat(repo, OWNER, run.runId, deps);
    const executed = repo.getDmRun(OWNER, campaignId, sessionId, run.runId);
    const beat: DmBeatRecord = {
      index, intent, state: executed.state,
      receipts: executed.receipts.map((receipt: any) => receipt.action),
      candidatesOffered: providerCalls.slice(planningCallsBefore)
        .filter((call) => call.lane === "campaign-dm-v1" && call.dmCandidates).flatMap((call) => call.dmCandidates!),
      narration: executed.narration ?? "", blockers: executed.blockers ?? [],
      latencyMs: Date.now() - started, success: executed.state === "completed",
    };
    dmBeats.push(beat);
    return beat;
  };

  const control = repo.getDmControl(OWNER, campaignId);
  if (control.mode !== "ai") repo.setDmControl(OWNER, campaignId, { mode: "ai", expectedRevision: control.revision, idempotencyKey: `ff-ai-${options.seed}` });

  const dmAfter = new Set([1, 4, 7, 10, 13, 16]);
  const limit = Math.max(0, Math.min(options.turns, FREEFORM_DECLARATIONS.length));
  for (let index = 0; index < limit; index += 1) {
    const entry = FREEFORM_DECLARATIONS[index]!;
    const record = await runPlayerTurn(entry, index);
    if (!options.quiet) process.stderr.write(`turn ${index} ${entry.id} state=${record.finalState} class=${record.narrationClass} source=${record.narrationSource} committed=${record.committed}\n`);
    if (dmAfter.has(index)) {
      const beat = await runDmBeat(index, index === 0 ? "open" : "continue");
      record.dmBeatIndex = index;
      if (!options.quiet) process.stderr.write(`  dm ${index} state=${beat.state} receipts=${beat.receipts.join(",") || "-"} candidates=${beat.candidatesOffered.length}\n`);
    }
  }

  await app.close();

  const metrics = computeMetrics(turnRecords, dmBeats, providerCalls);
  const artifact: EvalArtifact = {
    version: 2, generatedAt: new Date().toISOString(), mode: "in-process",
    provider: { baseUrl: providerConfig.baseUrl, model: providerConfig.model },
    seed: options.seed, dataDir: directory, baseUrl: null,
    world: { campaignId, sessionId, actorId }, declarations: limit,
    narrationClassification: narrationClassificationDescriptor(),
    reliability: {
      providerCalls: true, dmCandidates: true, coherence: true,
      notes: [
        "Location coherence is a conservative heuristic over committed receipts and the resolved actor location.",
        "Narration classes: provider (source=provider-assisted), deliberate-hold (grounded server hold marker), narration-failure (every other deterministic fallback). fallbackDistinctness is computed over narration-failure events only.",
      ],
    },
    probes: probeOutcomes(turnRecords),
    metrics, turns: turnRecords, dmBeats, providerCalls,
  };
  const markdown = renderMarkdown(artifact, options.baseline);
  const markdownPath = options.out.endsWith(".json") ? `${options.out.slice(0, -5)}.md` : `${options.out}.md`;
  await writeFile(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, markdown);
  if (createdDir && !options.keep) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  return { artifact, markdown, output: options.out, markdownPath };
}

// ---------------------------------------------------------------------------------------------
// base-url driver (against an already-running server)
// ---------------------------------------------------------------------------------------------

export interface BaseUrlOptions {
  baseUrl: string;
  campaignId?: string | undefined;
  sessionId?: string | undefined;
  actorId?: string | undefined;
  turns: number;
  out: string;
  baseline: BaselineMetrics | null;
  quiet: boolean;
}

export async function runAgainstBaseUrl(options: BaseUrlOptions): Promise<EvalArtifact> {
  if (!options.campaignId || !options.sessionId || !options.actorId)
    throw new Error("--base-url requires --campaign-id, --session-id and --actor-id");
  const root = options.baseUrl.replace(/\/$/, "");
  const api = root.endsWith("/api/rpg/v1") ? root : `${root}/api/rpg/v1`;
  const url = new URL(api);
  const request = makeRequester(url.hostname, Number(url.port || (url.protocol === "https:" ? 443 : 80)), url.pathname.replace(/\/$/, ""));

  const campaignId = options.campaignId;
  const sessionId = options.sessionId;
  const actorId = options.actorId;
  const controlResponse = await request("GET", `/campaigns/${campaignId}/dm`);
  const control = controlResponse.status >= 200 && controlResponse.status < 300 ? JSON.parse(controlResponse.body) : { mode: "ai", revision: 0 };
  if (control.mode !== "ai") {
    await request("POST", `/campaigns/${campaignId}/dm/mode-commands`,
      { mode: "ai", expectedRevision: control.revision, idempotencyKey: `ff-base-ai-${Date.now()}` });
  }

  const campaignRevision = async (): Promise<number> => {
    const response = await request("GET", `/campaigns/${campaignId}/rooms/${sessionId}/play-bootstrap`);
    if (response.status >= 200 && response.status < 300) {
      try { return JSON.parse(response.body).expectedRevision ?? 0; } catch { return 0; }
    }
    return 0;
  };

  const turns: TurnRecord[] = [];
  const beats: DmBeatRecord[] = [];
  const dmAfter = new Set([1, 4, 7, 10, 13, 16]);
  const limit = Math.max(0, Math.min(options.turns, FREEFORM_DECLARATIONS.length));

  for (let index = 0; index < limit; index += 1) {
    const entry = FREEFORM_DECLARATIONS[index]!;
    const record: TurnRecord = {
      index, id: entry.id, category: entry.category, declaration: entry.declaration, probe: entry.probe ?? null,
      status: 0, finalState: null, outcome: null, narration: "", narrationSource: "none", narrationClass: "none",
      narrationEvents: [], committed: false, receiptKinds: [], receiptCommandIds: [], proposalToolNames: [],
      confirmed: false, dmBeatIndex: null, providerCalls: 0, latencyMs: 0, coherence: [],
    };
    const started = Date.now();
    try {
      const first = streamOf(await request("POST", "/adventure-turns/stream", {
        campaignId, sessionId, actorId, declaration: entry.declaration,
        expectedRevision: await campaignRevision(), idempotencyKey: `ff-base-${index}`,
      }));
      record.status = first.status;
      let lastState = first.state; let lastOutcome = first.outcome;
      const phases: Array<{ phase: "initial" | "resume"; narration: string; narrationSource: NarrationSource }> = [
        { phase: "initial", narration: first.narration, narrationSource: first.narrationSource },
      ];
      if (first.confirmationRequired?.proposalIds?.length && first.turnId) {
        const view = JSON.parse((await request("GET", `/adventure-turns/${first.turnId}`)).body);
        record.confirmed = true;
        record.proposalToolNames = (view.proposals ?? []).map((proposal: any) => String(proposal.toolName));
        const confirmed = await request("POST", `/adventure-turns/${first.turnId}/confirm`, {
          proposalIds: first.confirmationRequired.proposalIds, decision: "approve",
          expectedRevision: view.turn.revision, idempotencyKey: `ff-base-confirm-${index}`,
        });
        const parsed = confirmed.status >= 200 && confirmed.status < 300 ? JSON.parse(confirmed.body) : {};
        const token = parsed.resumeToken ?? view.resumeToken;
        if (token) {
          const resumed = streamOf(await request("POST", "/adventure-turns/stream", { resumeToken: token }));
          lastState = resumed.state; lastOutcome = resumed.outcome;
          phases.push({ phase: "resume", narration: resumed.narration, narrationSource: resumed.narrationSource });
        }
      }
      record.finalState = lastState;
      record.outcome = lastOutcome;
      const finalPhase = phases[phases.length - 1]!;
      record.narration = finalPhase.narration;
      record.narrationSource = finalPhase.narrationSource;
      record.narrationClass = finalPhase.narrationSource === "none" || finalPhase.narration.trim().length === 0
        ? "none" : classifyNarration(finalPhase.narration, finalPhase.narrationSource);
      record.narrationEvents = narrationEventsOf(phases);
      if (first.turnId) {
        const view = JSON.parse((await request("GET", `/adventure-turns/${first.turnId}`)).body);
        record.receiptCommandIds = (view.receipts ?? []).map((receipt: any) => receipt.commandId as string);
        record.receiptKinds = record.receiptCommandIds.map(() => "receipt");
        record.committed = record.receiptCommandIds.length > 0;
      }
    } catch (error) {
      record.error = (error as Error).message.slice(0, 300);
    }
    record.latencyMs = Date.now() - started;
    turns.push(record);
    if (!options.quiet) process.stderr.write(`turn ${index} ${entry.id} class=${record.narrationClass} committed=${record.committed}\n`);
    if (dmAfter.has(index)) {
      const beat = await runBaseDmBeat(request, campaignId, sessionId, options, index);
      record.dmBeatIndex = index;
      beats.push(beat);
      if (!options.quiet) process.stderr.write(`  dm ${index} state=${beat.state}\n`);
    }
  }

  const artifact: EvalArtifact = {
    version: 2, generatedAt: new Date().toISOString(), mode: "base-url",
    provider: { baseUrl: root, model: "unknown" }, seed: 0, dataDir: null, baseUrl: root,
    world: { campaignId, sessionId, actorId }, declarations: limit,
    narrationClassification: narrationClassificationDescriptor(),
    reliability: {
      providerCalls: false, dmCandidates: false, coherence: false,
      notes: [
        "base-url mode cannot intercept provider calls: providerSuccessRate and fallback distinctness are unreliable.",
        "base-url mode cannot resolve receipt command ids to locations: location-coherence violations are not measured.",
        "base-url mode cannot resolve typed receipt kinds, so the labeled-probe assertions (commerce/check) are unreliable here.",
        "DM-beat offered candidates require provider-call interception and are empty in base-url mode.",
      ],
    },
    probes: probeOutcomes(turns),
    metrics: computeMetrics(turns, beats, []), turns, dmBeats: beats, providerCalls: [],
  };
  const markdown = renderMarkdown(artifact, options.baseline);
  const markdownPath = options.out.endsWith(".json") ? `${options.out.slice(0, -5)}.md` : `${options.out}.md`;
  await writeFile(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, markdown);
  return artifact;
}

async function runBaseDmBeat(
  request: Requester, campaignId: string, sessionId: string, options: BaseUrlOptions, index: number,
): Promise<DmBeatRecord> {
  const started = Date.now();
  const control = JSON.parse((await request("GET", `/campaigns/${campaignId}/dm`)).body);
  let run = JSON.parse((await request("POST", `/campaigns/${campaignId}/rooms/${sessionId}/dm/beat-commands`,
    { intent: index === 0 ? "open" : "continue", expectedModeRevision: control.revision, idempotencyKey: `ff-base-dm-${index}` })).body);
  if (run.state === "awaiting-approval") {
    const proposal = JSON.parse((await request("GET", `/campaigns/${campaignId}/rooms/${sessionId}/dm/runs/${run.runId}/proposal`)).body);
    run = JSON.parse((await request("POST", `/campaigns/${campaignId}/rooms/${sessionId}/dm/runs/${run.runId}/decision-commands`,
      { decision: "approved", expectedRevision: proposal.run.revision, idempotencyKey: `ff-base-dm-approve-${index}` })).body);
  }
  return {
    index, intent: run.intent ?? (index === 0 ? "open" : "continue"), state: run.state ?? "unknown",
    receipts: (run.receipts ?? []).map((receipt: any) => receipt.action),
    candidatesOffered: [], narration: run.narration ?? "", blockers: run.blockers ?? [],
    latencyMs: Date.now() - started, success: run.state === "completed",
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function argValue(args: readonly string[], name: string): string | undefined {
  const prefixed = args.find((value) => value.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < args.length && !args[index + 1]!.startsWith("--")) return args[index + 1];
  return undefined;
}

function printMetricTable(metrics: FreeformMetrics, baseline: BaselineMetrics | null): void {
  const record = metrics as unknown as Record<string, number>;
  const baselineRecord = baseline as unknown as Record<string, number> | null;
  const diffs = baselineRecord ? diffMetrics(record, baselineRecord) : [];
  const byKey = new Map(diffs.map((diff) => [diff.key, diff]));
  process.stdout.write(`${"metric".padEnd(24)} ${"current".padStart(12)} ${"baseline".padStart(12)}  verdict\n`);
  for (const key of Object.keys(metrics)) {
    const value = record[key]!;
    const diff = byKey.get(key);
    process.stdout.write(`${key.padEnd(24)} ${formatMetricValue(key, value).padStart(12)} ${(diff ? formatMetricValue(key, diff.baseline) : "-").padStart(12)}  ${diff ? diffVerdict(diff) : ""}\n`);
  }
}

async function loadBaseline(args: readonly string[]): Promise<BaselineMetrics | null> {
  const baselinePath = argValue(args, "baseline");
  if (!baselinePath) return DOCUMENTED_BASELINE;
  const parsed = JSON.parse(await readFile(baselinePath, "utf8")) as { metrics?: Record<string, number>; label?: string } & Record<string, number>;
  return parsed.metrics ? { label: parsed.label ?? "baseline-file", ...parsed.metrics } : parsed as BaselineMetrics;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrl = argValue(args, "base-url");
  const out = argValue(args, "out") ?? `/tmp/opencode/freeform-fun-eval-${Date.now()}.json`;
  const baseline = await loadBaseline(args);
  const turns = Number(argValue(args, "turns") ?? FREEFORM_DECLARATIONS.length);
  const quiet = args.includes("--quiet");

  if (baseUrl) {
    const artifact = await runAgainstBaseUrl({
      baseUrl, campaignId: argValue(args, "campaign-id"), sessionId: argValue(args, "session-id"),
      actorId: argValue(args, "actor-id"), turns, out, baseline, quiet,
    });
    printMetricTable(artifact.metrics, baseline);
    process.stdout.write(`\njson: ${out}\nmarkdown: ${out.endsWith(".json") ? out.slice(0, -5) : out}.md\n`);
    return;
  }

  const result = await runFreeformFunEval({
    dataDir: argValue(args, "data-dir"), turns,
    seed: Number(argValue(args, "seed") ?? 11),
    port: Number(argValue(args, "port") ?? 18814),
    out, baseline, keep: args.includes("--keep"), quiet,
  });
  printMetricTable(result.artifact.metrics, baseline);
  process.stdout.write(`\njson: ${result.output}\nmarkdown: ${result.markdownPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });
}

function fileURLToPath(url: string): string { return url.startsWith("file:") ? new URL(url).pathname : url; }
