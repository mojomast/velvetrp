import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttunementResponse, AttunementSnapshot } from "@velvet/contracts";
import { MagicItemAttunementPanel, type AttunementPanelApi } from "./MagicItemAttunementPanel";

afterEach(cleanup);

const AT = "2035-01-01T00:00:00.000Z";
const attuned: AttunementSnapshot = {
  campaignId: "campaign", actorId: "actor", limit: 3,
  attunements: [{ key: "ring", definition: { packId: "srd-5.1", packVersion: "1.6.0", definitionId: "srd-5.1:item:ring" }, attunedAt: AT }],
};
const empty: AttunementSnapshot = { campaignId: "campaign", actorId: "actor", limit: 3, attunements: [] };

function client(overrides: Partial<AttunementPanelApi> = {}): AttunementPanelApi {
  return {
    getActorAttunements: vi.fn().mockResolvedValue(empty),
    commandActorAttunement: vi.fn().mockResolvedValue({ ok: true, code: null, snapshot: empty } satisfies AttunementResponse),
    ...overrides,
  };
}

describe("MagicItemAttunementPanel", () => {
  it("loads the attunement set and reports the limit", async () => {
    render(<MagicItemAttunementPanel campaignId="campaign" actorId="actor" api={client({ getActorAttunements: vi.fn().mockResolvedValue(attuned) })} />);
    expect(await screen.findByText("srd-5.1:item:ring")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("attunes a candidate with the selected rest and updates the snapshot", async () => {
    const after = { ...empty, attunements: [{ key: "ring", definition: { packId: "srd-5.1", packVersion: "1.6.0", definitionId: "srd-5.1:item:ring" }, attunedAt: AT }] };
    const api = client({ commandActorAttunement: vi.fn().mockResolvedValue({ ok: true, code: null, snapshot: after } satisfies AttunementResponse) });
    render(<MagicItemAttunementPanel campaignId="campaign" actorId="actor" api={api}
      candidates={[{ definitionId: "srd-5.1:item:ring", name: "Ring of Protection", prerequisite: "short-rest" }]} />);
    await screen.findByText("No items are attuned.");
    fireEvent.change(screen.getByLabelText("Completed rest"), { target: { value: "long-rest" } });
    fireEvent.click(screen.getByRole("button", { name: "Attune" }));
    await waitFor(() => expect(api.commandActorAttunement).toHaveBeenCalledWith("campaign", "actor", {
      command: "attune", key: "srd-5.1:item:ring", definitionId: "srd-5.1:item:ring", satisfiedRest: "long-rest",
    }));
    expect(await screen.findByText("srd-5.1:item:ring")).toBeTruthy();
  });

  it("surfaces an engine rejection and disables already-attuned candidates", async () => {
    const api = client({
      getActorAttunements: vi.fn().mockResolvedValue(attuned),
      commandActorAttunement: vi.fn().mockResolvedValue({ ok: false, code: "capacity-exceeded", snapshot: attuned } satisfies AttunementResponse),
    });
    render(<MagicItemAttunementPanel campaignId="campaign" actorId="actor" api={api}
      candidates={[{ definitionId: "srd-5.1:item:ring", name: "Ring of Protection", prerequisite: "short-rest" },
        { definitionId: "srd-5.1:item:cloak", name: "Cloak", prerequisite: "short-rest" }]} />);
    await screen.findByText("srd-5.1:item:ring");
    expect((screen.getByRole("button", { name: "Attuned" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Attune" }));
    expect(await screen.findByText(/Attunement rejected: capacity-exceeded/)).toBeTruthy();
  });

  it("drops an attunement through the command surface", async () => {
    const api = client({
      getActorAttunements: vi.fn().mockResolvedValue(attuned),
      commandActorAttunement: vi.fn().mockResolvedValue({ ok: true, code: null, snapshot: empty } satisfies AttunementResponse),
    });
    render(<MagicItemAttunementPanel campaignId="campaign" actorId="actor" api={api} />);
    await screen.findByText("srd-5.1:item:ring");
    fireEvent.click(screen.getByRole("button", { name: "Drop attunement" }));
    await waitFor(() => expect(api.commandActorAttunement).toHaveBeenCalledWith("campaign", "actor", { command: "drop", key: "ring" }));
    expect(await screen.findByText("No items are attuned.")).toBeTruthy();
  });
});
