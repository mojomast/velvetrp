import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldExpeditionPanel } from "./WorldExpeditionPanel";

afterEach(cleanup);
const at = "2030-01-01T00:00:00.000Z";
const world = {
  currentLocations: [{ actorId: "actor-placed", locationId: "wood", revision: 1, updatedAt: at }],
  visibleLocations: [
    { locationId: "wood", parentLocationId: null, name: "Moon Wood", description: "Deep still woods." },
    { locationId: "town", parentLocationId: null, name: "Moon Town", description: "A quiet town." },
  ],
  visibleConnections: [],
};
const actors = [{ actorId: "actor-placed", name: "Placed" }, { actorId: "actor-new", name: "New" }];

describe("WorldExpeditionPanel", () => {
  it("places one unplaced actor with the verified revision exactly once per click", () => {
    const place = vi.fn().mockReturnValue(new Promise(() => undefined)), camp = vi.fn().mockResolvedValue({});
    render(<WorldExpeditionPanel campaignId="campaign" revision={7} world={world} actors={actors} canCommand disabled={false} api={{ place, camp }} />);
    expect((screen.getByRole("button", { name: "Place actor" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Make camp" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "actor-new" } });
    expect((screen.getByRole("button", { name: "Make camp" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "town" } });
    const button = screen.getByRole("button", { name: "Place actor" });
    fireEvent.click(button); fireEvent.click(button);
    expect(place).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledWith("actor-new", { campaignId: "campaign", locationId: "town", expectedRevision: 7, idempotencyKey: expect.any(String) });
    expect(camp).not.toHaveBeenCalled();
  });

  it("makes camp at the placed actor's location with the verified revision", () => {
    const camp = vi.fn().mockResolvedValue({});
    render(<WorldExpeditionPanel campaignId="campaign" revision={4} world={world} actors={actors} canCommand disabled={false} api={{ place: vi.fn(), camp }} />);
    fireEvent.click(screen.getByRole("button", { name: "Make camp" }));
    expect(camp).toHaveBeenCalledTimes(1);
    expect(camp).toHaveBeenCalledWith("actor-placed", { campaignId: "campaign", expectedRevision: 4, idempotencyKey: expect.any(String) });
  });

  it("renders no expedition controls for non-GM roles", () => {
    render(<WorldExpeditionPanel campaignId="campaign" revision={4} world={world} actors={actors} canCommand={false} disabled={false} api={{ place: vi.fn(), camp: vi.fn() }} />);
    expect(screen.queryByRole("heading", { name: "Expedition" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Place actor|Make camp/ })).toBeNull();
  });
});
