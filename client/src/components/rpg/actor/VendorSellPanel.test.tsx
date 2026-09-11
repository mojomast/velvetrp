import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryHttpGetResponse } from "@velvet/contracts";
import { VendorSellPanel } from "./VendorSellPanel";

afterEach(cleanup);
const item = { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "potion" };
const inventory = { entries: [{ kind: "stackable" as const, entryId: "stack", item, quantity: 3 }], equipment: [], capacity: 10, revision: 4 };
const quote = { quote: { quoteId: "quote-1", shopId: "shop", entryId: "stack", quantity: 2, payout: { currency: { kind: "currency" as const, packId: "pack", packVersion: "1", definitionId: "gold" }, minorUnits: 8 }, expiresAt: "2030-01-01T00:00:00.000Z", expectedRevision: 4 } };

describe("VendorSellPanel", () => {
  it("requests an exact quote and then sells with it", async () => {
    const onRequestQuote = vi.fn().mockResolvedValue(quote), onSell = vi.fn();
    render(<VendorSellPanel inventory={inventory} describeItem={() => ({ name: "Potion" })} onRequestQuote={onRequestQuote} onSell={onSell} />);
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: "stack" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Request sale quote" }));
    await screen.findByText("quote-1");
    expect(onRequestQuote).toHaveBeenCalledWith("stack", 2);
    expect(screen.getByText(/8 gold/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sell once" }));
    expect(onSell).toHaveBeenCalledWith("quote-1");
  });

  it("excludes equipped entries and blocks over-quantity", () => {
    const equipped = { ...inventory, equipment: [{ entryId: "stack" }] } as unknown as InventoryHttpGetResponse;
    render(<VendorSellPanel inventory={equipped} describeItem={() => ({ name: "Potion" })} onRequestQuote={vi.fn()} onSell={vi.fn()} />);
    expect(screen.getByText("Nothing sellable is in this actor's inventory.")).toBeTruthy();
    cleanup();
    render(<VendorSellPanel inventory={inventory} describeItem={() => ({ name: "Potion" })} onRequestQuote={vi.fn()} onSell={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: "stack" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "9" } });
    expect((screen.getByRole("button", { name: "Request sale quote" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
