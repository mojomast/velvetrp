import { describe, expect, it } from "vitest";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

const hold = (): ProviderCompletionResult => ({ message: { role: "assistant",
  content: "The scene waits; no mechanics are resolved yet." }, usage: null, model: { requestedModel: "fake", responseModel: "fake" } });

/** A settled SRD actor standing at Market Cross with a second known, non-adjacent place. */
async function fixture() {
  const f = await dmFixture(true);
  f.repo.createLocation(OWNER, { campaignId: f.campaign.id, locationId: "market-cross", name: "Market Cross", description: "A busy crossing." });
  f.repo.createLocation(OWNER, { campaignId: f.campaign.id, locationId: "old-mill", name: "Old Mill", description: "A grain mill by the water." });
  f.repo.placeActor(OWNER, f.actorId, { campaignId: f.campaign.id, locationId: "market-cross", expectedRevision: 0, idempotencyKey: "gate-place" });
  return f;
}
function turn(f: Awaited<ReturnType<typeof fixture>>, declaration: string, key: string) {
  return f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
    actorId: f.actorId, declaration, expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
}
function deps(f: Awaited<ReturnType<typeof fixture>>, advertised: string[]): AdventureAgentDependencies {
  return { getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }), getHarness: async () => defaultHarnessSettings(),
    now: f.options.clock.now, complete: async (input) => {
      advertised.splice(0, advertised.length, ...(input.tools ?? []).map((tool) => tool.name));
      return hold();
    } };
}

describe("known-location declaration gate", () => {
  it("withholds a location-bound check and the bare dice roll when the declaration names another known place", async () => {
    const f = await fixture(), advertised: string[] = [];
    const created = turn(f, "I search the grain loft at the Old Mill.", "gate-search");
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, advertised));
    expect(result.outcome).toBe("completed");
    expect(result.turn.toolCalls).toEqual([]);
    expect(result.turn.receiptLinks).toEqual([]);
    expect(result.hold).toMatchObject({ reason: "location-mismatch" });
    expect(result.hold?.message).toContain("Old Mill");
    expect(advertised).not.toContain("exact_srd_check.select");
    expect(advertised).not.toContain("actor_dice.roll");
    f.repo.close();
  });

  it("keeps the location-bound check and the bare dice roll advertised at the current place", async () => {
    const f = await fixture(), advertised: string[] = [];
    const created = turn(f, "I lean on the rail and watch the water.", "gate-here-allowed");
    await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, advertised));
    expect(advertised).toContain("exact_srd_check.select");
    expect(advertised).toContain("actor_dice.roll");
    f.repo.close();
  });

  it("reports the other destination, not already-at-location, when the declaration also names the current place", async () => {
    const f = await fixture(), advertised: string[] = [];
    const created = turn(f, "I head back to Market Cross and then on to the Old Mill.", "gate-both");
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, advertised));
    expect(result.outcome).toBe("completed");
    expect(result.hold).toMatchObject({ reason: "location-mismatch" });
    expect(result.hold?.message).toContain("Old Mill");
    expect(result.hold?.message).not.toMatch(/already at/i);
    f.repo.close();
  });

  it("still reports already-at-location when only the current place is named", async () => {
    const f = await fixture(), advertised: string[] = [];
    const created = turn(f, "I head back to Market Cross before dark.", "gate-only-here");
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, advertised));
    expect(result.hold).toMatchObject({ reason: "already-at-location" });
    f.repo.close();
  });
});
