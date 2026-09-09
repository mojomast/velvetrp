import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignContentDraftView, CampaignGeneratedPlanning } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { CampaignGeneratorPanel, type CampaignGeneratorPanelApi } from "./CampaignGeneratorPanel";
import { writeAuthoringField } from "../generation/generationRecovery";

const at = "2030-01-01T00:00:00.000Z";

function preview(overrides: Partial<CampaignContentDraftView["preview"]> = {}): CampaignContentDraftView["preview"] {
  return {
    outlines: [], arcs: [], locations: [], connections: [], factions: [], npcs: [], quests: [],
    encounters: [], clues: [], storyNodes: [], storyRelationships: [], lore: [], questItems: [], monsterConcepts: [], handouts: [], scenePrompts: [],
    npcStats: { body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" },
    ...overrides,
  };
}

function draft(candidate: CampaignContentDraftView["preview"]): CampaignContentDraftView {
  return {
    draft: { draftId: "draft-one", campaignId: "campaign", kind: "campaign-content", state: "staged", revision: 0, createdAt: at, updatedAt: at },
    preview: candidate, validationIssues: [], derivativeContextKeys: [],
  };
}

function planning(overrides: Partial<CampaignGeneratedPlanning> = {}): CampaignGeneratedPlanning {
  return { campaignId: "campaign", deliveryRevision: 0, encounters: [], lore: [], questItems: [], monsterConcepts: [], deliverables: [], ...overrides };
}

function client(overrides: Partial<CampaignGeneratorPanelApi> = {}): CampaignGeneratorPanelApi {
  return {
    createCampaignContentDraft: vi.fn(),
    applyCampaignContentDraft: vi.fn(),
    getCampaignGeneratedFoundation: vi.fn().mockResolvedValue({ campaignId: "campaign", revision: 0, opening: null }),
    getCampaignGeneratedPlanning: vi.fn().mockResolvedValue(planning()),
    publishCampaignMaterial: vi.fn(),
    getCampaignStartingLocation: vi.fn().mockResolvedValue({ campaignId: "campaign", revision: 1, startingLocation: null }),
    designateCampaignStartingLocation: vi.fn(),
    getCampaignStartingLocationWorld: vi.fn().mockResolvedValue({ currentLocations: [], visibleLocations: [], visibleConnections: [] }),
    ...overrides,
  } as CampaignGeneratorPanelApi;
}

async function generateCandidate(api: CampaignGeneratorPanelApi): Promise<void> {
  render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue: shape the vision" }));
  fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A city divided by an old oath" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue: review safety" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue: plan the world" }));
  fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
  await screen.findByRole("heading", { name: "Review generated material" });
}

function openVision(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue: shape the vision" }));
}

function openScope(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue: review safety" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue: plan the world" }));
}

function reviewAndGenerate(): void {
  fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("CampaignGeneratorPanel", () => {
  it("walks the seven-stage wizard and calls the provider only after explicit review", async () => {
    const candidate = preview({ handouts: [{ key: "letter", title: "Welcome", content: "Meet at dusk", visibility: "public" }] });
    const apply = vi.fn().mockResolvedValue({ draft: { ...draft(candidate).draft, state: "applied", revision: 1 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: at }, receipts: [] });
    const create = vi.fn().mockResolvedValue(draft(candidate));
    render(<CampaignGeneratorPanel campaignId="campaign" api={client({ createCampaignContentDraft: create, applyCampaignContentDraft: apply })} />);
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("foundation");
    openVision();
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("vision");
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A lantern city" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue: review safety" }));
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("safety");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue: plan the world" }));
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("scope");
    fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("review");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
    await screen.findByRole("heading", { name: "Review generated material" });
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("candidate");
    fireEvent.click(screen.getByLabelText(/I reviewed the 1 selected candidate artifact/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    await screen.findByRole("heading", { name: "Choose the opening, then prepare play" });
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("ready");
  });

  it("reloads an exact retained intent and reconciles uncertain ownership without dispatch",async()=>{
    const retained={input:{campaignId:"campaign",brief:"Before reload",tone:"hopeful",exclusions:[],sections:["handouts"],expandArtifactKeys:[],revisionFeedback:null,retryFailedAttempt:null,idempotencyKey:"reload-exact"},failedAttempt:null,ambiguous:true};
    writeAuthoringField("campaign","generationIntent",retained);
    const reconcile=vi.fn().mockResolvedValue({campaignId:"campaign",idempotencyKey:"reload-exact",state:"outcome-uncertain",attempt:1,draftId:null});
    const create=vi.fn().mockResolvedValue(draft(preview()));
    const api=client({createCampaignContentDraft:create,reconcileCampaignGeneration:reconcile});
    const mounted=render(<CampaignGeneratorPanel campaignId="campaign" api={api}/>);
    expect(create).not.toHaveBeenCalled();mounted.unmount();
    render(<CampaignGeneratorPanel campaignId="campaign" api={api}/>);
    fireEvent.click(screen.getByRole("button",{name:"Reconcile without provider call"}));
    await screen.findByText(/It may have charged/);
    expect(reconcile).toHaveBeenCalledWith(retained.input);expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Acknowledge attempt 1 and retry"}));
    await screen.findByRole("heading",{name:"Review generated material"});
    expect(create).toHaveBeenCalledWith({...retained.input,retryFailedAttempt:{failedAttempt:1}});
  });

  it("does not dispatch when the exact intent cannot be persisted",async()=>{
    const create=vi.fn();render(<CampaignGeneratorPanel campaignId="storage-blocked" api={client({createCampaignContentDraft:create})}/>);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/),{target:{value:"No unsafe dispatch"}});
    openScope();fireEvent.click(screen.getByRole("button",{name:"Review LLM request and cost"}));
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
    fireEvent.click(screen.getByRole("button",{name:"Generate candidate with LLM (may incur cost)"}));
    await screen.findByText(/No generation request was sent/);expect(create).not.toHaveBeenCalled();
  });
  it("produces equivalent requests from questionnaire and scripted interview without generating before review", async () => {
    const requests: unknown[] = [];
    for (const interview of [false, true]) {
      const create = vi.fn().mockResolvedValue(draft(preview()));
      render(<CampaignGeneratorPanel campaignId="campaign" api={client({ createCampaignContentDraft: create })} />);
      openVision();
      if (interview) fireEvent.click(screen.getByRole("button", { name: "Scripted guided interview" }));
      const answers = [[/^Campaign brief/, "A drowned city"], [/^Player fantasy/, "Investigators protecting their neighbors"], [/^Stakes and opposition/, "A guild controls the levees"], [/^Opening and scope/, "Six sessions, beginning at a broken floodgate"]] as const;
      for (const [index, [label, value]] of answers.entries()) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        if (interview && index < answers.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next question" }));
      }
      expect(create).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Generate candidate with LLM/ })).toBeNull();
      openScope();fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
      expect(screen.getByRole("region", { name: "Final brief review" }).textContent).toContain("A guild controls the levees");
      expect(create).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
      await screen.findByRole("heading", { name: "Review generated material" });
      const { idempotencyKey: _key, ...request } = create.mock.calls[0]![0];
      requests.push(request);
      cleanup();
      sessionStorage.clear();
    }
    expect(requests[0]).toEqual(requests[1]);
  });

  it("retains answers across mode changes, back navigation, and final review editing", () => {
    const create = vi.fn();
    render(<CampaignGeneratorPanel campaignId="campaign" api={client({ createCampaignContentDraft: create })} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "The old oath" } });
    fireEvent.change(screen.getByLabelText(/^Player fantasy/), { target: { value: "Reluctant heroes" } });
    fireEvent.click(screen.getByRole("button", { name: "Scripted guided interview" }));
    expect((screen.getByLabelText(/^Campaign brief/) as HTMLTextAreaElement).value).toBe("The old oath");
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect((screen.getByLabelText(/^Player fantasy/) as HTMLTextAreaElement).value).toBe("Reluctant heroes");
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    fireEvent.click(screen.getByRole("button", { name: "Questionnaire" }));
    openScope();fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
    fireEvent.click(screen.getByRole("button", { name: "Back: edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: /Vision/ }));
    expect((screen.getByLabelText(/^Player fantasy/) as HTMLTextAreaElement).value).toBe("Reluctant heroes");
    expect(screen.queryByRole("button", { name: /Generate candidate with LLM/ })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps coverage tied to the returned request rather than later scope edits", async () => {
    const api = client({ createCampaignContentDraft: vi.fn().mockResolvedValue(draft(preview({ handouts: [{ key: "letter", title: "Letter", content: "Read this", visibility: "public" }] }))) });
    await generateCandidate(api);
    expect(screen.getByText("Campaign outline: Requested; none returned")).toBeTruthy();
    expect(screen.getByText("Handouts: Not requested; 1 returned")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back: revise plan (keep candidate)" }));
    fireEvent.click(screen.getByLabelText(/Full narrative campaign/));
    fireEvent.click(screen.getByRole("button", { name: "Return to retained candidate" }));
    expect(screen.getByText("Handouts: Not requested; 1 returned")).toBeTruthy();
  });

  it("explains empty and missing generated sections without enabling apply", async () => {
    await generateCandidate(client({ createCampaignContentDraft: vi.fn().mockResolvedValue(draft(preview())) }));
    for (const domain of ["world", "cast", "story", "play"]) expect(screen.getByText(`No ${domain} candidates were returned.`)).toBeTruthy();
    expect(screen.getByText(/provider returned no reviewable artifacts/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept selected material as canon" })).toBeNull();
    expect(screen.getByText("Campaign outline: Requested; none returned")).toBeTruthy();
  });

  it("does not invent requested coverage for a reopened durable draft", async () => {
    render(<CampaignGeneratorPanel campaignId="campaign" openDraftId="draft-one" api={client({ getCampaignContentDraft: vi.fn().mockResolvedValue(draft(preview())) })} />);
    await screen.findByText(/Original requested sections are unavailable/);
    expect(screen.getByText("Campaign outline: Request unknown; none returned")).toBeTruthy();
  });

  it("offers foundation, full narrative, and grouped granular generation", async () => {
    const create = vi.fn().mockResolvedValue(draft(preview({ handouts: [{ key: "letter", title: "Letter", content: "Meet at dawn", visibility: "public" }] })));
    const api = client({ createCampaignContentDraft: create });
    render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "Build the whole drowned-city campaign" } });
    openScope();
    expect((screen.getByLabelText(/Foundation/) as HTMLInputElement).checked).toBe(true);
    for (const group of ["Location / world", "NPC / faction", "Quest / clue", "Encounter", "Story / lore", "Items / monsters", "Handout", "Scene prompt"]) expect(screen.getByText(group)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Full narrative campaign/));
    reviewAndGenerate();
    await screen.findByText("Letter");
    expect(create.mock.calls[0]?.[0].sections).toEqual(["outline", "arcs", "locations", "factions", "npcs", "quests", "encounters", "clues", "story", "lore", "quest-items", "monster-concepts", "handouts", "scene-prompts"]);
    expect(screen.getByText(/Generated handout/i)).toBeTruthy();
  });

  it("sends sparse sections, bounded feedback, and accepted expansion keys", async () => {
    const create = vi.fn().mockResolvedValue(draft(preview({ locations: [{ key: "old-harbor", name: "Old Harbor", description: "Flooded piers", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }] })));
    const accepted = planning({ deliverables: [
      { artifactKey: "old-harbor", resourceId: "old", title: "Old Harbor", visibility: "gm", sourceDraftId: "source", kind: "handout", content: "Harbor context", locationId: null, npcIds: [], publishedAt: null },
      { artifactKey: "lantern-guild", resourceId: "guild", title: "Lantern Guild", visibility: "gm", sourceDraftId: "source", kind: "handout", content: "Guild context", locationId: null, npcIds: [], publishedAt: null },
    ] });
    const api = client({ createCampaignContentDraft: create, getCampaignGeneratedPlanning: vi.fn().mockResolvedValue(accepted) });
    render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A drowned city" } });
    openScope();
    for (const name of ["Campaign outline", "Factions", "NPCs", "Quests"]) fireEvent.click(screen.getByLabelText(name));
    fireEvent.change(screen.getByLabelText(/^Revision direction/), { target: { value: "Make the harbor mystery urgent." } });
    fireEvent.click(await screen.findByLabelText(/Old HarborHandout/));
    fireEvent.click(screen.getByLabelText(/Lantern GuildHandout/));
    reviewAndGenerate();
    await screen.findByText("Old Harbor");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign", sections: ["locations"], revisionFeedback: "Make the harbor mystery urgent.",
      expandArtifactKeys: ["old-harbor", "lantern-guild"], retryFailedAttempt: null,
    }));
  });

  it("previews every candidate kind and applies only a dependency-safe explicit selection", async () => {
    const candidate = preview({
      outlines: [{ key: "outline", opening: "At dawn", premise: "Save the city", visibility: "public", startLocationKey: "harbor" }],
      arcs: [{ key: "arc", title: "Flood arc", summary: "The waters rise", visibility: "gm" }],
      factions: [{ key: "guild", name: "Guild", description: "Lantern keepers", visibility: "public" }],
      locations: [{ key: "harbor", name: "Harbor", description: "Old docks", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: ["guild"] }],
      connections: [{ key: "road", fromLocationKey: "harbor", toLocationKey: "harbor", description: "A loop", visibility: "public" }],
      npcs: [{ key: "mira", name: "Mira", archetype: "Guide", description: "Knows the tide", visibility: "public", locationKey: "harbor", factionKeys: ["guild"] }],
      quests: [{ key: "quest", title: "Light the lamps", description: "Restore the beacons", visibility: "public", arcKey: "arc", locationKeys: ["harbor"], objectives: [], rewards: [] }],
      encounters: [{ key: "encounter", title: "Pier standoff", description: "A tense blockade", visibility: "gm", locationKey: "harbor", participantNpcKeys: ["mira"], objectives: [], terrain: [], escalation: [], enemyReferences: [], monsterConceptKeys: [] }],
      storyNodes: [{ key: "secret", title: "The oath", description: "A broken promise", visibility: "gm" }],
      storyRelationships: [{ key: "secret-link", fromStoryNodeKey: "secret", toStoryNodeKey: "secret", description: "Echoes", visibility: "gm" }],
      clues: [{ key: "clue", title: "Wet seal", description: "Marks the oath", visibility: "public", locationKey: "harbor", revealsStoryNodeKey: "secret" }],
      handouts: [{ key: "letter", title: "Salt-stained letter", content: "Meet at dusk", visibility: "public" }],
      scenePrompts: [{ key: "scene", title: "Rising tide", prompt: "The bells ring", visibility: "public", locationKey: "harbor", npcKeys: ["mira"] }],
    });
    const apply = vi.fn().mockResolvedValue({ draft: { ...draft(candidate).draft, state: "applied", revision: 2 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: at }, receipts: [{ receiptId: "receipt", scope: "campaign-content", appliedAt: at }] });
    const api = client({ createCampaignContentDraft: vi.fn().mockResolvedValue(draft(candidate)), applyCampaignContentDraft: apply });
    await generateCandidate(api);
    for (const heading of ["World", "Cast", "Story", "Play"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/HarborGenerated location/));
    await screen.findByText(/Deselected 7 dependent candidates/);
    const selected = screen.getAllByRole("checkbox").filter((element) => (element as HTMLInputElement).checked && element.closest(".campaign-generation-artifact"));
    expect(selected.length).toBeLessThan(13);
    fireEvent.click(screen.getByLabelText(/I reviewed the .* selected candidate artifacts/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    await screen.findByText(/selected campaign material was applied once/i);
    const input = apply.mock.calls[0]?.[1];
    expect(input.selectedArtifactKeys).not.toContain("harbor");
    expect(input.selectedArtifactKeys).not.toContain("outline");
    expect(input.selectedArtifactKeys).toContain("letter");
  });

  it("retains an ambiguous generation intent and reuses its key only after operator retry", async () => {
    const create = vi.fn().mockRejectedValueOnce(new TypeError("connection reset")).mockResolvedValueOnce(draft(preview({ handouts: [{ key: "letter", title: "Letter", content: "Dawn", visibility: "public" }] })));
    const api = client({ createCampaignContentDraft: create });
    render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A lost letter" } });
    openScope();reviewAndGenerate();
    await screen.findByText(/response is uncertain/i);
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact request with same key" }));
    await screen.findByText("Letter");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0].idempotencyKey).toBe(create.mock.calls[0]?.[0].idempotencyKey);
    expect(create.mock.calls[1]?.[0].retryFailedAttempt).toBeNull();
  });

  it("requires explicit failed-attempt acknowledgement while preserving the generation key", async () => {
    const failure = new ApiError(503, "provider failed"); failure.code = "RPG_GENERATION_UNAVAILABLE";
    const create = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(draft(preview({ arcs: [{ key: "arc", title: "Second chance", summary: "Recovered", visibility: "gm" }] })));
    const api = client({ createCampaignContentDraft: create });
    render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "An uncertain path" } });
    openScope();reviewAndGenerate();
    const retry = await screen.findByRole("button", { name: "Acknowledge attempt 1 and retry" });
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await screen.findByText("Second chance");
    expect(create.mock.calls[1]?.[0]).toMatchObject({ idempotencyKey: create.mock.calls[0]?.[0].idempotencyKey, retryFailedAttempt: { failedAttempt: 1 } });
  });

  it("retains exact apply and publication intents across ambiguous responses", async () => {
    const candidate = preview({ handouts: [{ key: "letter", title: "Candidate letter", content: "Meet at dawn", visibility: "public" }] });
    const applyResult = { draft: { ...draft(candidate).draft, state: "applied" as const, revision: 2 }, application: { scope: "campaign-content" as const, campaignDomainMutated: true as const, appliedAt: at }, receipts: [{ receiptId: "receipt", scope: "campaign-content" as const, appliedAt: at }] };
    const apply = vi.fn().mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce(applyResult);
    const publicPlan = planning({ deliverables: [{ artifactKey: "published-letter", resourceId: "material", title: "Public letter", visibility: "public", sourceDraftId: "source", kind: "handout", content: "Read me", locationId: null, npcIds: [], publishedAt: null }] });
    const publish = vi.fn().mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce({ material: { artifactKey: "published-letter", resourceId: "material", kind: "handout", title: "Public letter", content: "Read me", publishedAt: at }, receipt: { idempotencyKey: "ignored-by-component", revisionBefore: 0, revisionAfter: 1, occurredAt: at } });
    const getPlanning = vi.fn().mockResolvedValue(publicPlan);
    const api = client({ createCampaignContentDraft: vi.fn().mockResolvedValue(draft(candidate)), applyCampaignContentDraft: apply, getCampaignGeneratedPlanning: getPlanning, publishCampaignMaterial: publish });
    await generateCandidate(api);
    fireEvent.click(screen.getByLabelText(/I reviewed the 1 selected candidate artifact/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    const retryApply = await screen.findByRole("button", { name: "Retry exact apply" });
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(retryApply);
    await screen.findByText(/selected campaign material was applied once/i);
    expect(apply.mock.calls[1]?.[1].idempotencyKey).toBe(apply.mock.calls[0]?.[1].idempotencyKey);
    expect(apply.mock.calls[1]?.[1].selectedArtifactKeys).toEqual(["letter"]);

    const deliver = await screen.findByRole("button", { name: "Share this material with players" });
    fireEvent.click(deliver);
    const retryPublish = await screen.findByRole("button", { name: "Retry exact publication" });
    expect(publish).toHaveBeenCalledTimes(1);
    fireEvent.click(retryPublish);
    await waitFor(() => expect(screen.getByText(/Shared with players/)).toBeTruthy());
    expect(publish.mock.calls[1]?.[1].idempotencyKey).toBe(publish.mock.calls[0]?.[1].idempotencyKey);
  });

  it("runs a staged full campaign one bounded request at a time and gates the next request on apply", async () => {
    let releaseFirst: ((value: CampaignContentDraftView) => void) | undefined;
    const first = new Promise<CampaignContentDraftView>((resolve) => { releaseFirst = resolve; });
    const firstCandidate = preview({
      locations: [{ key: "old-harbor", name: "Old Harbor", description: "Flooded piers", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
      arcs: [{ key: "secret-arc", title: "Hidden tide", summary: "GM plans", visibility: "gm" }],
    });
    const secondCandidate = preview({ factions: [{ key: "lamp-guild", name: "Lamp Guild", description: "Harbor keepers", visibility: "public" }] });
    const create = vi.fn().mockImplementationOnce(() => first).mockResolvedValueOnce(draft(secondCandidate));
    const apply = vi.fn().mockResolvedValue({ draft: { ...draft(firstCandidate).draft, state: "applied", revision: 1 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: at }, receipts: [] });
    render(<CampaignGeneratorPanel campaignId="campaign" api={client({ createCampaignContentDraft: create, applyCampaignContentDraft: apply })} />);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "Build the drowned city in stages" } });
    openScope();
    fireEvent.click(screen.getByLabelText(/Full narrative campaign/));
    fireEvent.click(screen.getByLabelText(/Generate in stages/));
    const plan = screen.getByTestId("staged-hydration-plan");
    expect(within(plan).getByText("1. Foundation and places")).toBeTruthy();
    expect(within(plan).getByText("5. Table materials")).toBeTruthy();
    reviewAndGenerate();
    fireEvent.click(screen.getByRole("button", { name: /Generating candidate/ }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].sections).toEqual(["outline", "arcs", "locations"]);
    releaseFirst?.(draft(firstCandidate));
    await screen.findByText("Old Harbor");
    expect(screen.queryByRole("button", { name: "Review next staged request" })).toBeNull();
    fireEvent.click(screen.getByLabelText(/I reviewed the 2 selected candidate artifacts/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    const context = await screen.findByRole("region", { name: "Context for next staged request" });
    expect(within(context).getByText("Old Harbor")).toBeTruthy();
    expect(within(context).queryByText("Hidden tide")).toBeNull();
    expect(context.textContent).not.toContain("old-harbor");
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(within(context).getByLabelText(/Old HarborLocation/));
    fireEvent.click(within(context).getByRole("button", { name: "Review next staged request" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Request 2 of 5: People and powers")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
    await screen.findByText("Lamp Guild");
    expect(create.mock.calls[1]?.[0]).toMatchObject({ sections: ["factions", "npcs"], expandArtifactKeys: ["old-harbor"] });
  });

  it("restores a staged cursor and failed exact request without a mount call or automatic retry", async () => {
    writeAuthoringField("campaign", "stagedMode", true);
    writeAuthoringField("campaign", "hydrationPlan", { version: 1, currentStep: 1, completed: [{ stepId: "foundation", draftId: "draft-one", returnedCount: 2, acceptedCount: 1 }], contextOptions: [{ key: "old-harbor", label: "Old Harbor", kind: "Location" }], contextKeys: ["old-harbor"] });
    const input = { campaignId: "campaign", brief: "Saved staged brief", tone: "hopeful", exclusions: [], sections: ["factions", "npcs"] as const, expandArtifactKeys: ["old-harbor"], revisionFeedback: null, retryFailedAttempt: null, idempotencyKey: "staged-reload" };
    writeAuthoringField("campaign", "generationIntent", { input, failedAttempt: 1, ambiguous: false });
    const create = vi.fn();
    render(<CampaignGeneratorPanel campaignId="campaign" api={client({ createCampaignContentDraft: create })} />);
    expect(await screen.findByText("Request 2 of 5: People and powers")).toBeTruthy();
    expect(screen.getByText(/Paused after failed or uncertain attempt/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Acknowledge attempt 1 and retry" })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports final staged coverage separately from readiness", async () => {
    const completed = [
      { stepId: "foundation", draftId: "draft-foundation", returnedCount: 3, acceptedCount: 2 },
      { stepId: "people", draftId: "draft-people", returnedCount: 2, acceptedCount: 2 },
      { stepId: "story", draftId: "draft-story", returnedCount: 4, acceptedCount: 3 },
      { stepId: "challenges", draftId: "draft-challenges", returnedCount: 3, acceptedCount: 2 },
    ];
    writeAuthoringField("campaign", "hydrationPlan", { version: 1, currentStep: 4, completed, contextOptions: [], contextKeys: [] });
    writeAuthoringField("campaign", "draftId", "draft-one");
    const candidate = preview({ handouts: [{ key: "last-letter", title: "Last Letter", content: "The final clue", visibility: "public" }] });
    const apply = vi.fn().mockResolvedValue({ draft: { ...draft(candidate).draft, state: "applied", revision: 1 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: at }, receipts: [] });
    render(<CampaignGeneratorPanel campaignId="campaign" api={client({ getCampaignContentDraft: vi.fn().mockResolvedValue(draft(candidate)), applyCampaignContentDraft: apply })} />);
    await screen.findByText("Last Letter");
    fireEvent.click(screen.getByLabelText(/I reviewed the 1 selected candidate artifact/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    await screen.findByRole("heading", { name: "Choose the opening, then prepare play" });
    expect(screen.getByText(/Section coverage: 14 of 14 planned sections applied/).textContent).toContain("Coverage is not playable readiness");
  });
});
