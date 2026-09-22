import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, generateSceneImage, getSceneImageGallery, getSceneImageJob, getSceneImageSettings,
  putSceneImageSettings, sceneImageAssetUrl, selectSceneImage,
  type SceneImageApi, type SceneImageGalleryItem, type SceneImageSettings,
} from "../../../api";
import { CampaignPlayPage, type CampaignPlayApi } from "./CampaignPlayPage";
import { SceneIllustration, SceneImageDmPanel } from "./SceneImagePanel";
import {
  SCENE_IMAGE_PREFERENCES_KEY,
  parseSceneImageAxis,
  planSceneImageComparison,
  readSceneImagePreferences,
  rememberSceneImageJobs,
} from "./sceneImages";

const at = "2030-01-01T00:00:00.000Z";

const settings: SceneImageSettings = {
  enabled: true, mode: "manual", stylePresetId: "campaign-default", stylePhrase: "", promptOverrides: {},
  steps: 20, guidance: 3, seedMode: "fixed", fixedSeed: 7, variationCount: 1,
  autoPerSessionLimit: 2, cooldownSeconds: 30, bandwidth: "full", hideImages: false, advancedOnlyDm: true,
};

function readyImage(overrides: Partial<SceneImageGalleryItem> = {}): SceneImageGalleryItem {
  return {
    assetId: "asset-1", jobId: "job-1", prompt: "A moonlit gate above the harbor", seed: 7, steps: 20,
    guidance: 3, status: "ready", seconds: 4.2, createdAt: at, selected: true, ...overrides,
  };
}

function sceneApi(overrides: Partial<SceneImageApi> = {}): SceneImageApi {
  return {
    getSettings: vi.fn().mockResolvedValue({ settings, revision: 3 }),
    putSettings: vi.fn(),
    generate: vi.fn().mockResolvedValue({ job: { jobId: "job-new", status: "queued" }, deduped: false }),
    getGallery: vi.fn().mockResolvedValue({ images: [] }),
    select: vi.fn(),
    getJob: vi.fn(),
    assetUrl: (campaignId, assetId) => `/api/rpg/v1/campaigns/${campaignId}/scene-images/assets/${assetId}`,
    ...overrides,
  };
}

afterEach(() => {
  cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("scene image API bindings", () => {
  it("reads and writes settings with exact revisions, no-store, and no secrets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings, revision: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { ...settings, steps: 30 }, revision: 3, receipt: { revisionAfter: 3 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSceneImageSettings("campaign:one")).resolves.toEqual({ settings, revision: 2 });
    await expect(putSceneImageSettings("campaign:one", { expectedRevision: 2, idempotencyKey: "settings-key", settings: { ...settings, steps: 30 } }))
      .resolves.toEqual({ settings: { ...settings, steps: 30 }, revision: 3, receipt: { revisionAfter: 3 } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/rpg/v1/campaigns/campaign%3Aone/scene-images/settings", expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/rpg/v1/campaigns/campaign%3Aone/scene-images/settings");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 2, idempotencyKey: "settings-key", settings: { ...settings, steps: 30 },
    });
  });

  it("accepts the documented 202 generation and binds the exact room and scene", async () => {
    const job = { jobId: "job-9", sessionId: "room", sceneKey: "location:gate", status: "queued" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job, deduped: false }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { sessionId: "room", sceneKey: "location:gate", prompt: "  a gate  ", seed: 7, steps: 20, guidance: 3, count: 2, idempotencyKey: "gen-key" };
    await expect(generateSceneImage("campaign", input)).resolves.toEqual({ job, deduped: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign/scene-images/generate", expect.objectContaining({ method: "POST", cache: "no-store" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ ...input, prompt: "a gate" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { ...job, sceneKey: "location:other" }, deduped: false }), { status: 202 })));
    await expect(generateSceneImage("campaign", input)).rejects.toThrow(/requested scene/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ job, deduped: "no" }), { status: 202 })));
    await expect(generateSceneImage("campaign", input)).rejects.toThrow(/malformed/);
  });

  it("reads the gallery for one session and posts one exact selection", async () => {
    const select = { selection: { sceneKey: "location:gate", assetId: "asset-1" }, receipt: { revisionAfter: 4 } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [readyImage()] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(select), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSceneImageGallery("campaign:one", "room:one")).resolves.toEqual({ images: [readyImage()] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rpg/v1/campaigns/campaign%3Aone/scene-images/gallery?sessionId=room%3Aone");
    const input = { sessionId: "room:one", sceneKey: "location:gate", assetId: "asset-1", expectedRevision: 3, idempotencyKey: "select-key" };
    await expect(selectSceneImage("campaign:one", input)).resolves.toEqual(select);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(input);
    expect(sceneImageAssetUrl("campaign:one", "asset:one")).toBe("/api/rpg/v1/campaigns/campaign%3Aone/scene-images/assets/asset%3Aone");
  });

  it("reads one exact job and rejects a mismatched job identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ job: { jobId: "job:9", status: "ready" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { jobId: "other", status: "ready" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSceneImageJob("campaign", "job:9")).resolves.toEqual({ job: { jobId: "job:9", status: "ready" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rpg/v1/campaigns/campaign/scene-images/jobs/job%3A9");
    await expect(getSceneImageJob("campaign", "job:9")).rejects.toThrow(/did not match/);
  });

  it("plans comparison grids with shared seeds and rejects oversized batches", () => {
    const plan = planSceneImageComparison({ count: 2, steps: [20, 30], guidance: [3], baseSeed: 10 });
    expect(plan.total).toBe(4);
    expect(plan.requests).toEqual([
      { steps: 20, guidance: 3, seed: 10, count: 2 },
      { steps: 30, guidance: 3, seed: 10, count: 2 },
    ]);
    expect(() => planSceneImageComparison({ count: 32, steps: [10, 20, 30, 40, 50, 60, 70, 80], guidance: [1, 2, 3, 4, 5, 6, 7, 8], baseSeed: 0 })).toThrow(/128/);
    expect(parseSceneImageAxis("20, thirty", "steps").error).toMatch(/not a number/);
    expect(parseSceneImageAxis("3", "guidance").values).toEqual([3]);
  });
});

describe("SceneIllustration", () => {
  it("shows the selected image with a scene group label and GM prompt alt text", async () => {
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="gm" enabled api={client} />);
    const image = await screen.findByRole("img", { name: "Old North Gate — A moonlit gate above the harbor" });
    expect(image.getAttribute("src")).toBe("/api/rpg/v1/campaigns/campaign/scene-images/assets/asset-1");
    expect(screen.getByText(/SCENE/)).toBeTruthy();
    expect(screen.getByText("Old North Gate")).toBeTruthy();
    expect(client.getGallery).toHaveBeenCalledWith("campaign", "room");
  });

  it("shows the player-visible scene description as a small caption under the illustration", async () => {
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate"
      sceneDescription="A cold gate above the harbor, its iron hinges furred with salt." audience="player" enabled api={client} />);
    await screen.findByRole("img");
    const caption = screen.getByText("A cold gate above the harbor, its iron hinges furred with salt.");
    expect(caption.className).toContain("scene-illustration-caption");
    expect(caption.getAttribute("title")).toContain("iron hinges");
  });

  it("expands and collapses the clamped location description at the same size", async () => {
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    const description = "A cold gate above the harbor, its iron hinges furred with salt, and beyond it the drowned road climbs"
      + " toward the lampless quarter where the fog never lifts and the bell buoys answer only the tide.";
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate"
      sceneDescription={description} audience="player" enabled api={client} />);
    const caption = await screen.findByText(description);
    expect(caption.className).toContain("scene-illustration-caption");
    expect(caption.className).not.toContain("is-expanded");
    expect(caption.getAttribute("title")).toBe(description);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(caption.className).toContain("is-expanded");
    expect(screen.getByRole("button", { name: "Less" })).toBeTruthy();
    // Expanding keeps the caption paragraph and its full text, only the clamp changes.
    expect(caption.textContent).toBe(description);
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(caption.className).not.toContain("is-expanded");
  });

  it("renders no description control when the scene has no description", async () => {
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled api={sceneApi()} />);
    await screen.findByText(/No illustration has been selected for this scene yet/);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("keeps player alt text free of prompt facts and falls back to text when the gallery fails", async () => {
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    const { unmount } = render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled api={client} />);
    await screen.findByRole("img", { name: "Scene illustration for Old North Gate" });
    unmount();
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled
      api={sceneApi({ getGallery: vi.fn().mockRejectedValue(new ApiError(404, "missing")) })} />);
    await screen.findByText(/An illustration is unavailable for this scene/);
  });

  it("degrades to text when the selected asset fails to load", async () => {
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled api={client} />);
    fireEvent.error(await screen.findByRole("img", { name: "Scene illustration for Old North Gate" }));
    expect(screen.getByText(/could not be displayed/)).toBeTruthy();
  });

  it("says when no illustration is selected yet", async () => {
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled api={sceneApi()} />);
    await screen.findByText(/No illustration has been selected for this scene yet/);
  });

  it("renders nothing while the images flag is off and never fetches", () => {
    const client = sceneApi();
    const { container } = render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="gm" enabled={false} api={client} />);
    expect(container.firstChild).toBeNull();
    expect(client.getGallery).not.toHaveBeenCalled();
  });

  it("respects local hide and text-only preferences and persists changes", async () => {
    localStorage.setItem(SCENE_IMAGE_PREFERENCES_KEY, JSON.stringify({ hideImages: true, reducedBandwidth: false, galleryThumbnailSize: 160 }));
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [readyImage()] }) });
    render(<SceneIllustration campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" audience="player" enabled api={client} />);
    expect(screen.getByText(/Images are hidden by your local preference/)).toBeTruthy();
    expect(client.getGallery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Hide images"));
    await waitFor(() => expect(client.getGallery).toHaveBeenCalledWith("campaign", "room"));
    expect(readSceneImagePreferences().hideImages).toBe(false);
    fireEvent.click(screen.getByLabelText("Text-only"));
    expect(readSceneImagePreferences().reducedBandwidth).toBe(true);
    expect(screen.getByText(/Text-only mode is on/)).toBeTruthy();
  });
});

describe("SceneImageDmPanel", () => {
  function renderPanel(client: SceneImageApi = sceneApi()) {
    return render(<SceneImageDmPanel campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" api={client} canManage enabled />);
  }

  it("applies the workflow presets and states the guidance-1 caveat", async () => {
    const client = sceneApi();
    renderPanel(client);
    await screen.findByRole("button", { name: "Balanced 20/3" });
    expect(screen.getByRole("button", { name: "Preview 10/3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reference 50/3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reference 50/3" }));
    expect((screen.getByLabelText("Steps") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Guidance") as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Experimental 20/guidance-1" }));
    expect((screen.getByLabelText("Steps") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("Guidance") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText(/may weaken prompt adherence/)).toBeTruthy();
  });

  it("shows the total comparison count and confirms grids larger than one before dispatch", async () => {
    const generate = vi.fn().mockImplementation(async (_campaignId: string, body: { steps: number; guidance: number; count: number; seed: number }) =>
      ({ job: { jobId: `job-${body.steps}-${body.guidance}`, sessionId: "room", sceneKey: "location:gate", status: "queued" }, deduped: false }));
    const client = sceneApi({ generate });
    renderPanel(client);
    await screen.findByRole("button", { name: "Balanced 20/3" });
    fireEvent.click(screen.getByLabelText("Compare steps and guidance combinations"));
    fireEvent.change(screen.getByLabelText("Steps to compare"), { target: { value: "20,30" } });
    fireEvent.change(screen.getByLabelText("Guidance to compare"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Variation count"), { target: { value: "2" } });
    await screen.findByText(/Grid: 4 images from 2 requests/);
    const submit = screen.getByRole("button", { name: /Generate comparison grid/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Confirm generating 4 images/));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    const bodies = generate.mock.calls.map((call) => call[1]);
    expect(bodies[0]).toMatchObject({ sessionId: "room", sceneKey: "location:gate", steps: 20, guidance: 3, count: 2, seed: 7 });
    expect(bodies[1]).toMatchObject({ steps: 30, guidance: 3, count: 2, seed: 7 });
    expect(bodies[0]?.idempotencyKey).not.toBe(bodies[1]?.idempotencyKey);
  });

  it("wires selection, regeneration, settings reuse, scene grouping, and two-image comparison", async () => {
    rememberSceneImageJobs("campaign", "room", { sceneKey: "location:gate", label: "Old North Gate", jobIds: ["job-1"] });
    const first = readyImage({ assetId: "asset-1", jobId: "job-1", seed: 11, steps: 50, guidance: 3, selected: false, prompt: "Keeper prompt" });
    const second = readyImage({ assetId: "asset-2", jobId: "job-2", seed: 22, steps: 20, guidance: 1, status: "failed", selected: false, createdAt: "2030-01-02T00:00:00.000Z", prompt: "Other prompt" });
    const third = readyImage({ assetId: "asset-3", jobId: "job-3", seed: 33, steps: 20, guidance: 3, status: "ready", selected: true, createdAt: "2030-01-03T00:00:00.000Z", prompt: "Selected prompt" });
    const select = vi.fn().mockResolvedValue({ selection: { sceneKey: "location:gate", assetId: "asset-1" }, receipt: { revisionAfter: 5 } });
    const generate = vi.fn().mockResolvedValue({ job: { jobId: "job-regenerated", status: "queued" }, deduped: true });
    const client = sceneApi({ getGallery: vi.fn().mockResolvedValue({ images: [first, second, third] }), select, generate });
    const { container } = renderPanel(client);
    await screen.findByRole("heading", { name: /Old North Gate/ });
    for (const name of ["Old North Gate", "Other generated images"]) {
      expect(screen.getByRole("heading", { name: new RegExp(name) })).toBeTruthy();
    }
    const firstCard = () => container.querySelector('[data-asset-id="asset-1"]') as HTMLElement;
    const secondCard = () => container.querySelector('[data-asset-id="asset-2"]') as HTMLElement;
    expect(within(firstCard()).getByText(/seed 11 · steps 50 · guidance 3/)).toBeTruthy();
    expect(within(secondCard()).getByText(/Failed/)).toBeTruthy();

    fireEvent.click(within(firstCard()).getByRole("button", { name: "Use for active scene" }));
    await waitFor(() => expect(select).toHaveBeenCalledWith("campaign", expect.objectContaining({ sessionId: "room", sceneKey: "location:gate", assetId: "asset-1", expectedRevision: 0 })));
    await waitFor(() => expect(client.getGallery).toHaveBeenCalledTimes(2));
    await screen.findByText(/Selected this illustration for Old North Gate/);

    fireEvent.click(within(secondCard()).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("campaign", expect.objectContaining({ prompt: "Other prompt", seed: 22, steps: 20, guidance: 1, count: 1 })));

    fireEvent.click(within(firstCard()).getByRole("button", { name: "Reuse settings" }));
    expect((screen.getByLabelText("Steps") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Guidance") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("11");

    fireEvent.click(within(firstCard()).getByRole("button", { name: "Compare" }));
    const thirdCard = container.querySelector('[data-asset-id="asset-3"]') as HTMLElement;
    fireEvent.click(within(thirdCard).getByRole("button", { name: "Compare" }));
    const comparison = screen.getByRole("region", { name: "Image comparison" });
    expect(within(comparison).getAllByRole("img").length).toBe(2);
  });

  it("hides controls from players and while the flag is off", async () => {
    const player = render(<SceneImageDmPanel campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" api={sceneApi()} canManage={false} enabled />);
    expect(player.getByText(/require the campaign owner or GM/)).toBeTruthy();
    player.unmount();
    const disabled = render(<SceneImageDmPanel campaignId="campaign" sessionId="room" sceneKey="location:gate" sceneLabel="Old North Gate" api={sceneApi()} canManage enabled={false} />);
    expect(disabled.getByText(/unavailable in this deployment/)).toBeTruthy();
  });
});

describe("CampaignPlayPage scene image availability", () => {
  const bootstrap = {
    dm: { mode: "human" as const, revision: 0 }, campaignId: "campaign", sessionId: "session", expectedRevision: 7,
    session: { attached: true as const, attachedAt: at, active: true, adventureEligible: true },
    principal: { role: "player" as const, control: "controlled" as const },
    capabilities: { campaignDice: { canView: false, canRoll: false } },
    playableActors: [{ actorId: "actor", name: "Aria" }],
  };

  function pageApi(): CampaignPlayApi {
    return {
      dm: {
        commandCampaignDmSceneBinding: vi.fn(), getBindingStory: vi.fn(), getBindingQuests: vi.fn(), listCampaignEncounters: vi.fn(),
        getCampaignDmHistory: vi.fn().mockResolvedValue({ control: { campaignId: "campaign", mode: "human", revision: 0 }, runs: [] }),
        commandCampaignDmMode: vi.fn(), commandCampaignDmBeat: vi.fn(), commandCampaignDmDecision: vi.fn(), getCampaignDmRun: vi.fn(),
        getCampaignDmProposal: vi.fn(), resumeCampaignDmRun: vi.fn(),
      },
      getCampaignPlayBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, dm: { mode: "human", revision: 0 } }),
      getAdventureTurnTranscript: vi.fn().mockResolvedValue({ campaignId: "campaign", sessionId: "session", turns: [] }),
      streamAdventureTurn: vi.fn().mockImplementation(() => ({ turnId: Promise.resolve("turn"), done: new Promise<void>(() => undefined), cancelDelivery: vi.fn() })),
      getAdventureTurn: vi.fn(), reconcileInitialAdventureTurn: vi.fn(), confirmAdventureTurn: vi.fn(),
      getCampaignCommandReceipt: vi.fn().mockRejectedValue(new Error("receipt unavailable")),
      getCampaignWorld: vi.fn().mockResolvedValue({ revision: 0, data: { currentLocations: [], visibleLocations: [], visibleConnections: [] } }),
      listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 0, data: { npcs: [] } }),
      listCampaignQuests: vi.fn().mockResolvedValue({ revision: 0, data: { quests: [], objectives: [] } }),
      getActorResources: vi.fn().mockResolvedValue({ resources: [], revision: 0 }),
      getActorGameplaySheet: vi.fn(),
      listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }),
      getCombatState: vi.fn(),
    };
  }

  it("offers Scene images to owner/GM only when the images flag is on", async () => {
    const gm = pageApi();
    vi.mocked(gm.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "gm", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } } });
    const first = render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={gm} sceneImageApi={sceneApi()} imagesEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const setup = await screen.findByRole("group", { name: "Table setup and administration" });
    expect(within(setup).getByRole("button", { name: "Scene images" })).toBeTruthy();
    first.unmount();

    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={pageApi()} sceneImageApi={sceneApi()} imagesEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(screen.queryByRole("button", { name: "Scene images" })).toBeNull();
  });

  it("keeps the DM panel hidden while the images flag is off", async () => {
    const gm = pageApi();
    vi.mocked(gm.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, principal: { role: "gm", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } } });
    const client = sceneApi();
    render(<CampaignPlayPage campaignId="campaign" sessionId="session" authorizationGeneration={1} api={gm} sceneImageApi={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Adventure room" });
    expect(screen.queryByRole("button", { name: "Scene images" })).toBeNull();
    expect(client.getSettings).not.toHaveBeenCalled();
  });
});
