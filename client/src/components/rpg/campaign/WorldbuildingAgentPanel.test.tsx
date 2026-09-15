import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignContentDraftView, CampaignContentGenerationRequest, CampaignCreateResponse } from "@velvet/contracts";
import { SECTION_FIELDS } from "./worldbuildingPlan";
import { WorldbuildingAgentPanel, type WorldbuildingAgentApi } from "./WorldbuildingAgentPanel";

const at = "2030-01-01T00:00:00.000Z";

function emptyPreview(): CampaignContentDraftView["preview"] {
  return {
    outlines: [], arcs: [], locations: [], connections: [], factions: [], npcs: [], quests: [],
    encounters: [], clues: [], storyNodes: [], storyRelationships: [], lore: [], questItems: [], monsterConcepts: [], handouts: [], scenePrompts: [],
    npcStats: { body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" },
  };
}

function previewWith(entries: Partial<Record<keyof CampaignContentDraftView["preview"], string>>): CampaignContentDraftView["preview"] {
  const base = emptyPreview();
  for (const [field, key] of Object.entries(entries)) {
    if (key === undefined) continue;
    (base as unknown as Record<string, unknown>)[field] = [{ key, visibility: "public" }];
  }
  return base;
}

function stagedDraft(preview: CampaignContentDraftView["preview"], options: { draftId?: string; campaignId?: string; validationIssues?: string[] } = {}): CampaignContentDraftView {
  return {
    draft: { draftId: options.draftId ?? "draft", campaignId: options.campaignId ?? "campaign", kind: "campaign-content", state: "staged", revision: 0, createdAt: at, updatedAt: at },
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
  return { campaignId: "campaign", deliveryRevision: 0, encounters: [], lore: [], questItems: [], monsterConcepts: [], deliverables: [] };
}

function client(overrides: Partial<WorldbuildingAgentApi> = {}): WorldbuildingAgentApi {
  return {
    createCampaign: vi.fn().mockResolvedValue({ campaign: { id: "created-campaign" } } as unknown as CampaignCreateResponse),
    setupSrd51Starter: vi.fn().mockResolvedValue({} as never),
    createCampaignContentDraft: vi.fn(),
    getCampaignContentDraft: vi.fn().mockResolvedValue(stagedDraft(emptyPreview())),
    applyCampaignContentDraft: vi.fn().mockResolvedValue(applyResponse()),
    getCampaignGeneratedFoundation: vi.fn().mockResolvedValue({ campaignId: "campaign", revision: 0, opening: null }),
    getCampaignGeneratedPlanning: vi.fn().mockResolvedValue(planning()),
    ...overrides,
  };
}

function previewForRequest(input: CampaignContentGenerationRequest, index: number): CampaignContentDraftView["preview"] {
  const section = input.sections[0]!;
  const field = SECTION_FIELDS[section][0]!;
  return previewWith({ [field]: `${field}-${index}` });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WorldbuildingAgentPanel", () => {
  it("runs the full default plan sequentially in prompt mode and applies each stage", async () => {
    let index = 0;
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => {
      index += 1;
      return stagedDraft(previewForRequest(input, index));
    });
    const apply = vi.fn().mockResolvedValue(applyResponse());
    const api = client({ createCampaignContentDraft: create, applyCampaignContentDraft: apply });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned city under a frozen moon" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(11));
    expect(apply).toHaveBeenCalledTimes(11);
    expect(await screen.findByText(/every planned stage was generated and applied once/i)).toBeTruthy();
    expect(screen.getByText(/Progress: 11 of 11 stages applied/)).toBeTruthy();
    expect(create.mock.calls[0]![0]).toMatchObject({ campaignId: "campaign", sections: ["factions"], tone: "adventurous and grounded" });
    expect(create.mock.calls[0]![0].brief).toContain("A drowned city under a frozen moon");
    expect(api.createCampaign).not.toHaveBeenCalled();
  });

  it("shows per-stage validation issues while still applying the reviewed candidate", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1), { validationIssues: ["Provider omitted a requested detail."] }));
    const api = client({ createCampaignContentDraft: create });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned city" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));

    expect(await screen.findAllByText("Provider omitted a requested detail.")).toBeTruthy();
    await waitFor(() => expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(11));
  });

  it("halts on an uncertain apply and never retries it without an explicit action", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1)));
    const apply = vi.fn().mockRejectedValueOnce(new Error("network reset")).mockResolvedValue(applyResponse());
    const getDraft = vi.fn().mockResolvedValue(stagedDraft(emptyPreview()));
    const api = client({ createCampaignContentDraft: create, applyCampaignContentDraft: apply, getCampaignContentDraft: getDraft });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned city" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));

    expect(await screen.findByText(/Apply outcome could not be confirmed/)).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Apply unconfirmed/)).toBeTruthy();

    const retry = screen.getByRole("button", { name: "Retry exact apply" });
    const firstIntent = apply.mock.calls[0]![1] as { idempotencyKey: string };
    fireEvent.click(retry);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]![1]).toMatchObject({ idempotencyKey: firstIntent.idempotencyKey });
  });

  it("validates advanced plan JSON and surfaces parse and shape errors", () => {
    render(<WorldbuildingAgentPanel campaignId="campaign" api={client()} />);
    fireEvent.click(screen.getByLabelText(/Advanced mode/));
    const textarea = screen.getByLabelText(/Plan JSON/);
    fireEvent.change(textarea, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate plan" }));
    expect(screen.getByRole("alert").textContent).toContain("could not be parsed");

    fireEvent.change(textarea, { target: { value: JSON.stringify({ stages: [{ id: "bad", sections: ["not-a-section"], brief: "x", desiredCounts: { factions: 1 } }] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Validate plan" }));
    expect(screen.getByRole("alert").textContent).toContain("unsupported section");
  });

  it("runs advanced stages individually and resolves expandFrom context from accepted public keys", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => {
      if (input.sections.includes("factions")) return stagedDraft(previewWith({ factions: "guild" }));
      return stagedDraft(previewWith({ npcs: "smuggler" }));
    });
    const api = client({ createCampaignContentDraft: create });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.click(screen.getByLabelText(/Advanced mode/));
    fireEvent.change(screen.getByLabelText(/Plan JSON/), {
      target: {
        value: JSON.stringify({
          tone: "grim",
          exclusions: ["torture"],
          stages: [
            { id: "factions", sections: ["factions"], brief: "Create factions.", desiredCounts: { factions: 4 } },
            { id: "cast", sections: ["npcs"], brief: "Create cast.", desiredCounts: { npcs: 6 }, expandFrom: [{ stageId: "factions", fields: ["factions"], limit: 4 }] },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate plan" }));
    await screen.findByText(/Plan loaded with 2 stages/);

    const runButtons = screen.getAllByRole("button", { name: "Run stage" });
    fireEvent.click(runButtons[0]!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ expandArtifactKeys: [] });

    fireEvent.click(screen.getAllByRole("button", { name: "Run stage" })[1]!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toMatchObject({ expandArtifactKeys: ["guild"], tone: "grim", exclusions: ["torture"] });
    await waitFor(() => expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(2));
  });

  it("creates a campaign and installs the SRD 5.1 starter when no campaign is provided", async () => {
    let index = 0;
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => {
      index += 1;
      expect(input.campaignId).toBe("fresh-campaign");
      return stagedDraft(previewForRequest(input, index), { campaignId: "fresh-campaign" });
    });
    const api = client({
      createCampaign: vi.fn().mockResolvedValue({ campaign: { id: "fresh-campaign" } } as unknown as CampaignCreateResponse),
      createCampaignContentDraft: create,
    });
    render(<WorldbuildingAgentPanel initialCampaignName="Frozen Reach" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A drowned city" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));

    await waitFor(() => expect(api.createCampaign).toHaveBeenCalledWith({ name: "Frozen Reach" }));
    await waitFor(() => expect(api.setupSrd51Starter).toHaveBeenCalledWith("fresh-campaign"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(11));
  });
});
