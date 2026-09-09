import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlayHelp } from "./PlayHelp";

afterEach(cleanup);
describe("PlayHelp", () => {
  it("covers supported gameplay and states orchestration and editing limits", () => {
    render(<PlayHelp />);
    expect(screen.getAllByRole("article")).toHaveLength(17);
    for (const name of ["Local movement: preview, then confirm", "World travel is not a local move", "Dice at the table", "Character, inventory, and powers", "NPCs, quests, and the field journal", "Combat and legal actions", "Rest and recovery", "Rewards and receipts", "Permissions and unavailable controls", "Interrupted or uncertain operations", "What the adventure agents can and cannot do"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getByText(/no client-side autonomous GM/)).toBeTruthy();
    expect(screen.getByText(/at most two configured-provider calls: planning and narration/)).toBeTruthy();
    expect(screen.getByText(/GM privately approves or rejects the exact proposal/)).toBeTruthy();
    expect(screen.getByText(/actual equip, unequip, consume, drop, and gift commands/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Advancement without leaving the table" })).toBeTruthy();
  });
  it("searches multiple words regardless of case and reports empty results", () => {
    render(<PlayHelp />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "PREVIEW confirm" } });
    expect(screen.getByRole("heading", { name: "Local movement: preview, then confirm" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nonexistent-feature" } });
    expect(screen.getByText("0 topics")).toBeTruthy();
    expect(screen.getByText(/No matching topics/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getAllByRole("article")).toHaveLength(17);
  });
});
