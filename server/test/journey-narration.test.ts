import { describe, expect, it } from "vitest";
import { narrationFallback, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";

/** Structural mirror of the route's non-exported journey narration receipt. */
type JourneyReceipt = {
  kind: "journey"; destination: string; currentLocation: string;
  status: "completed" | "interrupted"; interruption: string | null; legs: number; elapsedMinutes: number;
};

const completed: JourneyReceipt = {
  kind: "journey", destination: "Silver Harbor", currentLocation: "Silver Harbor",
  status: "completed", interruption: null, legs: 2, elapsedMinutes: 120,
};
const interrupted: JourneyReceipt = {
  kind: "journey", destination: "Silver Harbor", currentLocation: "Waystation",
  status: "interrupted", interruption: "A washed-out culvert forces a careful detour around broken ground.",
  legs: 1, elapsedMinutes: 60,
};

describe("journey narration receipts", () => {
  it("composes a completed journey as arrival at the committed current location", () => {
    const text = narrationFallback("I travel to Silver Harbor.", [completed]);
    expect(text).toContain("Silver Harbor");
    expect(text.toLowerCase()).toContain("arrive");
  });

  it("composes an interrupted journey as stopped with the requested destination still pending", () => {
    const text = narrationFallback("I travel to Silver Harbor.", [interrupted]);
    expect(text).toContain("Waystation");
    expect(text).toContain("Silver Harbor");
    expect(text.toLowerCase()).toContain("pending");
    expect(text.toLowerCase()).toContain("continue");
    expect(text.toLowerCase()).not.toContain("you arrive at silver harbor");
  });

  it("rejects a requested-destination arrival on an interrupted journey", () => {
    // Names the committed current location but claims arrival at the pending destination.
    expect(providerNarrationMatchesReceipts(
      "At Waystation you pause, then arrive at Silver Harbor by nightfall.", [interrupted], "Waystation")).toBe(false);
    // Stays at the committed current location and keeps the destination pending.
    expect(providerNarrationMatchesReceipts(
      "At Waystation you pause and make camp; Silver Harbor is still ahead.", [interrupted], "Waystation")).toBe(true);
  });

  it("rejects an interrupted journey narrated as completed", () => {
    expect(providerNarrationMatchesReceipts(
      "At Waystation the journey is completed; Silver Harbor remains pending.", [interrupted], "Waystation")).toBe(false);
  });

  it("rejects the reach/enter/step-onto arrival variants that name the pending destination", () => {
    const laSalle: JourneyReceipt = {
      kind: "journey", destination: "Place La Salle", currentLocation: "Miller's Crossing",
      status: "interrupted", interruption: null, legs: 1, elapsedMinutes: 60,
    };
    for (const claim of [
      "At Miller's Crossing you steady yourself, then you reach Place La Salle.",
      "At Miller's Crossing you enter Place La Salle by the old gate.",
      "At Miller's Crossing you step onto Place La Salle.",
    ]) expect(providerNarrationMatchesReceipts(claim, [laSalle], "Miller's Crossing"), claim).toBe(false);
    expect(providerNarrationMatchesReceipts(
      "At Miller's Crossing you steady yourself; Place La Salle still lies ahead.", [laSalle], "Miller's Crossing")).toBe(true);
  });

  it("rejects invented combat, damage, or rewards alongside a journey receipt", () => {
    for (const claim of [
      "At Waystation you take 7 damage.",
      "At Waystation you gain 50 gold.",
      "At Waystation the quest is completed and you claim the reward.",
    ]) expect(providerNarrationMatchesReceipts(claim, [interrupted], "Waystation"), claim).toBe(false);
  });

  it("accepts a completed journey that names the reached location", () => {
    expect(providerNarrationMatchesReceipts(
      "You reach Silver Harbor after the long road.", [completed], "Silver Harbor")).toBe(true);
  });
});
