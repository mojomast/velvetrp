import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpellcastingPanel } from "./SpellcastingPanel";

afterEach(cleanup);
const spell = { kind: "spell" as const, packId: "pack", packVersion: "1", definitionId: "magic-missile" };
const powers = { known: [spell], prepared: [spell], slots: [{ slotId: "slot-1" as const, level: 1, current: 1, max: 2 }], uses: [], legalNow: [{ powerRef: spell, legal: true, reasons: [] }],
  legalCommands: [{ powerRef: spell, targeting: "single" as const, validTargets: [{ actorId: "actor-2", label: "Goblin" }], maxTargets: 1, costs: [{ kind: "slot" as const, slotId: "slot-1" as const, amount: 1 as const }], concentration: false, effectKinds: ["damage" as const] }], revision: 7 };

describe("SpellcastingPanel", () => {
  it("casts a prepared spell through the dedicated lane with components and an exact target", () => {
    const onCast = vi.fn();
    render(<SpellcastingPanel powers={powers} onCast={onCast} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare cast" }));
    fireEvent.click(screen.getByLabelText("Goblin"));
    fireEvent.click(screen.getByRole("button", { name: "Cast once" }));
    expect(onCast).toHaveBeenCalledWith({ powerRef: spell, targetIds: ["actor-2"], choices: [], components: { verbal: true, somatic: true, material: true } });
  });

  it("explains when no prepared spell is castable", () => {
    render(<SpellcastingPanel powers={{ ...powers, legalCommands: [] }} />);
    expect(screen.getByText("No prepared spells are castable right now.")).toBeTruthy();
  });
});
