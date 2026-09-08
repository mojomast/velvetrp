import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorShopAdministrationPanel, type VendorShopAdministrationApi } from "./VendorShopAdministrationPanel";

const npcs = [{ npcId: "npc-mira", name: "Mira" }];
const shops = [{ shopId: "shop-docks", name: "Dock Market", stock: [{ stockId: "stock-rope", label: "Silk rope" }] }, { shopId: "shop-hill", name: "Hill Store", stock: [{ stockId: "stock-lamp", label: "Lamp" }] }];
const api = (): VendorShopAdministrationApi => ({ associateVendor: vi.fn(), configureBuyPolicy: vi.fn(), reconcileAssociation: vi.fn(), reconcileBuyPolicy: vi.fn() });

afterEach(cleanup);

describe("VendorShopAdministrationPanel", () => {
  it("requires review and confirmation for an exact vendor reassociation", () => {
    const callbacks = api();
    render(<VendorShopAdministrationPanel actorRole="gm" campaignRevision={8} npcs={npcs} shops={shops} associations={[{ npcId: "npc-mira", shopId: "shop-hill", revision: 2 }]} buyPolicies={[]} api={callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Review association" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already associated/);
    expect((screen.getByRole("button", { name: "Associate vendor once" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this exact NPC-to-shop/ }));
    fireEvent.click(screen.getByRole("button", { name: "Associate vendor once" }));
    expect(callbacks.associateVendor).toHaveBeenCalledWith({ npcId: "npc-mira", shopId: "shop-docks", expectedRevision: 8 });
  });

  it("submits a reviewed zero-payout gift policy and invalidates review after edits", () => {
    const callbacks = api();
    render(<VendorShopAdministrationPanel actorRole="owner" campaignRevision={4} npcs={npcs} shops={shops} associations={[]} buyPolicies={[]} api={callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Review buy policy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this exact stock payout/ }));
    fireEvent.change(screen.getByLabelText(/Payout per unit/), { target: { value: "125" } });
    expect(screen.queryByRole("heading", { name: "Review buy policy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review buy policy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this exact stock payout/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set buy policy once" }));
    expect(callbacks.configureBuyPolicy).toHaveBeenCalledWith({ shopId: "shop-docks", stockId: "stock-rope", payoutUnitMinor: 125, expectedRevision: 4 });
  });

  it("disables mutation by role and exposes explicit uncertain-outcome reconciliation", () => {
    const callbacks = api();
    render(<VendorShopAdministrationPanel actorRole="player" campaignRevision={4} npcs={npcs} shops={shops} associations={[]} buyPolicies={[]} associationMutation={{ phase: "uncertain" }} policyMutation={{ phase: "uncertain" }} api={callbacks} />);
    expect(screen.getByRole("button", { name: "Review association" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile association" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconcile buy policy" }));
    expect(callbacks.reconcileAssociation).toHaveBeenCalledWith("npc-mira");
    expect(callbacks.reconcileBuyPolicy).toHaveBeenCalledWith("shop-docks", "stock-rope");
  });
});
