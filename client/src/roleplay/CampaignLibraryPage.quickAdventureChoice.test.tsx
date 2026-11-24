// Approved test (Hermes/Nous quick adventure): the campaign library lets the player pick which bundled quick
// adventure to build; Sintermark stays the default and the choice is sent as adventureId.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuickAdventure, getCampaignAdministration, listCampaigns } from "../api";
import { CampaignLibraryPage } from "./CampaignLibraryPage";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCampaigns: vi.fn(),
  createCampaign: vi.fn(),
  getCampaignAdministration: vi.fn(),
  createQuickAdventure: vi.fn(),
}));

const built = {
  campaignId: "quick-campaign",
  campaignName: "Hermes Agent Squad: We Never Surrender",
  sessionId: "quick-room",
  actorId: "quick-actor",
  replayed: false,
};

function setup() {
  vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [] });
  vi.mocked(getCampaignAdministration).mockRejectedValue(new Error("unused"));
  vi.mocked(createQuickAdventure).mockResolvedValue(built);
  const onOpen = vi.fn();
  render(<CampaignLibraryPage onBack={vi.fn()} onOpen={onOpen} />);
  return {
    onOpen,
    picker: () => screen.getByRole("combobox", { name: /quick adventure world/i }) as HTMLSelectElement,
    button: () => screen.getByRole("button", { name: /quick adventure/i }),
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("CampaignLibraryPage quick adventure choice", () => {
  it("offers both bundled worlds with Sintermark selected by default", () => {
    const { picker } = setup();
    const options = Array.from(picker().options);
    expect(options.map((option) => option.value)).toEqual(["sintermark", "hermes-nous"]);
    expect(options[1]!.textContent).toContain("Hermes Agent Squad: We Never Surrender");
    expect(picker().value).toBe("sintermark");
  });

  it("sends the chosen world as adventureId and opens the new campaign", async () => {
    const { onOpen, picker, button } = setup();
    fireEvent.change(picker(), { target: { value: "hermes-nous" } });
    fireEvent.click(button());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("quick-campaign", "play"));
    const [request] = vi.mocked(createQuickAdventure).mock.calls[0]!;
    expect(request.adventureId).toBe("hermes-nous");
    expect(request.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it("sends sintermark when the default is kept", async () => {
    const { onOpen, button } = setup();
    fireEvent.click(button());
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(vi.mocked(createQuickAdventure).mock.calls[0]![0].adventureId).toBe("sintermark");
  });
});
