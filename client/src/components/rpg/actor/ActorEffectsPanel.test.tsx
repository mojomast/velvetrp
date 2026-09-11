import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorEffectsPanel } from "./ActorEffectsPanel";

afterEach(cleanup);
const effects = { effects: [{ effectId: "effect-1", source: null, modifiers: [{ kind: "flat" as const, amount: -2, appliesToId: "guard" }],
  duration: { kind: "rounds" as const, remaining: 3 }, recovery: "none" as const, stacking: "coexists" as const, appliedAt: "2030-01-01T00:00:00.000Z" }], concentration: [], revision: 5 };

describe("ActorEffectsPanel", () => {
  it("applies a bounded modifier with duration, recovery, and stacking", () => {
    const onApply = vi.fn();
    render(<ActorEffectsPanel effects={null} onApply={onApply} />);
    fireEvent.click(screen.getByText("Apply a new effect"));
    fireEvent.change(screen.getByLabelText("Modifier kind"), { target: { value: "flat" } });
    fireEvent.change(screen.getByLabelText("Applies to ID"), { target: { value: "guard" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "-2" } });
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "rounds" } });
    fireEvent.change(screen.getByLabelText("Rounds"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Recovery"), { target: { value: "short_rest" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply effect" }));
    expect(onApply).toHaveBeenCalledWith({ kind: "apply", effect: { source: null, modifiers: [{ kind: "flat", amount: -2, appliesToId: "guard" }],
      duration: { kind: "rounds", remaining: 3 }, recovery: "short_rest", stacking: { kind: "coexists" } } });
  });

  it("removes and advances a listed effect", () => {
    const onRemove = vi.fn(), onAdvance = vi.fn();
    render(<ActorEffectsPanel effects={effects} onRemove={onRemove} onAdvance={onAdvance} />);
    fireEvent.click(screen.getByRole("button", { name: "Advance 1 round" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove effect-1" }));
    expect(onAdvance).toHaveBeenCalledWith("effect-1", 1);
    expect(onRemove).toHaveBeenCalledWith("effect-1");
  });
});
