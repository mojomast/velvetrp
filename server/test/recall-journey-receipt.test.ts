import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDataDir } from "./helpers.js";
import { createMemoryEvalFixture } from "./fixtures/memory-evals/fixture.js";

// Approved test (Phase 0): explicit travel declarations settle through the actor-journey lane
// (journey-command:* receipts). Campaign recall must surface those settlements as committed
// travel outcomes, using only the public journey projection (names, status, legs, time).
describe("campaign recall of actor journey receipts", () => {
  it("recalls a completed journey as a public travel receipt without internal ids or rolls", async () => {
    const fixture = await createMemoryEvalFixture(makeTmpDataDir());
    const journeyCommandId = fixture.sourceIds["travel:hydration"]!;
    expect(journeyCommandId).toMatch(/^journey-command:/);
    fixture.repo.close();
    const repo = createRepository(fixture.options);
    try {
      const recall = repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id,
        audience: { kind: "player", actorId: fixture.actors.aster }, query: "memory destination", purpose: "public-narration" })!;
      const hit = recall.hits.find(value => value.sourceId === journeyCommandId);
      expect(hit).toMatchObject({ sourceKind: "travel-receipt", authority: "committed-outcome" });
      const receipt = JSON.parse(hit!.text) as Record<string, unknown>;
      expect(Object.keys(receipt).sort()).toEqual(["currentLocation", "destination", "elapsedMinutes", "interruption", "kind", "legs", "status"]);
      expect(receipt).toEqual({ kind: "journey", destination: "Memory Destination", currentLocation: "Memory Destination",
        status: "completed", interruption: null, legs: 1, elapsedMinutes: 60 });
      for (const leaked of ["memory-eval-origin", "memory-eval-destination", "memory-eval-route", "eventChecks", "revision", "journey-command"]) {
        expect(hit!.text).not.toContain(leaked);
      }
    } finally {
      repo.close();
    }
  });
});
