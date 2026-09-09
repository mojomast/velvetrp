import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignDicePanel, type CampaignDiceApi } from "./CampaignDicePanel";

const history = { characters: [{ position: 1, name: "Aria" }, { position: 2, name: "Borin" }], rolls: [{ character: { position: 2, name: "Borin" }, occurredAt: "2030-01-01T00:00:00.000Z", result: { expression: "2d20kh1+3", normalized: { count: 2, sides: 20, selection: { type: "keep_highest" as const, count: 1 } }, terms: [{ value: 17, kept: true }, { value: 4, kept: false }], modifier: 3, total: 20 } }] };

describe("CampaignDicePanel", () => {
  afterEach(cleanup);

  it("renders named authoritative physical terms, modifier, total, and history without rolling", async () => {
    const api: CampaignDiceApi = { getCampaignDiceHistory: vi.fn().mockResolvedValue(history), rollCampaignDice: vi.fn() };
    render(<CampaignDicePanel campaignId="campaign" api={api} canView canRoll actorNames={["Aria", "Borin"]} />);
    expect((await screen.findAllByText("Borin")).length).toBeGreaterThan(0);
    expect(screen.getByText("2d20kh1+3")).toBeTruthy();
    expect(screen.getByText("17 (kept)")).toBeTruthy();
    expect(screen.getByText("4 (discarded)")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    expect(api.rollCampaignDice).not.toHaveBeenCalled();
  });

  it("fails closed and never reads or writes without capability", () => {
    const api: CampaignDiceApi = { getCampaignDiceHistory: vi.fn(), rollCampaignDice: vi.fn() };
    render(<CampaignDicePanel campaignId="campaign" api={api} canView={false} canRoll={false} actorNames={[]} />);
    expect(screen.getByText(/not authorized for this role/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll dice" })).toBeNull();
    expect(api.getCampaignDiceHistory).not.toHaveBeenCalled();
    expect(api.rollCampaignDice).not.toHaveBeenCalled();
  });

  it("rolls only on explicit submission and reconciles by GET", async () => {
    const api: CampaignDiceApi = { getCampaignDiceHistory: vi.fn().mockResolvedValue(history), rollCampaignDice: vi.fn().mockResolvedValue({ roll: history.rolls[0] }) };
    render(<CampaignDicePanel campaignId="campaign" api={api} canView canRoll actorNames={["Aria"]} selectedActorName="Aria" />);
    await screen.findByRole("button", { name: "Roll dice" });
    expect(api.rollCampaignDice).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Dice expression"), { target: { value: "1d20+2" } });
    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    await waitFor(() => expect(api.rollCampaignDice).toHaveBeenCalledWith("campaign", { character: { position: 1, name: "Aria" }, expression: "1d20+2" }));
    await waitFor(() => expect(api.getCampaignDiceHistory).toHaveBeenCalledTimes(2));
  });
});
