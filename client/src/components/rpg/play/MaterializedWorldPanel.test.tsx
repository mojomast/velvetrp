import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function apiMock(overrides: Partial<MaterializedWorldPanelApi> = {}): MaterializedWorldPanelApi {
  return {
    getWorld: vi.fn().mockResolvedValue(world),
    getPresentCast: vi.fn().mockResolvedValue(cast),
    getNpcShop: vi.fn().mockResolvedValue(association),
    getShop: vi.fn().mockResolvedValue(shop),
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
    cleanup();

    const gmApi = apiMock();
    renderPanel(gmApi, "gm");
    expect(screen.getByRole("heading", { name: "Materialized world" })).toBeTruthy();
    // Explicit action only: the panel never auto-fires its reads.
    expect(gmApi.getWorld).not.toHaveBeenCalled();
    expect(gmApi.getPresentCast).not.toHaveBeenCalled();
    expect(gmApi.getNpcShop).not.toHaveBeenCalled();
    expect(screen.getByText(/does not read on mount/)).toBeTruthy();
  });

  it("renders the server's public locations, present NPCs, and associated shops after an explicit load", async () => {
    const api = apiMock();
    renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "Load world view" }));
    await screen.findByText("Old Gate");
    expect(screen.getByText("Mara - Old Gate")).toBeTruthy();
    expect(screen.getByText("Mara's wares")).toBeTruthy();
    expect(screen.getByText(/1 stock line/)).toBeTruthy();
    expect(api.getWorld).toHaveBeenCalledWith("campaign", "session");
    expect(api.getPresentCast).toHaveBeenCalledWith("campaign", "session", "gm");
    expect(api.getNpcShop).toHaveBeenCalledWith("campaign", "npc-mara");
    expect(api.getShop).toHaveBeenCalledWith("campaign", "ff-shop-1");
  });

  it("omits shops it cannot read instead of inventing them", async () => {
    const api = apiMock({ getNpcShop: vi.fn().mockRejectedValue(new TypeError("unavailable")) });
    renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "Load world view" }));
    await screen.findByText("No present merchant has a materialized shop.");
    expect(screen.getByText(/Some shops could not be read/)).toBeTruthy();
    expect(api.getShop).not.toHaveBeenCalled();
  });
});
