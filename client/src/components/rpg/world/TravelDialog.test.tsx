import { cleanup, render, screen } from "@testing-library/react";
import type { CampaignWorldHttpResponse } from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TravelDialog } from "./TravelDialog";

const liveWorldShape: CampaignWorldHttpResponse = {
  currentLocations: [],
  visibleLocations: [
    { locationId: "gen-location-3d2c5de869267e0a89f9d2d5245e594cd76f7398", parentLocationId: null, name: "Place La Salle and the Nine-Minute Clock", description: "Rain shines on avenue LaSalle." },
    { locationId: "gen-location-a4ce9a2936813bb29bbde4fd896f9fdd277f3a16", parentLocationId: null, name: "Parc des Pionniers Waterfront", description: "A waterfront park near the historic centre." },
  ],
  visibleConnections: [
    { connectionId: "gen-connection-66902d9c837298dd3991afe2981c81c78a63a796", fromLocationId: "gen-location-3d2c5de869267e0a89f9d2d5245e594cd76f7398", toLocationId: "gen-location-a4ce9a2936813bb29bbde4fd896f9fdd277f3a16" },
  ],
};

describe("TravelDialog", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders a hydrated live world on an insecure origin without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

    render(<TravelDialog world={liveWorldShape} revision={2} onTravel={vi.fn()} />);

    expect((screen.getByRole("button", { name: "Plan travel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
