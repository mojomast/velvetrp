import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignQuickPanel } from "./CampaignQuickPanel";

describe("CampaignQuickPanel", () => {
  afterEach(cleanup);

  it("renders only authoritative actor resources, inventory, and effects", async () => {
    const api = {
      getActorResources: vi.fn().mockResolvedValue({ resources: [{ name: "health", current: 7, max: 12 }], revision: 2 }),
      getActorInventory: vi.fn().mockResolvedValue({ entries: [{ kind: "stackable", entryId: "potion-entry", item: { packId: "starter", packVersion: "1", definitionId: "healing-potion", kind: "item" }, quantity: 2 }], equipment: [], capacity: 10, revision: 3 }),
      getActorEffects: vi.fn().mockResolvedValue({ effects: [], revision: 1 }),
    };
    render(<CampaignQuickPanel campaignId="campaign" selectedActorId="actor" actors={[{ actorId: "actor", name: "Aria" }]} api={api} />);
    await screen.findByText("7 / 12");
    expect(screen.getByText("healing-potion")).toBeTruthy();
    expect(screen.getByText("x2")).toBeTruthy();
    await waitFor(() => expect(api.getActorInventory).toHaveBeenCalledWith("campaign", "actor"));
  });
});
