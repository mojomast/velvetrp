// Approved test (playtest kink #1): place-name matching must not hijack ordinary actions.
// Seen live: "throat" read as The Throttle, "I step up" as The Steps, "upper road" as Ash Road,
// and a skill check that names the current place held as "already at location".
import { describe, expect, it } from "vitest";
import {
  declarationIntent,
  declarationLocationReference,
  locationBoundCandidatesAllowed,
} from "../src/agent/adventureOrchestrator.js";

const SINTERMARK = ["Slake-Head", "The Steps", "The Throttle", "Ash Road", "Foundered Row", "The Long Reflectory"];

describe("place-name matching does not fire on ordinary words", () => {
  it.each([
    ["I stab the nearest NPC in the throat, killing them instantly.", "Slake-Head"],
    ["I step up beside her and offer my hand.", "Slake-Head"],
    ["I keep the nod friendly. Name's Wren, just come down from the upper road.", "The Steps"],
    ["I ask the pigeon where the dungeon is, then row my arms like oars.", "Slake-Head"],
    ["Nobody steps past the cribbing until the dust settles.", "Slake-Head"],
    ["I found a dry spot and wait there.", "Slake-Head"],
  ])("%s", (declaration, current) => {
    const reference = declarationLocationReference(declaration, current, SINTERMARK);
    expect(reference.namedDestinations).toEqual([]);
    expect(reference.mismatchedDestination).toBeNull();
    expect(locationBoundCandidatesAllowed(reference)).toBe(true);
  });
});

describe("genuine place names still match", () => {
  it.each([
    ["I head down to the Steps.", "Slake-Head", "The Steps"],
    ["I travel to The Long Reflectory.", "Slake-Head", "The Long Reflectory"],
    ["I walk along Ash Road toward the gate.", "Slake-Head", "Ash Road"],
    ["I sprint toward Foundered Row.", "Slake-Head", "Foundered Row"],
    ["I go to the Throttle to see the pumps.", "Slake-Head", "The Throttle"],
  ])("%s", (declaration, current, expected) => {
    const reference = declarationLocationReference(declaration, current, SINTERMARK);
    expect(reference.mismatchedDestination).toBe(expected);
  });

  it("keeps the plural stem match for a one-word place", () => {
    const reference = declarationLocationReference("I search the crates along the dock.", "Market", [
      "Docks",
      "Market",
    ]);
    expect(reference.mismatchedDestination).toBe("Docks");
  });
});

describe("naming the current place in a non-travel action", () => {
  it("is not read as travel", () => {
    const declaration = "I make a Perception check to scan Slake-Head for quest hooks. What's the DC?";
    expect(declarationIntent(declaration).travel).toBe(false);
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).toBeNull();
    expect(locationBoundCandidatesAllowed(reference)).toBe(true);
  });
});
