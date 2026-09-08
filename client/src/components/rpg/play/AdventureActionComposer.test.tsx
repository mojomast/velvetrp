import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureActionComposer } from "./AdventureActionComposer";

describe("AdventureActionComposer", () => {
  afterEach(cleanup);
  it("submits a trimmed declaration for the exact selected server actor", () => {
    const submit = vi.fn(); const change = vi.fn();
    const common = { actors: [{ actorId: "actor", name: "Aria" }], selectedActorId: "actor", role: "player" as const,
      eligible: true, inactive: false, phase: "ready" as const, onActorChange: vi.fn(), onSubmit: submit, onDeclarationChange: change };
    const { rerender } = render(<AdventureActionComposer {...common} declaration="" />);
    fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "  I listen  " } });
    expect(change).toHaveBeenCalledWith("  I listen  "); rerender(<AdventureActionComposer {...common} declaration="  I listen  " />);
    fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    expect(submit).toHaveBeenCalledWith("I listen");
  });

  it.each(["observer", "inactive", "ambiguous"] as const)("keeps declarations disabled for %s state", (state) => {
    render(<AdventureActionComposer actors={[{ actorId: "actor", name: "Aria" }]} selectedActorId="actor"
      role={state === "observer" ? "observer" : "player"} eligible inactive={state === "inactive"}
      phase={state === "ambiguous" ? "ambiguous" : "ready"} declaration="" onDeclarationChange={vi.fn()} onActorChange={vi.fn()} onSubmit={vi.fn()} />);
    expect((screen.getByLabelText("What do you do?") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(state === "observer" ? /read-only/ : state === "inactive" ? /inactive/ : /uncertain/);
  });
});
