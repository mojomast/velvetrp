import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignStartingLocationPanel } from "./CampaignStartingLocationPanel";
import { CampaignStartingLocationHttpError, type CampaignStartingLocationApi } from "./campaignStartingLocationApi";

const at = "2030-01-01T00:00:00.000Z";
const empty = { campaignId: "campaign", revision: 4, startingLocation: null } as const;
const designated = { campaignId: "campaign", revision: 5, startingLocation: { locationId: "harbor", name: "Old Harbor", designatedAt: at } } as const;

function api(overrides: Partial<CampaignStartingLocationApi> = {}): CampaignStartingLocationApi {
  return {
    getCampaignStartingLocation: vi.fn().mockResolvedValue(empty),
    designateCampaignStartingLocation: vi.fn(),
    getCampaignStartingLocationWorld: vi.fn(),
    ...overrides,
  };
}

function response(key: string) {
  return { ...designated, receipt: { commandId: "command", idempotencyKey: key, revisionBefore: 4, revisionAfter: 5, occurredAt: at } };
}

function choose(): void {
  fireEvent.change(screen.getByLabelText("Public named location"), { target: { value: "harbor" } });
  fireEvent.click(screen.getByRole("button", { name: "Designate starting location once" }));
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("CampaignStartingLocationPanel", () => {
  it("persists the exact revision and identity before a successful dispatch", async () => {
    const designate = vi.fn().mockImplementation(async (_campaignId, input) => {
      expect(JSON.parse(sessionStorage.getItem("velvet.starting-location.v1:campaign") ?? "null")).toEqual(input);
      return response(input.idempotencyKey);
    });
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[{ locationId: "harbor", name: "Old Harbor" }]} canDesignate api={api({ designateCampaignStartingLocation: designate })} />);
    await screen.findByLabelText("Public named location");
    choose();
    await screen.findByText("Old Harbor is the authoritative campaign starting location.");
    expect(designate).toHaveBeenCalledWith("campaign", expect.objectContaining({ locationId: "harbor", expectedRevision: 4, idempotencyKey: expect.stringMatching(/^starting-location-/) }));
    expect(sessionStorage.getItem("velvet.starting-location.v1:campaign")).toBeNull();
  });

  it("reconciles an uncertain response and replays only the exact retained command", async () => {
    const reads = vi.fn().mockResolvedValue(empty);
    const designate = vi.fn().mockRejectedValueOnce(new TypeError("response lost")).mockImplementation(async (_campaignId, input) => response(input.idempotencyKey));
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[{ locationId: "harbor", name: "Old Harbor" }]} canDesignate api={api({ getCampaignStartingLocation: reads, designateCampaignStartingLocation: designate })} />);
    await screen.findByLabelText("Public named location"); choose();
    await screen.findByText(/response is uncertain/);
    const retained = JSON.parse(sessionStorage.getItem("velvet.starting-location.v1:campaign") ?? "null");
    expect(designate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile authoritative designation" }));
    const retry = await screen.findByRole("button", { name: "Retry exact retained designation" });
    expect(designate).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await screen.findByText("Old Harbor is the authoritative campaign starting location.");
    expect(designate.mock.calls[1]?.[1]).toEqual(retained);
  });

  it("refreshes a stale rejection without retrying", async () => {
    const reads = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue({ ...empty, revision: 6 });
    const designate = vi.fn().mockRejectedValue(new CampaignStartingLocationHttpError(409, "RPG_CAMPAIGN_STARTING_LOCATION_STALE"));
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[{ locationId: "harbor", name: "Old Harbor" }]} canDesignate api={api({ getCampaignStartingLocation: reads, designateCampaignStartingLocation: designate })} />);
    await screen.findByLabelText("Public named location"); choose();
    await screen.findByText(/campaign revision changed/i);
    expect(designate).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("locks a different authoritative designation during uncertain reconciliation", async () => {
    const other = { campaignId: "campaign", revision: 5, startingLocation: { locationId: "hill", name: "Beacon Hill", designatedAt: at } };
    const reads = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(other);
    const designate = vi.fn().mockRejectedValue(new TypeError("response lost"));
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[{ locationId: "harbor", name: "Old Harbor" }]} canDesignate api={api({ getCampaignStartingLocation: reads, designateCampaignStartingLocation: designate })} />);
    await screen.findByLabelText("Public named location"); choose();
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile authoritative designation" }));
    await screen.findByText(/Beacon Hill is already locked/);
    expect(screen.queryByRole("button", { name: /Retry exact/ })).toBeNull();
    expect(designate).toHaveBeenCalledTimes(1);
  });

  it.each(["player", "spectator"])("is read-only for a %s projection", async () => {
    const designate = vi.fn();
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[{ locationId: "harbor", name: "Old Harbor" }]} canDesignate={false} api={api({ designateCampaignStartingLocation: designate })} />);
    await screen.findByText(/only the campaign owner or GM/);
    expect(screen.queryByLabelText("Public named location")).toBeNull();
    expect(designate).not.toHaveBeenCalled();
  });

  it("shows an authoritative designation to read-only roles", async () => {
    render(<CampaignStartingLocationPanel campaignId="campaign" candidates={[]} canDesignate={false} api={api({ getCampaignStartingLocation: vi.fn().mockResolvedValue(designated) })} />);
    await waitFor(() => expect(screen.getByText("Old Harbor")).toBeTruthy());
    expect(screen.getByText(/create-once designation is locked/)).toBeTruthy();
  });
});
