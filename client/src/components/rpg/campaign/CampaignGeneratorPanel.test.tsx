import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignContentDraftView, CampaignGeneratedPlanning } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { CampaignGeneratorPanel, type CampaignGeneratorPanelApi } from "./CampaignGeneratorPanel";

const at = "2030-01-01T00:00:00.000Z";

function preview(overrides: Partial<CampaignContentDraftView["preview"]> = {}): CampaignContentDraftView["preview"] {
  return {
    outlines: [], arcs: [], locations: [], connections: [], factions: [], npcs: [], quests: [],
    encounters: [], clues: [], storyNodes: [], storyRelationships: [], handouts: [], scenePrompts: [],
    npcStats: { body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" },
    ...overrides,
  };
}

function draft(candidate: CampaignContentDraftView["preview"]): CampaignContentDraftView {
  return {
    draft: { draftId: "draft-one", campaignId: "campaign", kind: "campaign-content", state: "staged", revision: 0, createdAt: at, updatedAt: at },
    preview: candidate, validationIssues: [],
  };
}

function planning(overrides: Partial<CampaignGeneratedPlanning> = {}): CampaignGeneratedPlanning {
  return { campaignId: "campaign", deliveryRevision: 0, encounters: [], deliverables: [], ...overrides };
}

function client(overrides: Partial<CampaignGeneratorPanelApi> = {}): CampaignGeneratorPanelApi {
  return {
    createCampaignContentDraft: vi.fn(),
    applyCampaignContentDraft: vi.fn(),
    getCampaignGeneratedFoundation: vi.fn().mockResolvedValue({ campaignId: "campaign", revision: 0, opening: null }),
    getCampaignGeneratedPlanning: vi.fn().mockResolvedValue(planning()),
    publishCampaignMaterial: vi.fn(),
    ...overrides,
  } as CampaignGeneratorPanelApi;
}

async function generateCandidate(api: CampaignGeneratorPanelApi): Promise<void> {
  render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
  fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A city divided by an old oath" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate selected sections" }));
  await screen.findByRole("heading", { name: "Review generated material" });
}

afterEach(cleanup);

describe("CampaignGeneratorPanel", () => {
  it("sends sparse sections, bounded feedback, and accepted expansion keys", async () => {
    const create = vi.fn().mockResolvedValue(draft(preview({ locations: [{ key: "old-harbor", name: "Old Harbor", description: "Flooded piers", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }] })));
    const api = client({ createCampaignContentDraft: create });
    render(<CampaignGeneratorPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A drowned city" } });
    for (const name of ["Campaign outline", "Factions", "NPCs", "Quests"]) fireEvent.click(screen.getByLabelText(name));
    fireEvent.change(screen.getByLabelText(/^Focused revision feedback/), { target: { value: "Make the harbor mystery urgent." } });
    fireEvent.change(screen.getByLabelText(/^Accepted artifact keys to expand/), { target: { value: "old-harbor, lantern-guild" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate selected sections" }));
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
      quests: [{ key: "quest", title: "Light the lamps", description: "Restore the beacons", visibility: "public", arcKey: "arc", locationKeys: ["harbor"] }],
      encounters: [{ key: "encounter", title: "Pier standoff", description: "A tense blockade", visibility: "gm", locationKey: "harbor", participantNpcKeys: ["mira"] }],
      storyNodes: [{ key: "secret", title: "The oath", description: "A broken promise", visibility: "gm" }],
      storyRelationships: [{ key: "secret-link", fromStoryNodeKey: "secret", toStoryNodeKey: "secret", description: "Echoes", visibility: "gm" }],
      clues: [{ key: "clue", title: "Wet seal", description: "Marks the oath", visibility: "public", locationKey: "harbor", revealsStoryNodeKey: "secret" }],
      handouts: [{ key: "letter", title: "Salt-stained letter", content: "Meet at dusk", visibility: "public" }],
      scenePrompts: [{ key: "scene", title: "Rising tide", prompt: "The bells ring", visibility: "public", locationKey: "harbor", npcKeys: ["mira"] }],
    });
    const apply = vi.fn().mockResolvedValue({ draft: { ...draft(candidate).draft, state: "applied", revision: 2 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: at }, receipts: [{ receiptId: "receipt", scope: "campaign-content", appliedAt: at }] });
    const api = client({ createCampaignContentDraft: vi.fn().mockResolvedValue(draft(candidate)), applyCampaignContentDraft: apply });
    await generateCandidate(api);
    for (const heading of ["Outlines", "Arcs", "Locations", "Connections", "Factions", "NPCs", "Quests", "Encounter concepts", "Clues", "Story nodes", "Story relationships", "Handouts", "Scene prompts"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/HarborLocation/));
    await screen.findByText(/Deselected 7 dependent candidates/);
    const selected = screen.getAllByRole("checkbox").filter((element) => (element as HTMLInputElement).checked && element.closest(".campaign-generation-artifact"));
    expect(selected.length).toBeLessThan(13);
    fireEvent.click(screen.getByLabelText(/I reviewed the .* selected candidate artifacts/));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected material once" }));
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
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "A lost letter" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate selected sections" }));
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
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "An uncertain path" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate selected sections" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Apply selected material once" }));
    const retryApply = await screen.findByRole("button", { name: "Retry exact apply" });
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(retryApply);
    await screen.findByText(/selected campaign material was applied once/i);
    expect(apply.mock.calls[1]?.[1].idempotencyKey).toBe(apply.mock.calls[0]?.[1].idempotencyKey);
    expect(apply.mock.calls[1]?.[1].selectedArtifactKeys).toEqual(["letter"]);

    const deliver = await screen.findByRole("button", { name: "Deliver to players" });
    fireEvent.click(deliver);
    const retryPublish = await screen.findByRole("button", { name: "Retry exact publication" });
    expect(publish).toHaveBeenCalledTimes(1);
    fireEvent.click(retryPublish);
    await waitFor(() => expect(screen.getByText("Delivered")).toBeTruthy());
    expect(publish.mock.calls[1]?.[1].idempotencyKey).toBe(publish.mock.calls[0]?.[1].idempotencyKey);
  });
});
