import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpgCharacterSheetPage, type RpgCharacterSheetApi } from "./RpgCharacterSheetPage";

const inventory = { entries: [{ kind: "stackable" as const, entryId: "entry", item: { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "rope" }, quantity: 2 }], equipment: [], capacity: 10, revision: 4 };
function api(): RpgCharacterSheetApi {
  return { getSheet: vi.fn(), getResources: vi.fn().mockResolvedValue({ resources: [], revision: 4 }), getInventory: vi.fn().mockResolvedValue(inventory), getWallet: vi.fn().mockResolvedValue({ wallet: { balances: [] }, revision: 4 }), getEffects: vi.fn().mockResolvedValue({ effects: [], concentration: [], revision: 4 }), getPowers: vi.fn().mockResolvedValue({ known: [], prepared: [], slots: [], uses: [], legalNow: [], legalCommands: [], revision: 4 }), getShop: vi.fn(), inventoryCommand: vi.fn(), economyCommand: vi.fn(), rest: vi.fn(), checkCommand: vi.fn(), powerCommand: vi.fn(), spellCommand: vi.fn(), effectCommand: vi.fn(), resourceCommand: vi.fn(), getCampaignContent: vi.fn().mockRejectedValue(new Error("no catalog")), getCampaignPack: vi.fn() };
}
afterEach(() => { cleanup(); localStorage.clear(); });
describe("embedded character mechanics", () => {
  it("binds to the controlled actor without guessing a character-sheet ID and equips once", async () => {
    const client = api(); const changed = vi.fn(), locked = vi.fn(), authorize = vi.fn().mockResolvedValue(true);
    vi.mocked(client.inventoryCommand).mockImplementation(async (_campaign, _actor, command) => ({ inventory: { ...inventory, revision: 5 }, receipt: { idempotencyKey: command.idempotencyKey, kind: "equip", entryId: "entry", slot: "hand", revisionBefore: 4, revisionAfter: 5, occurredAt: "2030-01-01T00:00:00.000Z" } }));
    render(<RpgCharacterSheetPage embedded campaignId="campaign" controlledActorId="actor" api={client} reauthorize={authorize} onLockChange={locked} onStateChange={changed} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Inventory" });
    expect(client.getSheet).not.toHaveBeenCalled();
    expect(client.getInventory).toHaveBeenCalledWith("campaign", "actor");
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.queryByLabelText("Campaign-provided actor ID")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review equip" }));
    expect(locked).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText("Confirm these exact submitted values"));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    await screen.findByText("Command confirmed and authoritative state refreshed.");
    expect(authorize).toHaveBeenCalledOnce();
    expect(client.inventoryCommand).toHaveBeenCalledExactlyOnceWith("campaign", "actor", expect.objectContaining({ kind: "equip", entryId: "entry", expectedRevision: 4 }));
    expect(changed).toHaveBeenCalledOnce();
  });
  it("retains uncertain-command locks across remount and generic refresh", async () => {
    const client = api(); vi.mocked(client.inventoryCommand).mockRejectedValue(new Error("lost response"));
    const props = { embedded: true, campaignId: "campaign", controlledActorId: "actor", api: client, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<RpgCharacterSheetPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review equip" }));
    fireEvent.click(screen.getByLabelText("Confirm these exact submitted values")); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    await screen.findByText(/command outcome is uncertain/); first.unmount();
    render(<RpgCharacterSheetPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh authoritative state" }));
    await screen.findByText(/generic reads cannot prove this uncertain command/);
    expect((screen.getByRole("button", { name: "Review equip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.inventoryCommand).toHaveBeenCalledOnce();
  });
  it("rechecks room blocking after asynchronous reauthorization", async () => {
    const client = api(); let resolve!: (allowed: boolean) => void;
    const authorize = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const props = { embedded: true, campaignId: "campaign", controlledActorId: "actor", api: client, reauthorize: authorize, onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<RpgCharacterSheetPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review equip" })); fireEvent.click(screen.getByLabelText("Confirm these exact submitted values")); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    view.rerender(<RpgCharacterSheetPage {...props} blocked />);
    await act(async () => resolve(true));
    expect(client.inventoryCommand).not.toHaveBeenCalled();
  });
});
