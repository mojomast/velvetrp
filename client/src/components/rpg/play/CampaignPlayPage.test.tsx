import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import { CampaignPlayPage, type CampaignPlayApi } from "./CampaignPlayPage";

const bootstrap = { campaignId: "campaign", sessionId: "session", expectedRevision: 7, session: { attached: true as const, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true }, principal: { role: "player" as const, control: "controlled" as const }, playableActors: [{ actorId: "actor", name: "Aria" }] };
function api(): CampaignPlayApi {
  return { getCampaignPlayBootstrap: vi.fn().mockResolvedValue(bootstrap), streamAdventureTurn: vi.fn().mockImplementation(() => ({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() })), getAdventureTurn: vi.fn(), reconcileInitialAdventureTurn: vi.fn(), confirmAdventureTurn: vi.fn(), getCampaignCommandReceipt: vi.fn(),
    getCampaignWorld: vi.fn().mockResolvedValue({ revision: 0, data: { currentLocations: [], visibleLocations: [], visibleConnections: [] } }), listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 0, data: { npcs: [] } }), listCampaignQuests: vi.fn().mockResolvedValue({ revision: 0, data: { quests: [], objectives: [] } }), getActorResources: vi.fn().mockResolvedValue({ resources: [], revision: 0 }), listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn() };
}

describe("CampaignPlayPage", () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  it("uses bootstrap revision and streams an initial declaration exactly once", async () => {
    localStorage.clear(); const client = api(); vi.mocked(client.getCampaignPlayBootstrap)
      .mockResolvedValueOnce(bootstrap).mockResolvedValueOnce({ ...bootstrap, expectedRevision: 9 });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Existing Chat child</div></CampaignPlayPage>);
    await screen.findByText("Existing Chat child"); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "initial", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I listen", expectedRevision: 9 });
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toContain("I listen");
  });

  it("reconciles a persisted turn by GET without replaying its declaration", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "private declaration", state: "completed", revision: 2, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "none" }, receipts: [], narrationStatus: { status: "completed", text: "Fallback narration" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    await screen.findByText("Fallback narration"); expect(client.getAdventureTurn).toHaveBeenCalledWith("turn", { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "turn" }); expect(client.streamAdventureTurn).not.toHaveBeenCalled(); expect(screen.getByText(/does not identify whether narration used a fallback/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Swipe narration" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledWith(expect.objectContaining({ kind: "narration-swipe", priorTurnId: "turn", expectedRevision: 7 }), expect.any(Function)));
  });

  it("uses the App turn locator before local fallback and reconnects only with a recovered token", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "local-old", selectedActorId: "actor", streamPhase: "ambiguous" }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "nav-turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "Listen", state: "confirmed", revision: 3, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "decided", decisions: [{ proposalId: "proposal", decision: "approved", decidedAt: "2030-01-01T00:00:00.000Z" }] }, receipts: [], narrationStatus: { status: "none", text: null }, resumeToken: "v1.dHVybg.ZGlnZXN0" });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} initialTurnId="nav-turn" initialSelectedActorId="actor" api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    await waitFor(() => expect(client.getAdventureTurn).toHaveBeenCalledWith("nav-turn", expect.objectContaining({ turnId: "nav-turn" })));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledWith({ kind: "resume", resumeToken: "v1.dHVybg.ZGlnZXN0", expected: { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "nav-turn", priorTurnId: null } }, expect.any(Function)));
    expect(client.getAdventureTurn).not.toHaveBeenCalledWith("local-old", expect.anything());
  });

  it("offers exact pre-turn reconciliation, keeps null ambiguous, and never replays declaration", async () => {
    localStorage.clear(); const locator = { campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "locked-key" };
    localStorage.setItem("velvet.campaign-play-submit.v1:campaign:session", JSON.stringify(locator));
    const client = api(); vi.mocked(client.reconcileInitialAdventureTurn).mockResolvedValue(null);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile submitted declaration" }));
    await screen.findByText(/race is still possible/); expect(client.reconcileInitialAdventureTurn).toHaveBeenCalledWith(locator);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled(); expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toBeNull();
  });

  it("clears a known pre-commit stale lock and requires explicit resubmission", async () => {
    localStorage.clear(); const client = api(); vi.mocked(client.streamAdventureTurn).mockImplementation(() => {
      const failure = new ApiError(409, "stale"); return { turnId: Promise.reject(failure), done: Promise.reject(failure), cancelDelivery: vi.fn() };
    });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    await screen.findByText("Chat"); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await screen.findByText(/submit the declaration again explicitly/); expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).toBeNull();
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1); expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(3);
  });

  it("aborts delivery and clears safe play state when authorization generation remounts without capability", async () => {
    localStorage.clear(); const first = api(); const cancelDelivery = vi.fn(); vi.mocked(first.streamAdventureTurn).mockReturnValue({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery });
    const props = { campaignId: "campaign", sessionId: "session", api: first, onBack: vi.fn(), onUnavailable: vi.fn() };
    const { rerender } = render(<CampaignPlayPage key={1} {...props} authorizationGeneration={1}><div>Chat</div></CampaignPlayPage>);
    await screen.findByText("Chat"); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(first.streamAdventureTurn).toHaveBeenCalled());
    const downgraded = api(); vi.mocked(downgraded.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [], session: { ...bootstrap.session, adventureEligible: false } });
    rerender(<CampaignPlayPage key={2} {...props} api={downgraded} authorizationCanAct={false} authorizationGeneration={2}><div>Chat</div></CampaignPlayPage>);
    expect(cancelDelivery).toHaveBeenCalled(); await waitFor(() => expect(localStorage.getItem("velvet.campaign-play.v1:campaign:session")).toBeNull());
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).toBeNull(); expect(downgraded.streamAdventureTurn).not.toHaveBeenCalled();
  });
  it("moves stopped live delivery to GET-safe reconciliation instead of remaining streaming",async()=>{
    localStorage.clear();const client=api();const cancelDelivery=vi.fn();vi.mocked(client.streamAdventureTurn).mockReturnValue({turnId:Promise.resolve("turn"),done:new Promise<void>(()=>undefined),cancelDelivery});
    vi.mocked(client.getAdventureTurn).mockReturnValue(new Promise(()=>undefined));render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()}><div>Chat</div></CampaignPlayPage>);
    await screen.findByText("Chat");fireEvent.change(screen.getByLabelText("What do you do?"),{target:{value:"I listen"}});fireEvent.click(screen.getByRole("button",{name:"Declare action"}));
    fireEvent.click(await screen.findByRole("button",{name:"Stop receiving live updates"}));expect(cancelDelivery).toHaveBeenCalled();await screen.findByText("ambiguous");
    expect(client.getAdventureTurn).toHaveBeenCalledWith("turn",expect.objectContaining({campaignId:"campaign",sessionId:"session",actorId:"actor"}));
    expect(screen.getByRole("button", { name: "Reconcile known turn" })).toBeTruthy();
  });
});
