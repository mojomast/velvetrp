import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CampaignGeneratedPlanning, CampaignWorldHttpResponse, GmCampaignNpcsHttpResponse } from "@velvet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shared from "../../../api";
import { NpcRosterPage, type CastStudioApi } from "../cast/NpcRosterPage";
import { QuestJournalPage, type QuestJournalApi } from "../journal/QuestJournalPage";
import { StoryStudioPage, type StoryStudioApi } from "../journal/StoryStudioPage";
import { resetNarrativeMutationRegistryForTests } from "../narrativeMutationRegistry";
import type { StudioAuthorization } from "../StudioAuthorization";
import { WorldExplorerPage, type WorldExplorerApi } from "./WorldExplorerPage";
import type { CampaignStartingLocationApi } from "../generation/campaignStartingLocationApi";

const shell = vi.hoisted(() => ({ navigate: vi.fn(), generationAvailable: true }));
vi.mock("../shell/CampaignShell", () => ({ useCampaignShell: () => shell }));
const at = "2030-01-01T00:00:00.000Z";
const world: CampaignWorldHttpResponse = {
  currentLocations: [{ actorId: "actor", locationId: "harbor", revision: 2, updatedAt: at }],
  visibleLocations: [{ locationId: "harbor", parentLocationId: null, name: "Old Harbor", description: "Lanterns in the rain" }, { locationId: "hill", parentLocationId: null, name: "Beacon Hill", description: "Above the bay" }],
  visibleConnections: [{ connectionId: "road", fromLocationId: "harbor", toLocationId: "hill" }],
};
const npcs: GmCampaignNpcsHttpResponse = { npcs: [{ npcId: "npc", personaId: "persona", publicState: { name: "Mira" }, privateState: { goals: "SECRET GOAL", gmNotes: "SECRET NOTE", merchantState: null }, createdAt: at }], relationships: [] };
const factions = { factions: [{ factionId: "faction", name: "Harbor Guild", publicState: { description: "Dock workers" }, privateState: { gmNotes: "SECRET FACTION", visibility: "public" as const }, createdAt: at }], standings: [] };
const quests = { quests: [{ questId: "quest", storylineId: "story", campaignId: "campaign", title: "Recover the lantern", description: null, status: "offered" as const, rewards: [], createdAt: at, updatedAt: at }], objectives: [], journal: [] };
const story = { storylines: [{ storylineId: "story", campaignId: "campaign", title: "Harbor mystery", summary: null, status: "active" as const, createdAt: at, updatedAt: at }], nodes: [], edges: [], plotPoints: [], clues: [] };
const base = { visibility: "gm" as const, sourceDraftId: "draft" };
const planning: CampaignGeneratedPlanning = {
  campaignId: "campaign", deliveryRevision: 0, monsterConcepts: [], deliverables: [],
  encounters: [{ ...base, artifactKey: "ambush", resourceId: "plan", title: "SECRET AMBUSH", description: "A tense meeting", locationId: "harbor", participantNpcIds: ["npc"], objectives: [], terrain: [], escalation: [], resolution: null, enemyReferences: [], monsterConceptIds: [] }],
  lore: [{ ...base, artifactKey: "guild", resourceId: "lore", title: "Guild ties", summary: "An old bargain", details: [], locationIds: ["harbor"], factionIds: ["faction"], storyNodeIds: [] }],
  questItems: [{ ...base, artifactKey: "lantern", resourceId: "item", title: "Signal lantern", description: "A stolen light", questIds: ["quest"], locationIds: ["harbor"], mechanics: { state: "inert", reason: "Narrative prop" } }],
};
function authorization(role: StudioAuthorization["role"] = "gm", generation = 1): StudioAuthorization {
  const auth: StudioAuthorization = { role, audience: role === "gm" || role === "owner" ? "gm" : "player", generation, reauthorize: vi.fn() };
  vi.mocked(auth.reauthorize).mockResolvedValue(auth);
  return auth;
}
function castApi(): CastStudioApi {
  return { listNpcs: vi.fn().mockResolvedValue({ data: npcs, revision: 2 }), listFactions: vi.fn().mockResolvedValue({ data: factions, revision: 2 }), createNpc: vi.fn(), createFaction: vi.fn(), relationship: vi.fn(), reputation: vi.fn(), previewNpcs: shared.projectNpcsForPlayers, previewFactions: shared.projectFactionsForPlayers, getCompanion: vi.fn(), commandCompanion: vi.fn(), listMemberships: vi.fn(), listRooms: vi.fn() };
}
function worldApi(): WorldExplorerApi { return { getWorld: vi.fn().mockResolvedValue({ data: world, revision: 2 }), travel: vi.fn(), place: vi.fn(), camp: vi.fn() }; }

describe("connected worldbuilding workspace", () => {
  beforeEach(() => {
    localStorage.clear(); resetNarrativeMutationRegistryForTests(); shell.navigate.mockReset(); shell.generationAvailable = true;
    vi.spyOn(shared, "getCampaignGeneratedPlanning").mockResolvedValue(planning);
    vi.spyOn(shared, "getCampaignGeneratedFoundation").mockResolvedValue({ campaignId: "campaign", revision: 1, opening: { premise: "Keep the harbor safe", opening: "Rain at the quay", startLocationKey: "harbor", sourceDraftId: "draft" } });
    vi.spyOn(shared, "listCampaignNpcs").mockResolvedValue({ data: npcs, revision: 2 });
    vi.spyOn(shared, "listCampaignFactions").mockResolvedValue({ data: factions, revision: 2 });
    vi.spyOn(shared, "listCampaignQuests").mockResolvedValue({ data: quests, revision: 2 });
    vi.spyOn(shared, "getCampaignStory").mockResolvedValue({ data: story, revision: 2 });
    vi.spyOn(shared, "getEncounterSetupCandidates").mockResolvedValue({ actors: [{ actorId: "actor", label: "Tala" }], sessions: [], enemies: [], teams: { actor: "allies", enemy: "enemies" } });
    vi.spyOn(shared, "listCharacters").mockResolvedValue({ characters: [{ id: "persona", name: "Mira" } as shared.Character] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows named persisted location relationships and real shell destinations without mutating selection", async () => {
    const api = worldApi();
    render(<WorldExplorerPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByText("SECRET AMBUSH");
    expect(screen.getByText("Cast: Mira")).toBeTruthy();
    expect(screen.getByText("Factions: Harbor Guild")).toBeTruthy();
    expect(screen.getByText("Quests: Recover the lantern")).toBeTruthy();
    for (const [label, destination] of [["Review linked cast", "cast"], ["Review linked factions", "cast"], ["Review linked quests", "journal"], ["Prepare opening in Create", "create"], ["Check room readiness", "play"]]) {
      fireEvent.click(screen.getByRole("button", { name: label })); expect(shell.navigate).toHaveBeenLastCalledWith(destination);
    }
    fireEvent.click(screen.getByRole("treeitem", { name: /Beacon Hill/ }));
    expect(screen.queryByText("SECRET AMBUSH")).toBeNull();
    expect(screen.getByText(/No persisted planning links/)).toBeTruthy();
    expect(api.travel).not.toHaveBeenCalled();
    expect(screen.getByText(/Selecting a location here does not move anyone/)).toBeTruthy();
  });

  it("creates and then role-safely reads the authoritative opening in World", async () => {
    const read = vi.fn().mockResolvedValueOnce({ campaignId: "campaign", revision: 4, startingLocation: null })
      .mockResolvedValue({ campaignId: "campaign", revision: 5, startingLocation: { locationId: "harbor", name: "Old Harbor", designatedAt: at } });
    const designate = vi.fn(async (_campaignId, input) => ({ campaignId: "campaign", revision: 5,
      startingLocation: { locationId: "harbor", name: "Old Harbor", designatedAt: at },
      receipt: { commandId: "command", idempotencyKey: input.idempotencyKey, revisionBefore: 4, revisionAfter: 5, occurredAt: at } }));
    const startingLocationApi = { getCampaignStartingLocation: read, designateCampaignStartingLocation: designate,
      getCampaignStartingLocationWorld: vi.fn() } satisfies CampaignStartingLocationApi;
    const view = render(<WorldExplorerPage campaignId="campaign" authorization={authorization("owner")} api={worldApi()} startingLocationApi={startingLocationApi} onBack={vi.fn()} />);
    const choice = await screen.findByLabelText("Public named location");
    fireEvent.change(choice, { target: { value: "harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Designate starting location once" }));
    await screen.findByText("Old Harbor is the authoritative campaign starting location.");
    expect(designate).toHaveBeenCalledWith("campaign", expect.objectContaining({ locationId: "harbor", expectedRevision: 4 }));
    view.rerender(<WorldExplorerPage campaignId="campaign" authorization={authorization("observer", 2)} api={worldApi()} startingLocationApi={startingLocationApi} onBack={vi.fn()} />);
    await screen.findByText(/create-once designation is locked/);
    expect(screen.queryByLabelText("Public named location")).toBeNull();
    expect(screen.getByText(/only the campaign owner or GM/)).toBeTruthy();
  });

  it("drops private world planning immediately on role transition and ignores a late GM read", async () => {
    let resolve!: (value: CampaignGeneratedPlanning) => void;
    vi.mocked(shared.getCampaignGeneratedPlanning).mockReturnValue(new Promise(done => { resolve = done; }));
    const api = worldApi();
    const view = render(<WorldExplorerPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByText("Loading opening and planning context...");
    view.rerender(<WorldExplorerPage campaignId="campaign" authorization={authorization("observer", 2)} api={api} onBack={vi.fn()} />);
    await act(async () => resolve(planning));
    await screen.findByText(/Private planning links are not part/);
    expect(document.body.textContent).not.toContain("SECRET");
    expect(screen.queryByRole("button", { name: "Generate world material" })).toBeNull();
    expect((screen.getByRole("button", { name: "Plan travel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(shared.getCampaignGeneratedPlanning).toHaveBeenCalledTimes(1);
  });

  it("clears old GM cast even when the new observer projection cannot load", async () => {
    const api = castApi(); const view = render(<NpcRosterPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByText("SECRET NOTE");
    vi.mocked(api.listNpcs).mockRejectedValue(new Error("not available")); vi.mocked(api.listFactions).mockRejectedValue(new Error("not available"));
    view.rerender(<NpcRosterPage campaignId="campaign" authorization={authorization("observer", 2)} api={api} onBack={vi.fn()} />);
    expect(document.body.textContent).not.toContain("SECRET");
    expect(screen.queryByRole("button", { name: "Create an NPC" })).toBeNull();
    await screen.findByText("Cast could not be loaded.");
    expect(api.listNpcs).toHaveBeenLastCalledWith("campaign", "player");
  });

  it("creates the exact previewed NPC through the named persona workflow and preserves an ambiguous lock", async () => {
    const api = castApi(); vi.mocked(api.createNpc).mockRejectedValue(new Error("response lost"));
    const auth = authorization(); const view = render(<NpcRosterPage campaignId="campaign" authorization={auth} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Mira" });
    fireEvent.click(screen.getByRole("button", { name: "Create an NPC" }));
    await screen.findByRole("option", { name: "Mira" });
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "persona" } });
    fireEvent.change(screen.getByLabelText("Private goals"), { target: { value: "NEVER PUBLISH" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview exact player projection" }));
    const projection = screen.getByRole("heading", { name: "Exact player projection preview" }).parentElement!;
    expect(projection.textContent).toContain("Mira"); expect(projection.textContent).not.toContain("NEVER PUBLISH");
    fireEvent.click(screen.getByRole("button", { name: "Create exact previewed NPC" }));
    await screen.findByText("Command outcome unresolved");
    expect(api.createNpc).toHaveBeenCalledWith("campaign", expect.objectContaining({ personaId: "persona", expectedRevision: 2, publicState: { name: "Mira" }, privateState: { goals: "NEVER PUBLISH", gmNotes: "", merchantState: null }, idempotencyKey: expect.stringMatching(/^npc-ui-/) }));
    view.unmount(); resetNarrativeMutationRegistryForTests();
    render(<NpcRosterPage campaignId="campaign" authorization={auth} api={api} onBack={vi.fn()} />);
    await screen.findByText("Command outcome unresolved");
    fireEvent.click(screen.getByRole("button", { name: "Create an NPC" }));
    await screen.findByLabelText("Persona");
    expect((screen.getByRole("button", { name: "Create exact previewed NPC" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.createNpc).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("velvet.narrative-mutation.v3:campaign:npc")).not.toContain("NEVER PUBLISH");
  });

  it("keeps travel locked for a mismatching revision and reconciles via read-only refresh", async () => {
    const api = worldApi(); const auth = authorization("player");
    vi.mocked(api.getWorld).mockResolvedValueOnce({ data: world, revision: 2 }).mockResolvedValueOnce({ data: world, revision: 4 }).mockResolvedValue({ data: world, revision: 3 });
    vi.mocked(api.travel).mockResolvedValue({ locations: world.currentLocations, discoveries: [{ actorId: "actor", locationId: "hill", discoveredAt: at }], receipt: { idempotencyKey: "receipt", revisionBefore: 2, revisionAfter: 3, occurredAt: at } });
    render(<WorldExplorerPage campaignId="campaign" authorization={auth} api={api} onBack={vi.fn()} />);
    await screen.findByRole("treeitem", { name: /Old Harbor/ });
    fireEvent.click(screen.getByRole("button", { name: "Plan travel" }));
    fireEvent.change(screen.getByLabelText("Acting actor"), { target: { value: "actor" } });
    fireEvent.change(screen.getByLabelText("Eligible route"), { target: { value: "road" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" })); fireEvent.click(screen.getByRole("button", { name: "Confirm travel" }));
    await screen.findByText("Confirmed command; refresh partial");
    expect((screen.getByRole("button", { name: "Plan travel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reauthorize & refresh" }));
    await screen.findByText("Confirmed command receipt");
    expect((screen.getByRole("button", { name: "Plan travel" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.travel).toHaveBeenCalledTimes(1); expect(api.getWorld).toHaveBeenCalledTimes(3);
  });

  it("shows quest ancestry by title only to the GM and removes it while observer reads are pending", async () => {
    const api: QuestJournalApi = { list: vi.fn().mockResolvedValue({ data: quests, revision: 2 }), create: vi.fn(), command: vi.fn(), preview: shared.projectQuestsForPlayers };
    const view = render(<QuestJournalPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByText("Recover the lantern: Harbor mystery");
    fireEvent.click(screen.getByRole("button", { name: "Prepare a new quest" }));
    expect(screen.getByRole("option", { name: "Harbor mystery" })).toBeTruthy();
    vi.mocked(api.list).mockReturnValue(new Promise(() => undefined));
    view.rerender(<QuestJournalPage campaignId="campaign" authorization={authorization("observer", 2)} api={api} onBack={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Harbor mystery");
    expect(screen.queryByLabelText("Storyline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare a new quest" })).toBeNull();
  });

  it("creates an exact named-storyline quest and recovers its receipt without replay after a partial refresh", async () => {
    const api: QuestJournalApi = {
      list: vi.fn().mockResolvedValueOnce({ data: quests, revision: 2 }).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ data: quests, revision: 3 }),
      create: vi.fn(async (_id, request) => ({ receipt: { idempotencyKey: request.idempotencyKey, revisionBefore: request.expectedRevision, revisionAfter: 3, occurredAt: at } })),
      command: vi.fn(), preview: shared.projectQuestsForPlayers,
    };
    render(<QuestJournalPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Recover the lantern" });
    fireEvent.click(screen.getByRole("button", { name: "Prepare a new quest" }));
    await screen.findByRole("option", { name: "Harbor mystery" });
    fireEvent.change(screen.getByLabelText("Storyline"), { target: { value: "story" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Meet the keeper" } });
    fireEvent.change(screen.getByLabelText("Exact initial journal entry"), { target: { value: "Ask about the missing light." } });
    fireEvent.change(screen.getAllByLabelText("Description")[1]!, { target: { value: "Speak with Mira" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview exact public projection" }));
    fireEvent.click(screen.getByRole("button", { name: "Create exact previewed quest" }));
    await screen.findByText("Confirmed command; refresh partial");
    expect(api.create).toHaveBeenCalledWith("campaign", expect.objectContaining({ expectedRevision: 2, quest: expect.objectContaining({ storylineId: "story", title: "Meet the keeper", objectives: [expect.objectContaining({ description: "Speak with Mira" })] }) }));
    expect((screen.getByRole("button", { name: "Create exact previewed quest" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reauthorize & refresh" }));
    await screen.findByText("Confirmed command receipt");
    expect(api.create).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Create exact previewed quest" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("claims a reward using role-safe room character choices and the existing exact quest command", async () => {
    vi.spyOn(shared, "listCampaignRooms").mockResolvedValue({ attached: [{ sessionId: "session", title: "Opening night", participantNames: ["Tala"], createdAt: at, attachedAt: at, stopped: false }], eligible: [] });
    vi.spyOn(shared, "getCampaignPlayBootstrap").mockResolvedValue({ dm: { mode: "human", revision: 0 }, campaignId: "campaign", sessionId: "session", expectedRevision: 11, session: { attached: true, attachedAt: at, active: true, adventureEligible: true }, principal: { role: "player", control: "controlled" }, capabilities: { campaignDice: { canView: true, canRoll: true } }, playableActors: [{ actorId: "actor", name: "Tala" }] });
    const data = { ...quests, quests: [{ ...quests.quests[0]!, rewards: [{ rewardId: "reward", kind: "custom" as const, amount: null, label: "Guild favor", claimedByActorId: null, claimedAt: null }] }] };
    const api: QuestJournalApi = { list: vi.fn().mockResolvedValue({ data: shared.projectQuestsForPlayers(data), revision: 2 }), command: vi.fn().mockRejectedValue(new Error("unknown")), create: vi.fn(), preview: shared.projectQuestsForPlayers };
    render(<QuestJournalPage campaignId="campaign" authorization={authorization("player")} api={api} onBack={vi.fn()} />);
    await screen.findByRole("option", { name: "Opening night (Tala)" });
    fireEvent.change(screen.getByLabelText("Recipient room"), { target: { value: "session" } });
    await screen.findByRole("option", { name: "Tala" });
    fireEvent.change(screen.getByLabelText("Claiming character"), { target: { value: "actor" } });
    fireEvent.click(screen.getByRole("button", { name: "Claim this reward" }));
    await screen.findByText("Command outcome unresolved");
    expect(api.command).toHaveBeenCalledWith("quest", expect.objectContaining({ kind: "claim-reward", actorId: "actor", rewardId: "reward", expectedRevision: 2 }));
    expect(api.command).toHaveBeenCalledTimes(1);
    expect(shared.getCampaignPlayBootstrap).toHaveBeenCalledWith("campaign", "session");
    expect(screen.queryByLabelText("Claiming actor ID")).toBeNull();
  });

  it("removes private story graphs on role change and never offers GM commands to observers", async () => {
    const api: StoryStudioApi = { get: vi.fn().mockResolvedValue({ data: story, revision: 2 }), create: vi.fn(), command: vi.fn(), preview: shared.projectStoryForPlayers };
    const view = render(<StoryStudioPage campaignId="campaign" authorization={authorization()} api={api} onBack={vi.fn()} />);
    await screen.findByText("Harbor mystery");
    vi.mocked(api.get).mockResolvedValue({ data: { visibleNodes: [], discoveredClues: [] }, revision: 2 });
    view.rerender(<StoryStudioPage campaignId="campaign" authorization={authorization("observer", 2)} api={api} onBack={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Harbor mystery");
    await screen.findByText("Revealed story nodes");
    expect(screen.queryByRole("button", { name: "Prepare a new storyline" })).toBeNull();
    expect(api.command).not.toHaveBeenCalled();
  });

  it("does not offer generation when the existing shell disables it", async () => {
    shell.generationAvailable = false;
    render(<WorldExplorerPage campaignId="campaign" authorization={authorization()} api={worldApi()} onBack={vi.fn()} />);
    await screen.findByText("SECRET AMBUSH");
    expect(screen.queryByRole("button", { name: "Generate world material" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare opening in Create" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Worldbuilding destinations" })).getByRole("button", { name: "NPCs & factions" })).toBeTruthy();
    await waitFor(() => expect(shared.getCampaignGeneratedPlanning).toHaveBeenCalledTimes(1));
  });
});
