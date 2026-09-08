import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TacticalMapPanel, type TacticalMapPanelApi } from "./TacticalMapPanel";

const projection = { mapId: "map", width: 3, height: 2, grid: { kind: "square" as const, feetPerCell: 5 as const }, tiles: [
  { position: { x: 0, y: 0 }, terrain: "floor" as const, visibility: "visible" as const }, { position: { x: 1, y: 0 }, terrain: "floor" as const, visibility: "visible" as const }],
  tokens: [{ tokenId: "token", label: "Hero", position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const }], authoritativePath: null, reachable: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
const snapshot = { campaignId: "campaign", sessionId: "session", encounterId: null, mode: "exploration" as const, mapRevision: 2, tokenRevision: 4, controlledTokenId: "token", movement: { policy: "exploration-60-feet" as const, budgetFeet: 60 }, projection };
function api(overrides: Partial<TacticalMapPanelApi> = {}): TacticalMapPanelApi { return { getTacticalMap: vi.fn().mockResolvedValue(snapshot), generateTacticalMap: vi.fn(), previewTacticalMapMove: vi.fn().mockResolvedValue({ ...snapshot, previewId: "preview", pathCostFeet: 5, projection: { ...projection, authoritativePath: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } }), moveTacticalMapToken: vi.fn().mockResolvedValue({ receipt: { mapId: "map", tokenId: "token", previewId: "preview", idempotencyKey: "key", mapRevision: 2, tokenRevisionBefore: 4, tokenRevisionAfter: 5, destination: { x: 1, y: 0 }, occurredAt: "2030-01-01T00:00:00.000Z" }, snapshot: { ...snapshot, tokenRevision: 5 } }), ...overrides }; }
const props = { campaignId: "campaign", sessionId: "session", actorId: "actor", audience: "player" as const, mode: "exploration" as const, encounterId: null, combatantId: null };

describe("TacticalMapPanel", () => {
  beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)); afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("requires a server preview before one explicit move and renders the text equivalent", async () => {
    const client = api(); render(<TacticalMapPanel {...props} api={client} />); await screen.findByText(/60 feet available/); expect(screen.getByRole("table", { name: "Tactical map text equivalent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm move" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "2, 1" })); await screen.findByText(/Preview: 5 feet/);
    expect(client.previewTacticalMapMove).toHaveBeenCalledWith("campaign", "session", "exploration", { actorId: "actor", destination: { x: 1, y: 0 }, expectedMapRevision: 2, expectedTokenRevision: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" })); await screen.findByText(/Token moved/); expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1);
    expect(client.moveTacticalMapToken).toHaveBeenCalledWith("campaign", "session", "exploration", expect.objectContaining({ actorId: "actor", destination: { x: 1, y: 0 }, previewId: "preview", expectedMapRevision: 2, expectedTokenRevision: 4 }));
  });

  it("never retries an ambiguous command and recovery performs one GET only", async () => {
    const client = api({ moveTacticalMapToken: vi.fn().mockRejectedValue(new TypeError("network")) }); render(<TacticalMapPanel {...props} api={client} />); await screen.findByText(/60 feet available/);
    fireEvent.click(screen.getByRole("button", { name: "2, 1" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm move" })); await screen.findByText(/outcome is uncertain/);
    expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" })); await waitFor(() => expect(client.getTacticalMap).toHaveBeenCalledTimes(2)); expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1);
  });
});
