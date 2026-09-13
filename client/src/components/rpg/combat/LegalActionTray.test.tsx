import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CombatLegalAction } from "@velvet/contracts";
import { LegalActionTray } from "./LegalActionTray";

const action = (kind: string, targetIds: string[] = []) => ({ legalActionId: `${kind}:1`, kind, actingCombatantId: "actor", targetIds, cost: "action" }) as unknown as CombatLegalAction;

describe("LegalActionTray utility actions", () => {
  afterEach(cleanup);

  it("renders the server-supported utility actions", () => {
    const actions = [action("grapple", ["enemy"]), action("escape-grapple", ["actor"]), action("shove", ["enemy"]), action("help", ["ally"]), action("hide"), action("dash"), action("disengage")];
    render(<LegalActionTray legalActions={actions} combatantLabels={new Map([["enemy", "Goblin"], ["ally", "Aria"], ["actor", "Hero"]])} onSubmit={vi.fn()} />);
    for (const label of ["Grapple", "Escape grapple", "Shove", "Help", "Hide", "Dash", "Disengage"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("requires and submits the exact target for grapple", () => {
    const onSubmit = vi.fn();
    render(<LegalActionTray legalActions={[action("grapple", ["enemy"])]} combatantLabels={new Map([["enemy", "Goblin"]])} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Grapple" }));
    expect((screen.getByRole("button", { name: "Review action" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: "grapple" }), ["enemy"]);
  });

  it("submits a no-target utility action without a target", () => {
    const onSubmit = vi.fn();
    render(<LegalActionTray legalActions={[action("hide")]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: "hide" }), []);
  });
});
