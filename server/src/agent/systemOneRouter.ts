import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * L7 cost/quality router (System One lane `cost-router`).
 *
 * AUTHORITY BOUNDARY: this module only *selects which handler runs* for a request.
 * It never changes what a handler does. It cannot bypass authorization, candidate
 * binding, confirmation, or receipt issuance — those guarantees remain entirely the
 * responsibility of the downstream handler that is selected. The router may only
 * move a request toward a cheaper generation path or toward human review; it never
 * upgrades a request to a more capable handler, and on any missing or uncertain
 * answer it keeps the current handler (the status quo).
 */

/** The fixed handler set the router may choose from. */
export const ROUTER_HANDLERS = ["deterministic", "cheap-generation", "frontier-generation", "human-review"] as const;
export type RouterHandler = (typeof ROUTER_HANDLERS)[number];

/** Question keys in the router battery. */
export const ROUTER_HANDLER_KEY = "handler";
export const ROUTER_COMPLEXITY_KEY = "complexity";
export const ROUTER_DETERMINISTIC_KEY = "deterministic_sufficient";
/** The fail-closed choice used when no handler is appropriate. */
export const ROUTER_NONE = "none_of_these";

/** Ordered complexity levels for the `complexity` score question. */
export const ROUTER_COMPLEXITY_LEVELS = ["simple", "moderate", "complex"] as const;

/** The minimal request projection the router battery reasons over. */
export interface RouterRequestProjection {
  summary: string;
  hasDeterministicPath: boolean;
  requiresHumanDecision: boolean;
  safetySensitive: boolean;
}

export interface RouterDecision {
  band: SystemOneBand;
  /** The handler to run after composition, or null when nothing could be decided. */
  handler: RouterHandler | null;
  /** Clamped complexity level (0..2) from the score answer, or null when unanswered. */
  complexity: number | null;
  /** True only when the `deterministic_sufficient` noul clears the action threshold. */
  deterministicSufficient: boolean | null;
  /** The strongest confidence signal used for the decision, when any. */
  topSignal: number | null;
  reason: string;
}

/**
 * Builds the router battery: one `choice` over the handlers (plus `none_of_these`),
 * one three-level `complexity` `score`, and one `deterministic_sufficient` `noul`.
 * The answers are independent; composition in code is what produces a decision.
 */
export function buildRouterQuestions(request: RouterRequestProjection): SystemOneQuestions {
  const handlerCriteria: Record<string, string | null> = {
    deterministic: "A deterministic, non-generative path fully and safely satisfies the request",
    "cheap-generation": "A low-cost generation handler is sufficient for the request",
    "frontier-generation": "The request genuinely needs the most capable generation handler",
    "human-review": "The request needs a human decision or touches a safety-sensitive area",
  };
  handlerCriteria[ROUTER_NONE] = "None of the handlers is an appropriate fit for this request";
  return {
    [ROUTER_HANDLER_KEY]: {
      type: "choice",
      instructions: `Select the single handler that should run this request. Request: ${request.summary}`,
      criteria: handlerCriteria,
    },
    [ROUTER_COMPLEXITY_KEY]: {
      type: "score",
      instructions: "How complex is this request to handle well?",
      criteria: [...ROUTER_COMPLEXITY_LEVELS],
    },
    [ROUTER_DETERMINISTIC_KEY]: {
      type: "noul",
      instructions: "Can a deterministic, non-generative path fully satisfy this request?",
      criteria: {
        true: "A deterministic path exists and fully satisfies the request without generation",
        false: "No deterministic path can fully satisfy the request; generation or human review is required",
      },
    },
  };
}

/**
 * Capability/cost order for the generation handlers. Higher means more capable and
 * more expensive; `human-review` is deliberately not on this ladder because it is
 * always an allowed destination.
 */
const ROUTER_GENERATION_CAPABILITY: Record<Exclude<RouterHandler, "human-review">, number> = {
  deterministic: 0,
  "cheap-generation": 1,
  "frontier-generation": 2,
};

function isRouterHandler(value: string): value is RouterHandler {
  return (ROUTER_HANDLERS as readonly string[]).includes(value);
}

/**
 * The router may adopt a handler only when it is the current handler, a cheaper
 * generation handler, or human review. It never upgrades to a more capable
 * generation handler and never moves away from human review on its own.
 */
function mayAdoptHandler(current: RouterHandler, chosen: RouterHandler): boolean {
  if (chosen === current) return true;
  if (chosen === "human-review") return true;
  if (current === "human-review") return false;
  return ROUTER_GENERATION_CAPABILITY[chosen] < ROUTER_GENERATION_CAPABILITY[current];
}

function complexityLevel(score: number): number {
  return Math.max(0, Math.min(ROUTER_COMPLEXITY_LEVELS.length - 1, Math.round(score)));
}

/**
 * Composes a router decision from the battery.
 *
 * 1. Safety gate: when the request requires a human decision or is safety sensitive,
 *    the handler is forced to `human-review`; the band is `act` only when the model
 *    confidently chose human review, otherwise `confirm`. Such a request is never
 *    routed away from human review, regardless of any other answer.
 * 2. Deterministic-first: when a deterministic path exists and `deterministic_sufficient`
 *    confidently reads true, the cheapest path (`deterministic`) is selected.
 * 3. Otherwise the router acts on the chosen handler only when the probability
 *    assigned to that handler clears `actionThreshold` and the move is allowed by
 *    the cheaper-or-human rule.
 * 4. On `confirm`/`fallback`/missing answers it returns the current handler (status
 *    quo). The band is never `act` unless the handler was actually changed.
 */
export function composeRouterDecision(
  request: RouterRequestProjection,
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  currentHandler: RouterHandler,
): RouterDecision {
  const handlerAnswer = answers[ROUTER_HANDLER_KEY];
  const choice = handlerAnswer && handlerAnswer.type === "choice" ? handlerAnswer : null;
  const chosen = choice && isRouterHandler(choice.choice) ? choice.choice : null;
  // The relevant confidence is the probability mass assigned to the *chosen*
  // handler. Using the distribution maximum would let a confident
  // `none_of_these` act on a weakly chosen handler.
  const signal = choice && chosen ? choice.probabilities[chosen] ?? choice.confidence : null;

  const deterministicAnswer = answers[ROUTER_DETERMINISTIC_KEY];
  const deterministicNoul = deterministicAnswer && deterministicAnswer.type === "noul" ? deterministicAnswer.noul : null;
  const deterministicSufficient = deterministicNoul === null
    ? null
    : bandForConfidence(deterministicNoul, thresholds) === "act";

  const complexityAnswer = answers[ROUTER_COMPLEXITY_KEY];
  const complexity = complexityAnswer && complexityAnswer.type === "score" ? complexityLevel(complexityAnswer.score) : null;

  // 1. Safety gate. This is checked before every other rule and can never be
  //    overridden: a human decision or safety-sensitive request goes to human review.
  if (request.requiresHumanDecision || request.safetySensitive) {
    const confidentHumanReview = chosen === "human-review" && signal !== null && signal >= thresholds.actionThreshold;
    return {
      band: confidentHumanReview ? "act" : "confirm",
      handler: "human-review",
      complexity,
      deterministicSufficient,
      topSignal: signal,
      reason: confidentHumanReview
        ? "safety-sensitive request: human review chosen confidently"
        : "safety-sensitive request: human review required and never routed away",
    };
  }

  // 2. Deterministic-first: a confidently sufficient deterministic path is the
  //    cheapest outcome and is preferred whenever it is an allowed move.
  if (request.hasDeterministicPath && deterministicSufficient === true && mayAdoptHandler(currentHandler, "deterministic")) {
    return {
      band: "act",
      handler: "deterministic",
      complexity,
      deterministicSufficient,
      topSignal: deterministicNoul,
      reason: "deterministic path confidently sufficient",
    };
  }

  // 3. Confident handler choice. Act only above `actionThreshold`, and only when the
  //    move is toward a cheaper handler or human review.
  if (choice && chosen && signal !== null && signal >= thresholds.actionThreshold) {
    if (mayAdoptHandler(currentHandler, chosen)) {
      return {
        band: "act",
        handler: chosen,
        complexity,
        deterministicSufficient,
        topSignal: signal,
        reason: `confident handler choice: ${chosen}`,
      };
    }
    return {
      band: "confirm",
      handler: currentHandler,
      complexity,
      deterministicSufficient,
      topSignal: signal,
      reason: `refused ${chosen}: only cheaper or human-review handlers may be adopted from ${currentHandler}`,
    };
  }

  // 4. Status quo. Missing, low-confidence, or `none_of_these` answers keep the
  //    current handler; the band is capped below `act` because nothing was changed.
  const rawBand: SystemOneBand = signal !== null ? bandForConfidence(signal, thresholds) : "fallback";
  return {
    band: rawBand === "act" ? "confirm" : rawBand,
    handler: currentHandler,
    complexity,
    deterministicSufficient,
    topSignal: signal,
    reason: `no confident handler answer: keeping the current ${currentHandler} handler`,
  };
}
