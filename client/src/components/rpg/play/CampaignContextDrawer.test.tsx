import { render, screen, waitFor } from "@testing-library/react";
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
    render(<CampaignContextDrawer campaignId="campaign" sessionId="session" selectedActorId="actor" playableActorIds={["actor"]} audience="player" authorizationGeneration={1} api={api} />);
    await screen.findByText("Old stones"); await screen.findByText("Mira");
    expect(screen.getByText("Road")).toBeTruthy(); expect(screen.getByText(/presence is not tracked/)).toBeTruthy();
    expect(screen.getByText(/Open the gate/)).toBeTruthy(); expect(screen.getByText("health: 8 / 10")).toBeTruthy();
    expect(api.listCampaignNpcs).toHaveBeenCalledWith("campaign", "player");
  });

  it("shows encounters and active combat only for the exact room", async () => {
    const roomApi = { ...api, listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [
      { encounterId: "other", sessionId: "other-room", name: "Secret elsewhere", status: "active", combatId: "other-combat", combatants: [], revision: 1, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
      { encounterId: "here", sessionId: "session", name: "Gate fight", status: "active", combatId: "room-combat", combatants: [], revision: 1, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ] }), getCombatState: vi.fn().mockResolvedValue({ round: 2, currentCombatant: "hero" }) };
    render(<CampaignContextDrawer campaignId="campaign" sessionId="session" selectedActorId="actor" playableActorIds={["actor"]} audience="player" authorizationGeneration={1} api={roomApi} />);
    await screen.findByText("Gate fight: active"); expect(screen.queryByText(/Secret elsewhere/)).toBeNull();
    expect(roomApi.getCombatState).toHaveBeenCalledWith("room-combat"); expect(roomApi.getCombatState).not.toHaveBeenCalledWith("other-combat");
  });

  it("clears prior audience data while an authorized replacement is loading", async () => {
    let resolvePlayer!: (value: { revision: number; data: { npcs: never[] } }) => void;
    const player = new Promise<{ revision: number; data: { npcs: never[] } }>((resolve) => { resolvePlayer = resolve; });
    const roleApi = { ...api, listCampaignNpcs: vi.fn()
      .mockResolvedValueOnce({ revision: 1, data: { npcs: [{ npcId: "secret", publicState: { name: "GM projection" } }] } })
      .mockReturnValueOnce(player) };
    const { rerender } = render(<CampaignContextDrawer campaignId="campaign" sessionId="session" selectedActorId="actor" playableActorIds={["actor"]} audience="gm" authorizationGeneration={1} api={roleApi} />);
    await screen.findByText("GM projection");
    rerender(<CampaignContextDrawer campaignId="campaign" sessionId="session" selectedActorId="actor" playableActorIds={["actor"]} audience="player" authorizationGeneration={2} api={roleApi} />);
    await waitFor(() => expect(screen.queryByText("GM projection")).toBeNull()); resolvePlayer({ revision: 2, data: { npcs: [] } });
    await screen.findByText("No visible NPCs available.");
  });
});
