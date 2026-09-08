import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import { CampaignPlayPage, type CampaignPlayApi } from "./CampaignPlayPage";

const bootstrap = { campaignId: "campaign", sessionId: "session", expectedRevision: 7, session: { attached: true as const, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true }, principal: { role: "player" as const, control: "controlled" as const }, playableActors: [{ actorId: "actor", name: "Aria" }] };
const sheet = { identity: { actorId: "actor", name: "Aria" }, race: { reference: { kind: "race" as const, packId: "pack", packVersion: "1", definitionId: "human" }, label: "Human" }, background: { reference: { kind: "background" as const, packId: "pack", packVersion: "1", definitionId: "guide" }, label: "Guide" }, classes: [{ reference: { kind: "class" as const, packId: "pack", packVersion: "1", definitionId: "ranger" }, label: "Ranger", level: 1 }], attributes: [], proficiencies: [], choices: [], derived: { maxHp: 10, defenses: { guard: 10, evasion: 11, will: 12 }, initiative: 1, speed: 30, carryingLimit: 100, spellAttack: 2, saveDc: 10, explanations: (["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"] as const).map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 1 })) }, progression: { mode: "xp" as const, level: 1, totalXp: 0, milestoneCount: 0, pendingChoiceCount: 0, updatedAt: "2030-01-01T00:00:00.000Z" }, resources: [], inventory: { capacity: 10, items: [{ entryId: "rope", item: { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "rope" }, label: "Moonlit rope", quantity: 1, equippedSlot: null }] }, knownPowers: [{ power: { kind: "spell" as const, packId: "pack", packVersion: "1", definitionId: "spent" }, label: "Spent Ward", available: false, unavailableReasons: ["spell-slot-unavailable" as const] }], activeEffects: [] };
function api(): CampaignPlayApi {
  return { getCampaignPlayBootstrap: vi.fn().mockResolvedValue(bootstrap), getAdventureTurnTranscript: vi.fn().mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [] }), streamAdventureTurn: vi.fn().mockImplementation(() => ({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() })), getAdventureTurn: vi.fn(), reconcileInitialAdventureTurn: vi.fn(), confirmAdventureTurn: vi.fn(), getCampaignCommandReceipt: vi.fn(),
    getCampaignWorld: vi.fn().mockResolvedValue({ revision: 0, data: { currentLocations: [], visibleLocations: [], visibleConnections: [] } }), listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 0, data: { npcs: [] } }), listCampaignQuests: vi.fn().mockResolvedValue({ revision: 0, data: { quests: [], objectives: [] } }), getActorResources: vi.fn().mockResolvedValue({ resources: [], revision: 0 }), getActorInventory: vi.fn().mockResolvedValue({ entries: [], equipment: [], capacity: 10, revision: 0 }), getActorEffects: vi.fn().mockResolvedValue({ effects: [], revision: 0 }), getActorGameplaySheet: vi.fn().mockResolvedValue(sheet), listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn() };
}

describe("CampaignPlayPage", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
  });
  afterEach(() => { cleanup(); localStorage.clear(); });
  it("uses bootstrap revision and streams an initial declaration exactly once", async () => {
    localStorage.clear(); const client = api(); vi.mocked(client.getCampaignPlayBootstrap)
      .mockResolvedValueOnce(bootstrap).mockResolvedValueOnce({ ...bootstrap, expectedRevision: 9 });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "initial", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I listen", expectedRevision: 9 });
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toContain("I listen");
  });

  it("persists workbench preferences and supports keyboard pane controls", async () => {
    const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/);
    fireEvent.click(screen.getByRole("button", { name: "Campaign workbench preferences" }));
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "contrast" } });
    fireEvent.change(screen.getByLabelText("Layout density"), { target: { value: "compact" } });
    fireEvent.click(screen.getByLabelText("Present cast"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.campaign-workbench.v1") ?? "{}")).toMatchObject({ theme: "contrast", density: "compact", widgets: ["location", "objectives", "resources", "encounter"] }));
    expect(document.documentElement.dataset.theme).toBe("contrast");
    (screen.getByRole("dialog", { name: "Campaign workbench" }) as HTMLDialogElement).close();
    fireEvent.keyDown(window, { key: "F6" });
    expect(document.activeElement).toBe(document.getElementById("campaign-context-panel"));
    fireEvent.keyDown(window, { key: "F6" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Campaign narration and actions" }));
    const separator = screen.getByRole("separator", { name: "Resize campaign context" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("520");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(screen.queryByRole("complementary", { name: "Campaign context" })).toBeNull();
  });

  it("reconciles a persisted turn by GET without replaying its declaration", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "private declaration", state: "completed", revision: 2, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "none" }, receipts: [], narrationStatus: { status: "completed", text: "Fallback narration", source: "deterministic-fallback" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText("Fallback narration"); expect(client.getAdventureTurn).toHaveBeenCalledWith("turn", { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "turn" }); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Swipe narration" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledWith(expect.objectContaining({ kind: "narration-swipe", priorTurnId: "turn", expectedRevision: 7 }), expect.any(Function)));
  });

  it("uses the App turn locator before local fallback and reconnects only with a recovered token", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "local-old", selectedActorId: "actor", streamPhase: "ambiguous" }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "nav-turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "Listen", state: "confirmed", revision: 3, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "decided", decisions: [{ proposalId: "proposal", decision: "approved", decidedAt: "2030-01-01T00:00:00.000Z" }] }, receipts: [], narrationStatus: { status: "none", text: null, source: null }, resumeToken: "v1.dHVybg.ZGlnZXN0" });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} initialTurnId="nav-turn" initialSelectedActorId="actor" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await waitFor(() => expect(client.getAdventureTurn).toHaveBeenCalledWith("nav-turn", expect.objectContaining({ turnId: "nav-turn" })));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledWith({ kind: "resume", resumeToken: "v1.dHVybg.ZGlnZXN0", expected: { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "nav-turn", priorTurnId: null } }, expect.any(Function)));
    expect(client.getAdventureTurn).not.toHaveBeenCalledWith("local-old", expect.anything());
  });

  it("offers exact pre-turn reconciliation, keeps null ambiguous, and never replays declaration", async () => {
    localStorage.clear(); const locator = { campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "locked-key" };
    localStorage.setItem("velvet.campaign-play-submit.v1:campaign:session", JSON.stringify(locator));
    const client = api(); vi.mocked(client.reconcileInitialAdventureTurn).mockResolvedValue(null);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile submitted declaration" }));
    await screen.findByText(/race is still possible/); expect(client.reconcileInitialAdventureTurn).toHaveBeenCalledWith(locator);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled(); expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toBeNull();
  });

  it("clears a known pre-commit stale lock and requires explicit resubmission", async () => {
    localStorage.clear(); const client = api(); vi.mocked(client.streamAdventureTurn).mockImplementation(() => {
      const failure = new ApiError(409, "stale"); return { turnId: Promise.reject(failure), done: Promise.reject(failure), cancelDelivery: vi.fn() };
    });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await screen.findByText(/submit the declaration again explicitly/); expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).toBeNull();
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1); expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(3);
  });

  it("aborts delivery and clears safe play state when authorization generation remounts without capability", async () => {
    localStorage.clear(); const first = api(); const cancelDelivery = vi.fn(); vi.mocked(first.streamAdventureTurn).mockReturnValue({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery });
    const props = { campaignId: "campaign", sessionId: "session", api: first, onBack: vi.fn(), onUnavailable: vi.fn() };
    const { rerender } = render(<CampaignPlayPage key={1} {...props} authorizationGeneration={1} />);
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(first.streamAdventureTurn).toHaveBeenCalled());
    const downgraded = api(); vi.mocked(downgraded.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [], session: { ...bootstrap.session, adventureEligible: false } });
    rerender(<CampaignPlayPage key={2} {...props} api={downgraded} authorizationCanAct={false} authorizationGeneration={2} />);
    expect(cancelDelivery).toHaveBeenCalled(); await waitFor(() => expect(localStorage.getItem("velvet.campaign-play.v1:campaign:session")).toBeNull());
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).toBeNull(); expect(downgraded.streamAdventureTurn).not.toHaveBeenCalled();
  });
  it("moves stopped live delivery to GET-safe reconciliation instead of remaining streaming",async()=>{
    localStorage.clear();const client=api();const cancelDelivery=vi.fn();vi.mocked(client.streamAdventureTurn).mockReturnValue({turnId:Promise.resolve("turn"),done:new Promise<void>(()=>undefined),cancelDelivery});
    vi.mocked(client.getAdventureTurn).mockReturnValue(new Promise(()=>undefined));render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/);fireEvent.change(screen.getByLabelText("What do you do?"),{target:{value:"I listen"}});fireEvent.click(screen.getByRole("button",{name:"Declare action"}));
    fireEvent.click(await screen.findByRole("button",{name:"Stop receiving live updates"}));expect(cancelDelivery).toHaveBeenCalled();await screen.findByText("ambiguous");
    expect(client.getAdventureTurn).toHaveBeenCalledWith("turn",expect.objectContaining({campaignId:"campaign",sessionId:"session",actorId:"actor"}));
    expect(screen.getByRole("button", { name: "Reconcile known turn" })).toBeTruthy();
  });

  it("keeps the controlled draft until durable turn_started and then clears it", async () => {
    const client = api(); let receive!: Parameters<CampaignPlayApi["streamAdventureTurn"]>[1];
    vi.mocked(client.streamAdventureTurn).mockImplementation((_request, onEvent) => { receive = onEvent; return { turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() }; });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); const composer = screen.getByLabelText("What do you do?") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalled()); expect(composer.value).toBe("I listen");
    await act(async () => receive({ type: "turn_started", sequence: 0, timestamp: "2030-01-01T00:00:00.000Z", payload: { turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "I listen", state: "declared", revision: 0, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" } } }));
    expect(composer.value).toBe(""); expect(screen.getByRole("log").textContent).toContain("I listen");
  });

  it("opens the actor-bound accessible drawer and only appends/focuses until explicit declaration", async () => {
    const client = api(); render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); const composer = screen.getByLabelText("What do you do?") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "I inspect the arch." } }); const trigger = screen.getByRole("button", { name: "Open character sheet" }); fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Aria's character sheet" }); expect(drawer.getAttribute("aria-modal")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close character sheet" })));
    expect(client.getActorGameplaySheet).toHaveBeenCalledWith("actor"); fireEvent.click(screen.getByRole("button", { name: "Moonlit rope" }));
    expect(composer.value).toBe("I inspect the arch. I use Moonlit rope to "); await waitFor(() => expect(document.activeElement).toBe(composer)); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Spent Ward" })); expect(composer.value).not.toContain("Spent Ward");
    fireEvent.click(screen.getByRole("button", { name: "Close character sheet" })); await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(client.streamAdventureTurn).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Declare action" })); await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
  });

  it("owns loading and access-error drawer states without changing or submitting the draft", async () => {
    let reject!: (reason: unknown) => void; const pending = new Promise<typeof sheet>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const client = api(); vi.mocked(client.getActorGameplaySheet).mockReturnValue(pending);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "Existing draft" } }); fireEvent.click(screen.getByRole("button", { name: "Open character sheet" }));
    expect(await screen.findByRole("dialog", { name: "Opening character sheet" })).toBeTruthy(); reject(new ApiError(404, "hidden"));
    expect((await screen.findByText("This character sheet is unavailable with your current access.")).textContent).toContain("unavailable with your current access"); expect((screen.getByLabelText("What do you do?") as HTMLTextAreaElement).value).toBe("Existing draft"); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cannot start sheet references for observer, inflight, or ambiguous play", async () => {
    const observerClient = api(); vi.mocked(observerClient.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [] });
    const { unmount } = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} authorizationCanAct={false} api={observerClient} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect((await screen.findAllByText("Observer access is read-only.")).length).toBeGreaterThan(0); expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true); expect(observerClient.getActorGameplaySheet).not.toHaveBeenCalled(); unmount();

    const inflight = api(); render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={inflight} onBack={vi.fn()} onUnavailable={vi.fn()} />); await screen.findByText(/first declaration/);
    fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" })); await waitFor(() => expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true)); cleanup();

    localStorage.setItem("velvet.campaign-play-submit.v1:campaign:session", JSON.stringify({ campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "locked-key" })); const ambiguous = api(); render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={ambiguous} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("button", { name: "Reconcile submitted declaration" }); expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true); expect(ambiguous.getActorGameplaySheet).not.toHaveBeenCalled();
  });
});
