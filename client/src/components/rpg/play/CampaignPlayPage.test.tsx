import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignPlayPage, type CampaignPlayApi } from "./CampaignPlayPage";

const bootstrap = { campaignId: "campaign", sessionId: "session", expectedRevision: 7, session: { attached: true as const, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true }, principal: { role: "player" as const, control: "controlled" as const }, playableActors: [{ actorId: "actor", name: "Aria" }] };
function api(): CampaignPlayApi {
  return { getCampaignPlayBootstrap: vi.fn().mockResolvedValue(bootstrap), streamAdventureTurn: vi.fn().mockImplementation(() => ({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() })), getAdventureTurn: vi.fn(), confirmAdventureTurn: vi.fn(), getCampaignCommandReceipt: vi.fn(),
    getCampaignWorld: vi.fn().mockResolvedValue({ revision: 0, data: { currentLocations: [], visibleLocations: [], visibleConnections: [] } }), listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 0, data: { npcs: [] } }), listCampaignQuests: vi.fn().mockResolvedValue({ revision: 0, data: { quests: [], objectives: [] } }), getActorResources: vi.fn().mockResolvedValue({ resources: [], revision: 0 }), listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn() };
}

describe("CampaignPlayPage", () => {
  it("uses bootstrap revision and streams an initial declaration exactly once", async () => {
    localStorage.clear(); const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Existing Chat child</div></CampaignPlayPage>);
    await screen.findByText("Existing Chat child"); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "initial", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I listen", expectedRevision: 7 });
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toContain("I listen");
  });

  it("reconciles a persisted turn by GET without replaying its declaration", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "private declaration", state: "completed", revision: 2, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "none" }, receipts: [], narrationStatus: { status: "completed", text: "Fallback narration" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    await screen.findByText("Fallback narration"); expect(client.getAdventureTurn).toHaveBeenCalledWith("turn"); expect(client.streamAdventureTurn).not.toHaveBeenCalled(); expect(screen.getByText(/server fallback\/no-tools/)).toBeTruthy();
  });
});
