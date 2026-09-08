import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionZeroSafetyPanel, type SessionZeroSafetyApi, type SessionZeroSafetySettings } from "./SessionZeroSafetyPanel";

const settings: SessionZeroSafetySettings = { revision: 5, hardLimits: ["Harm to children"], veils: ["Body horror"], pvpPolicy: "explicit-consent", romancePolicy: "fade-to-black", lethalityPolicy: "consent-required", paused: false };
const api = (): SessionZeroSafetyApi => ({ updateSettings: vi.fn(), reconcileSettings: vi.fn(), pause: vi.fn(), resume: vi.fn(), skip: vi.fn(), rewind: vi.fn() });

afterEach(cleanup);

describe("SessionZeroSafetyPanel", () => {
  it("keeps pause, skip, and rewind visible and available to players while disabling agreement edits", () => {
    const callbacks = api();
    render(<SessionZeroSafetyPanel actorRole="player" settings={settings} api={callbacks} />);
    for (const action of ["pause", "skip", "rewind"] as const) {
      fireEvent.click(screen.getByRole("button", { name: `Review ${action}` }));
      fireEvent.click(screen.getByRole("checkbox", { name: `Confirm this exact ${action} request` }));
      fireEvent.click(screen.getByRole("button", { name: `Submit ${action} once` }));
    }
    expect(callbacks.pause).toHaveBeenCalledOnce();
    expect(callbacks.skip).toHaveBeenCalledOnce();
    expect(callbacks.rewind).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/Hard limits/).matches(":disabled")).toBe(true);
  });

  it("reviews and submits the complete revision-bound agreement", () => {
    const callbacks = api();
    render(<SessionZeroSafetyPanel actorRole="gm" settings={settings} api={callbacks} />);
    fireEvent.change(screen.getByLabelText(/Hard limits/), { target: { value: "Harm to children\nSpiders" } });
    fireEvent.change(screen.getByLabelText(/Player-versus-player/), { target: { value: "disallowed" } });
    fireEvent.click(screen.getByRole("button", { name: "Review safety agreement" }));
    expect((screen.getByRole("button", { name: "Save safety agreement once" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this complete revision-bound/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save safety agreement once" }));
    expect(callbacks.updateSettings).toHaveBeenCalledWith({ hardLimits: ["Harm to children", "Spiders"], veils: ["Body horror"], pvpPolicy: "disallowed", romancePolicy: "fade-to-black", lethalityPolicy: "consent-required", expectedRevision: 5 });
  });

  it("enforces boundary limits and reconciles uncertain outcomes without resubmitting", () => {
    const callbacks = api();
    render(<SessionZeroSafetyPanel actorRole="owner" settings={settings} mutation={{ phase: "uncertain" }} api={callbacks} />);
    fireEvent.change(screen.getByLabelText(/Hard limits/), { target: { value: "x".repeat(201) } });
    expect(screen.getByText(/Use no more than 32 hard limits/).textContent).toMatch(/no more than 32/);
    expect((screen.getByRole("button", { name: "Review safety agreement" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile safety agreement" }));
    expect(callbacks.reconcileSettings).toHaveBeenCalledOnce();
    expect(callbacks.updateSettings).not.toHaveBeenCalled();
  });
});
