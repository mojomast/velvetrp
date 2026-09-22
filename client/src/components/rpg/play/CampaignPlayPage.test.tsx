import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdventureTurnGetResponse } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { CampaignPlayPage, type CampaignPlayApi } from "./CampaignPlayPage";
import type { RpgCharacterSheetApi } from "../actor/RpgCharacterSheetPage";
import type { StudioAuthorization } from "../StudioAuthorization";
import { resetNarrativeMutationRegistryForTests } from "../narrativeMutationRegistry";

const bootstrap = { dm: { mode: "human" as const, revision: 0 }, campaignId: "campaign", sessionId: "session", expectedRevision: 7, session: { attached: true as const, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true }, principal: { role: "player" as const, control: "controlled" as const }, capabilities: { campaignDice: { canView: false, canRoll: false } }, playableActors: [{ actorId: "actor", name: "Aria" }] };
const sheet = { identity: { actorId: "actor", name: "Aria" }, race: { reference: { kind: "race" as const, packId: "pack", packVersion: "1", definitionId: "human" }, label: "Human" }, background: { reference: { kind: "background" as const, packId: "pack", packVersion: "1", definitionId: "guide" }, label: "Guide" }, classes: [{ reference: { kind: "class" as const, packId: "pack", packVersion: "1", definitionId: "ranger" }, label: "Ranger", level: 1 }], attributes: [], proficiencies: [], choices: [], derived: { maxHp: 10, defenses: { guard: 10, evasion: 11, will: 12 }, initiative: 1, speed: 30, carryingLimit: 100, spellAttack: 2, saveDc: 10, explanations: (["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"] as const).map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 1 })) }, progression: { mode: "xp" as const, level: 1, totalXp: 0, milestoneCount: 0, pendingChoiceCount: 0, updatedAt: "2030-01-01T00:00:00.000Z" }, resources: [], inventory: { capacity: 10, items: [{ entryId: "rope", item: { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "rope" }, label: "Moonlit rope", quantity: 1, equippedSlot: null }] }, knownPowers: [{ power: { kind: "spell" as const, packId: "pack", packVersion: "1", definitionId: "spent" }, label: "Spent Ward", available: false, unavailableReasons: ["spell-slot-unavailable" as const] }], activeEffects: [] };
function api(): CampaignPlayApi {
  return { dm: { commandCampaignDmSceneBinding: vi.fn(), getBindingStory: vi.fn(), getBindingQuests: vi.fn(), listCampaignEncounters: vi.fn(), getCampaignDmHistory: vi.fn().mockResolvedValue({ control: { campaignId: "campaign", mode: "human", revision: 0 }, runs: [] }), commandCampaignDmMode: vi.fn(), commandCampaignDmBeat: vi.fn(), commandCampaignDmDecision: vi.fn(), getCampaignDmRun: vi.fn(), getCampaignDmProposal: vi.fn(), resumeCampaignDmRun: vi.fn() }, getCampaignPlayBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, dm: { mode: "human", revision: 0 } }), getAdventureTurnTranscript: vi.fn().mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [] }), streamAdventureTurn: vi.fn().mockImplementation(() => ({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() })), getAdventureTurn: vi.fn(), reconcileInitialAdventureTurn: vi.fn(), confirmAdventureTurn: vi.fn(), getCampaignCommandReceipt: vi.fn().mockRejectedValue(new Error("receipt unavailable")),
    getCampaignWorld: vi.fn().mockResolvedValue({ revision: 0, data: { currentLocations: [], visibleLocations: [], visibleConnections: [] } }), listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 0, data: { npcs: [] } }), listCampaignQuests: vi.fn().mockResolvedValue({ revision: 0, data: { quests: [], objectives: [] } }), getActorResources: vi.fn().mockResolvedValue({ resources: [], revision: 0 }), getActorGameplaySheet: vi.fn().mockResolvedValue(sheet), listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn() };
}

type CompletedTurnOverride = { mode?: "original" | "narration-retry" | "narration-swipe"; priorTurnId?: string | null;
  receipts?: AdventureTurnGetResponse["receipts"]; narrationStatus?: AdventureTurnGetResponse["narrationStatus"];
  proposals?: AdventureTurnGetResponse["proposals"]; confirmation?: AdventureTurnGetResponse["confirmation"] };

/** Completed receipt turn used by the automatic narration retry suites. */
function completedReceiptTurn(override: CompletedTurnOverride = {}): AdventureTurnGetResponse {
  return { turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: override.mode ?? "original",
    priorTurnId: override.priorTurnId ?? null, declaration: "I search the archive.", state: "completed", revision: 2,
    createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: override.proposals ?? [],
    confirmation: override.confirmation ?? { state: "none" },
    receipts: override.receipts ?? [{ commandId: "command", proposalId: null, linkedAt: "2030-01-01T00:00:00.000Z" }],
    narrationStatus: override.narrationStatus ?? { status: "completed", text: "The archive yields a sealed ledger.", source: "deterministic-fallback" } };
}

/** Authoritative hold line returned when an original turn commits no mechanics. */
const heldNarration = { status: "completed" as const, text: "The scene holds. Your intended action remains pending; no movement or other campaign change is established.", source: "deterministic-fallback" as const };
/** Completed held turn: an original deterministic turn that committed no receipt. */
function completedHeldTurn(override: CompletedTurnOverride = {}): AdventureTurnGetResponse {
  return completedReceiptTurn({ ...override, receipts: [], narrationStatus: override.narrationStatus ?? heldNarration });
}
const pendingProposal: AdventureTurnGetResponse["proposals"][number] = { proposalId: "proposal", position: 0, toolName: "travel",
  proposedAt: "2030-01-01T00:00:00.000Z", policy: { version: "v1", category: "ambiguous-consequential-change", requiresConfirmation: true,
    requiredAuthorizer: "controller", review: { summary: "Travel to the harbor", consequences: [{ kind: "campaign-change", text: "The party moves" }] } },
  confirmation: { state: "pending", expiresAt: "2030-01-01T00:05:00.000Z" } };

/** Persists the active-turn locator and waits until the page and the transcript have settled. */
function renderPersistedTurn(client: CampaignPlayApi, text: string) {
  localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
  const view = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
  return { view, settled: screen.findByText(text) };
}

/** Settles every pending effect by forcing the periodic live refresh and waiting for it to land. */
async function settleLiveRefresh(client: CampaignPlayApi) {
  const bootstrapCalls = vi.mocked(client.getCampaignPlayBootstrap).mock.calls.length;
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(bootstrapCalls + 1));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("CampaignPlayPage", () => {
  it("keeps the map, draft and player transcript mounted when opening a director scene", async () => {
    const client = api();
    vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "owner", control: "all" } });
    const run = { runId: "opening", campaignId: "campaign", sessionId: "session", intent: "open" as const, mode: "human" as const, modeRevision: 0, revision: 1, state: "completed" as const, narration: "Lanterns stir above the quay.", receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" };
    vi.mocked(client.dm.commandCampaignDmBeat).mockImplementation(async () => {
      vi.mocked(client.dm.getCampaignDmHistory).mockResolvedValue({ control: { campaignId: "campaign", mode: "human", revision: 0 }, runs: [run] });
      return run;
    });
    vi.mocked(client.dm.getCampaignDmRun).mockResolvedValue(run);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    const map = screen.getByRole("region", { name: "Campaign maps" }), log = screen.getByRole("log");
    const composer = screen.getByLabelText("What do you do?") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "My own next action" } });
    fireEvent.click(screen.getByRole("button", { name: "Director" }));
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    expect(map.isConnected).toBe(true);
    fireEvent.click(screen.getByText("Open scene"));
    await screen.findByText("Lanterns stir above the quay.");
    expect(map.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Director" }));
    expect(screen.getByText("Lanterns stir above the quay.").closest("[hidden]")).toBeNull();
    expect(screen.getByRole("region", { name: "Campaign maps" })).toBe(map); expect(screen.getByRole("log")).toBe(log);
    expect(composer.value).toBe("My own next action"); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    expect(client.dm.commandCampaignDmBeat).toHaveBeenCalledWith("campaign", "session", { intent: "open", expectedModeRevision: 0, idempotencyKey: expect.any(String) });
  });
  it("integrates DM review locks without changing the App props or declaring an adventure turn", async () => {
    const client = api(); vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "gm", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } } });
    const navigate = vi.fn();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} onNavigate={navigate} combatAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "GM tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Short rest for Aria" }, { timeout: 5000 }));
    await screen.findByRole("button", { name: "Confirm rest" });
    expect((screen.getByRole("button", { name: /Back to campaign/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Acting character") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Declare action" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Combat & rewards" })); expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "GM tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }));
    await waitFor(() => expect((screen.getByLabelText("Acting character") as HTMLSelectElement).disabled).toBe(false));
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });
  it("keeps DM session commands locked while adventure streaming is in progress", async () => {
    const client = api(); vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "owner", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "GM tools" }));
    await screen.findByRole("button", { name: "Short rest for Aria" });
    fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "Listen at the door" } });
    fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledOnce());
    expect((screen.getByRole("button", { name: "Short rest for Aria" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Confirm rest" })).toBeNull();
  });
  it("groups session tools apart from table setup and administration", async () => {
    const client = api(); vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "gm", control: "all" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    const session = screen.getByRole("group", { name: "Session tools" });
    expect(within(session).getByRole("button", { name: "Character" })).toBeTruthy();
    expect(within(session).getByRole("button", { name: "Combat & rewards" })).toBeTruthy();
    expect(within(session).queryByRole("button", { name: "GM tools" })).toBeNull();
    const setup = screen.getByRole("group", { name: "Table setup and administration" });
    expect(within(setup).getByRole("button", { name: "GM tools" })).toBeTruthy();
    expect(within(setup).getByRole("button", { name: "Display" })).toBeTruthy();
    expect(within(setup).getByRole("button", { name: "Shortcuts" })).toBeTruthy();
  });
  it("offers automatic mechanics narration in the Display dialog and persists the choice", async () => {
    localStorage.clear(); const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const toggle = screen.getByRole("checkbox", { name: "Auto-narrate turns, including conversation (uses the configured provider)" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(JSON.parse(localStorage.getItem("velvet.campaign-workbench.v1") ?? "null")).toMatchObject({ autoNarrateMechanics: false });
  });
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
  });
  afterEach(() => { cleanup(); localStorage.clear(); resetNarrativeMutationRegistryForTests(); });
  it("renders a scrim behind the open drawer and closes the drawer when it is clicked", async () => {
    const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(document.querySelector(".campaign-drawers-scrim")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Director" }));
    await screen.findByRole("dialog", { name: "Director" });
    const scrim = document.querySelector(".campaign-drawers-scrim");
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim as HTMLElement);
    await waitFor(() => expect(document.querySelector(".campaign-drawers-scrim")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Director" })).toBeNull();
    // Escape keeps working after the scrim closes the first drawer.
    fireEvent.click(screen.getByRole("button", { name: "Dice" }));
    await screen.findByRole("dialog", { name: "Dice" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".campaign-drawers-scrim")).toBeNull());
  });
  it("opens each drawer from its configured side and edits sides in the Display dialog", async () => {
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ drawerSides: { director: "left", character: "left" } }));
    const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(document.querySelector("#atlas-director")?.getAttribute("data-side")).toBe("left");
    expect(document.querySelector("#atlas-character")?.getAttribute("data-side")).toBe("left");
    expect(document.querySelector("#atlas-dice")?.getAttribute("data-side")).toBe("right");
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const directorSide = screen.getByLabelText("Director drawer side") as HTMLSelectElement;
    expect(directorSide.value).toBe("left");
    expect(Array.from(directorSide.options).map((option) => option.value)).toEqual(["top", "right", "bottom", "left"]);
    fireEvent.change(directorSide, { target: { value: "right" } });
    expect(document.querySelector("#atlas-director")?.getAttribute("data-side")).toBe("right");
    expect(JSON.parse(localStorage.getItem("velvet.campaign-workbench.v1") ?? "null")).toMatchObject({ drawerSides: { director: "right" } });
  });
  it("moves an open drawer to any edge from its header control and persists the choice", async () => {
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ drawerSides: { director: "right", character: "left" } }));
    const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    fireEvent.click(screen.getByRole("button", { name: "Director" }));
    const slot = document.querySelector("#atlas-director") as HTMLElement;
    // The drawer keeps its opaque structure while the edge changes.
    expect(slot.querySelector(".atlas-drawer > .atlas-drawer-heading")).toBeTruthy();
    expect(slot.querySelector(".atlas-drawer > .atlas-drawer-content")).toBeTruthy();
    expect(slot.getAttribute("data-orientation")).toBe("vertical");
    fireEvent.click(screen.getByRole("button", { name: "Open drawer at top" }));
    expect(slot.getAttribute("data-side")).toBe("top");
    expect(slot.getAttribute("data-orientation")).toBe("horizontal");
    expect(screen.getByRole("button", { name: "Open drawer at top" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Open drawer at right" }).getAttribute("aria-pressed")).toBe("false");
    expect(JSON.parse(localStorage.getItem("velvet.campaign-workbench.v1") ?? "null")).toMatchObject({ drawerSides: { director: "top" } });

    // The character reference slot carries the same four-way control.
    fireEvent.click(screen.getByRole("button", { name: "Character" }));
    const character = document.querySelector("#atlas-character") as HTMLElement;
    expect(character.getAttribute("data-side")).toBe("left");
    const sheetDrawer = await screen.findByRole("dialog", { name: "Aria's character sheet" });
    expect(character.querySelector(".gameplay-sheet-drawer")).toBeTruthy();
    fireEvent.click(within(sheetDrawer).getByRole("button", { name: "Open drawer at bottom" }));
    expect(character.getAttribute("data-side")).toBe("bottom");
    expect(character.getAttribute("data-orientation")).toBe("horizontal");
    expect(JSON.parse(localStorage.getItem("velvet.campaign-workbench.v1") ?? "null")).toMatchObject({ drawerSides: { character: "bottom" } });
  });
  it("places the compact DM chronicle in the right rail with its own expand control", async () => {
    const client = api();
    const run = { runId: "opening", campaignId: "campaign", sessionId: "session", intent: "open" as const, mode: "human" as const, modeRevision: 0, revision: 1,
      state: "completed" as const, narration: "Lanterns stir above the quay and the fog answers.", receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" };
    vi.mocked(client.dm.getCampaignDmHistory).mockResolvedValue({ control: { campaignId: "campaign", mode: "human", revision: 0 }, runs: [run] });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const chronicle = await screen.findByRole("region", { name: "DM chronicle" });
    const rail = document.querySelector("#campaign-quick-tools");
    expect(rail?.contains(chronicle)).toBe(true);
    expect(chronicle.className).toContain("is-compact");
    expect(within(chronicle).getByRole("heading", { name: "Opening scene" })).toBeTruthy();
    fireEvent.click(within(chronicle).getByRole("button", { name: "More" }));
    expect(within(chronicle).getByRole("button", { name: "Less" })).toBeTruthy();
  });
  it("keeps travel review in-room and locks the composer even when its drawer is closed", async () => {
    const client = api(), navigate = vi.fn();
    const at = "2030-01-01T00:00:00.000Z";
    const world = { currentLocations: [{ actorId: "actor", locationId: "harbor", revision: 2, updatedAt: at }], visibleLocations: [{ locationId: "harbor", parentLocationId: null, name: "Harbor", description: "Salt air" }, { locationId: "road", parentLocationId: null, name: "Road", description: "Inland" }], visibleConnections: [{ connectionId: "route", fromLocationId: "harbor", toLocationId: "road" }] };
    const worldApi = { getWorld: vi.fn().mockResolvedValue({ data: world, revision: 2 }), travel: vi.fn(), place: vi.fn(), camp: vi.fn() };
    const authorization: StudioAuthorization = { role: "player", audience: "player", generation: 1, reauthorize: vi.fn() };
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} worldApi={worldApi} authorization={authorization} onBack={vi.fn()} onUnavailable={vi.fn()} onNavigate={navigate} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    const map = screen.getByRole("region", { name: "Living map" }), log = screen.getByRole("log");
    const composer = screen.getByLabelText("What do you do?") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "My pending story" } });
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    fireEvent.change(await screen.findByLabelText("Eligible route"), { target: { value: "route" } }); fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(composer.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Travel" }));
    expect(composer.disabled).toBe(true); expect(composer.value).toBe("My pending story");
    fireEvent.click(screen.getByRole("button", { name: "Travel" })); fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(composer.disabled).toBe(false));
    expect(screen.getByRole("region", { name: "Living map" })).toBe(map); expect(screen.getByRole("log")).toBe(log);
    expect(navigate).not.toHaveBeenCalled(); expect(worldApi.travel).not.toHaveBeenCalled(); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });
  it("reaches campaign destinations from the Command Center without changing the in-room tools", async () => {
    const client = api(), navigate = vi.fn();
    vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "owner", control: "all" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} onNavigate={navigate} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    const menu = screen.getByRole("combobox", { name: "Open a campaign destination" });
    expect(within(menu).getByRole("option", { name: "Overview" })).toBeTruthy();
    expect(within(menu).queryByRole("option", { name: "Play" })).toBeNull();
    fireEvent.change(menu, { target: { value: "overview" } });
    expect(navigate).toHaveBeenCalledWith("overview");
  });
  it("opens mechanical possessions from Character and preserves a hidden review lock", async () => {
    const client = api();
    const actorToolsApi: RpgCharacterSheetApi = { getSheet: vi.fn(), getInventory: vi.fn().mockResolvedValue({ entries: [{ kind: "stackable", entryId: "rope", item: { kind: "item", packId: "pack", packVersion: "1", definitionId: "rope" }, quantity: 1 }], equipment: [], capacity: 10, revision: 4 }), getResources: client.getActorResources, getEffects: vi.fn().mockResolvedValue({ effects: [], revision: 4 }), getPowers: vi.fn().mockResolvedValue({ known: [], prepared: [], slots: [], uses: [], legalNow: [], legalCommands: [], revision: 4 }), getWallet: vi.fn().mockResolvedValue({ wallet: { balances: [] }, revision: 4 }), getShop: vi.fn(), inventoryCommand: vi.fn(), economyCommand: vi.fn(), rest: vi.fn(), checkCommand: vi.fn(), powerCommand: vi.fn(), spellCommand: vi.fn(), effectCommand: vi.fn(), resourceCommand: vi.fn(), vendorSaleQuote: vi.fn(), getCampaignContent: vi.fn().mockRejectedValue(new Error("no catalog")), getCampaignPack: vi.fn() };
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} actorToolsApi={actorToolsApi} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Character" }));
    fireEvent.click(screen.getByRole("button", { name: "Inventory & equipment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review equip" }));
    expect(actorToolsApi.getInventory).toHaveBeenCalledWith("campaign", "actor");
    const composer = screen.getByLabelText("What do you do?") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Inventory & equipment" })); expect(composer.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Character" })); fireEvent.click(screen.getByRole("button", { name: "Inventory & equipment" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(composer.disabled).toBe(false));
    expect(actorToolsApi.getSheet).not.toHaveBeenCalled(); expect(actorToolsApi.inventoryCommand).not.toHaveBeenCalled();
  });
  it("keeps a new atlas map and conversation mounted while nonmodal tools open", async () => {
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={api()} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(document.querySelector(".campaign-play-page")).toBeTruthy();
    expect(document.querySelector(".living-atlas")).toBeNull();
    const map = screen.getByRole("region", { name: "Campaign maps" });
    const log = screen.getByRole("log");
    expect(screen.getByLabelText("Acting character")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exploration grid" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Combat grid" }));
    expect(screen.getByText(/No active combat in this room/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Character" }));
    await screen.findByRole("dialog", { name: "Aria's character sheet" });
    expect(screen.getByRole("region", { name: "Campaign maps" })).toBe(map);
    expect(screen.getByRole("log")).toBe(log);
    expect(screen.getByLabelText("What do you do?").closest("[hidden]")).toBeNull();
  });
  it("describes observer maps as read-only using the bootstrap role", async () => {
    const client = api(); vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [] });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(screen.getByText("Spectator access from server")).toBeTruthy();
    expect(screen.getByText(/Spectator \/ read-only access/)).toBeTruthy();
    expect(screen.queryByText(/Acting as/)).toBeNull();
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });
  it("uses bootstrap revision and streams an initial declaration exactly once", async () => {
    localStorage.clear(); const client = api(); vi.mocked(client.getCampaignPlayBootstrap)
      .mockResolvedValueOnce(bootstrap).mockResolvedValueOnce({ ...bootstrap, expectedRevision: 9 });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "initial", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I listen", expectedRevision: 9 });
    expect(localStorage.getItem("velvet.campaign-play-submit.v1:campaign:session")).not.toContain("I listen");
  });

  it("supports region shortcuts and searchable help without hiding the composer", async () => {
    const client = api();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/);
    fireEvent.keyDown(window, { key: "F6" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Living map" }));
    fireEvent.keyDown(window, { key: "F6" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Campaign narration and actions" }));
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Help" }).getAttribute("aria-modal")).toBe("false");
    fireEvent.change(screen.getByLabelText("Search the field guide"), { target: { value: "orchestration" } });
    expect(screen.getByRole("heading", { name: "What the adventure agents can and cannot do" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dice at the table" })).toBeNull();
    expect(screen.getByRole("log")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Help" })));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reconciles a persisted turn by GET without replaying its declaration", async () => {
    localStorage.clear(); localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
    // This suite covers authoritative reconciliation; automatic retries are disabled.
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ autoNarrateMechanics: false }));
    const client = api(); vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "private declaration", state: "completed", revision: 2, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }, proposals: [], confirmation: { state: "none" }, receipts: [], narrationStatus: { status: "completed", text: "Fallback narration", source: "deterministic-fallback" } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText("Fallback narration"); expect(client.getAdventureTurn).toHaveBeenCalledWith("turn", { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "turn" }); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Swipe narration" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledWith(expect.objectContaining({ kind: "narration-swipe", priorTurnId: "turn", expectedRevision: 7 }), expect.any(Function)));
  });

  it.each([
    ["passes completed original evidence with empty local receipts while the transcript lags", { receipts: [] }, true],
    ["omits nonoriginal turn evidence", { mode: "narration-retry", priorTurnId: "prior" }, false],
    ["omits non-completed turn evidence", { state: "failed" }, false],
    ["omits cross-campaign turn evidence", { campaignId: "other-campaign" }, false],
    ["omits cross-session turn evidence", { sessionId: "other-session" }, false],
  ] as const)("%s", async (_name, override, includesEvidence) => {
    localStorage.setItem("velvet.campaign-play.v1:campaign:session", JSON.stringify({ turnId: "turn", selectedActorId: "actor", streamPhase: "ambiguous" }));
    // This suite isolates DM evidence selection from automatic narration retries.
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ autoNarrateMechanics: false }));
    const client = api();
    const history = { control: { campaignId: "campaign", mode: "ai" as const, revision: 0 }, runs: [{ runId: "opening", campaignId: "campaign", sessionId: "session", intent: "open" as const, mode: "ai" as const, modeRevision: 0, revision: 1, state: "completed" as const, narration: null, receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" }] };
    vi.mocked(client.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "owner", control: "all" }, dm: { mode: "ai", revision: 0 } });
    vi.mocked(client.dm.getCampaignDmHistory).mockResolvedValue(history);
    vi.mocked(client.getAdventureTurnTranscript).mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [] });
    vi.mocked(client.getAdventureTurn).mockResolvedValue({ turn: { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "I secure the objective.", state: "completed", revision: 2, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", ...override }, proposals: [], confirmation: { state: "none" }, receipts: "receipts" in override ? override.receipts : [{ commandId: "command", proposalId: null, linkedAt: "2030-01-01T00:00:00.000Z" }], narrationStatus: { status: "completed", text: "The objective is complete.", source: "deterministic-fallback" } } as never);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText("The objective is complete.");
    fireEvent.click(screen.getByRole("button", { name: "Director" }));
    const continueScene = await screen.findByRole("button", { name: "Continue scene" }) as HTMLButtonElement;
    await waitFor(() => expect(continueScene.disabled).toBe(false));
    fireEvent.click(continueScene);
    await waitFor(() => expect(client.dm.commandCampaignDmBeat).toHaveBeenCalledOnce());
    const request = vi.mocked(client.dm.commandCampaignDmBeat).mock.calls[0]![2];
    expect(request).toEqual(expect.objectContaining({ intent: "continue", ...(includesEvidence ? { evidenceTurnId: "turn" } : {}) }));
    if (!includesEvidence) expect(request).not.toHaveProperty("evidenceTurnId");
  });

  it("auto-dispatches one receipt-bound narration retry for a completed deterministic turn", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedReceiptTurn());
    const { view } = renderPersistedTurn(client, "The archive yields a sealed ledger.");
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "narration-retry", campaignId: "campaign",
      sessionId: "session", actorId: "actor", priorTurnId: "turn", expectedRevision: 7 });
    // Re-rendering after the dispatch never queues a second provider call.
    view.rerender(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1);
  });

  it("records the automatic attempt so delivery recovery cannot dispatch a second provider call", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedReceiptTurn());
    vi.mocked(client.streamAdventureTurn).mockReturnValue({ turnId: Promise.resolve("turn"), done: Promise.reject(new Error("delivery lost")), cancelDelivery: vi.fn() });
    renderPersistedTurn(client, "The archive yields a sealed ledger.");
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    // Losing delivery reconciles the same original turn back to terminal; the attempt set still holds it.
    await waitFor(() => expect(client.getAdventureTurn).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1);
  });

  it("never auto-narrates a derivative turn", async () => {
    localStorage.clear();
    const client = api();
    // A derivative never carries receipts, so a held-shape derivative is the real guard case.
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn({ mode: "narration-retry", priorTurnId: "prior" }));
    renderPersistedTurn(client, heldNarration.text);
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("auto-dispatches one narration retry for a completed held turn", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn());
    const { view } = renderPersistedTurn(client, heldNarration.text);
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "narration-retry", campaignId: "campaign",
      sessionId: "session", actorId: "actor", priorTurnId: "turn", expectedRevision: 7 });
    // Re-rendering after the dispatch never queues a second provider call for the hold.
    view.rerender(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1);
  });

  it("does not auto-narrate a held turn while the aggregate confirmation is pending", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn({
      confirmation: { state: "pending", proposalIds: ["proposal"], expiresAt: "2030-01-01T00:05:00.000Z" } }));
    renderPersistedTurn(client, heldNarration.text);
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("does not auto-narrate a held turn while a proposal confirmation is pending", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn({ proposals: [pendingProposal] }));
    renderPersistedTurn(client, heldNarration.text);
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("does not loop or repeat when the held-turn narration retry is rejected", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn());
    const rejection = new ApiError(400, "narration rejected");
    vi.mocked(client.streamAdventureTurn).mockReturnValue({ turnId: Promise.reject(rejection), done: Promise.reject(rejection), cancelDelivery: vi.fn() });
    renderPersistedTurn(client, heldNarration.text);
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    // The failure surfaces once through the existing derivative path and is never replayed.
    await screen.findByText("No derivative turn identity was received. The narration request will not be replayed automatically.");
    await settleLiveRefresh(client);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("does not auto-narrate narration that is already provider-assisted", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedReceiptTurn({ narrationStatus: { status: "completed", text: "Provider prose about the archive.", source: "provider-assisted" } }));
    renderPersistedTurn(client, "Provider prose about the archive.");
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("does not auto-narrate when the transcript already reports derivative prose for the root", async () => {
    localStorage.clear();
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedReceiptTurn());
    vi.mocked(client.getAdventureTurnTranscript).mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [{ turnId: "turn", actorId: "actor",
      declaration: "I search the archive.", narration: "Provider prose about the sealed ledger.", completedAt: "2030-01-01T00:01:00.000Z" }] });
    renderPersistedTurn(client, "Provider prose about the sealed ledger.");
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("honours a disabled auto-narration preference and keeps manual retry", async () => {
    localStorage.clear();
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ autoNarrateMechanics: false }));
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedReceiptTurn());
    renderPersistedTurn(client, "The archive yields a sealed ledger.");
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry narration" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "narration-retry", priorTurnId: "turn", expectedRevision: 7 });
  });

  it("submits nothing for a held turn while the auto-narration preference is off", async () => {
    localStorage.clear();
    localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ autoNarrateMechanics: false }));
    const client = api();
    vi.mocked(client.getAdventureTurn).mockResolvedValue(completedHeldTurn());
    renderPersistedTurn(client, heldNarration.text);
    await settleLiveRefresh(client);
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry narration" }));
    await waitFor(() => expect(client.streamAdventureTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.streamAdventureTurn).mock.calls[0]?.[0]).toMatchObject({ kind: "narration-retry", priorTurnId: "turn", expectedRevision: 7 });
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
    fireEvent.change(composer, { target: { value: "I inspect the arch." } }); const trigger = screen.getByRole("button", { name: "Character" }); fireEvent.click(trigger);
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
    await screen.findByText(/first declaration/); fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "Existing draft" } }); fireEvent.click(screen.getByRole("button", { name: "Character" }));
    expect(await screen.findByRole("dialog", { name: "Opening character sheet" })).toBeTruthy(); reject(new ApiError(404, "hidden"));
    expect((await screen.findByText("This character sheet is unavailable with your current access.")).textContent).toContain("unavailable with your current access"); expect((screen.getByLabelText("What do you do?") as HTMLTextAreaElement).value).toBe("Existing draft"); expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cannot start sheet references for observer, inflight, or ambiguous play", async () => {
    const observerClient = api(); vi.mocked(observerClient.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [] });
    const { unmount } = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} authorizationCanAct={false} api={observerClient} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect((await screen.findAllByText("Observer access is read-only.")).length).toBeGreaterThan(0); fireEvent.click(screen.getByRole("button", { name: "Character" })); expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true); expect(observerClient.getActorGameplaySheet).not.toHaveBeenCalled(); unmount();

    const inflight = api(); render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={inflight} onBack={vi.fn()} onUnavailable={vi.fn()} />); await screen.findByText(/first declaration/);
    fireEvent.change(screen.getByLabelText("What do you do?"), { target: { value: "I listen" } }); fireEvent.click(screen.getByRole("button", { name: "Declare action" })); fireEvent.click(screen.getByRole("button", { name: "Character" })); await waitFor(() => expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true)); cleanup();

    localStorage.setItem("velvet.campaign-play-submit.v1:campaign:session", JSON.stringify({ campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "locked-key" })); const ambiguous = api(); render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={ambiguous} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("button", { name: "Reconcile submitted declaration" }); fireEvent.click(screen.getByRole("button", { name: "Character" })); expect((screen.getByRole("button", { name: "Open character sheet" }) as HTMLButtonElement).disabled).toBe(true); expect(ambiguous.getActorGameplaySheet).not.toHaveBeenCalled();
  });

  it("consumes server-derived player dice capability without writing on render", async () => {
    const player = api(); player.getCampaignDiceHistory = vi.fn(); player.rollCampaignDice = vi.fn();
    const first = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={player} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText("Player access from server");
    expect(screen.queryByRole("heading", { name: "Run this scene" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dice" }));
    expect(screen.getByText(/Table dice are not authorized/)).toBeTruthy();
    expect(player.getCampaignDiceHistory).not.toHaveBeenCalled(); expect(player.rollCampaignDice).not.toHaveBeenCalled();
    first.unmount();

    const enabled = api(); enabled.getCampaignDiceHistory = vi.fn().mockResolvedValue({ characters: [{ position: 1, name: "Aria" }], rolls: [] });
    enabled.rollCampaignDice = vi.fn();
    vi.mocked(enabled.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap,
      capabilities: { campaignDice: { canView: true, canRoll: true } } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={enabled} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dice" }));
    expect(await screen.findByRole("button", { name: "Roll dice" })).toBeTruthy();
    expect(enabled.getCampaignDiceHistory).toHaveBeenCalledOnce();
    expect(enabled.rollCampaignDice).not.toHaveBeenCalled();
    cleanup();

    const gm = api(); vi.mocked(gm.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "gm", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } } });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={gm} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "GM tools" }));
    expect(await screen.findByRole("heading", { name: "Run this scene" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "DM scene controls" })).toBeTruthy();
  });

  it("refreshes another player's transcript by GET on focus without issuing a write", async () => {
    const client = api(); const later = { turnId: "other-turn", actorId: "other", declaration: "Borin checks the bridge", narration: "The timbers hold.", completedAt: "2030-01-01T00:00:00.000Z" };
    vi.mocked(client.getAdventureTurnTranscript).mockResolvedValueOnce({ campaignId: "campaign", sessionId: "session", turns: [] })
      .mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [later] });
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Borin checks the bridge")).toBeTruthy();
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
  });

  it("cleans up its conservative live-read interval", async () => {
    const clearInterval = vi.spyOn(window, "clearInterval"); const client = api();
    const view = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/first declaration/); view.unmount();
    expect(clearInterval).toHaveBeenCalled();
    clearInterval.mockRestore();
  });

  it("ignores an initial bootstrap superseded by a successful focus refresh", async () => {
    let resolveInitial!: (value: typeof bootstrap) => void;
    let resolveFocused!: (value: typeof bootstrap) => void;
    const initial = new Promise<typeof bootstrap>((resolve) => { resolveInitial = resolve; });
    const focused = new Promise<typeof bootstrap>((resolve) => { resolveFocused = resolve; });
    const client = api(); const unavailable = vi.fn();
    vi.mocked(client.getCampaignPlayBootstrap).mockReturnValueOnce(initial).mockReturnValueOnce(focused);
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={unavailable} />);
    await waitFor(() => expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(2));
    await act(async () => resolveFocused(bootstrap));
    expect(await screen.findByText("Player access from server")).toBeTruthy();
    await act(async () => resolveInitial(bootstrap));
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("reports a genuine initial bootstrap failure exactly once", async () => {
    const client = api(); const unavailable = vi.fn();
    vi.mocked(client.getCampaignPlayBootstrap).mockRejectedValue(new Error("invalid bootstrap"));
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={unavailable} />);
    await waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1));
  });

  it("does not report a pending initial bootstrap failure after unmount", async () => {
    let rejectInitial!: (failure: unknown) => void;
    const client = api(); const unavailable = vi.fn();
    vi.mocked(client.getCampaignPlayBootstrap).mockReturnValue(new Promise((_resolve, reject) => { rejectInitial = reject; }));
    const view = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={unavailable} />);
    await waitFor(() => expect(client.getCampaignPlayBootstrap).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => rejectInitial(new Error("late failure")));
    expect(unavailable).not.toHaveBeenCalled();
  });
});

it("keeps optional voice beside the composer without submitting gameplay", async () => {
  const client = api();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ enabled: true, voices: [], speakers: [], assignments: [], sources: [] })))));
  try {
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const voice = await screen.findByRole("region", { name: "Voice playback" });
    expect(voice.closest(".campaign-play-center")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cast & Voices" }));
    expect(screen.getByLabelText("What do you do?")).toBeTruthy();
    expect(client.streamAdventureTurn).not.toHaveBeenCalled();
    expect(client.dm.commandCampaignDmBeat).not.toHaveBeenCalled();
  } finally { cleanup(); vi.unstubAllGlobals(); }
});
