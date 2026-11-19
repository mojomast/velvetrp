import { fireEvent, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionZeroSafetyPanel, type SessionZeroSafetyApi, type SessionZeroSafetySettings } from "./SessionZeroSafetyPanel";

const settings: SessionZeroSafetySettings = { revision: 5, hardLimits: ["Harm to children"], veils: ["Body horror"], pvpPolicy: "explicit-consent", romancePolicy: "fade-to-black", lethalityPolicy: "consent-required", paused: false };
const api = (): SessionZeroSafetyApi => ({ updateSettings: vi.fn(), reconcileSettings: vi.fn(), pause: vi.fn(), resume: vi.fn(), skip: vi.fn(), rewind: vi.fn() });

let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ""; });

describe("SessionZeroSafetyPanel draft state", () => {
  it("keeps an edit made before the mount's passive effects have flushed", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    // Render outside act(), the way a data-fetch resolution renders in the app, and edit as soon as the DOM is
    // committed. The mount's passive effects are still pending then, and they must not discard the edit.
    const committed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(container, { childList: true });
    });
    root.render(<SessionZeroSafetyPanel actorRole="owner" settings={settings} api={api()} />);
    await committed;
    fireEvent.change(screen.getByLabelText(/Hard limits/), { target: { value: "Harm to children\nSpiders" } });
    expect((screen.getByLabelText(/Hard limits/) as HTMLTextAreaElement).value).toBe("Harm to children\nSpiders");
    expect(screen.getByRole("button", { name: "Review safety agreement" }).matches(":disabled")).toBe(false);
  });
});
