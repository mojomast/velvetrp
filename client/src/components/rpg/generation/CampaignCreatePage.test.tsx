import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../api";
import { CampaignCreatePage } from "./CampaignCreatePage";
import type { CampaignContentDraftView } from "@velvet/contracts";

vi.mock("../../../api", async (original) => ({
  ...await original<typeof import("../../../api")>(),
  getCampaignAdministration: vi.fn(), getProvider: vi.fn(), preflightProviderCapabilities: vi.fn(),
  getCampaignGeneratedFoundation: vi.fn(), getCampaignGeneratedPlanning: vi.fn(),
  createCampaignContentDraft: vi.fn(), applyCampaignContentDraft: vi.fn(), publishCampaignMaterial: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getCampaignAdministration).mockResolvedValue({ campaign: { actorRole: "gm" } } as Awaited<ReturnType<typeof api.getCampaignAdministration>>);
  vi.mocked(api.getProvider).mockResolvedValue({ providerType: "ollama", model: "local-model", baseUrl: "http://localhost:11434", hasApiKey: false } as api.ProviderSettings);
  vi.mocked(api.getCampaignGeneratedFoundation).mockResolvedValue({ campaignId: "campaign", revision: 0, opening: null });
  vi.mocked(api.getCampaignGeneratedPlanning).mockResolvedValue({ campaignId: "campaign", deliveryRevision: 0, encounters: [], lore: [], questItems: [], monsterConcepts: [], deliverables: [] });
});
afterEach(cleanup);

function openVision(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue: shape the vision" }));
}

function openReview(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue: review safety" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue: plan the world" }));
  fireEvent.click(screen.getByRole("button", { name: "Review LLM request and cost" }));
}

describe("CampaignCreatePage", () => {
  it.each(["player", "observer"])("denies %s without reading provider settings or generating", async (role) => {
    vi.mocked(api.getCampaignAdministration).mockResolvedValue({ campaign: { actorRole: role } } as Awaited<ReturnType<typeof api.getCampaignAdministration>>);
    const onBack = vi.fn();
    render(<CampaignCreatePage campaignId={`denied-${role}`} onBack={onBack} />);
    await screen.findByRole("heading", { name: "DM access required" });
    expect(api.getProvider).not.toHaveBeenCalled();
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue: shape the vision" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to campaign" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("fails closed when permissions cannot be read and supports retry", async () => {
    vi.mocked(api.getCampaignAdministration).mockRejectedValueOnce(new Error("offline"));
    render(<CampaignCreatePage campaignId="retry-permissions" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry permissions" }));
    await screen.findByRole("heading", { name: "Understand the foundation" });
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
  });

  it("shows setup guidance and disables generation when a model is missing", async () => {
    vi.mocked(api.getProvider).mockResolvedValue({ providerType: "ollama", model: "", baseUrl: "http://localhost:11434", hasApiKey: false } as api.ProviderSettings);
    render(<CampaignCreatePage campaignId="missing-model" onBack={vi.fn()} />);
    await screen.findByText(/No model selected/);
    expect((screen.getByRole("button", { name: "Continue: shape the vision" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.preflightProviderCapabilities).not.toHaveBeenCalled();
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
  });

  it("checks provider capability only on explicit request", async () => {
    vi.mocked(api.preflightProviderCapabilities).mockResolvedValue({ model: "local-model", campaignGenerationCompatible: false, dmPlayCompatible: false, ok: false, capabilities: [] });
    render(<CampaignCreatePage campaignId="capability-check" onBack={vi.fn()} />);
    await screen.findByText(/local-model \/ credentials/);
    expect(api.preflightProviderCapabilities).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/^Provider setup:/));
    fireEvent.click(screen.getByRole("button", { name: "Check provider capability (may incur cost)" }));
    await screen.findByText(/Campaign generation capability was not confirmed/);
    expect(api.preflightProviderCapabilities).toHaveBeenCalledOnce();
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
  });

  it("keeps staged review and navigation lossless without mount generation", async () => {
    const onBack = vi.fn();
    const view = render(<CampaignCreatePage campaignId="retained-brief" onBack={onBack} />);
    await screen.findByText(/local-model \/ credentials/);
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "The lantern harbor" } });
    openReview();
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("review");
    expect(screen.queryByRole("button", { name: "Review LLM request and cost" })).toBeNull();
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to campaign" }));
    expect(onBack).toHaveBeenCalledOnce();
    view.unmount();
    render(<CampaignCreatePage campaignId="retained-brief" onBack={onBack} />);
    await screen.findByRole("region", { name: "Final brief review" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Back: edit plan" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Back: edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: /Vision/ }));
    expect((screen.getByLabelText(/^Campaign brief/) as HTMLTextAreaElement).value).toBe("The lantern harbor");
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
  });

  it("wires reviewed generation and explicit application to the real client API module", async () => {
    vi.mocked(api.getCampaignAdministration).mockResolvedValue({ campaign: { actorRole: "owner" } } as Awaited<ReturnType<typeof api.getCampaignAdministration>>);
    const candidate: CampaignContentDraftView = {
      draft: { draftId: "candidate-one", campaignId: "owner-flow", kind: "campaign-content", state: "staged", revision: 0, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
      preview: { outlines: [], arcs: [], locations: [], connections: [], factions: [], npcs: [], quests: [], encounters: [], clues: [], storyNodes: [], storyRelationships: [], lore: [], questItems: [], monsterConcepts: [], scenePrompts: [], handouts: [{ key: "letter", title: "Lantern letter", content: "Meet by the flooded quay", visibility: "public" }], npcStats: { body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" } },
      validationIssues: [], derivativeContextKeys: [],
    };
    vi.mocked(api.createCampaignContentDraft).mockResolvedValue(candidate);
    vi.mocked(api.applyCampaignContentDraft).mockResolvedValue({ draft: { ...candidate.draft, state: "applied", revision: 1 }, application: { scope: "campaign-content", campaignDomainMutated: true, appliedAt: "2030-01-01T00:00:00.000Z" }, receipts: [] });
    render(<CampaignCreatePage campaignId="owner-flow" onBack={vi.fn()} />);
    await screen.findByText(/local-model \/ credentials/);
    expect(api.createCampaignContentDraft).not.toHaveBeenCalled();
    openVision();
    fireEvent.change(screen.getByLabelText(/^Campaign brief/), { target: { value: "Letters from the drowned city" } });
    openReview();
    fireEvent.click(screen.getByRole("button", { name: "Generate candidate with LLM (may incur cost)" }));
    await screen.findByRole("heading", { name: "Review generated material" });
    expect(api.createCampaignContentDraft).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "owner-flow", retryFailedAttempt: null }));
    expect(screen.getByTestId("campaign-create-flow").getAttribute("data-stage")).toBe("candidate");
    expect(screen.queryByRole("button", { name: "Review LLM request and cost" })).toBeNull();
    expect(api.applyCampaignContentDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back: revise plan (keep candidate)" }));
    fireEvent.click(screen.getByRole("button", { name: /Vision/ }));
    expect((screen.getByLabelText(/^Campaign brief/) as HTMLTextAreaElement).value).toBe("Letters from the drowned city");
    fireEvent.click(screen.getByRole("button", { name: /World plan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Return to retained candidate" }));
    expect(screen.getByText("Meet by the flooded quay")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I reviewed the 1 selected candidate artifact/));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected material as canon" }));
    await screen.findByText(/selected campaign material was applied once/);
    expect(api.applyCampaignContentDraft).toHaveBeenCalledWith("candidate-one", expect.objectContaining({ expectedRevision: 0, selectedArtifactKeys: ["letter"] }));
    expect(api.publishCampaignMaterial).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Accept selected material as canon" })).toBeNull();
  });
});
