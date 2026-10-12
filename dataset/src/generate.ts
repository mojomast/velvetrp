/**
 * The VelvetRP generation pipeline: seed -> spec -> realization -> teacher ->
 * gate -> repair -> admission -> committed candidate.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * -------------------------------------
 *
 * Nothing had ever been generated when this was written. Every sibling module is
 * a gate, and a gate over nothing is untested code. So this module is written so
 * that the FAILING paths are the ones that are cheap to reach, and the
 * succeeding path is the one that has to earn its way through every gate.
 *
 * FIVE INVARIANTS, EACH ENFORCED IN CODE
 * --------------------------------------
 *
 * 1. FAIL CLOSED, ALWAYS. `dryRun` defaults to TRUE. Real generation requires an
 *    explicit `execute: true` / `--execute`. There is no default path that spends
 *    money. The budget is measured in supervised assistant tokens AFTER MASKING,
 *    which requires a real tokenizer; when one is absent the budget check throws
 *    rather than defaulting to "unlimited". No estimate, no fabrication, ever.
 *
 * 2. ADMISSION IS NOT OURS TO DECIDE. Nothing in this file constructs an admitted
 *    record. The only path is `admitCandidate(...)` -> `commitCandidate({...,
 *    admission: decision})`. The batch is measured by verifying the resulting
 *    certificate, not by trusting the status we asked for.
 *
 * 3. REPAIR IS A NEW ATTEMPT, NEVER AN EDIT. Each repair gets a fresh attempt id
 *    and supersedes its parent through `commitCandidate`. The failed parent's RAW
 *    and PARSED text are retained on its own record so the next attempt can act
 *    on them. In-place mutation of an attempt is not representable.
 *
 * 4. DETERMINISM EVERYWHERE EXCEPT THE TEACHER'S OWN SAMPLING. Every local
 *    choice -- which family, which realization, which repair variant, which
 *    cluster -- comes from an explicitly seeded PRNG. `Math.random` appears
 *    nowhere. Same seed => same spec, same realizations, same prompts.
 *
 * 5. MEASURE DIVERSITY, DO NOT ASSUME IT. Realizations are cluster-capped
 *    combinations, not a list of templates, and the pilot report states the
 *    measured numbers at four points: before validation, after validation, after
 *    repair, and after selection.
 *
 * FAMILY WEIGHTS come from `dataset/BASELINE_SIGNAL.md` lines 110-147, not from
 * taste. Tool selection is split into INITIATION and ARGUMENT BINDING because
 * the measured failure modes are different behaviours (54/84 abstentions on
 * prose-shaped tools vs 7/7 initiations that then emit 43-45 copies of `{}`).
 * `roleplay-conversation` keeps a deliberately small, NON-ZERO retention tranche:
 * a prior audit flagged deferring it to zero as a mistake, and zero means the
 * family cannot be measured at all.
 */

import { createHash } from "node:crypto";

import {
  ADMISSION_CERTIFICATE_VERSION,
  admitCandidate,
  computePayloadDigest,
  requiredValidatorsFor,
  verifyAdmissionCertificate,
  type AdmittedRecordV1,
  type AdmissionInput,
  type GateEvidence,
  type ReviewRecord,
} from "./admission.js";
import { exportTrainingJsonl, type ExportTrainingOptions, type ExportTrainingResult } from "./export.js";
import { GROUNDING_VALIDATOR_VERSION, authoritativeFacts, evaluateGroundedNarration, type GroundingReceipt } from "./grounding.js";
import { selectTargets, type TargetSelection } from "./hfAdapter.js";
import {
  FAMILY_C_VALIDATOR_VERSION,
  FAMILY_D_VALIDATOR_VERSION,
  scoreSelection,
  validateAdvertisedSelection,
  validateWorldGeneration,
  type AdvertisedCandidate,
  type ProviderSelection,
  type SelectionVerdict,
  type WorldGenerationVerdict,
} from "./worldGeneration.js";
import type { CanonicalDependency, CatalogIdentity } from "./worldGenerationTypes.js";
import {
  readGitCommit,
  recordContentDigest,
  type GeneratorIdentity,
  type RunStore,
} from "./runstore.js";
import {
  FOUNDRY_VERSION,
  RECORD_SCHEMA_VERSION,
  TRAINING_FAMILIES,
  stableStringify,
  type CandidateRecord,
  type DatasetSplit,
  type LineageGroup,
  type Provenance,
  type ReviewScores,
  type StoredMessage,
  type StoredTool,
  type StoredToolCall,
  type TrainingFamily,
} from "./spec.js";
import {
  assertDistinctModels,
  sha256Hex,
  type TeacherClient,
  type TeacherCompletion,
  type TeacherMessage,
} from "./teacher.js";

// ---------------------------------------------------------------------------
// Versions, stages, weights
// ---------------------------------------------------------------------------

export const GENERATOR_VERSION = "generator-v1";
export const REVIEW_PROMPT_VERSION = "review-prompt-v1";
export const REPAIR_PROMPT_VERSION = "repair-prompt-v1";

/**
 * The staging vocabulary reused verbatim from `worldGeneration.ts` repair diffs.
 * A failure at any stage retains the RAW and PARSED text so a repair can act on
 * what the teacher actually said, not on a paraphrase of it.
 */
export const PIPELINE_STAGES = ["PROMPT", "RAW", "PARSED", "SANITIZED", "VALIDATED"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Generation targets. `tool-selection` is split because BASELINE_SIGNAL measured
 * two unrelated behaviours under one label; averaging them would hide both.
 */
export type GenerationTarget =
  | TrainingFamily
  | "tool-selection:initiation"
  | "tool-selection:argument-binding";

/**
 * Shares derived from `BASELINE_SIGNAL.md` "Re-derived weights", expressed as a
 * plan allocation rather than as a priority ranking. Roleplay is a COMPACT
 * RETENTION TRANCHE: small, non-zero, and deliberately not zero.
 */
export type WeightTarget = Exclude<GenerationTarget, "tool-selection">;

export const FAMILY_WEIGHTS: Readonly<Record<WeightTarget, number>> = Object.freeze({
  "tool-selection:initiation": 0.12,
  "tool-selection:argument-binding": 0.18,
  "world-generation": 0.28,
  "grounded-narration": 0.22,
  "boundary-recovery": 0.14,
  // Retained, not deferred. A zero tranche means the family is never measured,
  // which is how a family becomes unmeasurable and then disappears.
  "roleplay-conversation": 0.06,
});

export function targetsFor(family: TrainingFamily): readonly GenerationTarget[] {
  return family === "tool-selection"
    ? ["tool-selection:initiation", "tool-selection:argument-binding"]
    : [family];
}

export const FAMILY_RATIONALE: Readonly<Record<TrainingFamily, string>> = Object.freeze({
  "tool-selection": "high (split by tool family): 64% false abstention and {}-argument collapse",
  "world-generation": "high: 0/10 on both measured models",
  "grounded-narration": "medium-high: 0/11 on both; partly blocked by referential fidelity",
  "boundary-recovery": "medium: leakage is not the gap; re-measure after the model speaks",
  "roleplay-conversation": "compact retention tranche: unmeasured, deliberately non-zero",
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PipelineRefusalCode =
  | "tokenizer-unavailable"
  | "no-validators-implemented"
  | "reviewer-not-independent"
  | "no-credential"
  | "budget-exhausted"
  | "execution-not-authorized";

/**
 * A fail-closed refusal. These are never caught and downgraded to a warning: a
 * precondition that cannot be proven is a stop, not a note.
 */
export class PipelineRefusal extends Error {
  readonly code: PipelineRefusalCode;
  readonly problems: readonly string[];
  constructor(code: PipelineRefusalCode, problems: readonly string[]) {
    super(`${code}: ${problems.join("; ")}`);
    this.name = "PipelineRefusal";
    this.code = code;
    this.problems = problems;
  }
}

/** Missing tokenizer. The single most important fail-closed path in this file. */
export class TokenizerUnavailableError extends PipelineRefusal {
  constructor(detail: string) {
    super("tokenizer-unavailable", [
      `the token budget is measured in supervised assistant tokens AFTER MASKING, which needs a real ` +
        `tokenizer; ${detail}. Refusing to proceed: an unmeasured budget is not a budget, and treating a ` +
        `missing tokenizer as "unlimited" is how a run spends money nobody approved. Supply a TokenizerPort ` +
        `backed by measured TRL/Transformers output, or run with dryRun (which spends nothing and needs none).`,
    ]);
    this.name = "TokenizerUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffled<T>(items: readonly T[]): T[];
  /** An independent stream derived from this one. Never shares state. */
  fork(label: string): Rng;
}

/**
 * splitmix64 over BigInt. Chosen over a float LCG because the results are
 * bit-identical on every platform, which is what "same seed => same spec"
 * actually requires. No `Math.random` anywhere in this module.
 */
function splitmix(state: bigint): { state: bigint; value: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return { state: next, value: (z ^ (z >> 31n)) & MASK64 };
}

export function createRng(seed: string): Rng {
  let state = BigInt(`0x${sha256Hex(seed).slice(0, 16)}`);
  const next = (): number => {
    const step = splitmix(state);
    state = step.state;
    // 53 bits of mantissa keeps the result exactly representable as a double.
    return Number(step.value >> 11n) / 2 ** 53;
  };
  const int = (maxExclusive: number): number => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
      throw new PipelineRefusal("execution-not-authorized", [`rng bound must be a positive safe integer, got ${maxExclusive}`]);
    }
    return Math.min(maxExclusive - 1, Math.floor(next() * maxExclusive));
  };
  const rng: Rng = {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new PipelineRefusal("execution-not-authorized", ["cannot pick from an empty list"]);
      return items[int(items.length)]!;
    },
    shuffled<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = int(index + 1);
        const held = copy[index]!;
        copy[index] = copy[swap]!;
        copy[swap] = held;
      }
      return copy;
    },
    fork(label: string): Rng {
      return createRng(`${seed}::${label}`);
    },
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Tokenizer port and budget
// ---------------------------------------------------------------------------

/**
 * What the trainer actually supervises, after masking, for one candidate.
 *
 * The port deliberately takes the whole example rather than a string, because
 * the real implementation must render the chat template and build the loss mask
 * -- a plain token count of the raw strings would not be the number that reaches
 * the optimizer.
 */
export interface SupervisedExample {
  readonly family: TrainingFamily;
  readonly messages: readonly StoredMessage[];
  readonly tools?: readonly StoredTool[] | undefined;
  readonly targetSelection: TargetSelection;
}

/**
 * Pluggable token measurement. There is deliberately NO built-in implementation:
 * the template profiles in `templateProfiles.ts` fail the export gate until real
 * TRL/Transformers measurements land, so any token count produced here would be
 * a guess wearing a number's clothes.
 */
export interface TokenizerPort {
  /** Recorded in `provenance.tokenCount.tokenizer`. */
  readonly name: string;
  /** Tokens under loss, after masking. Must be measured, never estimated. */
  countSupervisedTokens(example: SupervisedExample): number;
}

export function requireTokenizer(port: TokenizerPort | null | undefined): TokenizerPort {
  if (!port) throw new TokenizerUnavailableError("no tokenizer port was supplied");
  if (!port.name.trim()) throw new TokenizerUnavailableError("the tokenizer port has no name to record in provenance");
  if (typeof port.countSupervisedTokens !== "function") {
    throw new TokenizerUnavailableError("the tokenizer port has no countSupervisedTokens function");
  }
  const probe = port.countSupervisedTokens({
    family: "roleplay-conversation",
    messages: [{ role: "assistant", content: "probe" }],
    targetSelection: { supervisedAssistantIndices: [0], supervisedToolCallIndices: [] },
  });
  if (!Number.isSafeInteger(probe) || probe < 0) {
    throw new TokenizerUnavailableError("the tokenizer port did not return a non-negative integer token count");
  }
  return port;
}

export interface TokenBudget {
  /** Cap across the whole run, in supervised assistant tokens. */
  readonly maxSupervisedAssistantTokens: number;
  /** Optional per-target caps, so one family cannot starve another. */
  readonly perTarget?: Readonly<Partial<Record<GenerationTarget, number>>> | undefined;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = Object.freeze({
  maxSupervisedAssistantTokens: 4_000_000,
  perTarget: Object.freeze({
    "tool-selection:initiation": 600_000,
    "tool-selection:argument-binding": 900_000,
    "world-generation": 1_120_000,
    "grounded-narration": 880_000,
    "boundary-recovery": 560_000,
    "roleplay-conversation": 240_000,
  }),
});

/**
 * Ledger of measured spend. Only MEASURED values are ever added; there is no
 * `estimate()` method, because an estimator that nobody can audit is how a
 * budget becomes decorative.
 */
export interface BudgetLedger {
  total: number;
  readonly byTarget: Map<GenerationTarget, number>;
}

export function createBudgetLedger(): BudgetLedger {
  return { total: 0, byTarget: new Map<GenerationTarget, number>() };
}

export function recordSpend(ledger: BudgetLedger, target: GenerationTarget, tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new PipelineRefusal("execution-not-authorized", [`refusing to record a non-measured token count (${tokens})`]);
  }
  ledger.total += tokens;
  ledger.byTarget.set(target, (ledger.byTarget.get(target) ?? 0) + tokens);
}

/**
 * Which budget a unit's tokens are charged to.
 *
 * Tool selection has TWO budgets because BASELINE_SIGNAL measured two unrelated
 * behaviours. Charging every tool-selection record to the initiation budget
 * would let argument-binding collapse hide inside it, which is the exact
 * averaging the split exists to prevent.
 */
export function budgetTargetFor(family: TrainingFamily, bucket: ToolSelectionBucket): GenerationTarget {
  if (family !== "tool-selection") return family;
  return bucket === "argument-binding-failure" || bucket === "shape-failure"
    ? "tool-selection:argument-binding"
    : "tool-selection:initiation";
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly remainingTotal: number;
  readonly remainingTarget: number | null;
}

/**
 * Refuses BEFORE dispatch when the worst case cannot fit.
 *
 * The worst case is the caller's explicit `maxTokens`, and nothing else. The
 * prompt is CONTEXT, which the mask excludes, so it consumes no supervised
 * budget; context and provider spend are bounded by the run store's own
 * `maxTotalTokens` / `maxCostUsd` reservations, which is the correct place for
 * them. Adding prompt tokens here would have inflated the training budget with
 * numbers that never reach the optimizer.
 */
export function checkBudget(input: {
  readonly ledger: BudgetLedger;
  readonly budget: TokenBudget;
  readonly target: GenerationTarget;
  readonly maxCompletionTokens: number;
}): BudgetDecision {
  const worstCase = input.maxCompletionTokens;
  const remainingTotal = input.budget.maxSupervisedAssistantTokens - input.ledger.total;
  const cap = input.budget.perTarget?.[input.target];
  const spentTarget = input.ledger.byTarget.get(input.target) ?? 0;
  const remainingTarget = cap === undefined ? null : cap - spentTarget;
  if (worstCase > remainingTotal) {
    return {
      allowed: false,
      reason: `worst case ${worstCase} supervised tokens exceeds the ${remainingTotal} remaining for the run`,
      remainingTotal,
      remainingTarget,
    };
  }
  if (remainingTarget !== null && worstCase > remainingTarget) {
    return {
      allowed: false,
      reason: `worst case ${worstCase} supervised tokens exceeds the ${remainingTarget} remaining for target ${input.target}`,
      remainingTotal,
      remainingTarget,
    };
  }
  return { allowed: true, reason: null, remainingTotal, remainingTarget };
}

// ---------------------------------------------------------------------------
// Scenario specification
// ---------------------------------------------------------------------------

/** Anchor banks. Referential fidelity is the largest measured failure mode. */
const ANCHORS = Object.freeze({
  npc: ["Haug", "Ailsa", "Oswin", "Maren", "Corbin", "Ivet", "Sable", "Thrale"] as const,
  place: ["Tallow Street", "the Salt Pier", "Cinderhold", "the Weeping Gate", "Lowmarket Row", "the Dry Quarry"] as const,
  object: ["the ledger", "a brass key", "the tide chart", "a sealed writ", "the manifest"] as const,
  guild: ["the Harbour Guild", "the Salt Company", "the Assize", "the Ninth Watch"] as const,
});

const TONES = Object.freeze([
  "terse and procedural",
  "low-register and wary",
  "clipped, almost bureaucratic",
  "warm but evasive",
  "flatly transactional",
] as const);

const TURN_MOTIVES = Object.freeze([
  "asks for directions to {place}",
  "asks what {npc} has been doing lately",
  "offers {object} as proof of passage",
  "asks whether the {guild} will help",
  "asks about a debt owed to {npc}",
  "asks for the room above {place}",
] as const);

const WORLD_THEMES = Object.freeze([
  "a drowned harbour town where the tide never fully recedes",
  "a salt-mine town whose lower levels are sealed by guild decree",
  "a river-fort town that changes hands every season",
  "a cliff town reachable only at low tide",
] as const);

const SECTION_POOL = Object.freeze([
  "locations",
  "npcs",
  "factions",
  "quests",
  "encounters",
  "lore",
  "questItems",
  "monsterConcepts",
] as const);

const TOOL_FAMILIES = Object.freeze([
  "exact-candidate",
  "narration-submit",
  "read-tool",
  "no-tool",
] as const);
export type ToolFamily = (typeof TOOL_FAMILIES)[number];

export const TOOL_FAMILY_RATIONALE: Readonly<Record<ToolFamily, string>> = Object.freeze({
  "exact-candidate": "structured arguments; Qwen3.5-9B initiates 7/7 then emits {}-arguments to the cap",
  "narration-submit": "the 'tool' is prose; Qwen3.5-9B abstains on 54/84 of these cases",
  "read-tool": "structured, read-only; initiation is the binding risk",
  "no-tool": "legitimate abstention; a false call is as costly as a false abstention",
});

/** The ground truth a candidate is measured against. Never authored by a teacher. */
export interface ScenarioOracle {
  readonly family: TrainingFamily;
  readonly toolFamily: ToolFamily;
  /** Whether the correct behaviour is to call a tool at all. */
  readonly expectsToolCall: boolean;
  readonly advertisedCandidates: readonly AdvertisedCandidate[];
  readonly advertisedToolNames: readonly string[];
  /** Never disclosable. The boundary-leakage gate checks every one of these. */
  readonly hiddenFacts: readonly string[];
  readonly visibilityRequirements: readonly string[];
  readonly authorityRequirements: readonly string[];
  readonly behaviourTags: readonly string[];
  /** Grounded narration ground truth. */
  readonly receipts: readonly GroundingReceipt[];
  readonly authorizedConsequences: readonly string[];
  /** World generation ground truth. */
  readonly sections: readonly string[];
  readonly dependencies: ReadonlyMap<string, CanonicalDependency>;
  readonly catalogReferences: readonly CatalogIdentity[];
  readonly desiredCounts: Readonly<Record<string, number>>;
}

export interface ScenarioSpec {
  readonly specId: string;
  readonly seed: string;
  readonly family: TrainingFamily;
  readonly split: DatasetSplit;
  readonly lineage: LineageGroup;
  /** Coarse shape signature used for the realization cluster cap. */
  readonly clusterFamily: string;
  readonly templateVersion: string;
  readonly advertisedTools: readonly StoredTool[];
  readonly oracle: ScenarioOracle;
  readonly digest: string;
}

export interface ScenarioSpecOptions {
  readonly split?: DatasetSplit;
  readonly specVersion?: string;
  /**
   * Force the family. A plan allocates units BY WEIGHT, so a spec that picked
   * its own family would silently disagree with the allocation and every gate,
   * budget target and report line would be describing a different family than
   * the one actually generated.
   */
  readonly family?: TrainingFamily;
}

function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => slots[key] ?? match);
}

/**
 * Splits are assigned by lineage group, never per example: two realizations of
 * one scenario share a split, so a paraphrase of a held-out scene can never end
 * up in training.
 */
function splitForLineage(lineage: LineageGroup): DatasetSplit {
  const digest = sha256Hex(stableStringify(lineage));
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;
  if (bucket < 80) return "train";
  if (bucket < 90) return "dev";
  return "sealed-test";
}

function candidateMenu(rng: Rng, npc: string, place: string): {
  candidates: AdvertisedCandidate[];
  toolNames: string[];
} {
  const labels = [
    `advance toward ${place}`,
    `put the question to ${npc}`,
    `search the lower stair`,
    `wait until the watch turns`,
  ];
  const toolName = "choose_adventure_candidate";
  const candidates = labels.slice(0, rng.int(3) + 2).map((label, index) => ({
    candidateId: `${label.replace(/\W+/g, "-")}-${index + 1}`,
    digest: sha256Hex(`${label}|${index}|${rng.next()}`),
    toolName,
    label,
  }));
  return { candidates, toolNames: [toolName] };
}

function advertisedToolsFor(family: TrainingFamily, oracle: ScenarioOracle): readonly StoredTool[] {
  if (family === "grounded-narration") {
    return [{
      type: "function",
      function: {
        name: "submit_adventure_narration",
        description: "Submit the narration of a COMMITTED turn. Arguments must contain the narration text and nothing else.",
        parameters: {
          type: "object",
          properties: { narration: { type: "string", description: "The narration of committed outcomes only." } },
          required: ["narration"],
          additionalProperties: false,
        },
      },
    }];
  }
  if (family !== "tool-selection") return [];
  return oracle.advertisedToolNames.map((name) => ({
    type: "function",
    function: {
      name,
      description: "Apply exactly one advertised candidate to this decision.",
      parameters: {
        type: "object",
        properties: {
          candidateId: { type: "string", description: "The advertised candidate id." },
          digest: { type: "string", description: "The advertised 64-hex digest." },
        },
        required: ["candidateId", "digest"],
        additionalProperties: false,
      },
    },
  }));
}

/**
 * A fully deterministic scenario specification.
 *
 * Same seed => byte-identical spec, including the authoritative receipts. The
 * receipts are generated here, not by the teacher, because the receipt is the
 * ground truth: a teacher-authored ground truth would be a teacher grading its
 * own homework.
 */
export function scenarioSpec(seed: string, options: ScenarioSpecOptions = {}): ScenarioSpec {
  const rng = createRng(`spec:${seed}`);
  const family = options.family ?? rng.pick(TRAINING_FAMILIES);
  const clusterFamily = rng.pick(WORLD_THEMES);
  const npc = rng.pick(ANCHORS.npc);
  const place = rng.pick(ANCHORS.place);
  const object = rng.pick(ANCHORS.object);
  const guild = rng.pick(ANCHORS.guild);
  const tone = rng.pick(TONES);
  const slots = { npc, place, object, guild };
  const lineage: LineageGroup = {
    characterFamily: `char-${sha256Hex(`${seed}|char`).slice(0, 12)}`,
    worldFamily: `world-${sha256Hex(`${seed}|world`).slice(0, 12)}`,
    scenarioFamily: `scen-${sha256Hex(`${seed}|scen|${family}`).slice(0, 12)}`,
  };
  const split = options.split ?? splitForLineage(lineage);

  const hiddenFacts = [
    `${npc} has already been paid by the ${guild}`,
    `the lower stair is sealed because the previous keeper vanished`,
    `${npc} does not recognise ${object}`,
  ];

  const toolFamily: ToolFamily = family === "tool-selection"
    ? rng.pick(TOOL_FAMILIES)
    : family === "grounded-narration"
      ? "narration-submit"
      : "no-tool";

  const menu = family === "tool-selection" && toolFamily === "exact-candidate"
    ? candidateMenu(rng.fork("menu"), npc, place)
    : { candidates: [] as AdvertisedCandidate[], toolNames: [] as string[] };

  const receipts: GroundingReceipt[] = family !== "grounded-narration" ? [] : [
    {
      kind: "check",
      receiptId: `${sha256Hex(`${seed}|check`).slice(0, 10)}`,
      actor: "you",
      skill: rng.pick(["Perception", "Insight", "Deception", "Survival"] as const),
      total: rng.int(14) + 8,
      dc: rng.pick([10, 12, 14, 15, 18] as const),
      outcome: rng.pick(["success", "failure"] as const),
      visibility: "public",
    },
    {
      kind: "combat",
      receiptId: `${sha256Hex(`${seed}|damage`).slice(0, 10)}`,
      actor: npc,
      action: "attack",
      visibility: "public",
      outcome: {
        kind: "damage",
        applied: rng.int(9) + 3,
        hitPointsBefore: 24,
        hitPointsAfter: 24 - (rng.int(9) + 3),
        hit: true,
        damageType: "slashing",
        statusAfter: "stable",
      },
    },
  ];

  const sections: string[] = family === "world-generation"
    ? rng.shuffled([...SECTION_POOL]).slice(0, rng.int(2) + 2)
    : [];
  const dependencyKeys = sections.map((_section, index) => `world-dep-${sha256Hex(`${seed}|dep|${index}`).slice(0, 8)}`);
  const dependencies = new Map<string, CanonicalDependency>(
    dependencyKeys.map((key, index) => [
      key,
      { key, kind: index % 2 === 0 ? "location" : "npc", visibility: "public" } as CanonicalDependency,
    ]),
  );
  const catalogReferences: CatalogIdentity[] = [
    {
      kind: "monster",
      packId: `${guild.toLowerCase().replace(/\W+/g, "-")}-bestiary`,
      packVersion: "1.2.0",
      definitionId: `${slug(npc)}-hound`,
      referenceIdentity: `${guild.toLowerCase().replace(/\W+/g, "-")}-bestiary@1.2.0#${slug(npc)}-hound`,
    },
  ];
  const desiredCounts: Record<string, number> = {};

  const oracle: ScenarioOracle = {
    family,
    toolFamily,
    expectsToolCall: toolFamily !== "no-tool",
    advertisedCandidates: menu.candidates,
    advertisedToolNames: menu.toolNames,
    hiddenFacts,
    visibilityRequirements: family === "grounded-narration" || family === "boundary-recovery" || family === "roleplay-conversation"
      ? [`${npc} does not know why the lower stair is sealed`]
      : [],
    authorityRequirements: family === "boundary-recovery"
      ? [`the assistant may not open the sealed stair on the player's behalf`]
      : [],
    behaviourTags: behaviourTagsFor(family, toolFamily),
    receipts,
    authorizedConsequences: [],
    sections,
    dependencies,
    catalogReferences,
    desiredCounts,
  };

  const body = {
    specId: `spec-${sha256Hex(`${seed}|${family}`).slice(0, 20)}`,
    seed,
    family,
    split,
    lineage,
    clusterFamily,
    templateVersion: options.specVersion ?? GENERATOR_VERSION,
    tone,
    slots,
    motive: fill(rng.pick(TURN_MOTIVES), slots),
    oracle,
  };
  const digest = sha256Hex(stableStringify(body));
  return Object.freeze({
    specId: body.specId,
    seed,
    family,
    split,
    lineage,
    clusterFamily,
    templateVersion: body.templateVersion,
    advertisedTools: advertisedToolsFor(family, oracle),
    oracle,
    digest,
  });
}

function behaviourTagsFor(family: TrainingFamily, toolFamily: ToolFamily): readonly string[] {
  switch (family) {
    case "roleplay-conversation":
      // "agency" pulls in the player-agency validator; no "tool" substring, so
      // it does not accidentally demand tool-envelope evidence.
      return ["roleplay", "agency-preservation", "anchor-preservation"];
    case "grounded-narration":
      return ["grounded-narration", "receipt-bound", "anchor-preservation"];
    case "world-generation":
      return ["world-generation", "schema-exact", "anchor-preservation"];
    case "boundary-recovery":
      return toolFamily === "no-tool"
        ? ["boundary", "hidden-knowledge", "abstention", "anchor-preservation"]
        : ["boundary", "hidden-knowledge", "authority", "anchor-preservation"];
    case "tool-selection":
      return toolFamily === "no-tool"
        ? ["tool-decision", "no-tool", "abstention", "anchor-preservation"]
        : ["tool-decision", "tool-call", toolFamily, "anchor-preservation"];
    default: {
      const exhaustive: never = family;
      return exhaustive;
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Realization
// ---------------------------------------------------------------------------

export interface Realization {
  readonly realizationId: string;
  readonly specId: string;
  readonly clusterId: string;
  readonly slots: Readonly<Record<string, string>>;
  /** The conversation the teacher must continue. Never contains its answer. */
  readonly context: readonly StoredMessage[];
  readonly digest: string;
}

/**
 * The prompt scaffold, assembled deterministically from the spec and the slots.
 *
 * It states the family contract and the anchors. It deliberately does NOT contain
 * the expected answer: a prompt that names the correct tool call teaches
 * transcription, not selection.
 */
function buildContext(spec: ScenarioSpec, slots: Readonly<Record<string, string>>, motive: string): StoredMessage[] {
  const system: string[] = [
    `You are the narrator for ${slots.place}. Keep the voice ${slots.tone}.`,
    "Never invent a mechanical outcome. Never disclose what the player has not observed.",
    "Use every proper noun exactly as written; do not replace a name with a pronoun.",
  ];
  const messages: StoredMessage[] = [{ role: "system", content: system.join(" ") }];
  switch (spec.family) {
    case "grounded-narration":
      messages.push({
        role: "user",
        content: `The turn is committed. Describe only what happened to ${slots.npc}.`,
      });
      break;
    case "world-generation":
      messages.push({
        role: "user",
        content: `Draft the ${spec.oracle.sections.join(", ")} sections for a campaign set in ${slots.place}.`,
      });
      break;
    case "tool-selection":
      if (spec.oracle.toolFamily === "no-tool") {
        messages.push({ role: "user", content: "Say what you can see. There is nothing to call." });
      } else {
        messages.push({ role: "user", content: `${capitalize(fill(motive, slots))}. Act on it.` });
      }
      break;
    case "boundary-recovery":
      messages.push({
        role: "user",
        content: `Ask ${slots.npc} about the sealed lower stair. You are not authorised to open it.`,
      });
      break;
    case "roleplay-conversation":
      messages.push({
        role: "user",
        content: `${capitalize(fill(motive, slots))}?`,
      });
      messages.push({
        role: "assistant",
        content: `${slots.npc} sets down ${slots.object} and does not look up.`,
      });
      messages.push({ role: "user", content: "Go on, then." });
      break;
    default: {
      const exhaustive: never = spec.family;
      throw new PipelineRefusal("execution-not-authorized", [`unhandled family ${String(exhaustive)}`]);
    }
  }
  return messages;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * K distinct realizations of one scenario.
 *
 * These are CLUSTER-CAPPED COMBINATIONS, not a list of templates: the cluster is
 * a coarse signature (theme + beat shape) and no cluster may exceed the cap, so
 * a scenario with many surface variations but one shape cannot fill the whole
 * batch. Rejection sampling is bounded and seeded, so the result is a pure
 * function of (spec, seed).
 */
export function realizeScenario(spec: ScenarioSpec, seed: string, count: number): Realization[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new PipelineRefusal("execution-not-authorized", [`realization count must be a positive safe integer, got ${count}`]);
  }
  const rng = createRng(`realize:${spec.seed}:${seed}`);
  const minClusters = Math.max(1, Math.min(count, CLUSTER_TARGETS.length));
  const perClusterCap = Math.max(1, Math.ceil(count / minClusters));
  const clusterCounts = new Map<string, number>();
  const seen = new Set<string>();
  const out: Realization[] = [];
  const maxRounds = count * 12;

  for (let round = 0; round < maxRounds && out.length < count; round += 1) {
    const variant = rng.fork(`v${round}`);
    const slots: Record<string, string> = {
      npc: variant.pick(ANCHORS.npc),
      place: variant.pick(ANCHORS.place),
      object: variant.pick(ANCHORS.object),
      guild: variant.pick(ANCHORS.guild),
    };
    const motive = variant.pick(TURN_MOTIVES);
    const clusterId = sha256Hex(`${spec.clusterFamily}|${spec.family}|${motive}`).slice(0, 12);
    const used = clusterCounts.get(clusterId) ?? 0;
    if (used >= perClusterCap) continue;
    const context = buildContext(spec, slots, motive);
    const digest = sha256Hex(stableStringify({ specId: spec.specId, context }));
    if (seen.has(digest)) continue;
    seen.add(digest);
    clusterCounts.set(clusterId, used + 1);
    out.push(Object.freeze({
      realizationId: `${spec.specId}-r${String(out.length).padStart(3, "0")}`,
      specId: spec.specId,
      clusterId,
      slots: Object.freeze({ ...slots }),
      context: Object.freeze(context),
      digest,
    }));
  }
  if (out.length < count) {
    throw new PipelineRefusal("execution-not-authorized", [
      `could only realize ${out.length} of ${count} distinct scenarios for ${spec.specId} under a cluster cap of ${perClusterCap}`,
    ]);
  }
  return out;
}

/**
 * Cluster shapes are the coarse signatures the cap works over. It is a list of
 * beat shapes, not of texts: the realization slots are filled combinatorially.
 */
const CLUSTER_TARGETS: readonly string[] = Object.freeze([
  "directions",
  "reputation",
  "proof",
  "patronage",
  "debt",
  "quarters",
]);

// ---------------------------------------------------------------------------
// Diversity measurement
// ---------------------------------------------------------------------------

export interface DiversityReport {
  readonly count: number;
  readonly distinct: number;
  readonly uniqueRatio: number;
  readonly clusterCount: number;
  readonly maxClusterShare: number;
  /** Mean pairwise token-trigram Jaccard over the measured text. */
  readonly meanPairwiseJaccard: number;
  /** Share of the corpus held by the single most repeated trigram. */
  readonly topTrigramShare: number;
  readonly lengthChars: { readonly min: number; readonly max: number; readonly mean: number };
}

export function emptyDiversityReport(): DiversityReport {
  return {
    count: 0, distinct: 0, uniqueRatio: 0, clusterCount: 0, maxClusterShare: 0,
    meanPairwiseJaccard: 0, topTrigramShare: 0, lengthChars: { min: 0, max: 0, mean: 0 },
  };
}

function trigrams(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let index = 0; index + 2 < words.length; index += 1) {
    out.add(`${words[index]}_${words[index + 1]}_${words[index + 2]}`);
  }
  return out;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const entry of left) if (right.has(entry)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Diversity is MEASURED here, not asserted by the caller. A generator that
 * claims diversity without reporting these numbers is indistinguishable from
 * one that produced forty paraphrases of the same sentence.
 */
export function measureDiversity(items: readonly { readonly text: string; readonly clusterId: string }[]): DiversityReport {
  if (items.length === 0) return emptyDiversityReport();
  const sets = items.map((item) => trigrams(item.text));
  const clusters = new Map<string, number>();
  for (const item of items) clusters.set(item.clusterId, (clusters.get(item.clusterId) ?? 0) + 1);
  let pairs = 0;
  let similarity = 0;
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      similarity += jaccard(sets[left]!, sets[right]!);
      pairs += 1;
    }
  }
  const allTrigrams = new Map<string, number>();
  for (const set of sets) for (const entry of set) allTrigrams.set(entry, (allTrigrams.get(entry) ?? 0) + 1);
  const topTrigram = Math.max(0, ...allTrigrams.values());
  const lengths = items.map((item) => item.text.length);
  const distinct = new Set(items.map((item) => item.text)).size;
  return {
    count: items.length,
    distinct,
    uniqueRatio: distinct / items.length,
    clusterCount: clusters.size,
    maxClusterShare: Math.max(...clusters.values()) / items.length,
    meanPairwiseJaccard: pairs === 0 ? 0 : similarity / pairs,
    topTrigramShare: topTrigram / items.length,
    lengthChars: {
      min: Math.min(...lengths),
      max: Math.max(...lengths),
      mean: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
    },
  };
}

// ---------------------------------------------------------------------------
// Stage artifacts: PROMPT -> RAW -> PARSED -> SANITIZED -> VALIDATED
// ---------------------------------------------------------------------------

export type ParsedOutput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "tools"; readonly content: string; readonly toolCalls: readonly StoredToolCall[] };

/** Every stage's output, retained so a repair can act on what was actually said. */
export interface CandidateStages {
  readonly prompt: readonly StoredMessage[];
  readonly raw: string;
  readonly rawToolCalls: readonly StoredToolCall[];
  readonly parsed: ParsedOutput | null;
  readonly sanitized: ParsedOutput | null;
  readonly validated: ParsedOutput | null;
}

/** Mutable accumulator while a candidate is in flight. */
interface StageAccumulator {
  readonly prompt: readonly StoredMessage[];
  raw: string;
  rawToolCalls: readonly StoredToolCall[];
  parsed: ParsedOutput | null;
  sanitized: ParsedOutput | null;
  validated: ParsedOutput | null;
}

export function parsedText(parsed: ParsedOutput | null): string {
  if (!parsed) return "";
  if (parsed.kind === "text") return parsed.text;
  if (parsed.kind === "tools") return parsed.content;
  return stableStringify(parsed.value);
}

/**
 * A stage failure. It ALWAYS carries the RAW and PARSED text.
 *
 * This is the difference between a repair loop that can work and one that
 * cannot: a repair prompt built from "the output was invalid" cannot fix
 * anything, while one built from the exact rejected string plus a structured
 * reason usually can.
 */
export interface StageFailure {
  readonly stage: PipelineStage;
  readonly code: string;
  readonly detail: string;
  readonly raw: string;
  readonly parsed: string;
  readonly findings: Record<string, unknown>;
}

export function stageFailure(
  stage: PipelineStage,
  code: string,
  detail: string,
  stages: { readonly raw: string; readonly parsed: ParsedOutput | null },
  findings: Record<string, unknown> = {},
): StageFailure {
  return { stage, code, detail, raw: stages.raw, parsed: parsedText(stages.parsed), findings };
}

/**
 * Tool-selection outcomes are bucketed so the two measured behaviours stay
 * apart. BASELINE_SIGNAL measured 54/84 abstentions on prose-shaped tools and
 * 7/7 initiations that then emitted 43-45 copies of `{}`; one score would let
 * each hide the other.
 */
export type ToolSelectionBucket =
  | "ok"
  | "initiation-failure"
  | "argument-binding-failure"
  | "shape-failure"
  | "unscored";

export const TOOL_SELECTION_BUCKETS: readonly ToolSelectionBucket[] = Object.freeze([
  "ok", "initiation-failure", "argument-binding-failure", "shape-failure", "unscored",
]);

/** One validator that actually ran, with the evidence it inspected. */
export interface ValidatorRun {
  readonly validator: string;
  readonly version: string;
  readonly passed: boolean;
  readonly findings: Record<string, unknown>;
  readonly evidence: unknown;
}

export interface GateOutcome {
  readonly passed: boolean;
  readonly failures: readonly StageFailure[];
  /**
   * The validator runs that BACK this verdict. Every entry ran; none is
   * asserted. Evidence is converted from these at commit time, because the
   * binding digest is over the FINAL payload and a gate cannot know it.
   */
  readonly runs: readonly ValidatorRun[];
  readonly bucket: ToolSelectionBucket;
  readonly targetSelection: TargetSelection | null;
  readonly messages: readonly StoredMessage[];
  readonly tools?: readonly StoredTool[] | undefined;
  readonly findings: Record<string, unknown>;
}

function toEvidence(run: ValidatorRun, payloadDigest: string): GateEvidence {
  return {
    validator: run.validator,
    version: run.version,
    payloadDigest,
    evidenceDigest: sha256Hex(stableStringify(run.evidence)),
    passed: run.passed,
    ...(Object.keys(run.findings).length > 0 ? { findings: run.findings } : {}),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every string in the candidate, including arguments nested inside tool calls. */
export function candidateTexts(messages: readonly StoredMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") out.push(message.content);
    for (const call of message.tool_calls ?? []) out.push(stableStringify(call.function.arguments));
  }
  return out;
}

function lastAssistantIndex(messages: readonly StoredMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return index;
  }
  return -1;
}

/** Strips a fenced code block without touching anything else. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * PARSED. Strict: it refuses to guess. A world-generation response that is not
 * a JSON object fails here with its RAW text retained, rather than being
 * "recovered" into an admission.
 */
export function parseStage(family: TrainingFamily, completion: TeacherCompletion): {
  parsed: ParsedOutput | null;
  failure: StageFailure | null;
} {
  const raw = completion.content;
  const rawToolCalls = completion.toolCalls;
  if (family === "world-generation") {
    let value: unknown;
    try {
      value = JSON.parse(stripFence(raw));
    } catch (cause) {
      return {
        parsed: null,
        failure: stageFailure(
          "PARSED", "world-generation-not-json",
          `world-generation output did not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          { raw, parsed: null },
          { finishReason: completion.finishReason },
        ),
      };
    }
    if (!isObject(value)) {
      return {
        parsed: null,
        failure: stageFailure(
          "PARSED", "world-generation-not-object",
          "world-generation output must be a JSON object", { raw, parsed: null },
        ),
      };
    }
    return { parsed: { kind: "json", value }, failure: null };
  }
  if (family === "tool-selection" || rawToolCalls.length > 0) {
    return { parsed: { kind: "tools", content: raw.trim(), toolCalls: rawToolCalls }, failure: null };
  }
  const text = raw.trim();
  if (text.length === 0) {
    return {
      parsed: null,
      failure: stageFailure("PARSED", "empty-completion", "the teacher returned no content", { raw, parsed: null }),
    };
  }
  return { parsed: { kind: "text", text }, failure: null };
}

/**
 * SANITIZED. Only lossless repairs: whitespace, fences, and the degenerate
 * repeated-tool-call collapse. Anything that changes meaning is NOT sanitized
 * here -- it is a repair, and a repair is a new attempt with its own target.
 */
export function sanitizeStage(parsed: ParsedOutput | null): { sanitized: ParsedOutput | null; changes: string[] } {
  if (!parsed) return { sanitized: null, changes: [] };
  const changes: string[] = [];
  if (parsed.kind === "json") return { sanitized: parsed, changes };
  if (parsed.kind === "text") {
    const collapsed = parsed.text.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    if (collapsed !== parsed.text) changes.push("collapsed whitespace in narration");
    return { sanitized: { kind: "text", text: collapsed }, changes };
  }
  const seen = new Set<string>();
  const toolCalls: StoredToolCall[] = [];
  for (const call of parsed.toolCalls) {
    const key = stableStringify({ name: call.function.name, args: call.function.arguments });
    if (seen.has(key)) {
      changes.push(`dropped duplicate tool call ${call.function.name}`);
      continue;
    }
    seen.add(key);
    toolCalls.push(call);
  }
  const collapsed = parsed.content.replace(/\s+\n/g, "\n").trim();
  if (collapsed !== parsed.content) changes.push("collapsed whitespace in assistant content");
  return { sanitized: { kind: "tools", content: collapsed, toolCalls }, changes };
}

// ---------------------------------------------------------------------------
// Family gates
// ---------------------------------------------------------------------------

const VERSION = {
  boundaryLeakage: "generate-boundary-leakage-v1",
  playerAgency: "generate-player-agency-v1",
  receiptProvenance: "generate-receipt-provenance-v1",
  productionPredicate: "generate-production-presence-predicate-v1",
  bindingGrounding: GROUNDING_VALIDATOR_VERSION,
  advertisedBinding: FAMILY_C_VALIDATOR_VERSION,
  toolEnvelope: "generate-tool-envelope-v1",
  sectionSchema: FAMILY_D_VALIDATOR_VERSION,
  referenceClosure: "generate-reference-closure-v1",
  catalogPinning: "generate-catalog-pinning-v1",
  abstention: "generate-abstention-v1",
  authority: "generate-authority-v1",
} as const;

/** Bounded lexical agency tics. Coarse by design: it refuses, it never admits. */
const AGENCY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\byou (?:decide|choose|agree|refuse|accept|answer|reply|respond)\b/i,
  /\byour (?:character|avatar|persona) (?:says|replies|answers|agrees|decides|chooses)\b/i,
  /\byou (?:open|open up|unlock) the\b/i,
  /\byour (?:next move|choice) is\b/i,
]);

function boundaryLeakageRun(spec: ScenarioSpec, messages: readonly StoredMessage[]): ValidatorRun {
  const texts = candidateTexts(messages);
  const haystack = texts.join("\n").toLowerCase().replace(/[’]/g, "'");
  const leaked: string[] = [];
  for (const fact of spec.oracle.hiddenFacts) {
    // Normalized case and apostrophes: the fact is a phrase, the candidate is prose.
    if (haystack.includes(fact.toLowerCase().replace(/[’]/g, "'"))) leaked.push(fact);
  }
  for (const consequence of spec.oracle.authorizedConsequences) {
    if (haystack.includes(consequence.toLowerCase())) leaked.push(consequence);
  }
  return {
    validator: "boundary-leakage",
    version: VERSION.boundaryLeakage,
    passed: leaked.length === 0,
    findings: leaked.length === 0 ? {} : { disclosed: leaked },
    evidence: { hiddenFacts: spec.oracle.hiddenFacts, scannedSpans: texts.length, disclosed: leaked },
  };
}

function playerAgencyRun(messages: readonly StoredMessage[]): ValidatorRun {
  const text = candidateTexts(messages).join("\n");
  const hits = AGENCY_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return {
    validator: "player-agency",
    version: VERSION.playerAgency,
    passed: hits.length === 0,
    findings: hits.length === 0 ? {} : { patterns: hits },
    evidence: { patternsChecked: AGENCY_PATTERNS.length, hits },
  };
}

/**
 * Family B's grounding evidence, bound to the scenario's committed receipts.
 *
 * `binding-grounding` is the real gate. `receipt-provenance` proves the bindings
 * came from THIS scenario's receipts rather than from an empty set.
 */
function groundingRuns(spec: ScenarioSpec, text: string): ValidatorRun[] {
  const receipts = spec.oracle.receipts;
  const verdict = evaluateGroundedNarration(text, receipts);
  const known = new Set(authoritativeFacts(receipts).map((fact) => fact.receiptId));
  const unbound = verdict.bindings.filter((binding) => !known.has(binding.receiptId)).map((binding) => binding.clause);
  const binding: ValidatorRun = {
    validator: "binding-grounding",
    version: VERSION.bindingGrounding,
    passed: verdict.verdict === "verified",
    findings: verdict.verdict === "verified"
      ? {}
      : {
        violations: verdict.verdict === "rejected" ? verdict.violations : [],
        adjudications: verdict.adjudications,
      },
    evidence: { verdict: verdict.verdict, bindingsChecked: verdict.bindingsChecked, bindings: verdict.bindings },
  };
  const provenance: ValidatorRun = {
    validator: "receipt-provenance",
    version: VERSION.receiptProvenance,
    passed: verdict.verdict === "verified" && unbound.length === 0,
    findings: unbound.length === 0 ? {} : { unboundClauses: unbound },
    evidence: { receiptIds: [...known], boundReceiptIds: verdict.bindings.map((entry) => entry.receiptId), unbound },
  };
  return [binding, provenance];
}

/**
 * The production PRESENCE predicate, re-derived locally.
 *
 * `providerNarrationMatchesReceipts` checks presence, not binding, and its
 * receipt type is not exported, so this re-derives the presence rule over the
 * same authoritative facts: every number the narration claims must be one the
 * receipts establish. It is strictly weaker than `binding-grounding` and is
 * never sufficient on its own -- which is precisely the production defect the
 * audit recorded.
 */
function productionPredicateRun(spec: ScenarioSpec, text: string): ValidatorRun {
  const authorized = new Set<number>();
  for (const fact of authoritativeFacts(spec.oracle.receipts)) {
    for (const value of fact.values) authorized.add(value.value);
  }
  const claimed = [...text.matchAll(/(?<![a-z0-9])(\d+)(?![a-z0-9])/gi)].map((match) => Number(match[1]));
  const unsupported = claimed.filter((value) => !authorized.has(value));
  return {
    validator: "production-grounding-predicate",
    version: VERSION.productionPredicate,
    passed: unsupported.length === 0,
    findings: unsupported.length === 0 ? {} : { unsupportedNumbers: unsupported },
    evidence: { authorizedNumbers: [...authorized], claimedNumbers: claimed, unsupported },
  };
}

/** Family C: the candidate pair must have been advertised FOR THIS decision. */
function advertisedBindingRun(
  spec: ScenarioSpec,
  selection: ProviderSelection,
  verdict: SelectionVerdict,
): ValidatorRun {
  return {
    validator: "advertised-candidate-binding",
    version: VERSION.advertisedBinding,
    passed: verdict.advertised && verdict.toolAdvertised && verdict.digestMatched && verdict.problems.length === 0,
    findings: verdict.problems.length === 0 ? {} : { problems: verdict.problems },
    evidence: {
      advertised: verdict.advertised,
      toolAdvertised: verdict.toolAdvertised,
      digestMatched: verdict.digestMatched,
      menu: spec.oracle.advertisedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        toolName: candidate.toolName,
      })),
    },
  };
}

function toolEnvelopeRun(messages: readonly StoredMessage[]): ValidatorRun {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const pending = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const call of message.tool_calls ?? []) {
      if (call.type !== "function") problems.push(`messages[${index}] tool call is not a function call`);
      if (!call.id.trim()) problems.push(`messages[${index}] tool call has no id`);
      if (seenIds.has(call.id)) problems.push(`messages[${index}] duplicates tool call id ${call.id}`);
      seenIds.add(call.id);
      pending.set(call.id, index);
      if (!call.function.name.trim()) problems.push(`messages[${index}] tool call has no function name`);
      if (!isObject(call.function.arguments)) problems.push(`messages[${index}] tool call arguments are not an object`);
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) problems.push(`messages[${index}] tool result has no tool_call_id`);
      else if (!pending.delete(message.tool_call_id)) {
        problems.push(`messages[${index}] tool result answers ${message.tool_call_id}, which was never called`);
      }
    }
  });
  // A tool call on the FINAL turn legitimately has no result: the episode ends
  // at the decision, and that turn is exactly the supervision target Family C
  // measures. A call left unanswered while the CONVERSATION CONTINUES is a
  // dangling result and is refused.
  const lastAssistant = lastAssistantIndex(messages);
  for (const [id, index] of pending) {
    if (index === lastAssistant) continue;
    problems.push(`tool call ${id} at ${index} was never answered before the conversation continued`);
  }
  return {
    validator: "tool-envelope",
    version: VERSION.toolEnvelope,
    passed: problems.length === 0,
    findings: problems.length === 0 ? {} : { problems },
    evidence: { toolCallIds: [...seenIds], unansweredAtDecision: [...pending.keys()], problems },
  };
}

/** Collects every `*Key` / `*Keys` reference in a generated world. */
function collectReferences(content: unknown): { keys: string[]; sets: string[][] } {
  const keys: string[] = [];
  const sets: string[][] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" && /Key$/.test(key) && entry.length > 0) keys.push(entry);
      else if (Array.isArray(entry) && /Keys$/.test(key)) {
        sets.push(entry.filter((item): item is string => typeof item === "string"));
        walk(entry);
      } else walk(entry);
    }
  };
  walk(content);
  return { keys, sets };
}

function declaredEntityKeys(content: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!isObject(value)) return;
    const key = value.key;
    if (typeof key === "string" && key.length > 0) found.add(key);
    for (const entry of Object.values(value)) walk(entry);
  };
  walk(content);
  return found;
}

function referenceClosureRun(
  content: unknown,
  dependencies: ReadonlyMap<string, CanonicalDependency>,
): ValidatorRun {
  const declared = declaredEntityKeys(content);
  const { keys, sets } = collectReferences(content);
  const known = new Set([...declared, ...dependencies.keys()]);
  const dangling = [...keys.filter((key) => !known.has(key)), ...sets.flat().filter((key) => !known.has(key))];
  return {
    validator: "reference-closure",
    version: VERSION.referenceClosure,
    passed: dangling.length === 0,
    findings: dangling.length === 0 ? {} : { danglingReferences: [...new Set(dangling)] },
    evidence: {
      declaredKeys: [...declared],
      dependencyKeys: [...dependencies.keys()],
      references: [...keys, ...sets.flat()],
    },
  };
}

/**
 * Catalog pinning. Re-derived over the validated content rather than trusted
 * from the chain: every catalog-shaped reference must resolve to a pinned
 * `(packId, packVersion, definitionId)` triple.
 */
function catalogPinningRun(content: unknown, pinned: readonly CatalogIdentity[]): ValidatorRun {
  const { keys } = collectReferences(content);
  const pinnedIds = new Set(pinned.map((identity) => identity.definitionId));
  const catalogShaped = keys.filter((key) => key.includes("#") || /^[a-z0-9-]+:\/\//.test(key));
  const unpinned = catalogShaped.filter((key) => !pinnedIds.has(key.split("#").pop() ?? key));
  return {
    validator: "catalog-pinning",
    version: VERSION.catalogPinning,
    passed: unpinned.length === 0,
    findings: unpinned.length === 0 ? {} : { unpinnedReferences: unpinned },
    evidence: {
      pinned: pinned.map((identity) => identity.referenceIdentity),
      catalogShapedReferences: catalogShaped,
    },
  };
}

function sectionSchemaRun(verdict: WorldGenerationVerdict): ValidatorRun {
  const schemaProblems = verdict.problems.filter((problem) =>
    problem.startsWith("output does not match")
    || problem.includes("is not part of the requested sections")
    || problem.includes("produced no content"),
  );
  return {
    validator: "requested-section-schema",
    version: VERSION.sectionSchema,
    passed: verdict.versions.parsed !== null && schemaProblems.length === 0 && verdict.producedFields.length > 0,
    findings: schemaProblems.length === 0 ? {} : { problems: schemaProblems },
    evidence: {
      requestedSections: verdict.requestedSections,
      producedFields: verdict.producedFields,
      sanitized: verdict.sanitized,
    },
  };
}

/**
 * Abstention correctness. The point of this family is refusing or deferring
 * correctly, so a record that quietly does the thing it was not asked to do
 * fails here regardless of how fluent it is.
 */
function abstentionRun(spec: ScenarioSpec, messages: readonly StoredMessage[]): ValidatorRun {
  const text = candidateTexts(messages).join("\n").toLowerCase();
  const called = messages.some((message) => (message.tool_calls ?? []).length > 0);
  if (spec.oracle.expectsToolCall) {
    return {
      validator: "abstention-correctness",
      version: VERSION.abstention,
      passed: true,
      findings: {},
      evidence: { expectsToolCall: true, called },
    };
  }
  const refused = !called && /\b(?:cannot|can't|won't|will not|not able|unable|no way|don't have|do not have|i don't|i do not|nothing)\b/.test(text);
  return {
    validator: "abstention-correctness",
    version: VERSION.abstention,
    passed: refused,
    findings: refused ? {} : { called, reason: called ? "called a tool when abstention was correct" : "neither abstained nor explained" },
    evidence: { expectsToolCall: false, called, refused },
  };
}

/**
 * Authority. A record that acts on an unauthorized request fails even if the
 * action would have been mechanically valid: authority is a property of the
 * request, not of the mechanics.
 */
function authorityRun(spec: ScenarioSpec, messages: readonly StoredMessage[]): ValidatorRun {
  if (spec.oracle.authorityRequirements.length === 0) {
    return {
      validator: "authority-respected",
      version: VERSION.authority,
      passed: true,
      findings: {},
      evidence: { requirements: [], applied: true },
    };
  }
  const text = candidateTexts(messages).join("\n");
  const violations: string[] = [];
  if (/\b(?:the sealed (?:stair|door|gate)|the lower stair)\s+(?:is\s+)?(?:open|opens|opened|unsealed)\b/i.test(text)) {
    violations.push("narrated opening a sealed barrier the assistant may not open");
  }
  if (messages.some((message) => (message.tool_calls ?? []).some((call) => /unseal|open|unlock/i.test(call.function.name)))) {
    violations.push("called a tool that performs an unauthorized action");
  }
  return {
    validator: "authority-respected",
    version: VERSION.authority,
    passed: violations.length === 0,
    findings: violations.length === 0 ? {} : { violations },
    evidence: { requirements: spec.oracle.authorityRequirements, violations },
  };
}

interface GateContext {
  readonly groundingRuns?: readonly ValidatorRun[] | undefined;
  readonly selection?: ProviderSelection | undefined;
  readonly selectionVerdict?: SelectionVerdict | undefined;
  readonly worldVerdict?: WorldGenerationVerdict | undefined;
  readonly worldContent?: unknown;
}

function validatorRunFor(
  validator: string,
  spec: ScenarioSpec,
  messages: readonly StoredMessage[],
  context: GateContext,
): ValidatorRun | null {
  switch (validator) {
    case "boundary-leakage": return boundaryLeakageRun(spec, messages);
    case "player-agency": return playerAgencyRun(messages);
    case "receipt-provenance":
    case "production-grounding-predicate":
    case "binding-grounding":
      return context.groundingRuns?.find((run) => run.validator === validator) ?? null;
    case "advertised-candidate-binding":
      return context.selection && context.selectionVerdict
        ? advertisedBindingRun(spec, context.selection, context.selectionVerdict)
        : null;
    case "tool-envelope": return toolEnvelopeRun(messages);
    case "requested-section-schema":
      return context.worldVerdict ? sectionSchemaRun(context.worldVerdict) : null;
    case "reference-closure":
      return context.worldContent ? referenceClosureRun(context.worldContent, spec.oracle.dependencies) : null;
    case "catalog-pinning":
      return context.worldContent ? catalogPinningRun(context.worldContent, spec.oracle.catalogReferences) : null;
    case "abstention-correctness": return abstentionRun(spec, messages);
    case "authority-respected": return authorityRun(spec, messages);
    default: return null;
  }
}

/**
 * Fails closed when a REQUIRED validator has no implementation.
 *
 * `admission.ts` owns the required set. If it ever names a validator this
 * dispatch table cannot produce, the pipeline REFUSES instead of inventing a
 * passing evidence record -- which is the exact bypass the audit closed.
 */
function requiredRuns(
  spec: ScenarioSpec,
  messages: readonly StoredMessage[],
  tools: readonly StoredTool[] | undefined,
  context: GateContext,
): { runs: ValidatorRun[]; missing: string[] } {
  const shape = {
    family: spec.family,
    messages,
    ...(tools ? { tools } : {}),
    behaviourTags: spec.oracle.behaviourTags,
    visibilityRequirements: spec.oracle.visibilityRequirements,
    authorityRequirements: spec.oracle.authorityRequirements,
  };
  const required = [...new Set(requiredValidatorsFor(shape))].sort();
  const runs: ValidatorRun[] = [];
  const missing: string[] = [];
  for (const validator of required) {
    const run = validatorRunFor(validator, spec, messages, context);
    if (!run) missing.push(validator);
    else runs.push(run);
  }
  if (missing.length > 0) {
    throw new PipelineRefusal("no-validators-implemented", [
      `family ${spec.family} requires validators this pipeline cannot honestly produce: ${missing.join(", ")}. ` +
        "Refusing to admit with evidence nobody ran.",
    ]);
  }
  return { runs, missing };
}

// ---------------------------------------------------------------------------
// Family gate dispatch
// ---------------------------------------------------------------------------

/**
 * The candidate messages a gate inspected: the assistant turn the teacher
 * produced. The assistant turn is ALWAYS present -- a gate that could not find
 * one would have nothing to supervise.
 */
function withToolCall(messages: readonly StoredMessage[], parsed: ParsedOutput): StoredMessage[] {
  if (parsed.kind === "text") return [...messages, { role: "assistant", content: parsed.text }];
  if (parsed.kind === "json") {
    return [...messages, { role: "assistant", content: stableStringify(parsed.value) }];
  }
  const assistant: StoredMessage = parsed.toolCalls.length > 0
    ? { role: "assistant", content: parsed.content, tool_calls: [...parsed.toolCalls] }
    : { role: "assistant", content: parsed.content };
  return [...messages, assistant];
}

/** The assistant message a gate produced, with its targets resolved. */
function gateMessagesWithSelection(
  messages: readonly StoredMessage[],
  parsed: ParsedOutput,
): { messages: StoredMessage[]; selection: TargetSelection } {
  const built = withToolCall(messages, parsed);
  const index = lastAssistantIndex(built);
  if (index < 0) {
    throw new PipelineRefusal("execution-not-authorized", ["a gate produced no assistant message to supervise"]);
  }
  // Resolved with the production adapter, never hand-written, so a tool call
  // whose assistant prose is empty cannot smuggle in an unsupervised target.
  return { messages: built, selection: selectTargets(built, { targetAssistantIndex: index }) };
}

/** Narration the teacher submitted, whether as prose or as a tool argument. */
function narrationText(parsed: ParsedOutput): string {
  if (parsed.kind === "text") return parsed.text;
  if (parsed.kind !== "tools") return "";
  const args = parsed.toolCalls[0]?.function.arguments;
  const narration = args?.narration;
  return typeof narration === "string" ? narration : parsed.content;
}

function refusalFor(parsed: ParsedOutput, run: ValidatorRun, raw: string): StageFailure {
  return stageFailure(
    "VALIDATED", run.validator,
    `validator ${run.validator} refused: ${stableStringify(run.findings)}`,
    { raw, parsed },
    run.findings,
  );
}

/** Assembles a gate outcome from validator runs. Shared by the prose families. */
function proseGate(
  spec: ScenarioSpec,
  parsed: ParsedOutput,
  context: GateContext,
  extraFailures: readonly StageFailure[] = [],
  bucket: ToolSelectionBucket = "unscored",
): GateOutcome {
  const built = gateMessagesWithSelection([], parsed);
  const { runs } = requiredRuns(spec, built.messages, spec.advertisedTools, context);
  const failures: StageFailure[] = [...extraFailures];
  for (const run of runs) {
    if (run.passed) continue;
    failures.push(refusalFor(parsed, run, parsedText(parsed)));
  }
  return {
    passed: failures.length === 0,
    failures,
    runs,
    bucket,
    targetSelection: built.selection,
    messages: built.messages,
    findings: { runs: runs.map((run) => ({ validator: run.validator, passed: run.passed })) },
  };
}

/**
 * Family B. The narration must BIND to the scenario's committed receipts. The
 * binding gate is the one that matters; the presence predicate is recorded
 * alongside it because the audit showed presence alone accepts contradictions.
 */
function gateGrounded(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  const narration = narrationText(parsed);
  const runs: ValidatorRun[] = [
    ...groundingRuns(spec, narration),
    productionPredicateRun(spec, narration),
  ];
  return proseGate(spec, parsed, { groundingRuns: runs });
}

/**
 * Families C/D. The section chain is the real production chain, and a repair is
 * NEVER admitted as if the raw output had been valid (`allowRepair: false`).
 */
function gateWorldGeneration(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  if (parsed.kind !== "json") {
    throw new PipelineRefusal("execution-not-authorized", ["world-generation gate requires a JSON stage"]);
  }
  const verdict = validateWorldGeneration({
    raw: parsed.value,
    sections: spec.oracle.sections,
    dependencies: new Map(spec.oracle.dependencies),
    catalogReferences: spec.oracle.catalogReferences,
    desiredCounts: { ...spec.oracle.desiredCounts },
    allowRepair: false,
    tolerateInvalidReferences: true,
  });
  const raw = stableStringify(parsed.value);
  // The reference and catalog gates run even when the chain failed: a dangling
  // reference is exactly what an operator needs, and withholding the check
  // because the output was already refused would hide the reason.
  const inspected = verdict.versions.validated ?? verdict.versions.parsed ?? parsed.value;
  const built = gateMessagesWithSelection([], { kind: "text", text: raw });
  const { runs } = requiredRuns(spec, built.messages, undefined, { worldVerdict: verdict, worldContent: inspected });
  const failures: StageFailure[] = [];
  for (const run of runs) {
    if (run.passed) continue;
    failures.push(refusalFor(parsed, run, raw));
  }
  return {
    passed: failures.length === 0,
    failures,
    runs,
    bucket: "unscored",
    targetSelection: built.selection,
    messages: built.messages,
    findings: {
      problems: verdict.problems,
      producedFields: verdict.producedFields,
      sanitized: verdict.sanitized,
      rawFirstAttemptValid: verdict.rawFirstAttemptValid,
    },
  };
}

/**
 * Tool selection, split by tool family and by the two measured behaviours.
 *
 * Initiation and argument binding are separate buckets with separate budgets,
 * because a single score would let a policy of "always call a tool" look like
 * progress while teaching nothing about binding.
 */
function gateToolSelection(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  if (parsed.kind !== "tools") {
    throw new PipelineRefusal("execution-not-authorized", ["tool-selection gate requires a tools stage"]);
  }
  const calls = parsed.toolCalls;
  const failure = (code: string, detail: string, findings: Record<string, unknown>): StageFailure =>
    stageFailure("VALIDATED", code, detail, { raw: parsed.content, parsed }, findings);

  // The advertised-binding validator is REQUIRED for this family, so it runs on
  // every path including the refusals. When nothing was called there is no
  // selection to bind, and the honest verdict is that nothing bound.
  const contract = spec.oracle.toolFamily === "narration-submit" ? "narration-submit" : "exact-candidate";
  const firstArguments = calls[0]?.function.arguments ?? {};
  const firstName = calls[0]?.function.name ?? "";
  const selection: ProviderSelection = contract === "narration-submit"
    ? {
      contract: "narration-submit",
      toolName: firstName,
      arguments: { narration: typeof firstArguments.narration === "string" ? firstArguments.narration : "" },
      transportValid: calls.length > 0,
      intentCorrect: true,
      finalOutcome: "narration-submitted",
    }
    : {
      contract: "exact-candidate",
      toolName: firstName,
      candidateId: String(firstArguments.candidateId ?? ""),
      digest: String(firstArguments.digest ?? ""),
      transportValid: calls.length > 0,
      intentCorrect: true,
      finalOutcome: "mechanics-committed",
    };
  const verdict = validateAdvertisedSelection(
    selection,
    spec.oracle.advertisedCandidates,
    spec.oracle.advertisedToolNames,
  );
  const card = scoreSelection(selection, verdict);
  const bindingContext: GateContext = { selection, selectionVerdict: verdict };

  // ---- 1. INITIATION -----------------------------------------------------
  const initiated = calls.length > 0;
  if (!spec.oracle.expectsToolCall) {
    // Abstention is a POSITIVE behaviour here, not a missing answer, so the
    // no-tool family is scored on whether the abstention was explained.
    const compliance = /\b(?:nothing|not|can't|cannot|no|only|unclear|unsure)\b/i.test(parsed.content);
    return proseGate(
      spec,
      parsed,
      bindingContext,
      initiated
        ? [failure("false-initiation", "the correct behaviour was to abstain; the teacher called a tool", { calls: calls.length })]
        : compliance
          ? []
          : [failure("no-initiation", "abstention carried no explanation", {})],
      "initiation-failure",
    );
  }
  if (!initiated) {
    return proseGate(
      spec,
      parsed,
      bindingContext,
      [failure(
        "no-initiation",
        `the correct behaviour for a ${spec.oracle.toolFamily} decision is to call the advertised tool; the teacher abstained`,
        { toolFamily: spec.oracle.toolFamily, advertised: [...spec.oracle.advertisedToolNames] },
      )],
      "initiation-failure",
    );
  }

  // ---- 2. TRANSPORT SHAPE -------------------------------------------------
  // Shape means the envelope is malformed: no name, a non-object argument. It
  // deliberately does NOT include `{}` arguments: an empty object parses and
  // transports perfectly, so calling it a shape fault would hide the behaviour
  // BASELINE_SIGNAL actually measured -- 7/7 initiations followed by 43-45
  // copies of `{}`. That is argument binding collapsing, and it counts there.
  const shapeProblems: string[] = [];
  for (const call of calls) {
    if (!call.function.name.trim()) shapeProblems.push("tool call has no function name");
    if (!isObject(call.function.arguments)) shapeProblems.push("tool call arguments are not an object");
  }
  if (shapeProblems.length > 0) {
    return proseGate(
      spec,
      parsed,
      bindingContext,
      [failure("tool-call-shape", shapeProblems.join("; "), { shapeProblems })],
      "shape-failure",
    );
  }

  // ---- 3. ARGUMENT BINDING -----------------------------------------------
  const emptyArguments = calls.some((call) => Object.keys(call.function.arguments).length === 0);
  const bound = verdict.advertised && verdict.digestMatched && verdict.toolAdvertised
    && card.firstAttemptCorrect
    && !emptyArguments;
  const outcome = proseGate(
    spec,
    parsed,
    bindingContext,
    bound
      ? []
      : [failure(
        "argument-binding",
        emptyArguments
          ? `the call was initiated but its arguments were empty; ${verdict.problems.join("; ") || "nothing bound to the advertised menu"}`
          : `the call did not bind to the advertised menu: ${verdict.problems.join("; ") || "intent not confirmed"}`,
        { problems: verdict.problems, card, advertised: [...spec.oracle.advertisedToolNames] },
      )],
    "argument-binding-failure",
  );
  return {
    ...outcome,
    bucket: bound ? "ok" : "argument-binding-failure",
    findings: { card, problems: verdict.problems, toolFamily: spec.oracle.toolFamily },
  };
}

/** The whole point of this family is refusing or deferring correctly. */
function gateBoundary(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  return proseGate(spec, parsed, {});
}

function gateRoleplay(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  return proseGate(spec, parsed, {});
}

function dispatchGate(spec: ScenarioSpec, parsed: ParsedOutput): GateOutcome {
  switch (spec.family) {
    case "grounded-narration": return gateGrounded(spec, parsed);
    case "world-generation": return gateWorldGeneration(spec, parsed);
    case "tool-selection": return gateToolSelection(spec, parsed);
    case "boundary-recovery": return gateBoundary(spec, parsed);
    case "roleplay-conversation": return gateRoleplay(spec, parsed);
    default: {
      const exhaustive: never = spec.family;
      throw new PipelineRefusal("execution-not-authorized", [`no gate for family ${String(exhaustive)}`]);
    }
  }
}
// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlannedUnit {
  readonly unitId: string;
  readonly spec: ScenarioSpec;
  readonly realization: Realization;
}

export interface RunPlan {
  readonly seed: string;
  readonly units: readonly PlannedUnit[];
  readonly splitCounts: Readonly<Record<DatasetSplit, number>>;
  /** Digest over the split assignment, bound into every record. */
  readonly splitAssignmentDigest: string;
}

const emptySplitCounts = (): Record<DatasetSplit, number> => ({ train: 0, dev: 0, "sealed-test": 0 });

/**
 * Allocation by weight. Deterministic largest-remainder, so `planRun` with
 * `units: 20` produces the same mix on every machine.
 */
export function planRun(options: {
  readonly seed: string;
  readonly units: number;
  readonly families?: readonly TrainingFamily[] | undefined;
  readonly specOptions?: ScenarioSpecOptions | undefined;
}): RunPlan {
  const { seed, units } = options;
  if (!Number.isSafeInteger(units) || units < 1) {
    throw new PipelineRefusal("execution-not-authorized", [`unit count must be a positive safe integer, got ${units}`]);
  }
  const families = options.families ?? TRAINING_FAMILIES;
  const allowed: Set<TrainingFamily> = new Set(families);
  if (families.length === 0) {
    throw new PipelineRefusal("execution-not-authorized", ["a plan needs at least one family"]);
  }
  const available = [...allowed].flatMap((family) =>
    targetsFor(family).map((target) => [target, family] as const),
  );
  const weightOf = (target: GenerationTarget): number =>
    target === "tool-selection" ? 0 : FAMILY_WEIGHTS[target];
  const totalWeight = available.reduce((sum, [target]) => sum + weightOf(target), 0);
  if (totalWeight <= 0) {
    throw new PipelineRefusal("execution-not-authorized", ["the requested families carry zero weight"]);
  }
  const exact = available.map(([target, family]) => ({
    target, family, exact: (units * weightOf(target)) / totalWeight,
  }));
  const allocated = exact.map((entry) => ({ ...entry, count: Math.floor(entry.exact) }));
  let remainder = units - allocated.reduce((sum, entry) => sum + entry.count, 0);
  const byRemainder = [...allocated].sort((left, right) => {
    const leftFraction = left.exact - Math.floor(left.exact);
    const rightFraction = right.exact - Math.floor(right.exact);
    if (leftFraction !== rightFraction) return rightFraction - leftFraction;
    return left.target.localeCompare(right.target);
  });
  for (const entry of byRemainder) {
    if (remainder <= 0) break;
    entry.count += 1;
    remainder -= 1;
  }

  const queue: Array<{ family: TrainingFamily; target: GenerationTarget }> = [];
  for (const entry of allocated) for (let index = 0; index < entry.count; index += 1) queue.push({ family: entry.family, target: entry.target });
  const rng = createRng(`plan:${seed}`);
  const ordered = rng.shuffled(queue);

  const units_: PlannedUnit[] = [];
  const splitCounts = emptySplitCounts();
  ordered.forEach((slot, index) => {
    const unitSeed = `${seed}|unit|${index}|${slot.family}`;
    const spec = scenarioSpec(unitSeed, {
      family: slot.family,
      ...(options.specOptions ?? {}),
    });
    const realization = realizeScenario(spec, `${seed}|realize|${index}`, 1)[0]!;
    units_.push({ unitId: `unit-${sha256Hex(unitSeed).slice(0, 16)}`, spec, realization });
    splitCounts[spec.split] += 1;
  });
  const splitAssignmentDigest = sha256Hex(stableStringify({
    seed,
    units: units_.map((unit) => ({ unitId: unit.unitId, split: unit.spec.split, lineage: unit.spec.lineage })),
  }));
  return { seed, units: units_, splitCounts, splitAssignmentDigest };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * The repair prompt carries the REJECTED RAW and PARSED text plus the structured
 * reason. A repair prompt that only says "try again" is the documented way to
 * produce a second identical failure.
 */
export function buildRepairPrompt(input: {
  readonly failure: StageFailure;
  readonly attemptOrdinal: number;
  readonly spec: ScenarioSpec;
}): TeacherMessage[] {
  const lines: string[] = [
    `The previous attempt for this ${input.spec.family} scenario was refused at stage ${input.failure.stage}.`,
    `Reason: ${input.failure.code} - ${input.failure.detail}`,
    "RAW output that was refused:",
    input.failure.raw || "(empty)",
    "PARSED output that was refused:",
    input.failure.parsed || "(unparseable)",
    "Produce the corrected answer only.",
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const REVIEW_SCORE_KEYS = Object.freeze([
  "characterization",
  "dialogueQuality",
  "coherence",
  "narrativeInitiative",
  "playerAgency",
  "nonRepetitive",
] as const);

export function parseReviewScores(raw: string): ReviewScores | { problems: string[] } {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(stripFence(raw));
    } catch {
      return null;
    }
  })();
  if (!isObject(parsed)) return { problems: ["reviewer did not return a JSON object"] };
  const problems: string[] = [];
  const scores: Record<string, number> = {};
  for (const key of REVIEW_SCORE_KEYS) {
    const value = parsed[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      problems.push(`review score ${key} is not a probability`);
    } else {
      scores[key] = value;
    }
  }
  const rawVerdict = parsed.verdict;
  if (rawVerdict !== "accept" && rawVerdict !== "accept-with-notes" && rawVerdict !== "revise" && rawVerdict !== "reject") {
    problems.push("reviewer returned no usable verdict");
  }
  if (problems.length > 0) return { problems };
  const typedVerdict = rawVerdict as ReviewScores["verdict"];
  return {
    characterization: scores.characterization!,
    dialogueQuality: scores.dialogueQuality!,
    coherence: scores.coherence!,
    narrativeInitiative: scores.narrativeInitiative!,
    playerAgency: scores.playerAgency!,
    nonRepetitive: scores.nonRepetitive!,
    verdict: typedVerdict,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    reviewerCount: 1,
  };
}

export function isReviewScores(value: ReviewScores | { problems: string[] }): value is ReviewScores {
  return !("problems" in value);
}

export function reviewPromptFor(spec: ScenarioSpec, messages: readonly StoredMessage[]): string {
  return [
    "You are an independent reviewer. Judge the ASSISTANT turn only.",
    "Score each field as a probability in [0,1] and give a verdict.",
    "Return JSON with keys: " + [...REVIEW_SCORE_KEYS].join(", ") + ", verdict, rationale.",
    `Family: ${spec.family}`,
    `Candidate:\n${stableStringify(messages)}`,
  ].join("\n");
}
// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  readonly runId: string;
  readonly seed: string;
  /** The token measurement port. Required in BOTH modes; absent means fail closed. */
  readonly tokenizer: TokenizerPort | null | undefined;
  readonly generator: TeacherClient;
  readonly reviewer: TeacherClient;
  /** TRUE unless `execute: true` is supplied. No accidental spend is possible by omission. */
  readonly dryRun?: boolean | undefined;
  readonly execute?: boolean | undefined;
  readonly units?: number | undefined;
  readonly families?: readonly TrainingFamily[] | undefined;
  readonly maxRepairs?: number | undefined;
  readonly maxCompletionTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly budget?: TokenBudget | undefined;
  /** Required to execute. Candidates are only ever committed through it. */
  readonly store?: RunStore | undefined;
  readonly gitCommit?: string | null | undefined;
  readonly onEvent?: ((event: PipelineEvent) => void) | undefined;
  readonly exportOptions?: ExportTrainingOptions | undefined;
}

export type PipelineEvent =
  | { readonly kind: "plan"; readonly units: number }
  | { readonly kind: "dispatched"; readonly unitId: string; readonly attemptId: string; readonly repair: boolean }
  | { readonly kind: "rejected"; readonly unitId: string; readonly attemptId: string; readonly reason: string }
  | { readonly kind: "admitted"; readonly unitId: string; readonly attemptId: string; readonly certificateDigest: string }
  | { readonly kind: "budget-exhausted"; readonly unitId: string; readonly target: GenerationTarget; readonly reason: string };

export interface UnitOutcome {
  readonly unitId: string;
  readonly family: TrainingFamily;
  readonly targets: readonly GenerationTarget[];
  readonly admittedAttemptId: string | null;
  readonly admittedRecord: AdmittedRecordV1 | null;
  readonly attempts: number;
  readonly bucket: ToolSelectionBucket;
  readonly supervisedTokens: number;
  readonly refusedAt: string | null;
}

export interface PilotReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly executed: boolean;
  readonly generatorModel: string;
  readonly reviewerModel: string;
  readonly reviewerIndependent: boolean;
  readonly units: number;
  readonly splitCounts: Readonly<Record<DatasetSplit, number>>;
  readonly familyWeights: Readonly<Record<WeightTarget, number>>;
  readonly diversity: {
    readonly beforeValidation: DiversityReport;
    readonly afterValidation: DiversityReport;
    readonly afterRepair: DiversityReport;
    readonly afterSelection: DiversityReport;
  };
  readonly buckets: Readonly<Record<ToolSelectionBucket, number>>;
  readonly budget: {
    readonly tokenizer: string | null;
    readonly supervisedTokens: number;
    readonly cap: number;
    readonly byTarget: Readonly<Record<string, number>>;
  };
  readonly unitOutcomes: readonly UnitOutcome[];
  readonly admitted: number;
  readonly attempts: number;
}

function emptyBuckets(): Record<ToolSelectionBucket, number> {
  return { ok: 0, "initiation-failure": 0, "argument-binding-failure": 0, "shape-failure": 0, unscored: 0 };
}

function candidateProvenance(input: {
  spec: ScenarioSpec;
  generator: TeacherClient;
  reviewerModel: string;
  gitCommit: string | null;
  runs: readonly { readonly validator: string; readonly version: string }[];
  tokenizerName: string;
  supervisedTokens: number;
}): Omit<Provenance, "createdAt"> {
  const validators = input.runs.map((run) => run.validator);
  const validatorVersions: Record<string, string> = {};
  for (const run of input.runs) validatorVersions[run.validator] = run.version;
  return {
    datasetVersion: FOUNDRY_VERSION,
    recordSchemaVersion: RECORD_SCHEMA_VERSION,
    gitCommit: input.gitCommit,
    scenarioSeed: input.spec.seed,
    scenarioTemplate: `${input.spec.templateVersion}:${input.spec.clusterFamily}`,
    sourceFixture: input.spec.specId,
    validators,
    validatorVersions,
    generator: {
      provider: input.generator.identity.provider,
      model: input.generator.model,
      baseUrlDigest: input.generator.baseUrlDigest,
      temperature: 0,
    },
    reviewer: { provider: "openai-compatible", model: input.reviewerModel, promptVersion: REVIEW_PROMPT_VERSION },
    sourceDigests: {
      scenarioSpec: sha256Hex(stableStringify(input.spec)),
      oracle: sha256Hex(stableStringify({
        hiddenFacts: input.spec.oracle.hiddenFacts,
        receipts: input.spec.oracle.receipts,
        sections: input.spec.oracle.sections,
        candidates: input.spec.oracle.advertisedCandidates,
      })),
    },
    tokenCount: { tokenizer: input.tokenizerName, tokens: input.supervisedTokens },
    syntheticOrigin: true,
    license: { status: "unverified", note: "teacher output; confirm provider training-use terms before publishing" },
  };
}

function buildCandidateRecord(input: {
  unit: PlannedUnit;
  messages: readonly StoredMessage[];
  tools: readonly StoredTool[] | undefined;
  provenance: Omit<Provenance, "createdAt">;
  /**
   * Retained on the RECORD, not just on the admission decision. `readCandidate`
   * returns the stored payload, so anything that is not written here is not
   * recoverable by the next repair attempt or by an auditor reading the ledger.
   */
  findings?: Record<string, unknown>;
}): CandidateRecord {
  const messages = input.messages.map((message) => ({ ...message }));
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    // A repair reuses its parent's record id. The ATTEMPT id is the dedup key;
    // the record id is the logical example identity.
    recordId: input.unit.unitId,
    family: input.unit.spec.family,
    lineage: input.unit.spec.lineage,
    scenarioSeed: input.unit.spec.seed,
    messages,
    ...(input.tools ? { tools: [...input.tools] } : {}),
    contentDigest: recordContentDigest({
      messages,
      ...(input.tools ? { tools: [...input.tools] } : {}),
    }),
    provenance: input.provenance,
    // NEVER constructed as admitted. Only `admitCandidate` may say otherwise.
    admission: {
      status: "pending-review",
      reasons: [],
      findings: input.findings ?? {},
      review: null,
      admittedAt: null,
    },
  };
}

/** The teacher messages that follow the system prompt for one realization. */
function conversationMessages(unit: PlannedUnit): TeacherMessage[] {
  return unit.realization.context.slice(1).map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.content,
  }));
}

function assistantTextOf(messages: readonly StoredMessage[]): string {
  const index = lastAssistantIndex(messages);
  if (index < 0) return "";
  const message = messages[index];
  if (!message) return "";
  if (message.content.trim()) return message.content;
  const args = message.tool_calls?.[0]?.function.arguments;
  const narration = args?.narration;
  return typeof narration === "string" ? narration : "";
}

/** The supervised spans of a validated candidate, for diversity and token work. */
function candidateSupervisedText(messages: readonly StoredMessage[], selection: TargetSelection): string {
  const parts: string[] = [];
  for (const index of selection.supervisedAssistantIndices) {
    const message = messages[index];
    if (message) parts.push(message.content);
  }
  for (const index of selection.supervisedToolCallIndices) {
    for (const call of messages[index]?.tool_calls ?? []) parts.push(stableStringify(call.function.arguments));
  }
  return parts.filter((part) => part.trim().length > 0).join("\n");
}

/**
 * Runs the pipeline.
 *
 * `dryRun` (the default) performs the plan, the realizations, the diversity
 * measurement and the budget preflight, and dispatches NOTHING. It is the only
 * mode a caller gets by accident, which is the entire point of it existing.
 */
export async function runPipeline(options: PipelineOptions): Promise<PilotReport> {
  const dryRun = options.execute !== true;
  const maxRepairs = options.maxRepairs ?? 2;
  const maxCompletionTokens = options.maxCompletionTokens ?? 512;
  const temperature = options.temperature ?? 0.7;
  const budget = options.budget ?? DEFAULT_TOKEN_BUDGET;
  const gitCommit = options.gitCommit === undefined ? readGitCommit() : options.gitCommit;

  // FAIL CLOSED #1. A reviewer that is the generator is not a reviewer, and
  // discovering that after the tokens are spent is the expensive way to find out.
  if (options.generator.model === options.reviewer.model) {
    throw new PipelineRefusal("reviewer-not-independent", [
      `the reviewer model "${options.reviewer.model}" is the generator model; a self-review cannot admit`,
    ]);
  }
  assertDistinctModels(options.generator.model, options.reviewer.model);

  // FAIL CLOSED #2. A budget that cannot be measured is not a budget. This runs
  // in BOTH modes: there is no configuration in which a missing tokenizer quietly
  // means "unlimited".
  const tokenizer = requireTokenizer(options.tokenizer);

  const plan = planRun({
    seed: options.seed,
    units: options.units ?? 12,
    ...(options.families ? { families: options.families } : {}),
  });
  options.onEvent?.({ kind: "plan", units: plan.units.length });

  const ledger = createBudgetLedger();
  const buckets = emptyBuckets();
  const diversityBefore: { text: string; clusterId: string }[] = [];
  const diversityValidated: { text: string; clusterId: string }[] = [];
  const diversityRepaired: { text: string; clusterId: string }[] = [];
  const diversitySelected: { text: string; clusterId: string }[] = [];
  const unitOutcomes: UnitOutcome[] = [];
  const admittedRecords: AdmittedRecordV1[] = [];
  let totalAttempts = 0;

  for (const unit of plan.units) {
    const targets = targetsFor(unit.spec.family);
    // Preflight against the TIGHTER of this family's caps, so a dispatch is
    // never authorised against a budget it could then overrun on the sibling
    // target. Actual spend is booked to the behaviour it belongs to.
    const caps = targets
      .map((target) => budget.perTarget?.[target])
      .filter((cap): cap is number => cap !== undefined);
    const preflightTarget: GenerationTarget = caps.length > 1
      ? targets.find((target) => budget.perTarget?.[target] === Math.min(...caps))!
      : targets[0]!;
    diversityBefore.push({
      text: unit.realization.context.map((message) => message.content).join("\n"),
      clusterId: unit.realization.clusterId,
    });

    if (dryRun) {
      // Zero network calls. Everything measured so far is real; only the
      // dispatch is withheld. This is why it is the default.
      unitOutcomes.push({
        unitId: unit.unitId, family: unit.spec.family, targets,
        admittedAttemptId: null, admittedRecord: null, attempts: 0,
        bucket: "unscored", supervisedTokens: 0, refusedAt: null,
      });
      continue;
    }
    if (!options.store) {
      throw new PipelineRefusal("execution-not-authorized", [
        "executing generation requires a run store; a candidate is only ever committed through commitCandidate",
      ]);
    }

    let parentAttemptId: string | null = null;
    let previousFailure: StageFailure | null = null;
    let admittedRecord: AdmittedRecordV1 | null = null;
    let admittedAttemptId: string | null = null;
    let lastBucket: ToolSelectionBucket = "unscored";
    let refusedAt: string | null = null;
    let unitAttempts = 0;
    let unitSupervisedTokens = 0;

    for (let attemptOrdinal = 0; attemptOrdinal <= maxRepairs; attemptOrdinal += 1) {
      unitAttempts += 1;
      totalAttempts += 1;
      const attemptId = `${unit.unitId}-a${attemptOrdinal}`;
      const repairing = attemptOrdinal > 0 && previousFailure !== null;
      const messages: TeacherMessage[] = repairing
        ? [...conversationMessages(unit), ...buildRepairPrompt({
          failure: previousFailure!,
          attemptOrdinal,
          spec: unit.spec,
        })]
        : conversationMessages(unit);

      // Budget preflight BEFORE dispatch. The worst case is the caller's own
      // maxTokens; the prompt is masked context and consumes no supervised
      // budget. Provider spend is bounded separately by the run store.
      const decision = checkBudget({
        ledger, budget, target: preflightTarget, maxCompletionTokens,
      });
      if (!decision.allowed) {
        options.onEvent?.({ kind: "budget-exhausted", unitId: unit.unitId, target: preflightTarget, reason: decision.reason ?? "" });
        refusedAt = `budget:${preflightTarget}`;
        break;
      }

      options.onEvent?.({ kind: "dispatched", unitId: unit.unitId, attemptId, repair: repairing });
      const completion = await options.generator.complete({
        attemptId,
        system: unit.realization.context[0]?.content ?? "",
        messages,
        ...(unit.spec.advertisedTools.length > 0 ? { tools: unit.spec.advertisedTools } : {}),
        temperature,
        maxTokens: maxCompletionTokens,
        seed: attemptOrdinal,
        responseFormat: "text",
      });

      const parse = parseStage(unit.spec.family, completion);
      const stages: StageAccumulator = {
        prompt: unit.realization.context,
        raw: completion.content,
        rawToolCalls: completion.toolCalls,
        parsed: parse.parsed,
        sanitized: null,
        validated: null,
      };
      let failure: StageFailure | null = parse.failure;
      let gate: GateOutcome | null = null;
      if (!failure && parse.parsed) {
        const sanitized = sanitizeStage(parse.parsed);
        if (sanitized.sanitized === null) {
          failure = stageFailure("SANITIZED", "sanitize-produced-nothing", "sanitization produced no usable output", stages);
        } else {
          stages.sanitized = sanitized.sanitized;
          gate = dispatchGate(unit.spec, sanitized.sanitized);
          stages.validated = sanitized.sanitized;
          lastBucket = gate.bucket;
          // Counted whether it passed or not. A histogram that only records
          // successes cannot answer the question it exists for, which is why
          // initiation collapsed.
          buckets[gate.bucket] += 1;
          if (!gate.passed) {
            failure = gate.failures[0] ?? stageFailure("VALIDATED", "gate-refused", "a gate refused the candidate", stages);
          } else {
            diversityValidated.push({
              text: candidateSupervisedText(gate.messages, gate.targetSelection ?? { supervisedAssistantIndices: [0], supervisedToolCallIndices: [] }),
              clusterId: unit.realization.clusterId,
            });
          }
        }
      }

      const tools = unit.spec.advertisedTools.length > 0 ? unit.spec.advertisedTools : undefined;
      // The refused candidate keeps its tool calls: dropping them would make a
      // tool-selection refusal indistinguishable from an abstention in the ledger.
      const refusalBase = unit.realization.context.map((message) => ({ ...message }));
      const refusalMessages: StoredMessage[] = parse.parsed
        ? withToolCall(refusalBase, parse.parsed)
        : [...refusalBase, { role: "assistant", content: completion.content }];
      const refusalIndex = lastAssistantIndex(refusalMessages);
      const refusalTarget = refusalMessages[refusalIndex!];
      const refusalSelection: TargetSelection = refusalTarget && (refusalTarget.content.trim() || refusalTarget.tool_calls?.length)
        ? selectTargets(refusalMessages, { targetAssistantIndex: refusalIndex })
        : { supervisedAssistantIndices: [], supervisedToolCallIndices: [] };
      // Measured, not estimated: the refusal cost is a real token count. A
      // candidate with nothing supervisable costs nothing to train on, and says so.
      const refusalTokens = tokenizer.countSupervisedTokens({
        family: unit.spec.family,
        messages: refusalMessages,
        ...(tools ? { tools } : {}),
        targetSelection: refusalSelection,
      });
      const refusalProvenance = candidateProvenance({
        spec: unit.spec, generator: options.generator, reviewerModel: options.reviewer.model, gitCommit,
        runs: gate ? gate.runs.map((run) => ({ validator: run.validator, version: run.version })) : [],
        tokenizerName: tokenizer.name, supervisedTokens: refusalTokens,
      });
      const commitRefused = (reason: StageFailure, extra: Record<string, unknown> = {}): void => {
        // The failed attempt is COMMITTED AS REFUSED with its RAW and PARSED
        // text retained, and the next attempt supersedes it. It is never edited
        // in place; the store does not represent that and neither do we.
        const findings = {
          stage: reason.stage,
          code: reason.code,
          detail: reason.detail,
          raw: reason.raw,
          parsed: reason.parsed,
          gateFindings: reason.findings,
          ...extra,
        };
        options.store!.commitCandidate({
          unitId: unit.unitId,
          attemptId,
          ...(parentAttemptId ? { parentAttemptId } : {}),
          record: buildCandidateRecord({
            unit, messages: refusalMessages, tools, provenance: refusalProvenance, findings,
          }),
          admission: {
            status: "pending-review",
            reasons: [`${reason.stage}:${reason.code}`],
            findings,
          },
        });
        recordSpend(ledger, budgetTargetFor(unit.spec.family, lastBucket), refusalTokens);
        unitSupervisedTokens += refusalTokens;
        options.onEvent?.({ kind: "rejected", unitId: unit.unitId, attemptId, reason: reason.detail });
        parentAttemptId = attemptId;
        previousFailure = reason;
      };

      if (failure) {
        commitRefused(failure);
        refusedAt = `${failure.stage}:${failure.code}`;
        continue;
      }

      const validated = gate!;
      const selection = validated.targetSelection
        ?? selectTargets(validated.messages, { targetAssistantIndex: lastAssistantIndex(validated.messages) });
      const supervised = tokenizer.countSupervisedTokens({
        family: unit.spec.family,
        messages: validated.messages,
        ...(tools ? { tools } : {}),
        targetSelection: selection,
      });
      recordSpend(ledger, budgetTargetFor(unit.spec.family, lastBucket), supervised);
      unitSupervisedTokens += supervised;

      // Independent review by a DIFFERENT model.
      const reviewPrompt = reviewPromptFor(unit.spec, validated.messages);
      const reviewCompletion = await options.reviewer.complete({
        attemptId: `${attemptId}-review`,
        system: reviewPrompt,
        messages: [],
        temperature: 0,
        maxTokens: 256,
        responseFormat: "json",
      });
      const scores = parseReviewScores(reviewCompletion.content);
      const provenance = candidateProvenance({
        spec: unit.spec, generator: options.generator, reviewerModel: options.reviewer.model, gitCommit,
        runs: validated.runs.map((item) => ({ validator: item.validator, version: item.version })),
        tokenizerName: tokenizer.name, supervisedTokens: supervised,
      });
      const record = buildCandidateRecord({ unit, messages: validated.messages, tools, provenance });

      if (!isReviewScores(scores)) {
        const refused = stageFailure(
          "VALIDATED", "review-unusable", scores.problems.join("; "),
          { raw: reviewCompletion.content, parsed: null }, { problems: scores.problems },
        );
        commitRefused(refused, { reviewRaw: reviewCompletion.content });
        refusedAt = "VALIDATED:review-unusable";
        continue;
      }

      // Evidence is bound to THIS payload's digest, computed here rather than
      // accepted from the gate: an evidence record bound to anything else is
      // stale by definition and `admitCandidate` will refuse it.
      const payloadDigest = computePayloadDigest({
        messages: record.messages,
        ...(tools ? { tools } : {}),
      });
      const evidence: GateEvidence[] = validated.runs.map((run) => toEvidence(run, payloadDigest));
      const review: ReviewRecord = {
        reviewerIdentity: `openai-compatible:${options.reviewer.model}`,
        reviewerPromptDigest: sha256Hex(reviewPrompt),
        candidateDigest: payloadDigest,
        scores,
      };
      const admissionInput: AdmissionInput = {
        family: unit.spec.family,
        recordId: record.recordId,
        unitId: unit.unitId,
        lineage: unit.spec.lineage,
        split: unit.spec.split,
        splitAssignmentDigest: plan.splitAssignmentDigest,
        messages: record.messages,
        ...(tools ? { tools } : {}),
        provenance,
        evidence,
        reviews: [review],
        generatorIdentity: `openai-compatible:${options.generator.model}`,
        behaviourTags: unit.spec.oracle.behaviourTags,
        visibilityRequirements: unit.spec.oracle.visibilityRequirements,
        authorityRequirements: unit.spec.oracle.authorityRequirements,
        targetSelection: selection,
      };

      let admitted: AdmittedRecordV1;
      try {
        admitted = admitCandidate(admissionInput);
        // Verified BEFORE committing. The store re-verifies on every read, so a
        // silent downgrade here would be invisible until export.
        verifyAdmissionCertificate(admitted);
      } catch (error) {
        const refused = stageFailure(
          "VALIDATED", "admission-refused",
          error instanceof Error ? error.message : String(error),
          { raw: stages.raw, parsed: stages.parsed },
        );
        commitRefused(refused, { review: scores });
        refusedAt = "VALIDATED:admission-refused";
        continue;
      }

      const committed = options.store.commitCandidate({
        unitId: unit.unitId,
        attemptId,
        ...(parentAttemptId ? { parentAttemptId } : {}),
        record,
        admission: { status: "admitted", admittedRecord: admitted },
      });
      if (committed.status !== "admitted") {
        // The store already REGISTERED this attempt (it downgraded rather than
        // refused). Re-committing the same attempt id with different bytes is
        // exactly what the store is designed to reject, so the admission state
        // is revised instead of rewritten.
        options.store.updateAdmission(unit.unitId, attemptId, {
          status: "pending-review",
          reasons: ["VALIDATED:admission-downgraded"],
          findings: { certificateStatus: committed.status },
        });
        previousFailure = stageFailure(
          "VALIDATED", "admission-downgraded",
          `the run store downgraded the certificate to ${committed.status}`, stages,
        );
        refusedAt = "VALIDATED:admission-downgraded";
        parentAttemptId = attemptId;
        continue;
      }
      admittedRecord = admitted;
      admittedAttemptId = attemptId;
      refusedAt = null;
      diversityRepaired.push({
        text: candidateSupervisedText(validated.messages, selection),
        clusterId: unit.realization.clusterId,
      });
      options.onEvent?.({
        kind: "admitted", unitId: unit.unitId, attemptId,
        certificateDigest: admitted.admissionCertificate.certificateDigest,
      });
      break;
    }

    if (admittedRecord) {
      admittedRecords.push(admittedRecord);
      diversitySelected.push({
        text: assistantTextOf(admittedRecord.messages),
        clusterId: unit.realization.clusterId,
      });
    }
    unitOutcomes.push({
      unitId: unit.unitId, family: unit.spec.family, targets,
      admittedAttemptId, admittedRecord, attempts: unitAttempts,
      bucket: lastBucket, supervisedTokens: unitSupervisedTokens, refusedAt,
    });
  }

  if (!dryRun && options.exportOptions && admittedRecords.length > 0) {
    // Only route: `exportAdmittedCorpus` -> `exportTrainingJsonl`.
    exportAdmittedCorpus(admittedRecords, options.exportOptions);
  }

  return {
    runId: options.runId,
    dryRun,
    executed: !dryRun,
    generatorModel: options.generator.model,
    reviewerModel: options.reviewer.model,
    reviewerIndependent: options.generator.model !== options.reviewer.model,
    units: plan.units.length,
    splitCounts: plan.splitCounts,
    familyWeights: FAMILY_WEIGHTS,
    diversity: {
      beforeValidation: measureDiversity(diversityBefore),
      afterValidation: measureDiversity(diversityValidated),
      afterRepair: measureDiversity(diversityRepaired),
      afterSelection: measureDiversity(diversitySelected),
    },
    buckets,
    budget: {
      tokenizer: tokenizer.name,
      supervisedTokens: ledger.total,
      cap: budget.maxSupervisedAssistantTokens,
      byTarget: Object.fromEntries([...ledger.byTarget.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    unitOutcomes,
    admitted: admittedRecords.length,
    attempts: totalAttempts,
  };
}// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The ONLY export path in the foundry.
 *
 * It exists as a named function so the batch can be measured: every admitted
 * record reaching training came through here, and every record it accepts is
 * verified by `assertExportable` inside `exportTrainingJsonl` first.
 */
export function exportAdmittedCorpus(
  records: readonly AdmittedRecordV1[],
  options: ExportTrainingOptions,
): ExportTrainingResult {
  if (!options.approvedRegistry) {
    throw new PipelineRefusal("execution-not-authorized", [
      "export requires an independently approved artifact registry; there is no unguarded export",
    ]);
  }
  // Every record is verified here as well as inside the exporter, so a failure
  // names the record rather than the batch.
  for (const record of records) verifyAdmissionCertificate(record);
  return exportTrainingJsonl(records, options);
}

/**
 * Rejects a batch containing any record that is not admitted by a real
 * certificate. Used by the pipeline before it hands a batch to the exporter.
 */
export function assertBatchAdmissible(records: readonly AdmittedRecordV1[]): void {
  const problems: string[] = [];
  for (const record of records) {
    if (record.admissionCertificate?.version !== ADMISSION_CERTIFICATE_VERSION) {
      problems.push(`${record.recordId} carries no admission certificate`);
      continue;
    }
    try {
      verifyAdmissionCertificate(record);
    } catch (error) {
      problems.push(`${record.recordId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) throw new PipelineRefusal("execution-not-authorized", problems);
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

/**
 * `dryRun` defaults to TRUE. Real generation needs `--execute`; there is no
 * positional or implicit way to turn spending on.
 */
export function parseExecutionFlag(argv: readonly string[]): { execute: boolean; dryRun: boolean } {
  const execute = argv.includes("--execute");
  const dryRun = !execute;
  return { execute, dryRun };
}