import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignContentDraftView, CampaignContentGenerationRequest, CampaignCreateResponse } from "@velvet/contracts";
import { SECTION_FIELDS } from "./worldbuildingPlan";
import { WorldbuildingAgentPanel, type WorldbuildingAgentApi } from "./WorldbuildingAgentPanel";

const at = "2030-01-01T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
    reconcileWorldbuildingGeneration: vi.fn(async (input: CampaignContentGenerationRequest) => ({ campaignId: input.campaignId, idempotencyKey: input.idempotencyKey, state: "not-found" as const, attempt: 0, draftId: null })),
    ...overrides,
  };
}

function previewForRequest(input: CampaignContentGenerationRequest, index: number): CampaignContentDraftView["preview"] {
  const preview = emptyPreview();
  for (const field of input.sections.flatMap((section) => SECTION_FIELDS[section])) {
    (preview as unknown as Record<string, unknown>)[field] = Array.from({ length: input.desiredCounts?.[field] ?? 1 }, (_, n) => ({ key: `${field}-${index}-${n}`, visibility: "public" }));
  }
  if (preview.locations.length) {
    const root = preview.locations[0]!.key;
    preview.connections = preview.locations.slice(1).flatMap((place, n) => [
      { key: `out-${n}`, fromLocationKey: root, toLocationKey: place.key, description: "road", visibility: "public" as const },
      { key: `back-${n}`, fromLocationKey: place.key, toLocationKey: root, description: "road", visibility: "public" as const },
    ]);
  }
  const locationKey = input.expandArtifactKeys.find((key) => key.startsWith("locations-"));
  for (const outline of preview.outlines) outline.startLocationKey = locationKey;
  for (const npc of preview.npcs) npc.locationKey = locationKey;
  for (const scene of preview.scenePrompts) scene.locationKey = locationKey;
  for (const quest of preview.quests) {
    quest.locationKeys = locationKey ? [locationKey] : [];
    quest.objectives = [{ key: `objective-${quest.key}`, description: "Explore", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" }];
  }
  return preview;
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

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
    expect(await screen.findByText(/every planned stage met its coverage targets/i)).toBeTruthy();
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
            { id: "factions", sections: ["factions"], brief: "Create factions.", desiredCounts: { factions: 1 } },
            { id: "cast", sections: ["npcs"], brief: "Create cast.", desiredCounts: { npcs: 1 }, expandFrom: [{ stageId: "factions", fields: ["factions"], limit: 4 }] },
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

  it("blocks incomplete coverage instead of applying or claiming completion", async () => {
    const api = client({ createCampaignContentDraft: vi.fn().mockResolvedValue(stagedDraft(previewWith({ factions: "only-one" }))) });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    expect(await screen.findByText(/factions requires 4, received 1/)).toBeTruthy();
    expect(api.applyCampaignContentDraft).not.toHaveBeenCalled();
    expect(screen.queryByText(/World build completed/)).toBeNull();
    expect(api.createCampaignContentDraft).toHaveBeenCalledWith(expect.objectContaining({ desiredCounts: { factions: 4 } }));
  });

  it("restores interrupted generation without automatic paid redispatch and retries the identical intent", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Connection lost"));
    const api = client({ createCampaignContentDraft: create });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Generation failed/);
    const intent = create.mock.calls[0]![0];
    first.unmount();
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect((screen.getByLabelText(/Premise or description/) as HTMLTextAreaElement).value).toBe("A living forest");
    fireEvent.click(screen.getByRole("button", { name: "Resume world build" }));
    await screen.findByText(/Build paused/);
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile generation" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(intent);
  });

  it("restores an uncertain apply and keeps its exact revision, selection and idempotency key", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1)));
    const apply = vi.fn().mockRejectedValue(new Error("Connection lost"));
    const api = client({ createCampaignContentDraft: create, applyCampaignContentDraft: apply });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Apply outcome could not be confirmed/);
    const intent = apply.mock.calls[0];
    first.unmount();
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact apply" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]).toEqual(intent);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("notifies creation only after starter setup succeeds, and retries setup before generation", async () => {
    const setup = vi.fn().mockRejectedValueOnce(new Error("setup unavailable")).mockResolvedValue({});
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1), { campaignId: "created-campaign" }));
    const onCreated = vi.fn();
    const api = client({ setupSrd51Starter: setup, createCampaignContentDraft: create });
    render(<WorldbuildingAgentPanel api={api} onCampaignCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/starter setup failed/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resume world build" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(11));
    expect(setup).toHaveBeenCalledTimes(2);
    expect(api.createCampaign).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "outcome-uncertain"] as const)("reconciles %s generation without making another paid call", async (state) => {
    const create = vi.fn().mockRejectedValue(new Error("Connection lost"));
    const api = client({ createCampaignContentDraft: create, reconcileWorldbuildingGeneration: vi.fn(async (input: CampaignContentGenerationRequest) => ({ campaignId: input.campaignId, idempotencyKey: input.idempotencyKey, state, attempt: 1, draftId: null })) });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Generation failed/);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile generation" }));
    await screen.findByText(`Generation is ${state}. Reconcile again later; no paid retry was dispatched.`);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("requires a separate explicit paid retry after learning a failed attempt number", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Connection lost"));
    const api = client({ createCampaignContentDraft: create, reconcileWorldbuildingGeneration: vi.fn(async (input: CampaignContentGenerationRequest) => ({ campaignId: input.campaignId, idempotencyKey: input.idempotencyKey, state: "failed" as const, attempt: 2, draftId: null })) });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Generation failed/);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile generation" }));
    await screen.findByText(/The server confirmed a failed generation attempt/);
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry paid generation" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual({ ...create.mock.calls[0]![0], retryFailedAttempt: { failedAttempt: 2 } });
  });

  it("creates from the advanced example with a shared name and placed NPC context", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1), { campaignId: input.campaignId }));
    const api = client({ createCampaignContentDraft: create });
    render(<WorldbuildingAgentPanel api={api} />);
    fireEvent.click(screen.getByLabelText(/Advanced mode/));
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Advanced Reach" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Run all stages" }));
    await screen.findByText(/Progress: 3 of 3 stages applied/);
    expect(api.createCampaign).toHaveBeenCalledWith({ name: "Advanced Reach" });
    expect(create.mock.calls.map(([input]) => input.sections)).toEqual([["factions"], ["locations"], ["npcs"]]);
    expect(create.mock.calls[2]![0].expandArtifactKeys).toEqual(expect.arrayContaining(["locations-1-0", "factions-1-0"]));
    expect(create.mock.calls[2]![0].expandArtifactKeys).toHaveLength(10);
  });

  it("starts another new world after completion while retaining the first campaign journal", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1), { campaignId: input.campaignId }));
    const api = client({
      createCampaignContentDraft: create,
      createCampaign: vi.fn().mockResolvedValueOnce({ campaign: { id: "first-world" } }).mockResolvedValueOnce({ campaign: { id: "second-world" } }),
    });
    const first = render(<WorldbuildingAgentPanel api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "First world" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/);
    first.unmount();
    render(<WorldbuildingAgentPanel api={api} />);
    const completed = sessionStorage.getItem("velvet-worldbuilding-v1:first-world");
    fireEvent.click(screen.getByRole("button", { name: "Build another world" }));
    expect(sessionStorage.getItem("velvet-worldbuilding-v1:new")).toBeNull();
    expect(sessionStorage.getItem("velvet-worldbuilding-v1:first-world")).toBe(completed);
    expect((screen.getByLabelText(/Premise or description/) as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "Second world" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/);
    expect(api.createCampaign).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[11]![0].campaignId).toBe("second-world");
    expect(sessionStorage.getItem("velvet-worldbuilding-v1:first-world")).toBe(completed);
  });

  it("can start another additive plan in an existing campaign after completion", async () => {
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1)));
    const api = client({ createCampaignContentDraft: create });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "First district" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/);
    fireEvent.click(screen.getByRole("button", { name: "Build another world" }));
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "Another district" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/Progress: 11 of 11 stages applied/);
    expect(create).toHaveBeenCalledTimes(22);
    expect(create.mock.calls[11]![0].campaignId).toBe("campaign");
    expect(create.mock.calls[11]![0].idempotencyKey).not.toBe(create.mock.calls[0]![0].idempotencyKey);
    expect(api.createCampaign).not.toHaveBeenCalled();
  });

  it("pauses a late generated response after navigation and recovers its draft without re-generating", async () => {
    const pending = deferred<CampaignContentDraftView>();
    const create = vi.fn<WorldbuildingAgentApi["createCampaignContentDraft"]>().mockReturnValue(pending.promise);
    const api = client({ createCampaignContentDraft: create });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const request = create.mock.calls[0]![0];
    first.unmount();
    const second = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    const draft = stagedDraft(previewForRequest(request, 1), { draftId: "late-draft" });
    await act(async () => { pending.resolve(draft); await pending.promise; });
    expect(api.applyCampaignContentDraft).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const journal = JSON.parse(sessionStorage.getItem("velvet-worldbuilding-v1:campaign")!);
    expect(journal.stages[0]).toMatchObject({ status: "failed", draftId: "late-draft", generationIntent: request });
    expect(journal.stages[1].status).toBe("pending");
    expect(screen.queryByRole("button", { name: "Build another world" })).toBeNull();
    second.unmount();
    vi.mocked(api.getCampaignContentDraft).mockResolvedValue(draft);
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile draft" }));
    await waitFor(() => expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.applyCampaignContentDraft).toHaveBeenCalledWith("late-draft", expect.objectContaining({ idempotencyKey: `${request.idempotencyKey}-apply`, expectedRevision: 0 }));
  });

  it("records a committed apply arriving after unmount without dispatching the next stage", async () => {
    const pending = deferred<Awaited<ReturnType<WorldbuildingAgentApi["applyCampaignContentDraft"]>>>();
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => stagedDraft(previewForRequest(input, 1)));
    const api = client({ createCampaignContentDraft: create, applyCampaignContentDraft: vi.fn().mockReturnValue(pending.promise) });
    const first = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A living forest" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await waitFor(() => expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect(screen.queryByRole("button", { name: "Build another world" })).toBeNull();
    await act(async () => { pending.resolve(applyResponse()); await pending.promise; });
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(1);
    const journal = JSON.parse(sessionStorage.getItem("velvet-worldbuilding-v1:campaign")!);
    expect(journal.stages[0]).toMatchObject({ status: "applied", applyIntent: null });
    expect(journal.stages[1].status).toBe("pending");
    second.unmount();
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    expect(screen.getByText(/Progress: 1 of 11 stages applied/)).toBeTruthy();
  });

  it("explicitly revises a rejected location candidate using a fresh key and retained accepted dependencies", async () => {
    let locationAttempts = 0;
    let rejected: CampaignContentDraftView;
    const create = vi.fn(async (input: CampaignContentGenerationRequest) => {
      const draft = stagedDraft(previewForRequest(input, 1), { draftId: input.sections.includes("locations") ? "location-draft" : "faction-draft" });
      if (input.sections.includes("locations") && ++locationAttempts === 1) {
        draft.preview.locations[0]!.visibility = "gm";
        rejected = draft;
      }
      return draft;
    });
    const api = client({ createCampaignContentDraft: create, getCampaignContentDraft: vi.fn(async () => rejected) });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A hidden coast" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    await screen.findByText(/World-map locations must be public/);
    expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(1);
    const original = create.mock.calls[1]![0];
    fireEvent.click(screen.getByRole("button", { name: "Generate revised stage" }));
    await screen.findByText(/Progress: 2 of 11 stages applied/);
    expect(create).toHaveBeenCalledTimes(3);
    const revised = create.mock.calls[2]![0];
    expect(revised.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(revised.revisionFeedback).toContain("World-map locations must be public");
    expect(revised).toEqual({ ...original, idempotencyKey: revised.idempotencyKey, revisionFeedback: revised.revisionFeedback });
    expect(revised.expandArtifactKeys).toEqual(expect.arrayContaining(["factions-1-0"]));
    expect(api.applyCampaignContentDraft).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(sessionStorage.getItem("velvet-worldbuilding-v1:campaign")!);
    expect(journal.stages[0].status).toBe("applied");
    expect(journal.stages[1].generationKey).toBe(revised.idempotencyKey);
    expect(journal.stages[1].canRevise).toBe(false);
    expect(journal.stages[2].status).toBe("pending");
  });

  it("does not revise a rejected candidate that was subsequently applied elsewhere", async () => {
    const create = vi.fn().mockResolvedValue(stagedDraft(previewWith({ factions: "short-candidate" })));
    const api = client({ createCampaignContentDraft: create, getCampaignContentDraft: vi.fn().mockResolvedValue(appliedDraft("draft")) });
    render(<WorldbuildingAgentPanel campaignId="campaign" api={api} />);
    fireEvent.change(screen.getByLabelText(/Premise or description/), { target: { value: "A hidden coast" } });
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate revised stage" }));
    await screen.findByText(/This candidate was already applied/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.applyCampaignContentDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Generate revised stage" })).toBeNull();
  });
});
