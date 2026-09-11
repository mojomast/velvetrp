import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorChecksPanel } from "./ActorChecksPanel";

afterEach(cleanup);

describe("ActorChecksPanel", () => {
  it("submits a skill check intent with the chosen difficulty and never a total", () => {
    const onSubmit = vi.fn();
    render(<ActorChecksPanel onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Check kind"), { target: { value: "skill" } });
    fireEvent.change(screen.getByLabelText("Skill or attribute ID"), { target: { value: "stealth" } });
    fireEvent.change(screen.getByLabelText("Difficulty"), { target: { value: "hard" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve check" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "skill", skillOrAttribute: "stealth", difficultyRef: "hard" });
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("total");
  });

  it("requires an exact target for an opposed check", () => {
    const onSubmit = vi.fn();
    render(<ActorChecksPanel onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Check kind"), { target: { value: "opposed" } });
    fireEvent.change(screen.getByLabelText("Skill or attribute ID"), { target: { value: "insight" } });
    expect((screen.getByRole("button", { name: "Resolve check" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Target actor ID"), { target: { value: "actor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve check" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "opposed", skillOrAttribute: "insight", targetActorId: "actor-2" });
  });

  it("renders the authoritative outcome and revision", () => {
    render(<ActorChecksPanel result={{ check: { terms: [], modifier: 2, total: 14, target: { kind: "difficulty_class", value: 12 }, outcome: "success" },
      receipt: { idempotencyKey: "k", revisionBefore: 3, revisionAfter: 4, occurredAt: "2030-01-01T00:00:00.000Z" } }} />);
    expect(screen.getByText("success")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("3 → 4")).toBeTruthy();
  });
});
