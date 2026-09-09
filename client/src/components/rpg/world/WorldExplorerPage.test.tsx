import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioAuthorization } from "../StudioAuthorization";
import { resetNarrativeMutationRegistryForTests } from "../narrativeMutationRegistry";
import { WorldExplorerPage, type WorldExplorerApi } from "./WorldExplorerPage";

const at = "2030-01-01T00:00:00.000Z";
const world = { currentLocations: [{ actorId: "actor", locationId: "harbor", revision: 2, updatedAt: at }], visibleLocations: [{ locationId: "harbor", parentLocationId: null, name: "Harbor", description: "Salt air" }, { locationId: "road", parentLocationId: null, name: "Road", description: "Inland" }], visibleConnections: [{ connectionId: "route", fromLocationId: "harbor", toLocationId: "road" }] };
const authorization = (): StudioAuthorization => { const auth: StudioAuthorization = { role: "player", audience: "player", generation: 1, reauthorize: vi.fn().mockImplementation(async () => auth) }; return auth; };
afterEach(() => { cleanup(); localStorage.clear(); resetNarrativeMutationRegistryForTests(); });
describe("embedded travel", () => {
  it("uses inline review, existing mutation recovery, and no standalone chrome", async () => {
    const auth = authorization(), locked = vi.fn(), changed = vi.fn();
    const api: WorldExplorerApi = { getWorld: vi.fn().mockResolvedValueOnce({ data: world, revision: 2 }).mockResolvedValue({ data: { ...world, currentLocations: [{ actorId: "actor", locationId: "road", revision: 3, updatedAt: at }] }, revision: 3 }), travel: vi.fn().mockResolvedValue({ receipt: { idempotencyKey: "travel", revisionBefore: 2, revisionAfter: 3, occurredAt: at } }) };
    render(<WorldExplorerPage embedded campaignId="campaign" authorization={auth} api={api} actors={[{ actorId: "actor", name: "Aria" }]} onBack={vi.fn()} onLockChange={locked} onStateChange={changed} />);
    await screen.findByLabelText("Eligible route");
    expect(screen.queryByRole("main")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Campaign starting location")).toBeNull();
    fireEvent.change(screen.getByLabelText("Eligible route"), { target: { value: "route" } }); fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(locked).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm travel" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(api.travel).toHaveBeenCalledExactlyOnceWith("actor", expect.objectContaining({ connectionId: "route", partyActorIds: ["actor"], expectedRevision: 2 }));
    expect(auth.reauthorize).toHaveBeenCalledOnce();
  });
  it("rejects submission if another room operation locks during reauthorization", async () => {
    const auth = authorization(); let resolve!: (value: StudioAuthorization) => void;
    vi.mocked(auth.reauthorize).mockReturnValue(new Promise((done) => { resolve = done; }));
    const api: WorldExplorerApi = { getWorld: vi.fn().mockResolvedValue({ data: world, revision: 2 }), travel: vi.fn() };
    const props = { embedded: true, campaignId: "campaign", authorization: auth, api, actors: [{ actorId: "actor", name: "Aria" }], onBack: vi.fn() };
    const view = render(<WorldExplorerPage {...props} />);
    fireEvent.change(await screen.findByLabelText("Eligible route"), { target: { value: "route" } }); fireEvent.click(screen.getByRole("button", { name: "Review" })); fireEvent.click(screen.getByRole("button", { name: "Confirm travel" }));
    view.rerender(<WorldExplorerPage {...props} blocked />); await act(async () => resolve(auth));
    expect(api.travel).not.toHaveBeenCalled();
  });
});
