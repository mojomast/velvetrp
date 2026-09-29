import { describe, expect, it } from "vitest";
import { describeHeldDeclaration, type AdventureHold, type HeldDeclarationContext } from "../src/agent/adventureOrchestrator.js";
import { holdNarration, holdNarrationIsWarranted } from "../src/routes/rpg/v1/adventureTurns.js";

const context = (patch: Partial<HeldDeclarationContext>): HeldDeclarationContext => ({
  declaration: "", currentLocation: "Market", destinationNames: ["Docks", "Market"],
  checkCandidates: [], restCandidates: [], commerceCandidates: [], travelCandidates: [], ...patch,
});

const travel = (candidateId: string, target: string) => ({ candidateId, semanticLabel: { target } });

/** One representative deliberate hold for every machine reason the orchestrator can return. */
const everydayHolds: ReadonlyArray<{ name: string; declaration: string; hold: AdventureHold; step: string }> = [
  { name: "location-mismatch", declaration: "I search the crates along the dock.",
    hold: describeHeldDeclaration(context({
      declaration: "I search the crates along the dock.",
      checkCandidates: [{ candidateId: "check:inv", label: "Investigation (Intelligence), Medium difficulty, normal" }],
      travelCandidates: [travel("travel:docks", "Docks")] })), step: "Travel to Docks" },
  { name: "already-at-location", declaration: "I head back to the Market before it gets dark.",
    hold: describeHeldDeclaration(context({ declaration: "I head back to the Market before it gets dark.",
      travelCandidates: [travel("travel:docks", "Docks")] })), step: "Travel to Docks" },
  { name: "pending-compound-step", declaration: "I buy a longsword from Mara and then take a short rest.",
    hold: describeHeldDeclaration(context({ declaration: "I buy a longsword from Mara and then take a short rest.",
      commerceCandidates: [{ candidateId: "commerce:longsword", action: "buy", vendorLabel: "Mara", itemLabel: "Longsword" }],
      restCandidates: [{ candidateId: "rest:short", restKind: "short", restName: "Short rest" }] })), step: "Buy Longsword from Mara" },
  { name: "no-advertised-match", declaration: "I draw my sword and attack the Goblin Scout by the crates.",
    hold: describeHeldDeclaration(context({ declaration: "I draw my sword and attack the Goblin Scout by the crates.",
      travelCandidates: [travel("travel:docks", "Docks")] })), step: "Travel to Docks" },
];

describe("player-visible deliberate holds", () => {
  it("carries the bounded reason and safe next step for every hold reason", () => {
    for (const { name, hold, step } of everydayHolds) {
      const text = holdNarration(hold);
      expect(text, name).toContain(hold.message);
      expect(text, name).toContain(`Suggested next step: ${step}.`);
      expect(text, name).toContain("Nothing is resolved; no movement or other campaign change is established.");
    }
  });

  it("is deterministic and never renders a candidate id, digest, or private surface", () => {
    for (const { name, hold } of everydayHolds) {
      expect(holdNarration(hold), name).toBe(holdNarration(structuredClone(hold)));
      if (hold.suggestedCandidateId !== null) {
        expect(holdNarration(hold), name).not.toContain(hold.suggestedCandidateId);
      }
      expect(holdNarration(hold), name).not.toMatch(/\b(?:candidate|digest|proposal|command|provider|revision)\b/i);
    }
  });

  it("warrants the deterministic line only for a declaration naming a concrete action", () => {
    for (const { name, hold, declaration } of everydayHolds)
      expect(holdNarrationIsWarranted(hold, declaration), name).toBe(true);
    // A pure conversation hold keeps provider-backed prose even though navigation is advertised.
    const declaration = "I ask the ferryman about the square.";
    const conversation = describeHeldDeclaration(context({ declaration, travelCandidates: [travel("travel:docks", "Docks")] }));
    expect(conversation.suggestedNextStep).toBe("Travel to Docks");
    expect(holdNarrationIsWarranted(conversation, declaration)).toBe(false);
  });

  it("leaves a hold with no advertised next step to the existing narration path", () => {
    const hold: AdventureHold = { reason: "no-advertised-match", message: "Nothing is advertised.", suggestedNextStep: null, suggestedCandidateId: null };
    expect(holdNarrationIsWarranted(hold, "I search the crates.")).toBe(false);
  });
});
