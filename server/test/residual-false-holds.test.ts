// Approved tests from the round-3 post-deploy playtest on ed5f105.
// Residual holds after C2: looking around the current square and greeting someone
// here was tagged already-at-location; leaving a queue and walking toward another
// stall in the same place was tagged pending-compound-step. Real buy-then-rest
// compounds must still hold.
import { describe, expect, it } from "vitest";
import { describeHeldDeclaration, type HeldDeclarationContext } from "../src/agent/adventureOrchestrator.js";

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

describe("looking around here is not travel to the current place", () => {
  it("does not hold a look-around and greeting at the current square as already-at-location", () => {
    // Round-3 roleplayer #1 on ed5f105.
    const declaration =
      'I set down my bundle of wrapped glass and look around the square. Then, to the nearest stallkeeper: "Forgive me — I\'m newly arrived. Is there honest work for a glass-artisan here?"';
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake-Head" }));
    expect(hold.reason).not.toBe("already-at-location");
    expect(hold.reason).not.toBe("location-mismatch");
  });
});

describe("leaving a queue then walking in the same place is not a compound mechanic", () => {
  it("does not hold stepping out of a queue and making for far stalls as pending-compound-step", () => {
    // Round-3 roleplayer #10 on ed5f105.
    const declaration =
      "I thank her quietly and step out of the queue. Then I make for the far stalls, looking for the Sinkers' bench — and for someone who looks like they keep a ledger.";
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake Market" }));
    expect(hold.reason).not.toBe("pending-compound-step");
    expect(hold.reason).not.toBe("already-at-location");
  });

  it("does not hold a first-step restatement that only steps back from a stall as pending-compound-step", () => {
    // Round-3 roleplayer #11 on ed5f105.
    const declaration =
      "I step away from the queue first — just that, nothing more. One pace back from the slate woman's stall, then a breath before I go looking for the bench.";
    const hold = describeHeldDeclaration(context({ declaration, currentLocation: "Slake Market" }));
    expect(hold.reason).not.toBe("pending-compound-step");
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
