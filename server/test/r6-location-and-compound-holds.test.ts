// Approved tests from the round-6 playtest on aa3f05e.
// 1. Roleplayer 3 asked whether a stallholder trained at Kiln College and was held as
//    location-mismatch ("You are still at Slake-Head, not Kiln College"). A question about
//    an NPC's past or another place is not a move toward that place. Real travel to an
//    advertised place must still stage that destination.
// 2. Roleplayer 10 thanked the stallholder, then quietly asked whether a furnace-keeper
//    would accept a kindness from a stranger; roleplayer 11 restated that and turned up
//    the apron. Both were held as pending-compound-step. Thanking and asking is not a
//    compound mechanic. A real thank-then-accept-quest or buy-then-rest must still hold.
import { describe, expect, it } from "vitest";
import {
  declarationLocationReference,
  describeHeldDeclaration,
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

describe("questions about an NPC's past or another place are not location-mismatch", () => {
  it("does not hold asking whether a stallholder trained at Kiln College", () => {
    // Round-6 long-roleplayer #3 on aa3f05e.
    const declaration =
      "I fold my hands back into my sleeves. You know the furnaces well—did you train at Kiln College yourself, or learn the trade another way?\nI ask it gently, meaning no pry.";
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).toBeNull();
    expect(reference.namedDestinations).not.toContain("Kiln College");
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("location-mismatch");
  });

  it("does not hold asking whether someone learned the trade at Survey House", () => {
    const declaration = "Did you learn the trade at Survey House, or was it passed down in the family?";
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).toBeNull();
    expect(reference.namedDestinations).not.toContain("Survey House");
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("location-mismatch");
  });

  it("still treats walking to Kiln College as a staged destination", () => {
    const declaration = "I leave Slake-Head and walk the road to Kiln College.";
    const reference = declarationLocationReference(declaration, "Slake-Head", SINTERMARK);
    expect(reference.mismatchedDestination).toBe("Kiln College");
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).toBe("location-mismatch");
  });
});

describe("thanking then asking about a kindness is not a compound mechanic", () => {
  it("does not hold thanking a stallholder then asking what kindness a stranger could bring", () => {
    // Round-6 long-roleplayer #10 on aa3f05e.
    const declaration =
      "I thank her, and mean it. Then, quieter: \"Is there a kindness he'd accept from a stranger — something to bring, or a hand worth offering? I'd not come empty to a man's fire.";
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("pending-compound-step");
  });

  it("does not hold thanking, asking about a kindness, then turning toward the lintel", () => {
    // Round-6 long-roleplayer #11 on aa3f05e.
    const declaration =
      "I thank her warmly, then ask quieter: \"Is there a kindness he'd accept from a stranger — something to bring, or a hand worth offering? I'd not come empty to a man's fire.\" Then I turn north up the apron toward the crooked lintel.";
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("pending-compound-step");
  });

  it("still holds thanking someone then accepting an advertised quest", () => {
    const hold = describeHeldDeclaration(
      context({
        declaration: 'I thank her, then I accept the job "The Sinkers\' Contract".',
        currentLocation: "Slake-Head",
      }),
    );
    expect(hold.reason).toBe("pending-compound-step");
  });

  it("still holds a real buy-then-rest compound on the first advertised purchase", () => {
    const hold = describeHeldDeclaration(
      context({
        declaration: "I buy a token-cake from the stall vendor and then take a short rest.",
        currentLocation: "Slake-Head",
        commerceCandidates: [
          {
            candidateId: "commerce:cake",
            action: "buy",
            vendorLabel: "stall vendor",
            itemLabel: "token-cake",
          },
        ],
        restCandidates: [{ candidateId: "rest:short", restKind: "short", restName: "Short rest" }],
      }),
    );
    expect(hold.reason).toBe("pending-compound-step");
  });
});
