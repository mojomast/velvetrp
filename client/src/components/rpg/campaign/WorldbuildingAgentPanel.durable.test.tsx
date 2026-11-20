// Approved test (round-2 playtest kink 10): world-build progress lived only in sessionStorage, so after
// the Cast stage failed live, a new tab (or a browser restart) showed no "Resume world build" and the 3 applied
// stages could not be continued from the UI. Progress must survive a new tab and still resume in order.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CampaignContentDraftView,
  CampaignContentGenerationRequest,
  CampaignCreateResponse,
} from "@velvet/contracts";
import { SECTION_FIELDS } from "./worldbuildingPlan";
import { WorldbuildingAgentPanel, type WorldbuildingAgentApi } from "./WorldbuildingAgentPanel";

const at = "2030-01-01T00:00:00.000Z";

function emptyPreview(): CampaignContentDraftView["preview"] {
  return {
    outlines: [],
    arcs: [],
    locations: [],
    connections: [],
    factions: [],
    npcs: [],
    quests: [],
    encounters: [],
    clues: [],
    storyNodes: [],
    storyRelationships: [],
    lore: [],
    questItems: [],
    monsterConcepts: [],
    handouts: [],
    scenePrompts: [],
    npcStats: { body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" },
  };
}

function stagedDraft(
  preview: CampaignContentDraftView["preview"],
  options: { draftId?: string; campaignId?: string; validationIssues?: string[] } = {},
): CampaignContentDraftView {
  return {
    draft: {
      draftId: options.draftId ?? "draft",
      campaignId: options.campaignId ?? "campaign",
      kind: "campaign-content",
      state: "staged",
      revision: 0,
      createdAt: at,
      updatedAt: at,
    },
    preview,
    validationIssues: options.validationIssues ?? [],
    derivativeContextKeys: [],
  };
}

function appliedDraft(draftId: string): CampaignContentDraftView {
  const base = stagedDraft(emptyPreview(), { draftId });
  return { ...base, draft: { ...base.draft, state: "applied", revision: 1 } };
}

function applyResponse(draftId = "draft") {
  return {
    draft: appliedDraft(draftId).draft,
    application: { scope: "campaign-content" as const, campaignDomainMutated: true as const, appliedAt: at },
    receipts: [{ receiptId: "receipt", scope: "campaign-content" as const, appliedAt: at }],
  };
}

function planning() {
  return {
    campaignId: "campaign",
    deliveryRevision: 0,
    encounters: [],
    lore: [],
    questItems: [],
    monsterConcepts: [],
    deliverables: [],
  };
}

function client(overrides: Partial<WorldbuildingAgentApi> = {}): WorldbuildingAgentApi {
  return {
    createCampaign: vi
      .fn()
      .mockResolvedValue({ campaign: { id: "created-campaign" } } as unknown as CampaignCreateResponse),
    setupSrd51Starter: vi.fn().mockResolvedValue({} as never),
    createCampaignContentDraft: vi.fn(),
    getCampaignContentDraft: vi.fn().mockResolvedValue(stagedDraft(emptyPreview())),
    applyCampaignContentDraft: vi.fn().mockResolvedValue(applyResponse()),
    getCampaignGeneratedFoundation: vi.fn().mockResolvedValue({ campaignId: "campaign", revision: 0, opening: null }),
    getCampaignGeneratedPlanning: vi.fn().mockResolvedValue(planning()),
    reconcileWorldbuildingGeneration: vi.fn(async (input: CampaignContentGenerationRequest) => ({
      campaignId: input.campaignId,
      idempotencyKey: input.idempotencyKey,
      state: "not-found" as const,
      attempt: 0,
      draftId: null,
    })),
    ...overrides,
  };
}

function previewForRequest(
  input: CampaignContentGenerationRequest,
  index: number,
): CampaignContentDraftView["preview"] {
  const preview = emptyPreview();
  for (const field of input.sections.flatMap((section) => SECTION_FIELDS[section])) {
    (preview as unknown as Record<string, unknown>)[field] = Array.from(
      { length: input.desiredCounts?.[field] ?? 1 },
      (_, n) => ({ key: `${field}-${index}-${n}`, visibility: "public" }),
    );
  }
  if (preview.locations.length) {
    const root = preview.locations[0]!.key;
    preview.connections = preview.locations.slice(1).flatMap((place, n) => [
      {
        key: `out-${n}`,
        fromLocationKey: root,
        toLocationKey: place.key,
        description: "road",
        visibility: "public" as const,
      },
      {
        key: `back-${n}`,
        fromLocationKey: place.key,
        toLocationKey: root,
        description: "road",
        visibility: "public" as const,
      },
    ]);
  }
  const locationKey = input.expandArtifactKeys.find((key) => key.startsWith("locations-"));
  for (const outline of preview.outlines) outline.startLocationKey = locationKey;
  for (const npc of preview.npcs) npc.locationKey = locationKey;
  for (const scene of preview.scenePrompts) scene.locationKey = locationKey;
  for (const quest of preview.quests) {
    quest.locationKeys = locationKey ? [locationKey] : [];
    quest.objectives = [
      {
        key: `objective-${quest.key}`,
        description: "Explore",
        targetProgress: 1,
        dependencyObjectiveKeys: [],
        visibility: "public",
      },
    ];
  }
  return preview;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

function failingCast() {
  let index = 0;
  return vi.fn(async (input: CampaignContentGenerationRequest) => {
    if (input.sections.includes("npcs")) throw new Error("Campaign content generation is unavailable");
    index += 1;
    return stagedDraft(previewForRequest(input, index));
  });
}

describe("WorldbuildingAgentPanel durable progress", () => {
  it("offers to resume an interrupted build in a new tab", async () => {
    const create = failingCast();
    const api = client({ createCampaignContentDraft: create });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned archipelago" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 3 of 11 stages applied/);
    first.unmount();

    // A new tab starts with an empty sessionStorage.
    sessionStorage.clear();
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect(await screen.findByText(/Progress: 3 of 11 stages applied/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume world build" })).toBeTruthy();
  });

  it("resumes from the failed stage in the new tab without regenerating applied stages", async () => {
    const create = failingCast();
    const api = client({ createCampaignContentDraft: create });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned archipelago" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 3 of 11 stages applied/);
    const generatedBefore = create.mock.calls.length;
    first.unmount();
    sessionStorage.clear();

    let index = 100;
    const healthy = vi.fn(async (input: CampaignContentGenerationRequest) => {
      index += 1;
      return stagedDraft(previewForRequest(input, index));
    });
    const api2 = client({ createCampaignContentDraft: healthy });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api2} />);
    await screen.findByText(/Progress: 3 of 11 stages applied/);
    fireEvent.click(screen.getByRole("button", { name: "Resume world build" }));
    // A failed paid call is never redispatched automatically; the user reconciles it explicitly.
    await screen.findByText(/Build paused/);
    expect(healthy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile generation" }));
    await screen.findByText(/Progress: 4 of 11 stages applied/);
    fireEvent.click(screen.getByRole("button", { name: "Resume world build" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/, undefined, { timeout: 5000 });
    expect(generatedBefore).toBe(4);
    expect(healthy.mock.calls[0]![0].sections).toContain("npcs");
    expect(healthy.mock.calls.some((call) => call[0].sections.includes("factions"))).toBe(false);
  });

  it("does not resurrect a finished build in a new tab", async () => {
    let index = 0;
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => {
      index += 1;
      return stagedDraft(previewForRequest(input, index));
    });
    const api = client({ createCampaignContentDraft: create });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/);
    first.unmount();
    sessionStorage.clear();
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect(screen.queryByRole("button", { name: "Resume world build" })).toBeNull();
  });
});
