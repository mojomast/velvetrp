import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FreeformFactionHttpResponse, type FreeformQuestHttpResponse, type FreeformRumorHttpResponse } from "../../../api";
import { FreeformSeekPanel, type FreeformSeekApi } from "./FreeformSeekPanel";

afterEach(cleanup);

const factionResponse: FreeformFactionHttpResponse = {
  classification: { intent: "materialize-faction", factionName: "Ashen Circle",
    candidates: [{ candidateId: "ffac-1", factionKey: "ff-faction-1", gmAgendaKey: "ff-agenda-1", name: "Ashen Circle",
      archetype: "order", description: "A quiet order.", gmAgenda: "secret agenda", visibility: "public" }] },
  materialization: { status: "materialized",
    candidate: { candidateId: "ffac-1", factionKey: "ff-faction-1", gmAgendaKey: "ff-agenda-1", name: "Ashen Circle", visibility: "public" },
    factionId: "ff-faction-1", draftId: "draft-1", contentReceiptId: "receipt-1", gmAgendaArtifactKey: "ff-agenda-1" },
};
const questDeclined: FreeformQuestHttpResponse = { classification: { intent: "none", reason: "known-quest" } };
const rumorResponse: FreeformRumorHttpResponse = {
  classification: { intent: "materialize-rumor", subject: "the drowned bell",
    candidates: [{ candidateId: "ffrc-1", hearsayKey: "ff-rumor-hearsay-1", truthKey: "ff-rumor-truth-1", locationKey: "gate",
      subject: "the drowned bell", source: "a dockhand", publicText: "They say the bell tolls beneath the tide.",
      gmTruth: "It is a signal.", templateId: "drowned-bell", visibility: "public" }] },
  materialization: { status: "materialized",
    candidate: { candidateId: "ffrc-1", hearsayKey: "ff-rumor-hearsay-1", truthKey: "ff-rumor-truth-1", subject: "the drowned bell",
      source: "a dockhand", publicText: "They say the bell tolls beneath the tide.", visibility: "public" },
    rumorId: "ff-rumor-hearsay-1", draftId: "draft-2", contentReceiptId: "receipt-2", gmTruthArtifactKey: "ff-rumor-truth-1" },
};

function apiMock(overrides: Partial<FreeformSeekApi> = {}): FreeformSeekApi {
  return { seekFaction: vi.fn(), seekQuest: vi.fn(), seekRumor: vi.fn(), ...overrides };
}

function renderPanel(api: FreeformSeekApi, audience: "gm" | "player" = "gm", actorId: string | null = "actor") {
  return render(<FreeformSeekPanel campaignId="campaign" sessionId="session" actorId={actorId} audience={audience} api={api} />);
}

describe("FreeformSeekPanel", () => {
  it("calls the faction route once with the entered text and surfaces the materialized result", async () => {
    const api = apiMock({ seekFaction: vi.fn().mockResolvedValue(factionResponse) });
    renderPanel(api);
    expect(api.seekFaction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What to seek"), { target: { value: "the ashen circle" } });
    fireEvent.click(screen.getByRole("button", { name: "Seek faction" }));
    await screen.findByText(/Materialized faction "Ashen Circle"/);
    expect(api.seekFaction).toHaveBeenCalledTimes(1);
    expect(api.seekFaction).toHaveBeenCalledWith("campaign", "session", "actor", { text: "the ashen circle" });
    expect(api.seekQuest).not.toHaveBeenCalled();
    expect(api.seekRumor).not.toHaveBeenCalled();
  });

  it("surfaces a decline reason and does not retry", async () => {
    const api = apiMock({ seekQuest: vi.fn().mockResolvedValue(questDeclined) });
    renderPanel(api);
    fireEvent.change(screen.getByLabelText("Mechanic to seek"), { target: { value: "quest" } });
    fireEvent.change(screen.getByLabelText("What to seek"), { target: { value: "work at the docks" } });
    fireEvent.click(screen.getByRole("button", { name: "Seek quest" }));
    await screen.findByText(/already known canon/);
    expect(api.seekQuest).toHaveBeenCalledTimes(1);
    expect(api.seekFaction).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Seek quest" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("seeks a rumor through its own lane and surfaces the materialized subject", async () => {
    const api = apiMock({ seekRumor: vi.fn().mockResolvedValue(rumorResponse) });
    renderPanel(api);
    fireEvent.change(screen.getByLabelText("Mechanic to seek"), { target: { value: "rumor" } });
    fireEvent.change(screen.getByLabelText("What to seek"), { target: { value: "the drowned bell" } });
    fireEvent.click(screen.getByRole("button", { name: "Seek rumor" }));
    await screen.findByText(/Materialized rumor "the drowned bell"/);
    expect(api.seekRumor).toHaveBeenCalledTimes(1);
    expect(api.seekRumor).toHaveBeenCalledWith("campaign", "session", "actor", { text: "the drowned bell" });
  });

  it("surfaces a transport failure without retrying", async () => {
    const api = apiMock({ seekFaction: vi.fn().mockRejectedValue(new ApiError(409, "conflict")) });
    renderPanel(api);
    fireEvent.change(screen.getByLabelText("What to seek"), { target: { value: "a new order" } });
    fireEvent.click(screen.getByRole("button", { name: "Seek faction" }));
    await screen.findByText(/conflicts with current campaign state/);
    expect(api.seekFaction).toHaveBeenCalledTimes(1);
  });

  it("is hidden for players and fires no command on mount", () => {
    const api = apiMock({ seekFaction: vi.fn().mockResolvedValue(factionResponse) });
    const view = renderPanel(api, "player");
    expect(view.container.textContent).toBe("");
    expect(api.seekFaction).not.toHaveBeenCalled();
    expect(api.seekQuest).not.toHaveBeenCalled();
    expect(api.seekRumor).not.toHaveBeenCalled();
  });
});
