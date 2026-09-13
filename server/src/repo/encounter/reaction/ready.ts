import { boundedTriggerMatches } from "./engine.js";
import type {
  BoundedReactionTrigger, ReactionEvent, ReactionEventKind, ReactionMatchContext, ReactionResponseKind, ReactionSubject,
  ReadyAction,
} from "./types.js";

/** The closed trigger vocabulary a player may ready an action against. */
export type Dnd5eReadyTrigger = Readonly<{
  event: ReactionEventKind;
  subject: ReactionSubject;
  maxDistanceFeet?: number;
  requiresHit?: boolean;
}>;

export type Dnd5eReadyPlan = Readonly<{
  kind: "ready";
  legal: boolean;
  reasons: readonly string[];
  ready: ReadyAction | null;
}>;

const EVENTS: ReadonlySet<ReactionEventKind> = new Set(["hit", "targeted", "turn-start", "leaves-reach"]);
const SUBJECTS: ReadonlySet<ReactionSubject> = new Set(["self", "ally", "enemy"]);
const RESPONSE_KINDS: ReadonlySet<ReactionResponseKind> = new Set(["spell", "maneuver"]);
const MAX_READY_ROUNDS = 10;

/**
 * Plans a Ready action. The trigger is bounded by the closed event/subject
 * vocabulary, an optional reach/range cap, and a hard expiry so a readied
 * action can never become an unbounded script.
 */
export function planDnd5eReadyAction(input: Readonly<{
  readyId: string;
  reactorCombatantId: string;
  responseKind: ReactionResponseKind;
  responseId: string;
  trigger: Dnd5eReadyTrigger;
  round: number;
  expiresAtRound: number;
}>): Dnd5eReadyPlan {
  const reasons: string[] = [];
  if (!input.readyId) reasons.push("ready action ID is required");
  if (!input.reactorCombatantId) reasons.push("reactor combatant ID is required");
  if (!input.responseId) reasons.push("ready response ID is required");
  if (!RESPONSE_KINDS.has(input.responseKind)) reasons.push("ready response kind is invalid");
  if (!EVENTS.has(input.trigger.event)) reasons.push("ready trigger event is invalid");
  if (!SUBJECTS.has(input.trigger.subject)) reasons.push("ready trigger subject is invalid");
  if (input.trigger.maxDistanceFeet !== undefined
    && (!Number.isInteger(input.trigger.maxDistanceFeet) || input.trigger.maxDistanceFeet < 0 || input.trigger.maxDistanceFeet > 1_000)) {
    reasons.push("ready trigger reach must be a bounded integer");
  }
  if (!Number.isInteger(input.round) || input.round < 1) reasons.push("ready round is invalid");
  if (!Number.isInteger(input.expiresAtRound) || input.expiresAtRound <= input.round || input.expiresAtRound > input.round + MAX_READY_ROUNDS) {
    reasons.push("ready action must expire within a bounded number of rounds");
  }
  if (reasons.length > 0) return Object.freeze({ kind: "ready", legal: false, reasons: Object.freeze(reasons), ready: null });
  const trigger: BoundedReactionTrigger = Object.freeze({ ...input.trigger });
  const ready: ReadyAction = Object.freeze({
    readyId: input.readyId,
    reactorCombatantId: input.reactorCombatantId,
    responseKind: input.responseKind,
    responseId: input.responseId,
    trigger,
    expiresAtRound: input.expiresAtRound,
  });
  return Object.freeze({ kind: "ready", legal: true, reasons: Object.freeze([]), ready });
}

/** A readied action fires only while it is unexpired and its bounded trigger matches. */
export function readyActionFires(
  ready: ReadyAction, event: ReactionEvent, context: ReactionMatchContext, currentRound: number,
): boolean {
  if (!Number.isInteger(currentRound) || currentRound > ready.expiresAtRound) return false;
  return boundedTriggerMatches(ready.trigger, event, context);
}
