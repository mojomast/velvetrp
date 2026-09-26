import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EconomyHttpCommandResponse, EconomyHttpShopGetResponse, EconomyHttpWalletGetResponse } from "@velvet/contracts";
import { ApiError, type FreeformShopHttpResponse } from "../../../api";
import { MerchantVisitPanel, type MerchantVisitApi } from "./MerchantVisitPanel";

afterEach(cleanup);

const at = "2030-01-01T00:00:00.000Z";
const currency = { kind: "currency" as const, packId: "pack", packVersion: "1", definitionId: "gold" };
const item = { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "potion" };
const stockLine = { stockId: "ff-stock-1", item, quantity: 3, unitPriceMinor: 105, currencyCode: "gold" };
const candidate = { candidateId: "ffsc-1", shopId: "ff-shop-1", shopName: "Mara's wares", npcId: "npc-mara", items: [stockLine] };
const materialized: FreeformShopHttpResponse = {
  classification: { intent: "materialize-shop", merchantName: "Mara", candidates: [candidate] },
  materialization: { status: "materialized", candidate, shopId: "ff-shop-1", npcId: "npc-mara", draftId: "draft-1",
    contentReceiptId: "receipt-1", bindingCreated: true, stock: [stockLine] },
};
const declined: FreeformShopHttpResponse = { classification: { intent: "none", reason: "merchant-not-public" } };
const wallet: EconomyHttpWalletGetResponse = { wallet: { balances: [{ currency, minorUnits: 500 }] }, revision: 4 };
const shop: EconomyHttpShopGetResponse = {
  shop: { name: "Mara's wares" }, stock: [{ item, quantity: 3, unitPrice: { currency, minorUnits: 105 } }], currencies: [currency],
};
const quoteResponse: EconomyHttpCommandResponse = { type: "request_purchase_quote",
  quote: { quoteId: "quote-1", item, quantity: 1, total: { currency, minorUnits: 105 }, expiresAt: at },
  receipt: { type: "request_purchase_quote", idempotencyKey: "quote-key", revisionBefore: 4, revisionAfter: 5, occurredAt: at } };
const purchaseResponse: EconomyHttpCommandResponse = { type: "purchase_from_shop",
  purchase: { purchaseId: "purchase-1", quoteId: "quote-1", quantity: 1, total: { currency, minorUnits: 105 }, purchasedAt: at },
  receipt: { type: "purchase_from_shop", idempotencyKey: "purchase-key", revisionBefore: 5, revisionAfter: 6, occurredAt: at } };

function apiMock(overrides: Partial<MerchantVisitApi> = {}): MerchantVisitApi {
  return { visitMerchant: vi.fn(), getShop: vi.fn(), getWallet: vi.fn(), economyCommand: vi.fn(), ...overrides };
}

const merchants = [{ npcId: "npc-mara", name: "Mara" }];

function renderPanel(api: MerchantVisitApi) {
  return render(<MerchantVisitPanel campaignId="campaign" sessionId="session" actorId="actor" merchants={merchants} api={api} />);
}

describe("MerchantVisitPanel", () => {
  it("calls the free-form shop route once for the selected merchant and renders the server stock", async () => {
    const api = apiMock({ visitMerchant: vi.fn().mockResolvedValue(materialized), getWallet: vi.fn().mockResolvedValue(wallet), getShop: vi.fn().mockResolvedValue(shop) });
    renderPanel(api);
    expect(api.visitMerchant).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Present NPC to visit"), { target: { value: "npc-mara" } });
    fireEvent.click(screen.getByRole("button", { name: "Visit merchant" }));
    await screen.findByText("Mara's wares");
    expect(api.visitMerchant).toHaveBeenCalledTimes(1);
    expect(api.visitMerchant).toHaveBeenCalledWith("campaign", "session", "actor", { merchantNpcId: "npc-mara" });
    expect(api.getShop).toHaveBeenCalledWith("campaign", "ff-shop-1");
    // Stock and price are exactly the server projection; nothing is invented client-side.
    expect(screen.getByText("potion")).toBeTruthy();
    expect(screen.getByText("Server stock: 3 remaining")).toBeTruthy();
    expect(screen.getByText(/105 minor units \(gold\) each/)).toBeTruthy();
  });

  it("purchases the exact selected stock line through the commerce command", async () => {
    const api = apiMock({ visitMerchant: vi.fn().mockResolvedValue(materialized), getWallet: vi.fn().mockResolvedValue(wallet),
      getShop: vi.fn().mockResolvedValue(shop),
      economyCommand: vi.fn().mockResolvedValueOnce(quoteResponse).mockResolvedValueOnce(purchaseResponse) });
    renderPanel(api);
    fireEvent.change(screen.getByLabelText("Present NPC to visit"), { target: { value: "npc-mara" } });
    fireEvent.click(screen.getByRole("button", { name: "Visit merchant" }));
    await screen.findByText("Mara's wares");
    fireEvent.click(screen.getByRole("button", { name: "Request server quote" }));
    await screen.findByText("quote-1");
    expect(api.economyCommand).toHaveBeenNthCalledWith(1, "campaign", "actor",
      expect.objectContaining({ type: "request_purchase_quote", shopId: "ff-shop-1", item, quantity: 1, expectedRevision: 4 }));
    fireEvent.click(screen.getByLabelText("Confirm this exact server quote and total"));
    fireEvent.click(screen.getByRole("button", { name: "Purchase once" }));
    await waitFor(() => expect(api.economyCommand).toHaveBeenNthCalledWith(2, "campaign", "actor",
      expect.objectContaining({ type: "purchase_from_shop", quoteId: "quote-1", expectedRevision: 4 })));
    expect(screen.queryByText("quote-1")).toBeNull();
  });

  it("surfaces a declined classification and a transport error without breaking the view", async () => {
    const api = apiMock({ visitMerchant: vi.fn().mockResolvedValue(declined) });
    renderPanel(api);
    fireEvent.change(screen.getByLabelText("Present NPC to visit"), { target: { value: "npc-mara" } });
    fireEvent.click(screen.getByRole("button", { name: "Visit merchant" }));
    await screen.findByText(/no public identity/);
    expect(api.visitMerchant).toHaveBeenCalledTimes(1);
    expect(api.getShop).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Visit merchant" }) as HTMLButtonElement).disabled).toBe(false);

    const failing = apiMock({ visitMerchant: vi.fn().mockRejectedValue(new ApiError(409, "conflict")) });
    cleanup();
    renderPanel(failing);
    fireEvent.change(screen.getByLabelText("Present NPC to visit"), { target: { value: "npc-mara" } });
    fireEvent.click(screen.getByRole("button", { name: "Visit merchant" }));
    await screen.findByText(/conflicts with current campaign state/);
    expect(failing.visitMerchant).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Visit merchant" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not offer a visit when no NPC is present", () => {
    const api = apiMock();
    render(<MerchantVisitPanel campaignId="campaign" sessionId="session" actorId="actor" merchants={[]} api={api} />);
    expect((screen.getByRole("button", { name: "Visit merchant" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.visitMerchant).not.toHaveBeenCalled();
  });
});
