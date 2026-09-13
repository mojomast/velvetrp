/**
 * Generalized reaction/interrupt vocabulary.
 *
 * A reaction is a bounded response to a combat event. Events are the closed
 * set `hit`, `targeted`, `turn-start`, and `leaves-reach`. Every response is
 * declared against a bounded trigger and, when it fires, consumes the single
 * per-round reaction budget and produces a receipt.
 */

export type ReactionEventKind = "hit" | "targeted" | "turn-start" | "leaves-reach";

/** Relation of the event subject to the reacting combatant. */
export type ReactionSubject = "self" | "ally" | "enemy";

/**
 * A trigger is deliberately bounded: a closed event kind, a subject relation,
 * an optional reach/range cap, and an optional "only on a hit" guard. There is
 * no condition tree or client-authored predicate.
 */
export type BoundedReactionTrigger = Readonly<{
  event: ReactionEventKind;
  subject: ReactionSubject;
  maxDistanceFeet?: number;
  requiresHit?: boolean;
}>;

export type ReactionResponseKind = "spell" | "maneuver";

/** A standing declaration: a combatant always responds to a matching trigger. */
export type DeclaredReaction = Readonly<{
  reactorCombatantId: string;
  responseKind: ReactionResponseKind;
  responseId: string;
  trigger: BoundedReactionTrigger;
}>;

/** A ready action: a response held until a bounded trigger fires or it expires. */
export type ReadyAction = Readonly<{
  readyId: string;
  reactorCombatantId: string;
  responseKind: ReactionResponseKind;
  responseId: string;
  trigger: BoundedReactionTrigger;
  expiresAtRound: number;
}>;

export type ReactionEvent = Readonly<{
  kind: ReactionEventKind;
  encounterId: string;
  campaignId: string;
  round: number;
  occurredAt: string;
  /** The subject of the event: the hit/targeted target, the turn starter, or the mover leaving reach. */
  subjectCombatantId: string;
  /** The other party: the attacker, the targeter, or the source of the event. */
  sourceCombatantId: string | null;
  hit?: boolean;
  attackTotal?: number;
  armorClass?: number;
  critical?: boolean;
}>;

/** One eligible reactor and the bounded response it would spend its reaction on. */
export type ReactionWindowEntry = Readonly<{
  reactorCombatantId: string;
  source: "declared" | "ready" | "innate";
  readyId: string | null;
  responseKind: ReactionResponseKind;
  responseId: string;
  trigger: BoundedReactionTrigger;
}>;

export type ReactionReceipt<TOutcome = Record<string, unknown>> = Readonly<{
  reactionId: string;
  event: ReactionEventKind;
  reactorCombatantId: string;
  sourceCombatantId: string | null;
  round: number;
  responseKind: ReactionResponseKind;
  responseId: string;
  readiness: "declared" | "ready" | "innate";
  outcome: TOutcome;
}>;

/** Inputs used to decide whether a bounded trigger fires for a concrete reactor. */
export type ReactionMatchContext = Readonly<{
  reactorCombatantId: string;
  reactorTeam: string;
  subjectTeam: string;
  distanceFeet?: number;
  round: number;
}>;
