import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CampaignWorldHttpResponse } from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignRouteMap } from "./CampaignRouteMap";

const at = "2030-01-01T00:00:00.000Z";
const world: CampaignWorldHttpResponse = {
  currentLocations: [{ actorId: "actor", locationId: "town", revision: 2, updatedAt: at }],
  visibleLocations: [
    { locationId: "town", parentLocationId: null, name: "Moon Town", description: "A harbor town." },
    { locationId: "wood", parentLocationId: "town", name: "Whisper Wood", description: "A dark wood." },
    { locationId: "tower", parentLocationId: "wood", name: "Glass Tower", description: "A distant tower." },
  ],
  visibleConnections: [
    { connectionId: "road", fromLocationId: "town", toLocationId: "wood" },
    { connectionId: "trail", fromLocationId: "wood", toLocationId: "tower" },
  ],
};

describe("CampaignRouteMap", () => {
  afterEach(cleanup);

  it("highlights the selected actor location and only exact outgoing destinations", () => {
    const prefill = vi.fn();
    const { container } = render(<CampaignRouteMap world={world} selectedActorId="actor" onPrefillDeclaration={prefill} onOpenWorld={vi.fn()} />);
    expect(screen.getByText(/Topological route map, not to scale/)).toBeTruthy();
    expect(container.querySelector('[data-location-id="town"]')?.classList.contains("is-current")).toBe(true);
    expect(container.querySelector('[data-location-id="wood"]')?.classList.contains("is-reachable")).toBe(true);
    expect(container.querySelector('[data-location-id="tower"]')?.classList.contains("is-reachable")).toBe(false);
    const destinations = screen.getByRole("region", { name: "Reachable destinations" });
    expect(within(destinations).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(destinations).getByRole("button", { name: "Prefill travel to Whisper Wood" }));
    expect(prefill).toHaveBeenCalledWith("Travel to Whisper Wood.");
  });

  it("does not infer a reverse route or render connections with unprojected endpoints", () => {
    const projection: CampaignWorldHttpResponse = {
      ...world,
      currentLocations: [{ actorId: "actor", locationId: "wood", revision: 3, updatedAt: at }],
      visibleConnections: [
        { connectionId: "one-way", fromLocationId: "town", toLocationId: "wood" },
        { connectionId: "hidden", fromLocationId: "wood", toLocationId: "secret" },
      ],
    };
    const { container } = render(<CampaignRouteMap world={projection} selectedActorId="actor" onPrefillDeclaration={vi.fn()} onOpenWorld={vi.fn()} />);
    expect(screen.getByText("No outgoing reachable destinations for the selected actor.")).toBeTruthy();
    expect(container.querySelectorAll(".route-map-connection")).toHaveLength(1);
    expect(screen.queryByText(/secret/i)).toBeNull();
  });

  it("uses stable hierarchy depth and order coordinates without mutating the projection", () => {
    const locationsBefore = structuredClone(world.visibleLocations);
    const { container } = render(<CampaignRouteMap world={world} selectedActorId={null} onPrefillDeclaration={vi.fn()} onOpenWorld={vi.fn()} />);
    expect(container.querySelector('[data-location-id="town"]')?.getAttribute("transform")).toBe("translate(80 55)");
    expect(container.querySelector('[data-location-id="wood"]')?.getAttribute("transform")).toBe("translate(260 145)");
    expect(container.querySelector('[data-location-id="tower"]')?.getAttribute("transform")).toBe("translate(440 235)");
    expect(world.visibleLocations).toEqual(locationsBefore);
  });

  it("offers native keyboard controls for destination and World actions", () => {
    const openWorld = vi.fn();
    render(<CampaignRouteMap world={world} selectedActorId="actor" onPrefillDeclaration={vi.fn()} onOpenWorld={openWorld} />);
    const destination = screen.getByRole("button", { name: "Prefill travel to Whisper Wood" });
    expect(destination.tagName).toBe("BUTTON");
    expect(destination.getAttribute("tabindex")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open World" }));
    expect(openWorld).toHaveBeenCalledTimes(1);
  });
});
