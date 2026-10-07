/**
 * Pure per-leg travel interruption selection.
 *
 * Campaigns author their own original travel-event tables. This module never
 * reproduces SRD random-encounter rules, encounter tables or monster math, and
 * never invents a stat block, damage, reward, price or enemy. An interruption is
 * narrative framing plus at most one optional pointer to a pre-prepared
 * encounter that the parent resolves and re-validates before committing.
 *
 * `selectTravelInterruption` returns `null` when an interruption must not happen
 * (safe route, zero chance, active encounter, cap already spent, or no eligible
 * event), and otherwise the exact server-authored event chosen from injected
 * rolls. It never rolls, reads a clock/database/state, or persists.
 */
export type TravelEventKind = "weather" | "obstacle" | "social" | "discovery" | "encounter";
export type TravelEventCondition = "always" | "party-injured" | "after-long-travel";
export type TravelEnvironment = "urban" | "road" | "wilderness" | "water";
export type TravelRisk = "safe" | "watched" | "dangerous";

/** Elapsed in-game minutes that count as a long stretch of travel (8 hours). */
export const AFTER_LONG_TRAVEL_MINUTES = 480;
/** At most one interruption may fire in a single journey/continuation tranche. */
export const MAX_INTERRUPTIONS_PER_TRANCHE = 1;

export interface TravelEventDefinition {
  readonly id: string; readonly kind: TravelEventKind; readonly summary: string; readonly weight: number;
  readonly condition?: TravelEventCondition; readonly environments: readonly TravelEnvironment[];
  /** Stable key of a pre-prepared encounter; the parent resolves and re-validates it. */
  readonly encounterId?: string;
}
/** Server-authored, original campaign travel table (deliberately not an SRD table). */
export const TRAVEL_EVENT_POOL: readonly TravelEventDefinition[] = Object.freeze([
  { id: "weather-squall", kind: "weather", summary: "A cold squall crosses the route; the party pauses to find shelter before continuing.", weight: 30, environments: ["road", "wilderness", "water"] },
  { id: "weather-fog", kind: "weather", summary: "Fog closes in until only the next short stretch of ground is certain.", weight: 20, condition: "after-long-travel", environments: ["road", "water"] },
  { id: "obstacle-washout", kind: "obstacle", summary: "Broken ground blocks the way; the party pauses to assess a safe crossing.", weight: 25, environments: ["road", "wilderness"] },
  { id: "obstacle-crowd", kind: "obstacle", summary: "A crowd chokes the way; the party stops to look for a gap.", weight: 15, environments: ["urban", "road"] },
  { id: "social-news", kind: "social", summary: "A passing traveler stops to ask the party for news of the road ahead.", weight: 20, environments: ["urban", "road"] },
  { id: "social-kindness", kind: "social", summary: "A wayside stranger notices the party's injuries and offers help.", weight: 20, condition: "party-injured", environments: ["urban", "road", "wilderness"] },
  { id: "discovery-marker", kind: "discovery", summary: "A verge-stone carries a sigil the party has not seen before, still sharp.", weight: 15, environments: ["wilderness", "water"] },
  { id: "encounter-traveler", kind: "encounter", summary: "A wary traveler steps into view and signals for the party to stop.", weight: 10, environments: ["wilderness", "road"] },
]);
export interface TravelEventRouteProfile {
  readonly environment: TravelEnvironment;
  readonly risk: TravelRisk;
  /** 0..100 interruption chance, authored by the parent from campaign/route state. */
  readonly chancePercent: number;
}
export interface TravelEventSituation {
  readonly elapsedMinutes: number; readonly partyInjured: boolean;
  readonly activeEncounter: boolean; readonly journeyInterruptionCount: number;
}
export interface SelectTravelInterruptionInput {
  readonly route: TravelEventRouteProfile; readonly situation: TravelEventSituation;
  /** Injected 1..100 trigger roll; required only when the route can interrupt. */
  readonly triggerRoll?: number;
  /** Injected 1..100 selection roll; required only when several events are eligible. */
  readonly eventRoll?: number;
  /** Campaign-authored table; defaults to {@link TRAVEL_EVENT_POOL}. */
  readonly pool?: readonly TravelEventDefinition[];
}
export interface TravelInterruption {
  readonly event: TravelEventDefinition; readonly triggerRoll: number; readonly eventRoll: number | null;
}
const KINDS: readonly TravelEventKind[] = ["weather", "obstacle", "social", "discovery", "encounter"];
const CONDITIONS: readonly TravelEventCondition[] = ["always", "party-injured", "after-long-travel"];
const ENVIRONMENTS: readonly TravelEnvironment[] = ["urban", "road", "wilderness", "water"];
const RISKS: readonly TravelRisk[] = ["safe", "watched", "dangerous"];
function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new RangeError(`${label} is invalid`);
  return value as T;
}
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}
function requireInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}
function conditionSatisfied(condition: TravelEventCondition, situation: TravelEventSituation): boolean {
  if (condition === "party-injured") return situation.partyInjured;
  if (condition === "after-long-travel") return situation.elapsedMinutes >= AFTER_LONG_TRAVEL_MINUTES;
  return true;
}
/** Validates one server-authored event and tests it against the route and situation. */
export function isEligibleTravelEvent(
  event: TravelEventDefinition, environment: TravelEnvironment, situation: TravelEventSituation,
): boolean {
  if (typeof event.id !== "string" || event.id.length === 0) throw new RangeError("event id is invalid");
  requireEnum(event.kind, KINDS, "event kind");
  if (typeof event.summary !== "string" || event.summary.trim().length === 0) throw new RangeError("event summary is invalid");
  requireInteger(event.weight, 1, 100, "event weight");
  if (event.condition !== undefined) requireEnum(event.condition, CONDITIONS, "event condition");
  if (!Array.isArray(event.environments) || event.environments.length === 0
    || event.environments.some((value) => !ENVIRONMENTS.includes(value))) throw new RangeError("event environments are invalid");
  if (!event.environments.includes(environment)) return false;
  return conditionSatisfied(event.condition ?? "always", situation);
}
/** The ordered eligible subset of the pool for one environment and situation. */
export function eligibleTravelEvents(
  route: TravelEventRouteProfile, situation: TravelEventSituation, pool: readonly TravelEventDefinition[] = TRAVEL_EVENT_POOL,
): readonly TravelEventDefinition[] {
  const environment = requireEnum(route.environment, ENVIRONMENTS, "environment");
  requireBoolean(situation.partyInjured, "partyInjured");
  requireInteger(situation.elapsedMinutes, 0, Number.MAX_SAFE_INTEGER, "elapsedMinutes");
  return pool.filter((event) => isEligibleTravelEvent(event, environment, situation));
}
/** Deterministic weighted pick from a non-empty eligible set, using one 1..100 roll. */
export function pickWeightedEvent(events: readonly TravelEventDefinition[], roll: number): TravelEventDefinition {
  if (events.length === 0) throw new RangeError("no eligible travel events");
  const total = events.reduce((sum, event) => sum + event.weight, 0);
  // Scale the injected 1..100 roll proportionally onto [1, total] so relative
  // weights are honoured instead of aliasing under a modulo walk.
  const target = Math.floor(((requireInteger(roll, 1, 100, "eventRoll") - 1) * total) / 100) + 1;
  let cursor = 0;
  for (const event of events) {
    cursor += event.weight;
    if (target <= cursor) return event;
  }
  return events[events.length - 1]!;
}
/** Selects zero or one interruption for one journey tranche from injected rolls. */
export function selectTravelInterruption(input: SelectTravelInterruptionInput): TravelInterruption | null {
  const { route, situation } = input;
  const environment = requireEnum(route.environment, ENVIRONMENTS, "environment");
  requireEnum(route.risk, RISKS, "risk");
  const chance = requireInteger(route.chancePercent, 0, 100, "chancePercent");
  requireInteger(situation.elapsedMinutes, 0, Number.MAX_SAFE_INTEGER, "elapsedMinutes");
  requireBoolean(situation.partyInjured, "partyInjured");
  requireBoolean(situation.activeEncounter, "activeEncounter");
  const count = requireInteger(situation.journeyInterruptionCount, 0, Number.MAX_SAFE_INTEGER, "journeyInterruptionCount");
  if (route.risk === "safe" || chance === 0 || situation.activeEncounter || count >= MAX_INTERRUPTIONS_PER_TRANCHE) return null;
  const eligible = eligibleTravelEvents({ ...route, environment }, situation, input.pool);
  if (eligible.length === 0) return null;
  if (input.triggerRoll === undefined) throw new RangeError("triggerRoll is required when the route can interrupt");
  const triggerRoll = requireInteger(input.triggerRoll, 1, 100, "triggerRoll");
  if (triggerRoll > chance) return null;
  if (eligible.length === 1) return { event: eligible[0]!, triggerRoll, eventRoll: null };
  if (input.eventRoll === undefined) throw new RangeError("eventRoll is required when several events are eligible");
  const eventRoll = requireInteger(input.eventRoll, 1, 100, "eventRoll");
  return { event: pickWeightedEvent(eligible, eventRoll), triggerRoll, eventRoll };
}
