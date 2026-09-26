import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SystemOneAnswer, SystemOneCaller, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds, SystemOneSettings } from "../types.js";
import { systemOneLaneMode } from "../defaults.js";
import { recordSystemOneDecision } from "../repo/index.js";
import { calibrateTopSignal } from "./systemOneCalibration.js";
import { SYSTEM_ONE_CONFIDENCE_POLICY_VERSION, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * `freeform-materialization` — advisory, shadow-only System One lane for free-form attempts.
 *
 * It follows the free-form generation invariants (docs/freeform-generation-research.md §2.0,
 * §2.6, §3.3): the server owns a closed, small candidate set and asks Jev only routing-shaped
 * questions. Jev never authors names, descriptions, stats, items, prices, enemies, or lore, and
 * it never mutates state, authorizes a command, or commits a materialization. This module only
 * classifies ("does this attempt need new durable content?"), gates legality, and selects among
 * candidates the server already produced — or fails closed to no action.
 *
 * The lane is SHADOW-ONLY: it has no call site and no promotion record. Its execution contract
 * (`SYSTEM_ONE_EXECUTION_CONTRACTS`) and promotion gate exist so a future passing evaluation can
 * bind, but `isLanePromoted("freeform-materialization")` stays false without a production record.
 * Every dispatch is recorded with `shadow: true`; a lane mode of `active` changes nothing because
 * nothing consumes the composition. The deterministic free-form classifier that will own the
 * actual materialization is not implemented yet (Phase 1 of the research plan).
 */

/** Materialization families the server may author as candidates. */
export const FREEFORM_MATERIALIZATION_KINDS = [
  "materialize-location",
  "materialize-npc",
  "hostile-encounter",
  "shop-stock",
  "new-clue",
] as const;
export type FreeformMaterializationKind = (typeof FREEFORM_MATERIALIZATION_KINDS)[number];

/** The fail-closed choice used when no authored candidate is appropriate. */
export const FREEFORM_MATERIALIZATION_NONE = "none_of_these";

/** Question keys in the free-form materialization battery. */
export const FREEFORM_NEEDS_CONTENT_KEY = "needs_content";
export const FREEFORM_LEGAL_KEY = "legal";
export const FREEFORM_CANDIDATE_KEY = "candidate";

/**
 * The single action family the lane may ever authorize: selecting one server-authored
 * materialization candidate. A future active path must record its evaluation binding under this
 * family (`systemOneEvaluationBinding("freeform-materialization", settings, responseModel,
 * FREEFORM_MATERIALIZATION_ACTION_FAMILY)`), and the composition can only ever return a candidate
 * id/kind from the closed authored set or a fallback. The lane never authorizes prose, stats,
 * items, prices, stock, or a state mutation.
 */
export const FREEFORM_MATERIALIZATION_ACTION_FAMILY = "freeform.materialize-candidate";

/** Bound on the advertised candidate set; mirrors the other lanes' closed-set caps. */
export const FREEFORM_MATERIALIZATION_CANDIDATE_CAP = 32;
/** Bound on the embedded player attempt, so `state` can never carry unbounded text. */
const MAX_ATTEMPT_CHARS = 4_000;

/** One server-authored materialization candidate. IDs are opaque and server-owned. */
export const freeformMaterializationCandidateSchema = z.object({
  candidateId: z.string().min(1).max(200),
  kind: z.enum(FREEFORM_MATERIALIZATION_KINDS),
  label: z.string().min(1).max(200),
}).strict();

/** The bounded, server-authored lane state: identity plus the closed candidate list. */
export const freeformMaterializationStateSchema = z.object({
  campaignId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  attempt: z.string().min(1).max(MAX_ATTEMPT_CHARS),
  candidates: z.array(freeformMaterializationCandidateSchema).min(1).max(FREEFORM_MATERIALIZATION_CANDIDATE_CAP),
}).strict();

export type FreeformMaterializationCandidate = z.infer<typeof freeformMaterializationCandidateSchema>;
export type FreeformMaterializationState = z.infer<typeof freeformMaterializationStateSchema>;

/** The strict shape of a recorded selection; an out-of-set or malformed answer records nothing. */
export const freeformMaterializationSelectionSchema = z.object({
  candidateId: z.string().min(1).max(200).nullable(),
  kind: z.enum(FREEFORM_MATERIALIZATION_KINDS).nullable(),
  needsContent: z.boolean().nullable(),
  legal: z.boolean().nullable(),
  signals: z.object({
    needsContent: z.number().min(0).max(1).nullable(),
    legal: z.number().min(0).max(1).nullable(),
    candidate: z.number().min(0).max(1).nullable(),
  }).strict(),
  topSignal: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1).max(200),
}).strict();

/** The advisory composition of the battery over model answers. */
export interface FreeformMaterializationDecision {
  band: SystemOneBand;
  /** The selected server-authored candidate, or null when the lane takes no action. */
  candidateId: string | null;
  kind: FreeformMaterializationKind | null;
  /** True only when the `needs_content` gate cleared the action threshold. */
  needsContent: boolean | null;
  /** True only when the `legal` gate cleared the action threshold. */
  legal: boolean | null;
  /** Raw signals, in [0, 1], for observability and calibration. */
  signals: { needsContent: number | null; legal: number | null; candidate: number | null };
  /** The weakest gating signal (the binding constraint), or null when nothing was answered. */
  topSignal: number | null;
  /** A short machine reason; never model-authored prose. */
  reason: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function boundedAttempt(value: string): string {
  const trimmed = value.trim() || "(empty attempt)";
  return trimmed.length <= MAX_ATTEMPT_CHARS ? trimmed : `${trimmed.slice(0, MAX_ATTEMPT_CHARS)}…`;
}

/**
 * Builds the battery: a `noul` for "does this need new durable content?", a `noul` for "is this
 * attempt legal under the authored state?", and one aggregate `choice` over the exact authored
 * candidate ids plus an explicit `none_of_these`. One property per question; composition in code.
 */
export function buildFreeformMaterializationQuestions(state: FreeformMaterializationState): SystemOneQuestions {
  const attempt = boundedAttempt(state.attempt);
  const criteria: Record<string, string | null> = {};
  for (const candidate of state.candidates) criteria[candidate.candidateId] = `${candidate.kind}: ${candidate.label}`;
  criteria[FREEFORM_MATERIALIZATION_NONE] = "No authored candidate is appropriate; narrate a hold or use the deterministic classifier";
  return {
    [FREEFORM_NEEDS_CONTENT_KEY]: {
      type: "noul",
      instructions: `Does this player attempt require new durable campaign content that a later apply would have to commit (a location, NPC, encounter, shop stock, or clue), rather than being fully covered by narration or a hold?\nAttempt: ${attempt}`,
      criteria: {
        true: "It needs new durable content the prepared campaign does not contain; a materialization would have to be committed",
        false: "Narration or an explicit hold fully covers it; no new durable content is required",
      },
    },
    [FREEFORM_LEGAL_KEY]: {
      type: "noul",
      instructions: `Is adding new durable content for this attempt legal under the currently authored campaign state and readiness constraints?\nAttempt: ${attempt}`,
      criteria: {
        true: "New content may be added now: the campaign state admits it and no readiness or canon constraint forbids it",
        false: "Adding new content now would be illegal under the authored state, canon, or readiness constraints",
      },
    },
    [FREEFORM_CANDIDATE_KEY]: {
      type: "choice",
      instructions: `Which authored materialization candidate, if any, should this attempt materialize?\nAttempt: ${attempt}`,
      criteria,
    },
  };
}

function noulSignal(answers: Record<string, SystemOneAnswer>, key: string): number | null {
  const answer = answers[key];
  return answer && answer.type === "noul" && Number.isFinite(answer.noul) ? clamp01(answer.noul) : null;
}

/** The choice signal is the probability mass on the chosen id; an unadvertised id fails closed. */
function choiceSignal(
  answers: Record<string, SystemOneAnswer>,
  state: FreeformMaterializationState,
): { candidate: FreeformMaterializationCandidate; signal: number } | null {
  const answer = answers[FREEFORM_CANDIDATE_KEY];
  if (!answer || answer.type !== "choice") return null;
  const candidate = state.candidates.find((entry) => entry.candidateId === answer.choice);
  if (!candidate) return null;
  const probability = answer.probabilities[answer.choice];
  const signal = typeof probability === "number" && Number.isFinite(probability) ? probability : answer.confidence;
  if (!Number.isFinite(signal)) return null;
  return { candidate, signal: clamp01(signal) };
}

/**
 * Composes the advisory decision. The lane acts only when both `noul` gates and the `choice`
 * agree at the action threshold; any missing, invalid, out-of-set, low-confidence, or negative
 * answer falls back to no action (the deterministic classifier/hold). It never invents a
 * candidate and never reads the attempt text as authority.
 */
export function composeFreeformMaterializationDecision(
  state: FreeformMaterializationState,
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
): FreeformMaterializationDecision {
  const needsSignal = noulSignal(answers, FREEFORM_NEEDS_CONTENT_KEY);
  const legalSignal = noulSignal(answers, FREEFORM_LEGAL_KEY);
  const choice = choiceSignal(answers, state);
  const action = thresholds.actionThreshold;
  const signals = {
    needsContent: needsSignal,
    legal: legalSignal,
    candidate: choice?.signal ?? null,
  };
  const answered = [needsSignal, legalSignal, choice?.signal].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const topSignal = answered.length === 0 ? null : Math.min(...answered);

  const fallback = (reason: string): FreeformMaterializationDecision => ({
    band: "fallback",
    candidateId: null,
    kind: null,
    needsContent: needsSignal === null ? null : needsSignal >= action,
    legal: legalSignal === null ? null : legalSignal >= action,
    signals,
    topSignal,
    reason,
  });

  if (!Number.isFinite(action) || action < 0 || action > 1) return fallback("invalid_action_threshold");
  if (needsSignal === null || legalSignal === null || choice === null) return fallback("missing_or_invalid_answers");
  if (needsSignal < action) return fallback("narration_or_hold_sufficient");
  if (legalSignal < action) return fallback("attempt_not_legal");
  if (choice.signal < action) return fallback("candidate_below_action_threshold");
  return {
    band: "act",
    candidateId: choice.candidate.candidateId,
    kind: choice.candidate.kind,
    needsContent: true,
    legal: true,
    signals,
    topSignal,
    reason: "candidate_selected",
  };
}

/** The bounded input to one shadow dispatch. */
export interface FreeformMaterializationShadowInput {
  campaignId: string;
  sessionId: string;
  /** The raw player declaration or GM action that triggered the attempt. */
  attempt: string;
  /** The closed, server-authored candidate set. */
  candidates: readonly FreeformMaterializationCandidate[];
  turnId?: string | null;
}

/**
 * Records one immutable `freeform-materialization` shadow decision. It validates the
 * server-authored state and the composed selection strictly, asks the injected caller, and
 * persists the advisory decision. It never throws, never mutates gameplay state, never
 * authorizes a command, and never changes what any existing call site does — no call site
 * consumes this lane.
 */
export async function recordFreeformMaterializationShadowDecision(
  settings: SystemOneSettings,
  caller: SystemOneCaller,
  input: FreeformMaterializationShadowInput,
): Promise<void> {
  try {
    if (systemOneLaneMode(settings, "freeform-materialization") === "off") return;
    const parsed = freeformMaterializationStateSchema.safeParse({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      attempt: input.attempt,
      candidates: input.candidates,
    });
    if (!parsed.success) return;
    const state = parsed.data;
    const questions = buildFreeformMaterializationQuestions(state);
    const startedAt = performance.now();
    const result = await caller({ settings, state: state as never, questions });
    const composed = composeFreeformMaterializationDecision(
      state,
      result.answers,
      settings.confidencePolicy["freeform-materialization"],
    );
    // Re-validate the exact recorded shape; a malformed composition records nothing.
    const selection = freeformMaterializationSelectionSchema.safeParse({
      candidateId: composed.candidateId,
      kind: composed.kind,
      needsContent: composed.needsContent,
      legal: composed.legal,
      signals: composed.signals,
      // The recorded confidence is calibrated for observability; the band is decided on raw signals.
      topSignal: calibrateTopSignal(composed.topSignal, settings.confidenceCalibration["freeform-materialization"]),
      reason: composed.reason,
    });
    if (!selection.success) return;
    recordSystemOneDecision({
      decisionId: randomUUID(),
      lane: "freeform-materialization",
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      provider: "typesafe",
      model: result.model.responseModel ?? settings.model,
      confidencePolicyVersion: SYSTEM_ONE_CONFIDENCE_POLICY_VERSION,
      state,
      questions,
      answers: result.answers,
      selection: selection.data,
      confidenceBand: composed.band,
      fallbackUsed: true,
      shadow: true,
      usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Advisory shadow recording: never affects gameplay, generation, fallbacks, or the response.
  }
}
