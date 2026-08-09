import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignContextDrawer } from "./CampaignContextDrawer";

const api = {
  getCampaignWorld: vi.fn().mockResolvedValue({ revision: 1, data: { currentLocations: [{ actorId: "actor", locationId: "gate", revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" }], visibleLocations: [{ locationId: "gate", parentLocationId: null, name: "Gate", description: "Old stones" }, { locationId: "road", parentLocationId: null, name: "Road", description: "North" }], visibleConnections: [{ connectionId: "north", fromLocationId: "gate", toLocationId: "road" }] } }),
  listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 1, data: { npcs: [{ npcId: "npc", publicState: { name: "Mira" } }], relationships: [] } }),
  listCampaignQuests: vi.fn().mockResolvedValue({ revision: 1, data: { quests: [{ questId: "quest", status: "active" }], objectives: [{ objectiveId: "objective", questId: "quest", description: "Open the gate", progress: 1, targetProgress: 2, completedAt: null }], journal: [] } }),
  getActorResources: vi.fn().mockResolvedValue({ resources: [{ name: "health", current: 8, max: 10 }], revision: 1 }),
  listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn(),
};

describe("CampaignContextDrawer", () => {
  it("loads independent role-safe lanes and binds exits to the selected actor origin", async () => {
    render(<CampaignContextDrawer campaignId="campaign" selectedActorId="actor" playableActorIds={["actor"]} audience="player" authorizationGeneration={1} api={api} />);
    await screen.findByText("Old stones"); await screen.findByText("Mira");
    expect(screen.getByText("Road")).toBeTruthy(); expect(screen.getByText(/presence is not tracked/)).toBeTruthy();
    expect(screen.getByText(/Open the gate/)).toBeTruthy(); expect(screen.getByText("health: 8 / 10")).toBeTruthy();
    expect(api.listCampaignNpcs).toHaveBeenCalledWith("campaign", "player");
  });
});
