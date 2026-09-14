import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncounterPlanResponse } from "@velvet/contracts";
import { EncounterBuilderPanel, type EncounterBuilderApi } from "./EncounterBuilderPanel";

afterEach(cleanup);

const response: EncounterPlanResponse = {
  candidates: [
    { id: "srd-5.1:enemy-template:goblin", name: "Goblin", challengeRating: 0.25 },
    { id: "srd-5.1:enemy-template:orc", name: "Orc", challengeRating: 0.5 },
  ],
  plan: {
    targetDifficulty: "hard", targetXp: 450, upperBound: 800,
    roster: [{ id: "srd-5.1:enemy-template:orc", challengeRating: 0.5, count: 3 }],
    rawXp: 300, adjustedXp: 600, difficulty: "hard", monsterCount: 3, legal: true, reasons: [],
  },
};

function client(overrides: Partial<EncounterBuilderApi> = {}): EncounterBuilderApi {
  return { planCampaignEncounter: vi.fn().mockResolvedValue(response), ...overrides };
}

describe("EncounterBuilderPanel", () => {
  it("plans an encounter from party levels and difficulty and renders the roster", async () => {
    const api = client();
    render(<EncounterBuilderPanel campaignId="campaign" defaultPartyLevels={[3, 3]} api={api} />);
    fireEvent.change(screen.getByLabelText(/Party levels/), { target: { value: "3, 3, 3" } });
    fireEvent.change(screen.getByLabelText(/Target difficulty/), { target: { value: "hard" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan encounter" }));
    await waitFor(() => expect(api.planCampaignEncounter).toHaveBeenCalledWith("campaign", { partyLevels: [3, 3, 3], targetDifficulty: "hard" }));
    expect(await screen.findByText(/Resulting difficulty:/)).toBeTruthy();
    expect(screen.getByText("Orc ×3 (CR 0.5)")).toBeTruthy();
    expect(screen.getByLabelText("Encounter plan")).toBeTruthy();
  });

  it("surfaces planning errors without discarding the form", async () => {
    const api = client({ planCampaignEncounter: vi.fn().mockRejectedValue(new Error("Campaign not found")) });
    render(<EncounterBuilderPanel campaignId="campaign" api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan encounter" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Campaign not found");
    expect(screen.queryByLabelText("Encounter plan")).toBeNull();
  });
});
