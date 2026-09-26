import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignGeneratedPlanning } from "@velvet/contracts";
import type { CampaignFactionsHttpResponse, GmCampaignQuestsHttpResponse } from "../../../api";
import { MaterializedWorldPanel, type MaterializedWorldPanelApi } from "./MaterializedWorldPanel";

afterEach(cleanup);

const at = "2030-01-01T00:00:00.000Z";
const currency = { kind: "currency" as const, packId: "pack", packVersion: "1", definitionId: "gold" };
const item = { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "potion" };
const world = {
  revision: 3,
  data: {
    currentLocations: [],
    visibleLocations: [
      { locationId: "gate", parentLocationId: null, name: "Old Gate", description: "Weathered stone." },
    ],
    visibleConnections: [],
  },
};
const cast = {
  audience: "gm" as const,
  state: "running" as const,
  sessionRevision: 5,
  presentCast: [{
    npcId: "npc-mara", publicState: { name: "Mara" }, revision: 1, presentAt: at, updatedAt: at,
    location: { locationId: "gate", label: "Old Gate" }, personaId: "persona-mara", principals: ["local-owner"],
    privateState: { goals: "", gmNotes: "", merchantState: null },
  }],
};
const association = { npcId: "npc-mara", vendorLabel: "Mara", shopId: "ff-shop-1", shopLabel: "Mara's wares" };
const shop = {
  shop: { name: "Mara's wares" },
  stock: [{ item, quantity: 3, unitPrice: { currency, minorUnits: 105 } }],
  currencies: [currency],
};
const factions: CampaignFactionsHttpResponse = {
  factions: [
    { factionId: "ff-faction-1", name: "Ashen Circle", publicState: { description: "A quiet order." },
      privateState: { gmNotes: "secret", visibility: "public" }, createdAt: at },
    { factionId: "ff-faction-gm", name: "Hidden Hand", publicState: { description: "Not public." },
      privateState: { gmNotes: "secret", visibility: "gm" }, createdAt: at },
  ],
  standings: [],
};
const quests: GmCampaignQuestsHttpResponse = {
  quests: [{ questId: "ff-quest-1", campaignId: "campaign", storylineId: "story-1", title: "Dockside Work",
    description: "Help the dockhands.", status: "offered", rewards: [], createdAt: at, updatedAt: at }],
  objectives: [{ objectiveId: "obj-1", questId: "ff-quest-1", description: "Move the crates.", targetProgress: 3,
    progress: 0, dependencyObjectiveIds: [], completedAt: null }],
  journal: [],
};
const planning: CampaignGeneratedPlanning = {
  campaignId: "campaign", deliveryRevision: 0, encounters: [], questItems: [], monsterConcepts: [], deliverables: [],
  lore: [{ artifactKey: "ff-rumor-hearsay-1", resourceId: "rumor-1", title: "Hearsay: the drowned bell",
    visibility: "public", sourceDraftId: "draft-2", summary: "They say the bell tolls beneath the tide.",
    details: [], locationIds: [], factionIds: [], storyNodeIds: [] }],
};

function apiMock(overrides: Partial<MaterializedWorldPanelApi> = {}): MaterializedWorldPanelApi {
  return {
    getWorld: vi.fn().mockResolvedValue(world),
    getPresentCast: vi.fn().mockResolvedValue(cast),
    getNpcShop: vi.fn().mockResolvedValue(association),
    getShop: vi.fn().mockResolvedValue(shop),
    listFactions: vi.fn().mockResolvedValue({ data: factions, revision: 1 }),
    listQuests: vi.fn().mockResolvedValue({ data: quests, revision: 1 }),
    getGeneratedPlanning: vi.fn().mockResolvedValue(planning),
    ...overrides,
  };
}

function renderPanel(api: MaterializedWorldPanelApi, audience: "gm" | "player" = "gm") {
  return render(<MaterializedWorldPanel campaignId="campaign" sessionId="session" audience={audience} api={api} />);
}

describe("MaterializedWorldPanel", () => {
  it("is hidden for players and fires no read on mount", () => {
    const playerApi = apiMock();
    const player = renderPanel(playerApi, "player");
    expect(player.container.textContent).toBe("");
    expect(playerApi.getWorld).not.toHaveBeenCalled();
    expect(playerApi.getPresentCast).not.toHaveBeenCalled();
    expect(playerApi.listFactions).not.toHaveBeenCalled();
    expect(playerApi.listQuests).not.toHaveBeenCalled();
    expect(playerApi.getGeneratedPlanning).not.toHaveBeenCalled();
    cleanup();

    const gmApi = apiMock();
    renderPanel(gmApi, "gm");
    expect(screen.getByRole("heading", { name: "Materialized world" })).toBeTruthy();
    // Explicit action only: the panel never auto-fires its reads.
    expect(gmApi.getWorld).not.toHaveBeenCalled();
    expect(gmApi.getPresentCast).not.toHaveBeenCalled();
    expect(gmApi.getNpcShop).not.toHaveBeenCalled();
    expect(gmApi.listFactions).not.toHaveBeenCalled();
    expect(gmApi.listQuests).not.toHaveBeenCalled();
    expect(gmApi.getGeneratedPlanning).not.toHaveBeenCalled();
    expect(screen.getByText(/does not read on mount/)).toBeTruthy();
  });

  it("renders the server's public locations, characters, shops, factions, quests, and rumors after an explicit load", async () => {
    const api = apiMock();
    renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "Load world view" }));
    await screen.findByText("Old Gate");
    expect(screen.getByText("Mara - Old Gate")).toBeTruthy();
    expect(screen.getByText("Mara's wares")).toBeTruthy();
    expect(screen.getByText(/1 stock line/)).toBeTruthy();
    await screen.findByText(/Faction Ashen Circle/);
    expect(screen.getByText(/Quest Dockside Work/)).toBeTruthy();
    expect(screen.getByText(/Rumor the drowned bell/)).toBeTruthy();
    // A GM-only faction is omitted from the public projection.
    expect(screen.queryByText(/Hidden Hand/)).toBeNull();
    expect(api.getWorld).toHaveBeenCalledWith("campaign", "session");
    expect(api.getPresentCast).toHaveBeenCalledWith("campaign", "session", "gm");
    expect(api.getNpcShop).toHaveBeenCalledWith("campaign", "npc-mara");
    expect(api.getShop).toHaveBeenCalledWith("campaign", "ff-shop-1");
    expect(api.listFactions).toHaveBeenCalledWith("campaign", "gm");
    expect(api.listQuests).toHaveBeenCalledWith("campaign", "gm");
    expect(api.getGeneratedPlanning).toHaveBeenCalledWith("campaign");
  });

  it("omits shops it cannot read instead of inventing them", async () => {
    const api = apiMock({ getNpcShop: vi.fn().mockRejectedValue(new TypeError("unavailable")) });
    renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "Load world view" }));
    await screen.findByText("No present merchant has a materialized shop.");
    expect(screen.getByText(/Some shops could not be read/)).toBeTruthy();
    expect(api.getShop).not.toHaveBeenCalled();
  });

  it("omits an unreadable mechanics section with an honest notice while reading the rest", async () => {
    const api = apiMock({ listFactions: vi.fn().mockRejectedValue(new TypeError("unavailable")) });
    renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "Load world view" }));
    await screen.findByText(/Public factions could not be read/);
    expect(screen.queryByText(/Ashen Circle/)).toBeNull();
    // The other server reads still render.
    expect(screen.getByText(/Quest Dockside Work/)).toBeTruthy();
    expect(screen.getByText(/Rumor the drowned bell/)).toBeTruthy();
  });
});
