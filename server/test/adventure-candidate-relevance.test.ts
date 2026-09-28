import { describe, expect, it } from "vitest";
import {
  adventureCandidateContext,
  candidateFamilyPriority,
  declarationIntent,
  declarationLocationReference,
  declarationShadowsTravel,
  describeHeldDeclaration,
  locationBoundCandidatesAllowed,
  prioritizeCandidateOptions,
  selectHeldCommerceCandidate,
  selectHeldRestCandidate,
  selectTravelCandidates,
  type AdventureCandidateContextOption,
  type HeldDeclarationContext,
} from "../src/agent/adventureOrchestrator.js";

const label = (action: string, source: string, target: string | null = null) =>
  ({ action, source, target, cost: null, consequence: `${action} consequence` });

const travelOption = (candidateId: string, source: string, target: string): AdventureCandidateContextOption =>
  ({ toolName: "exact_actor_travel.select", arguments: { candidateId, kind: "actor.travel", version: "v1", choices: [] }, label: label("Travel", source, target) });
const pairOption = (toolName: string, candidateId: string, action: string, source: string, target: string | null): AdventureCandidateContextOption =>
  ({ toolName, arguments: { candidateId, digest: "a".repeat(64) }, label: label(action, source, target) });

const orderOf = (context: string): string[] => {
  const table = JSON.parse(context.slice(context.indexOf("{"))) as { candidateOptions: AdventureCandidateContextOption[] };
  return table.candidateOptions.map((option) => option.toolName);
};

describe("declaration intent and candidate ordering", () => {
  it("orders an advertised purchase ahead of a bare travel row (everyday case: buy)", () => {
    const options = [
      travelOption("travel:docks", "Market", "Docks"),
      pairOption("exact_vendor_commerce.select", "commerce:buy", "buy", "Longsword at Mara's Goods", "Mara"),
      pairOption("exact_srd_check.select", "check:inv", "Resolve SRD check", "Investigation", null),
    ];
    const order = orderOf(adventureCandidateContext(options, "I find Mara's stall and buy a longsword."));
    expect(order.indexOf("exact_vendor_commerce.select")).toBeLessThan(order.indexOf("exact_actor_travel.select"));
    expect(order).toHaveLength(3);
  });

  it("orders an advertised rest ahead of unrelated rows (everyday case: short rest)", () => {
    const options = [
      travelOption("travel:docks", "Market", "Docks"),
      pairOption("exact_rest.select", "rest:short", "Short rest", "Short rest", "Source actor"),
    ];
    const order = orderOf(adventureCandidateContext(options, "I sit down and take a short rest."));
    expect(order[0]).toBe("exact_rest.select");
  });

  it("keeps the advertised order when the declaration names nothing relevant", () => {
    const options = [
      travelOption("travel:docks", "Market", "Docks"),
      pairOption("exact_rest.select", "rest:short", "Short rest", "Short rest", "Source actor"),
      pairOption("exact_vendor_commerce.select", "commerce:buy", "buy", "Longsword", "Mara"),
    ];
    expect(prioritizeCandidateOptions(options, "I lean on the rail and watch the water.")
      .map((option) => option.toolName)).toEqual(options.map((option) => option.toolName));
    expect(orderOf(adventureCandidateContext(options, "I lean on the rail and watch the water."))).toEqual(options.map((option) => option.toolName));
  });

  it("withholds a bare travel row that would shadow a stronger commerce, rest, or check intent", () => {
    expect(declarationShadowsTravel("I buy a longsword from Mara.")).toBe(true);
    expect(declarationShadowsTravel("I take a short rest.")).toBe(true);
    expect(declarationShadowsTravel("I search the crates for clues.")).toBe(true);
    // A declaration that stages travel is never shadowed, and combat keeps navigation available.
    expect(declarationShadowsTravel("I walk to the market.")).toBe(false);
    expect(declarationShadowsTravel("I attack the goblin.")).toBe(false);
    expect(declarationShadowsTravel("I lean on the rail and wait.")).toBe(false);
  });

  it("identifies the relevant families deterministically", () => {
    expect(candidateFamilyPriority("I buy a longsword from Mara.")).toContain("exact_vendor_commerce.select");
    expect(candidateFamilyPriority("I take a short rest.")).toEqual(["exact_rest.select"]);
    expect(candidateFamilyPriority("I search the crates for clues.")).toEqual(["exact_srd_check.select"]);
    expect(candidateFamilyPriority("I wait by the water.")).toEqual([]);
  });
});

describe("deterministic candidate selection for a held declaration", () => {
  it("selects the advertised short rest the declaration names (everyday case: rest)", () => {
    const candidates = [{ restKind: "short" as const }, { restKind: "long" as const }];
    expect(selectHeldRestCandidate("I sit down on a crate and take a short rest.", candidates)).toEqual({ restKind: "short" });
    expect(selectHeldRestCandidate("I turn in for the night.", candidates)).toBeNull();
  });

  it("selects the single advertised commerce candidate the declaration names (everyday case: buy)", () => {
    const candidates = [
      { candidateId: "commerce:longsword", action: "buy", vendorLabel: "Mara", itemLabel: "Longsword" },
      { candidateId: "commerce:shield", action: "buy", vendorLabel: "Mara", itemLabel: "Shield" },
    ];
    expect(selectHeldCommerceCandidate("I find Mara's stall and buy a longsword.", candidates)).toMatchObject({ candidateId: "commerce:longsword" });
    expect(selectHeldCommerceCandidate("I buy something unspecified.", candidates)).toBeNull();
    expect(selectHeldCommerceCandidate("I sell my longsword to Mara.", candidates)).toBeNull();
  });

  it("narrows travel to a named destination and never to the current location", () => {
    const candidates = [
      { candidateId: "travel:docks", semanticLabel: { target: "Docks" } },
      { candidateId: "travel:market", semanticLabel: { target: "Market" } },
    ];
    expect(selectTravelCandidates(candidates, "I set out for the Docks.", "Market")).toEqual(candidates);
    // Everyday case: heading back to where the actor already stands withholds travel entirely.
    expect(selectTravelCandidates(candidates, "I head back to the Market before it gets dark.", "Market")).toEqual([]);
    expect(selectTravelCandidates(candidates, "We should leave this place.", "Market")).toEqual(candidates);
  });
});

describe("location gating", () => {
  it("flags a declaration that names a known place other than the actor's location", () => {
    const mismatch = declarationLocationReference("I search the crates along the dock for anything hidden.", "Market", ["Docks", "Market"]);
    expect(mismatch.namedDestinations).toEqual(["Docks"]);
    expect(mismatch.mismatchedDestination).toBe("Docks");
    expect(locationBoundCandidatesAllowed(mismatch)).toBe(false);

    const here = declarationLocationReference("I search the market stalls for anything hidden.", "Market", ["Docks", "Market"]);
    expect(here.mismatchedDestination).toBeNull();
    expect(locationBoundCandidatesAllowed(here)).toBe(true);
  });

  it("does not treat a person or object sharing one word with a destination as naming that place", () => {
    // "Keeper Maren" must not match the destination "Keeper House"; a same-location conversation
    // check therefore stays allowed.
    const conversation = declarationLocationReference("I ask Keeper Maren for an insight check.", "Lantern Quay", ["Keeper House", "Breakwater Cave"]);
    expect(conversation.namedDestinations).toEqual([]);
    expect(conversation.mismatchedDestination).toBeNull();
    expect(locationBoundCandidatesAllowed(conversation)).toBe(true);
    // A genuine multi-word destination still matches when every significant word is present.
    const genuine = declarationLocationReference("I set out for Keeper House with the lens.", "Lantern Quay", ["Keeper House", "Breakwater Cave"]);
    expect(genuine.mismatchedDestination).toBe("Keeper House");
    expect(locationBoundCandidatesAllowed(genuine)).toBe(false);
  });

  it("stages travel for a compound declaration's first step", () => {
    const intent = declarationIntent("I set out for the Docks and then buy a longsword from Mara.");
    expect(intent.steps.length).toBe(2);
    expect(intent.steps[0]!.travel).toBe(true);
    expect(intent.steps[1]!.commerce).toBe(true);
  });
});

describe("hold descriptions", () => {
  const context = (patch: Partial<HeldDeclarationContext>): HeldDeclarationContext => ({
    declaration: "", currentLocation: "Market", destinationNames: ["Docks", "Market"],
    checkCandidates: [], restCandidates: [], commerceCandidates: [], travelCandidates: [], ...patch,
  });

  it("offers navigation for an everyday attack that names no reachable target (case: attack)", () => {
    const hold = describeHeldDeclaration(context({
      declaration: "I draw my sword and attack the Goblin Scout by the crates.",
      travelCandidates: [{ candidateId: "travel:docks", semanticLabel: { target: "Docks" } }],
    }));
    expect(hold.reason).toBe("no-advertised-match");
    expect(hold.suggestedNextStep).toBe("Travel to Docks");
    expect(hold.suggestedCandidateId).toBe("travel:docks");
  });

  it("declines a mismatched-location check and points at navigation", () => {
    const hold = describeHeldDeclaration(context({
      declaration: "I search the crates along the dock for anything hidden.",
      checkCandidates: [{ candidateId: "check:inv", label: "Investigation (Intelligence), Medium difficulty, normal" }],
      travelCandidates: [{ candidateId: "travel:docks", semanticLabel: { target: "Docks" } }],
    }));
    expect(hold.reason).toBe("location-mismatch");
    expect(hold.message).toContain("Docks");
    expect(hold.suggestedNextStep).toBe("Travel to Docks");
  });

  it("names a real destination when the actor is already where the declaration points (case: head back)", () => {
    const hold = describeHeldDeclaration(context({ declaration: "I head back to the Market before it gets dark." }));
    expect(hold.reason).toBe("already-at-location");
    expect(hold.suggestedNextStep).toBe("Travel to Docks");
  });

  it("states the pending later step of a compound declaration that cannot chain", () => {
    const hold = describeHeldDeclaration(context({
      declaration: "I buy a longsword from Mara and then take a short rest.",
      commerceCandidates: [{ candidateId: "commerce:longsword", action: "buy", vendorLabel: "Mara", itemLabel: "Longsword" }],
      restCandidates: [{ candidateId: "rest:short", restKind: "short", restName: "Short rest" }],
    }));
    expect(hold.reason).toBe("pending-compound-step");
    expect(hold.message).toContain("the rest remains pending");
    expect(hold.suggestedNextStep).toBe("Buy Longsword from Mara");
  });

  it("suggests the advertised rest candidate when the provider held on an everyday rest", () => {
    const hold = describeHeldDeclaration(context({
      declaration: "I sit down on a crate and take a short rest.",
      restCandidates: [{ candidateId: "rest:short", restKind: "short", restName: "Short rest" }],
    }));
    expect(hold.suggestedCandidateId).toBe("rest:short");
    expect(hold.suggestedNextStep).toBe("Take a short rest");
  });

  it("declines a rest or transaction the current state does not advertise without a misdirected travel hint", () => {
    const rest = describeHeldDeclaration(context({
      declaration: "I sit down on a crate and take a short rest.",
      travelCandidates: [{ candidateId: "travel:docks", semanticLabel: { target: "Docks" } }],
    }));
    expect(rest.reason).toBe("no-advertised-match");
    expect(rest.message).toMatch(/rest is not advertised/i);
    expect(rest.suggestedNextStep).toBeNull();

    const commerce = describeHeldDeclaration(context({
      declaration: "I buy a longsword from the smith.",
      travelCandidates: [{ candidateId: "travel:docks", semanticLabel: { target: "Docks" } }],
    }));
    expect(commerce.message).toMatch(/transaction is not advertised/i);
    expect(commerce.suggestedNextStep).toBeNull();
  });
});
