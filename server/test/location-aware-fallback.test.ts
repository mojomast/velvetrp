import { describe, expect, it } from "vitest";
import { describeHeldDeclaration } from "../src/agent/adventureOrchestrator.js";
import { holdNarration, narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";

const CARNIVAL = "Hackathon Carnival";
const PLAZA = "ASK HERMES Plaza";
const LIGHTHOUSE = "Teknium's Lighthouse Tower";
const DETAILS = {
  [CARNIVAL]: "lantern cables looping between signposts and the smell of hot solder and fried batter",
  [PLAZA]: "the great ASK HERMES panel throwing shifting neon across wet paving",
};

const JARGON =
  /authoritative|declaration|declared|\bactor\b|campaign change|established|mechanics|committed|candidate|receipt|suggested next step|pending/i;

describe("location-aware travel arrival fallback", () => {
  it("turns a bare arrival into location-aware prose that still names the destination", () => {
    const bare = narrationFallback("I walk to the Hackathon Carnival", [{ kind: "travel", destination: CARNIVAL }]);
    const rich = narrationFallback("I walk to the Hackathon Carnival", [{ kind: "travel", destination: CARNIVAL }], {
      currentLocation: CARNIVAL,
      locationDetails: DETAILS,
      reachablePlaces: [PLAZA, "Night Kart Circuit"],
    });
    expect(bare).toContain(`You arrive at ${CARNIVAL}`);
    expect(rich).toContain(CARNIVAL);
    expect(rich.length).toBeGreaterThan(bare.length);
    expect(rich).toMatch(/solder|lantern|batter|fried/i);
    expect(rich).toContain(PLAZA);
    expect(rich).not.toBe(`You arrive at ${CARNIVAL}.`);
    expect(rich).not.toMatch(/\bTessel\b|\bSlake-Head\b/);
    expect(rich).toMatch(/\byou\b/i);
  });
});

describe("location-aware zero-receipt fallback", () => {
  it("replaces the bare hold line with location-aware prose that answers the player's look-around", () => {
    const bare = narrationFallback("I look around.", [], { currentLocation: CARNIVAL, reachablePlaces: [PLAZA] });
    const rich = narrationFallback("I look around.", [], {
      currentLocation: CARNIVAL,
      locationDetails: DETAILS,
      reachablePlaces: [PLAZA],
    });
    expect(bare).toMatch(/you stay where you are/i);
    expect(rich).not.toBe(
      "You stay where you are; nothing has changed yet. Whatever you meant to do is still ahead of you.",
    );
    expect(rich).toContain(CARNIVAL);
    expect(rich).toMatch(/solder|lantern|batter|fried/i);
    expect(rich).toMatch(/\b(?:yet|still|nothing|not)\b/i);
    expect(rich).toContain(PLAZA);
    expect(rich).not.toMatch(/\byou (?:arrive|have arrived|are now (?:at|in))\b/i);
    expect(rich).not.toMatch(JARGON);
    expect(rich).toMatch(/\byou\b/i);
  });
});

describe("location-aware potion consume fallback", () => {
  it("keeps the no-effect guarantee but reads as fiction at the current place", () => {
    const receipt = {
      kind: "inventory" as const,
      itemLabel: "Potion of Healing",
      action: "consume" as const,
      quantity: 1,
      slot: null,
      recipient: null,
    };
    const bare = narrationFallback("I drink a healing potion if I have one.", [receipt]);
    const rich = narrationFallback("I drink a healing potion if I have one.", [receipt], {
      currentLocation: CARNIVAL,
      locationDetails: DETAILS,
    });
    expect(bare).toMatch(/potion of healing/i);
    expect(bare).toMatch(/no item effect/i);
    expect(rich).toMatch(/potion of healing/i);
    expect(rich).not.toMatch(
      /\byou (?:heal|are healed|regain|recover)\b|\bhit points?\b|\b\d+\s+hp\b|\bwounds? (?:close|fade|mend)/i,
    );
    expect(rich.length).toBeGreaterThan(bare.length);
    expect(rich).toContain(CARNIVAL);
    expect(rich).not.toMatch(JARGON);
  });
});

describe("unreachable destination refusal points to a connected place", () => {
  const travelCandidates = [{ candidateId: "to-plaza", semanticLabel: { target: PLAZA } }];
  it("keeps the no-road fact and names a reachable place on the way", () => {
    const hold = describeHeldDeclaration({
      declaration: `I head across the skybridge to ${LIGHTHOUSE}.`,
      currentLocation: CARNIVAL,
      destinationNames: [PLAZA, LIGHTHOUSE],
      travelCandidates,
      commerceCandidates: [],
      restCandidates: [],
      checkCandidates: [],
    });
    expect(hold.reason).toBe("location-mismatch");
    expect(hold.message).toContain(`You are still at ${CARNIVAL}, not ${LIGHTHOUSE}`);
    expect(hold.message).toMatch(/no road from here runs to/i);
    expect(hold.message).toContain(PLAZA);
    expect(holdNarration(hold)).toContain(PLAZA);
  });
});
