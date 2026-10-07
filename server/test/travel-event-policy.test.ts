import { describe, expect, it } from "vitest";
import {
  AFTER_LONG_TRAVEL_MINUTES,
  MAX_INTERRUPTIONS_PER_TRANCHE,
  TRAVEL_EVENT_POOL,
  eligibleTravelEvents,
  isEligibleTravelEvent,
  pickWeightedEvent,
  selectTravelInterruption,
  type TravelEventDefinition,
  type TravelEventRouteProfile,
  type TravelEventSituation,
} from "../src/repo/world/travelEventPolicy.js";

const route = (overrides: Partial<TravelEventRouteProfile> = {}): TravelEventRouteProfile =>
  ({ environment: "road", risk: "watched", chancePercent: 100, ...overrides });
const situation = (overrides: Partial<TravelEventSituation> = {}): TravelEventSituation =>
  ({ elapsedMinutes: 0, partyInjured: false, activeEncounter: false, journeyInterruptionCount: 0, ...overrides });

/**
 * A small campaign-authored test table. `kind`s and `summary`s are original and
 * carry no stats, damage, rewards or SRD random-encounter content.
 */
const pool: readonly TravelEventDefinition[] = [
  { id: "always-a", kind: "weather", summary: "Alpha.", weight: 10, environments: ["road"] },
  { id: "always-b", kind: "obstacle", summary: "Beta.", weight: 20, environments: ["road"] },
  { id: "hurt", kind: "social", summary: "Gamma.", weight: 50, condition: "party-injured", environments: ["road"] },
  { id: "long", kind: "discovery", summary: "Delta.", weight: 50, condition: "after-long-travel", environments: ["road"] },
  { id: "water", kind: "weather", summary: "Epsilon.", weight: 30, environments: ["water"] },
  { id: "enc", kind: "encounter", summary: "Zeta.", weight: 100, environments: ["road"], encounterId: "prepared:test-ring" },
];

describe("travel event policy", () => {
  it("returns null on a safe urban route with zero chance and no injected rolls", () => {
    expect(selectTravelInterruption({ route: route({ environment: "urban", risk: "safe", chancePercent: 0 }), situation: situation() })).toBeNull();
    expect(selectTravelInterruption({ route: route({ environment: "urban", risk: "watched", chancePercent: 0 }), situation: situation() })).toBeNull();
    expect(selectTravelInterruption({ route: route({ environment: "urban", risk: "safe", chancePercent: 100 }), situation: situation() })).toBeNull();
  });

  it("never interrupts during an active encounter", () => {
    expect(selectTravelInterruption({ route: route(), situation: situation({ activeEncounter: true }), triggerRoll: 1, eventRoll: 1, pool })).toBeNull();
  });

  it("allows at most one interruption per journey tranche", () => {
    expect(MAX_INTERRUPTIONS_PER_TRANCHE).toBe(1);
    expect(selectTravelInterruption({ route: route(), situation: situation({ journeyInterruptionCount: 1 }), triggerRoll: 1, eventRoll: 1, pool })).toBeNull();
  });

  it("returns null when nothing is eligible, without requiring rolls", () => {
    const waterOnly = [pool[4]!];
    expect(selectTravelInterruption({ route: route({ environment: "urban" }), situation: situation(), pool: waterOnly })).toBeNull();
  });

  it("gates the trigger on the injected roll against chancePercent", () => {
    const base = { route: route({ chancePercent: 40 }), situation: situation(), pool };
    expect(selectTravelInterruption({ ...base, triggerRoll: 40, eventRoll: 1 })?.event.id).toBe("always-a");
    expect(selectTravelInterruption({ ...base, triggerRoll: 41, eventRoll: 1 })).toBeNull();
  });

  it("filters server-authored conditions with no text inference", () => {
    expect(eligibleTravelEvents(route(), situation(), pool).map((event) => event.id)).toEqual(["always-a", "always-b", "enc"]);
    expect(eligibleTravelEvents(route(), situation({ partyInjured: true }), pool).map((event) => event.id)).toEqual(["always-a", "always-b", "hurt", "enc"]);
    expect(eligibleTravelEvents(route(), situation({ elapsedMinutes: AFTER_LONG_TRAVEL_MINUTES }), pool).map((event) => event.id)).toEqual(["always-a", "always-b", "long", "enc"]);
  });

  it("treats after-long-travel as elapsed minutes at or above 480", () => {
    expect(eligibleTravelEvents(route(), situation({ elapsedMinutes: AFTER_LONG_TRAVEL_MINUTES - 1 }), pool).map((event) => event.id)).not.toContain("long");
    expect(eligibleTravelEvents(route(), situation({ elapsedMinutes: AFTER_LONG_TRAVEL_MINUTES }), pool).map((event) => event.id)).toContain("long");
  });

  it("only offers events authored for the route environment", () => {
    expect(eligibleTravelEvents(route({ environment: "water" }), situation(), pool).map((event) => event.id)).toEqual(["water"]);
    expect(isEligibleTravelEvent(pool[4]!, "road", situation())).toBe(false);
    expect(isEligibleTravelEvent(pool[2]!, "road", situation({ partyInjured: false }))).toBe(false);
    expect(isEligibleTravelEvent(pool[2]!, "road", situation({ partyInjured: true }))).toBe(true);
  });

  it("selects deterministically by cumulative weight from the injected roll", () => {
    const pair = [pool[0]!, pool[1]!]; // weights 10 and 20
    expect(pickWeightedEvent(pair, 1).id).toBe("always-a");
    expect(pickWeightedEvent(pair, 34).id).toBe("always-a");
    expect(pickWeightedEvent(pair, 35).id).toBe("always-b");
    expect(pickWeightedEvent(pair, 100).id).toBe("always-b");
  });

  it("uses the injected event roll for a weighted selectTravelInterruption choice", () => {
    expect(selectTravelInterruption({ route: route(), situation: situation(), triggerRoll: 1, eventRoll: 15, pool })?.event.id).toBe("always-b");
    expect(selectTravelInterruption({ route: route(), situation: situation(), triggerRoll: 1, eventRoll: 100, pool })?.event.id).toBe("enc");
  });

  it("returns a lone eligible event without consuming an event roll and preserves its prepared encounter pointer", () => {
    const onlyEncounter = [pool[5]!];
    expect(selectTravelInterruption({ route: route(), situation: situation(), triggerRoll: 50, pool: onlyEncounter })).toMatchObject({
      event: { id: "enc", encounterId: "prepared:test-ring" }, triggerRoll: 50, eventRoll: null,
    });
  });

  it("is stable for identical injected rolls", () => {
    const input = { route: route({ chancePercent: 60 }), situation: situation({ elapsedMinutes: 500, partyInjured: true }), triggerRoll: 12, eventRoll: 42, pool };
    const first = selectTravelInterruption(input);
    expect(first).toEqual(selectTravelInterruption(input));
    expect(first?.triggerRoll).toBe(12);
    expect(first?.eventRoll).toBe(42);
  });

  it("throws on malformed or out-of-bounds input", () => {
    expect(() => selectTravelInterruption({ route: route({ environment: "sky" as never }), situation: situation() })).toThrow(RangeError);
    expect(() => selectTravelInterruption({ route: route({ chancePercent: 101 }), situation: situation() })).toThrow(RangeError);
    expect(() => selectTravelInterruption({ route: route(), situation: situation({ elapsedMinutes: -1 }) })).toThrow(RangeError);
    expect(() => selectTravelInterruption({ route: route({ chancePercent: 50 }), situation: situation(), triggerRoll: 0, pool })).toThrow(RangeError);
    expect(() => selectTravelInterruption({ route: route({ chancePercent: 50 }), situation: situation(), pool })).toThrow(RangeError);
    expect(() => selectTravelInterruption({ route: route(), situation: situation(), triggerRoll: 1, pool })).toThrow(RangeError);
    expect(() => pickWeightedEvent([], 1)).toThrow(RangeError);
    const broken = [{ id: "x", kind: "weather", summary: "x", weight: 0, environments: ["road"] }] as unknown as TravelEventDefinition[];
    expect(() => eligibleTravelEvents(route(), situation(), broken)).toThrow(RangeError);
  });

  it("ships an original server-authored table with no SRD-style mechanics prose", () => {
    expect(TRAVEL_EVENT_POOL.length).toBeGreaterThan(0);
    for (const event of TRAVEL_EVENT_POOL) {
      expect(event.id).not.toHaveLength(0);
      expect(event.weight).toBeGreaterThanOrEqual(1);
      expect(event.weight).toBeLessThanOrEqual(100);
      expect(event.environments.length).toBeGreaterThan(0);
      expect(event.summary).not.toMatch(/\d/);
      expect(event.summary).not.toMatch(/\b(?:hp|hit points?|damage|xp|gold|silver|copper|coin|treasure|loot|stat block|challenge rating)\b/i);
    }
  });
});
