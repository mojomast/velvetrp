import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CharacterForm } from "./CharacterForm";

describe("CharacterForm persona profile", () => {
  it("progressively reveals optional fields with visible help and submits the profile", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<CharacterForm onCancel={() => undefined} onSave={onSave} />);

    const depth = screen.getByText("Character depth (optional)").closest("details") as HTMLDetailsElement;
    expect(depth.open).toBe(false);
    fireEvent.click(screen.getByText("Character depth (optional)"));
    expect(depth.open).toBe(true);
    expect(screen.getByText(/leave every field blank/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Find a home" } });
    const advanced = screen.getByText("Advanced details (optional)").closest("details") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    fireEvent.click(screen.getByText("Advanced details (optional)"));
    expect(advanced.open).toBe(true);
    expect(screen.getByText(/richer continuity/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Voice"), { target: { value: "Measured and quiet" } });

    fireEvent.change(screen.getByLabelText("Character name"), { target: { value: "Mara" } });
    fireEvent.change(screen.getByLabelText("Age (18+)"), { target: { value: "32" } });
    fireEvent.change(screen.getByLabelText("Archetype / vibe"), { target: { value: "Confidant" } });
    fireEvent.change(screen.getByLabelText("Boundaries & hard limits"), { target: { value: "No cruelty" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save to library" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ goal: "Find a home", voice: "Measured and quiet", history: "" }),
    }), false);
  });
});
