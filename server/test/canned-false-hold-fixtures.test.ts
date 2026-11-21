// Approved tests from round-2 canned-narration playtest (false orchestrator holds).
// Live failures: talking about a place, an NPC surname, or a spoken "I'll pay" froze the turn
// with "The declaration names X, but the actor is at Y" or "the purchase or sale remains pending."
// Genuine travel and advertised purchases must still resolve or hold honestly.
import { describe, expect, it } from "vitest";
import {
  declarationLocationReference,
  describeHeldDeclaration,
  locationBoundCandidatesAllowed,
  selectHeldCommerceCandidate,
  type HeldDeclarationContext,
} from "../src/agent/adventureOrchestrator.js";

const SINTERMARK = [
  "Slake-Head",
  "Slake Market",
  "The Long Reflectory",
  "Cold Kiln",
  "Kiln College",
  "Survey House",
  "The Steps",
  "The Throttle",
  "Ash Road",
  "Foundered Row",
];

const context = (patch: Partial<HeldDeclarationContext>): HeldDeclarationContext => ({
  declaration: "",
  currentLocation: "Slake-Head",
  destinationNames: SINTERMARK,
  checkCandidates: [],
  restCandidates: [],
  commerceCandidates: [],
  travelCandidates: SINTERMARK.filter((name) => name !== (patch.currentLocation ?? "Slake-Head")).map((name) => ({
    candidateId: `travel:${name}`,
    semanticLabel: { target: name },
  })),
  ...patch,
});

describe("place names in dialogue or by accident are not staged travel", () => {
  it("does not hold asking about the short draught at Slake-Head while standing in Slake Market", () => {
    // Round-2 long-explorer #5.
    const declaration =
      "I approach the stall with the glass chimes and ask the trader whether he's noticed the short draught at Slake-Head, and what he'd sell me that could measure it.";
    const reference = declarationLocationReference(declaration, "Slake Market", SINTERMARK);
    expect(reference.mismatchedDestination).toBeNull();
    expect(locationBoundCandidatesAllowed(reference)).toBe(true);
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake Market" }));
    expect(hold.reason).not.toBe("location-mismatch");
  });

  it("does not treat 'I head for the Kiln College gate, ask after Borin Slake' as naming Slake-Head", () => {
    // Round-2 long-explorer #21: verb "head" + surname "Slake" completed every significant word of Slake-Head.
    const declaration =
      "Fair enough — I'll not put my ledger on you. I head for the Kiln College gate, ask the porter after Borin Slake, and watch for a man drawing on his own sleeve.";
    const reference = declarationLocationReference(declaration, "The Long Reflectory", SINTERMARK);
    expect(reference.mismatchedDestination).not.toBe("Slake-Head");
    expect(reference.namedDestinations).not.toContain("Slake-Head");
    // This is a real travel gesture toward Kiln College when that road is advertised.
    expect(reference.mismatchedDestination).toBe("Kiln College");
  });

  it("does not treat 'kiln-marked' plus 'going cold' as naming Cold Kiln", () => {
    // Round-2 long-explorer #2.
    const declaration =
      "I step between the carter and the kiln-marked woman and ask her name, then whether the furnace going cold and the short draught are the same trouble or two.";
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).not.toBe("Cold Kiln");
    expect(reference.namedDestinations).not.toContain("Cold Kiln");
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("location-mismatch");
  });

  it("still treats a real walk to an advertised place as travel toward that place", () => {
    const declaration =
      "I leave Slake-Head and walk the road to Kiln College, asking the gate warden there whether Borin Slake has come through.";
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).toBe("Kiln College");
    expect(reference.namedDestinations).not.toContain("Slake-Head");
  });

  it("holds honestly when the named destination is known but not an advertised road", () => {
    const declaration = "I leave Slake-Head and walk the road to Kiln College.";
    const hold = describeHeldDeclaration(
      context({
        declaration,
        currentLocation: "Slake-Head",
        travelCandidates: [{ candidateId: "travel:reflectory", semanticLabel: { target: "The Long Reflectory" } }],
      }),
    );
    expect(hold.reason).toBe("location-mismatch");
    expect(hold.message.toLowerCase()).not.toMatch(/\bactor\b|\bdeclaration\b|\bcampaign change\b/);
    expect(hold.suggestedNextStep ?? "").not.toMatch(/Move to Kiln College first/i);
  });
});

describe("spoken payment is not a compound purchase", () => {
  const cakeStall = {
    candidateId: "commerce:cake",
    action: "buy",
    vendorLabel: "stall vendor",
    itemLabel: "token-cake",
  };

  it("does not hold 'Then let me pay you — name your price' as a pending purchase", () => {
    // Round-2 long-roleplayer #8, and similar #3/#7/#10/#16.
    const declaration =
      'I turn to the silent one and hold her gaze. "Then let me pay you — name your price, and I\'ll meet it."';
    const hold = describeHeldDeclaration(
      context({
        declaration,
        currentLocation: "Slake-Head",
        commerceCandidates: [cakeStall],
      }),
    );
    expect(hold.reason).not.toBe("pending-compound-step");
    expect(`${hold.message} ${hold.suggestedNextStep ?? ""}`.toLowerCase()).not.toMatch(/purchase or sale/);
  });

  it("still selects a real advertised buy when the player names the item and vendor", () => {
    const declaration = "I buy a token-cake from the stall vendor.";
    expect(selectHeldCommerceCandidate(declaration, [cakeStall])).toEqual(cakeStall);
  });

  it("still holds a real buy-then-rest compound on the first advertised purchase", () => {
    const hold = describeHeldDeclaration(
      context({
        declaration: "I buy a token-cake from the stall vendor and then take a short rest.",
        currentLocation: "Slake-Head",
        commerceCandidates: [cakeStall],
        restCandidates: [{ candidateId: "rest:short", restKind: "short", restName: "Short rest" }],
      }),
    );
    expect(hold.reason).toBe("pending-compound-step");
    expect(hold.suggestedNextStep).toMatch(/Buy token-cake from stall vendor/i);
  });
});
