import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/** The question key for the aggregate "who is the single best speaker" choice. */
export const ROOM_ROUTING_BEST_SPEAKER_KEY = "best_speaker";
/** The fail-closed option used when no participant is a supported speaker. */
export const ROOM_ROUTING_NONE = "none_of_these";

/** The minimal participant projection a room-routing question needs. */
export interface RoomRoutingParticipant {
  id: string;
  name: string;
  archetype: string;
}

/**
 * Builds a speculative fan-out battery: one atomic `noul` per participant plus a
 * single aggregate `choice` naming the best speaker. The per-participant answers
 * support multi-speaker turns; the choice rescues ambiguous turns where no single
 * participant clears the action threshold, so the lane can still act instead of
 * always deferring to the LLM.
 */
export function buildRoomRoutingQuestions(
  participants: readonly RoomRoutingParticipant[],
  userContent: string,
  recentHistory: string,
): SystemOneQuestions {
  const questions: SystemOneQuestions = {};
  for (const participant of participants) {
    questions[participant.id] = {
      type: "noul",
      instructions: `Should ${participant.name} (${participant.archetype}) speak in the next room turn, given the user message and recent history?`,
      criteria: {
        true: `${participant.name} is addressed by name, directly implicated, or is the natural next speaker in this scene`,
        false: `${participant.name} is not addressed, not implicated, and should stay silent this turn`,
      },
    };
  }
  const criteria: Record<string, string | null> = {};
  for (const participant of participants) {
    criteria[participant.id] = `${participant.name} — ${participant.archetype}`;
  }
  criteria[ROOM_ROUTING_NONE] = "No participant is a well-supported speaker for this turn";
  questions[ROOM_ROUTING_BEST_SPEAKER_KEY] = {
    type: "choice",
    instructions: "Which single participant is the best-supported speaker for the next room turn, or none?",
    criteria,
  };
  return questions;
}

export type RoomRoutingMethod = "threshold" | "best-pick" | "defer";

export interface RoomRoutingComposition {
  /** `act` selects the participants; `confirm`/`fallback` defer to the LLM or deterministic path. */
  band: SystemOneBand;
  /** How the selection was reached. */
  method: RoomRoutingMethod;
  /** Participants selected, highest support first. */
  speakerIds: string[];
  /** The strongest signal used, for observability and calibration. */
  topSignal: number | null;
}

function topProbability(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((max, value) => (value > max ? value : max), 0);
}

/**
 * Composes a room-routing decision from the battery.
 *
 * 1. Participants whose `noul` clears the action threshold are selected (ordered,
 *    capped) — this preserves multi-speaker turns.
 * 2. If none do, the aggregate `choice` acts as a fallback when its top option is a
 *    real participant and its probability clears the review threshold.
 * 3. Otherwise the lane defers, and the caller keeps the existing LLM/deterministic path.
 */
export function composeRoomRoutingSelection(
  participants: readonly RoomRoutingParticipant[],
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  maxSpeakers: number,
): RoomRoutingComposition {
  const participantIds = new Set(participants.map((participant) => participant.id));
  const scored: Array<{ id: string; signal: number; band: SystemOneBand }> = [];
  for (const participant of participants) {
    const answer = answers[participant.id];
    if (!answer || answer.type !== "noul") continue;
    scored.push({ id: participant.id, signal: answer.noul, band: bandForConfidence(answer.noul, thresholds) });
  }
  scored.sort((left, right) => right.signal - left.signal);
  const acting = scored.filter((entry) => entry.band === "act").slice(0, maxSpeakers);
  if (acting.length > 0) {
    return { band: "act", method: "threshold", speakerIds: acting.map((entry) => entry.id), topSignal: scored[0]?.signal ?? null };
  }

  const best = answers[ROOM_ROUTING_BEST_SPEAKER_KEY];
  const bestTop = best && best.type === "choice" ? topProbability(best.probabilities) : null;
  if (best && best.type === "choice" && best.choice !== ROOM_ROUTING_NONE && participantIds.has(best.choice) && bestTop !== null && bestTop >= thresholds.reviewThreshold) {
    return { band: "act", method: "best-pick", speakerIds: [best.choice], topSignal: bestTop };
  }

  const topNoul = scored[0]?.signal ?? null;
  const signal = Math.max(topNoul ?? 0, bestTop ?? 0);
  return { band: scored[0]?.band ?? "fallback", method: "defer", speakerIds: [], topSignal: signal > 0 ? signal : null };
}
