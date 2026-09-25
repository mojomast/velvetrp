import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedCampaignContentProviderSchema, type Campaign } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { ProviderCompletionInput } from "../src/provider/index.js";
import type { SceneImageEnqueueInput, SceneImageJob } from "../src/image/service.js";
import type { SceneImageRouteService } from "../src/routes/rpg/v1/sceneImages.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  delete process.env.VELVET_SCENE_IMAGES_ENABLED;
});

const OWNER = "local-owner";
const AT = "2036-01-01T00:00:00.000Z";

function makeJob(sceneKey: string, index: number): SceneImageJob {
  return {
    jobId: `img-job-${index}`,
    campaignId: "campaign",
    sessionId: "session",
    sceneKey,
    sceneRevision: 0,
    narrationEventId: null,
    prompt: "p",
    seed: 0,
    steps: 20,
    guidance: 3,
    kind: "single",
    count: 1,
    serviceBatchId: null,
    serviceJobIds: [],
    status: "queued",
    attempts: 0,
    errorCode: null,
    createdAt: AT,
    updatedAt: AT,
    submittedAt: null,
    completedAt: null,
    assetId: null,
  };
}

/**
 * Fake sidecar that models the real receipt idempotency: the same
 * (principal, campaign, operation, idempotencyKey) never creates a second job.
 */
function createFakeSceneImages(enabled = true) {
  const jobsByKey = new Map<string, SceneImageJob>();
  const calls: Array<{ key: string; sceneKey: string }> = [];
  const service = {
    getSettings: vi.fn(() => ({
      settings: { enabled, mode: "automatic", stylePresetId: "campaign-default", stylePhrase: "ink and rain",
        promptOverrides: {}, steps: 20, guidance: 3 },
      revision: 0,
    })),
    updateSettings: vi.fn(),
    enqueue: vi.fn((_principal: string, _campaign: string, input: SceneImageEnqueueInput, key: string) => {
      calls.push({ key, sceneKey: input.sceneKey });
      const existing = jobsByKey.get(key);
      if (existing) return { job: existing, deduped: true, refusal: null as null };
      const job = makeJob(input.sceneKey, jobsByKey.size + 1);
      jobsByKey.set(key, job);
      return { job, deduped: false, refusal: null as null };
    }),
    listGallery: vi.fn(),
    selectImage: vi.fn(),
    getJob: vi.fn(),
    readAsset: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
  } as unknown as SceneImageRouteService;
  return { service, jobsByKey, calls };
}

/** Applies reviewed public + GM-only preparation so only public material is eligible. */
function applyPreparation(repo: Awaited<ReturnType<typeof dmFixture>>["repo"], campaign: Campaign, clock: { now(): Date }) {
  const content = generatedCampaignContentProviderSchema.parse({
    outlines: [{ key: "opening", opening: "The harbor wakes under grey rain.", premise: "Find what the tide hid.", startLocationKey: "harbor", visibility: "public" }],
    locations: [
      { key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" },
      { key: "market", name: "Fish Market", description: "Stalls under dripping awnings.", visibility: "public" },
      { key: "vault", name: "GM Vault", description: "A GM-only hidden vault.", visibility: "gm" },
    ],
    handouts: [
      { key: "welcome", title: "Welcome", content: "A public welcome handout.", visibility: "public" },
      { key: "gm-notes", title: "GM Notes", content: "GM-only notes.", visibility: "gm" },
    ],
    scenePrompts: [
      { key: "arrival", title: "Arrival", prompt: "A public arrival scene.", visibility: "public" },
      { key: "gm-scene", title: "GM Scene", prompt: "A GM-only running scene.", visibility: "gm" },
    ],
  });
  const context = repo.getCampaignGenerationContext(OWNER, campaign.id, [])!;
  const draft = repo.createGenerationDraft(OWNER, {
    campaignId: campaign.id, timelineId: campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: clock.now().toISOString() },
    expectedCampaignRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision,
    idempotencyKey: "startup-content",
  });
  repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "startup-content-apply",
    selectedArtifactKeys: ["opening", "harbor", "market", "vault", "welcome", "gm-notes", "arrival", "gm-scene"],
  });
}

async function startupFixture() {
  const f = await dmFixture();
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  applyPreparation(f.repo, f.campaign, f.options.clock);
  const complete = vi.fn(async (input: ProviderCompletionInput) => dmCompletion(input, "ambient-beat"));
  const scene = createFakeSceneImages();
  const app = buildApp({
    campaignRepositoryFactory: () => f.repo,
    adventureAgentDependencies: dmDependencies(complete),
    sceneImageService: scene.service,
    sceneImageInstallationEnabled: () => true,
  });
  const url = `/api/rpg/v1/campaigns/${f.campaign.id}/rooms/${f.session.id}/startup-commands`;
  return { ...f, app, complete, scene, url };
}

describe("campaign startup route", () => {
  it("switches to AI, publishes public materials, opens the beat, and images each public location", async () => {
    const f = await startupFixture();
    // Human mode is the durable default before the command.
    expect(f.repo.getDmControl(OWNER, f.campaign.id)).toEqual({ campaignId: f.campaign.id, mode: "human", revision: 0 });

    const result = await f.app.inject({ method: "POST", url: f.url, payload: {}, headers: { "content-type": "application/json" } });
    expect(result.statusCode, result.body).toBe(200);
    const body = result.json() as {
      dmMode: string; published: string[]; beat: { state: string; runId: string | null };
      imagesEnqueued: Array<{ locationId: string; jobId: string | null; deduped: boolean }>; blockers: string[];
    };

    // (a) The campaign is now AI-directed at the post-set revision.
    expect(body.dmMode).toBe("ai");
    expect(f.repo.getDmControl(OWNER, f.campaign.id).mode).toBe("ai");

    // (b) The opening beat reached a terminal committed state using the public
    // starting-location fallback (no public story candidate exists).
    expect(body.beat.state).toBe("completed");
    expect(body.beat.runId).not.toBeNull();
    const run = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, body.beat.runId!);
    expect(run.state).toBe("completed");
    expect(run.receipts.map((receipt) => receipt.action)).toEqual(["ambient-beat"]);

    // Only public handouts/scene-prompts were published; GM-only ones were skipped.
    const published = f.repo.getCampaignPublishedMaterials(OWNER, f.campaign.id)!;
    expect(published.materials.map((material) => material.artifactKey).sort()).toEqual(["arrival", "welcome"]);
    expect(body.published.sort()).toEqual(["arrival", "welcome"]);

    // (c) Exactly one image per public location, none for the GM-only location.
    const publicLocationIds = f.repo.getCampaignStartupRead(OWNER, f.campaign.id, f.session.id)!.locations.map((location) => location.locationId);
    expect(publicLocationIds).toHaveLength(2);
    expect(body.imagesEnqueued.map((image) => image.locationId).sort()).toEqual([...publicLocationIds].sort());
    expect(body.imagesEnqueued.every((image) => image.jobId !== null)).toBe(true);
    expect(f.scene.jobsByKey.size).toBe(2);
    const sceneKeys = f.scene.calls.map((call) => call.sceneKey).sort();
    expect(sceneKeys).toEqual(publicLocationIds.map((locationId) => `location:${locationId}`).sort());
    // No GM location id ever reached the image lane.
    expect(sceneKeys.some((sceneKey) => sceneKey.includes("vault"))).toBe(false);

    await f.app.close();
    f.repo.close();
  });

  it("is idempotent on a second identical call", async () => {
    const f = await startupFixture();
    const first = await f.app.inject({ method: "POST", url: f.url, payload: {}, headers: { "content-type": "application/json" } });
    expect(first.statusCode, first.body).toBe(200);
    const providerCallsAfterFirst = f.complete.mock.calls.length;
    const deliveriesAfterFirst = f.repo.getCampaignPublishedMaterials(OWNER, f.campaign.id)!.materials.length;
    const jobsAfterFirst = f.scene.jobsByKey.size;

    const second = await f.app.inject({ method: "POST", url: f.url, payload: {}, headers: { "content-type": "application/json" } });
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json() as {
      beat: { state: string; runId: string | null }; published: string[];
      imagesEnqueued: Array<{ deduped: boolean }>;
    };

    // No new beat was opened or planned, no material was re-published, and every
    // image replay was absorbed by the sidecar's deterministic key.
    expect(secondBody.beat.runId).toBe(first.json().beat.runId);
    expect(secondBody.beat.state).toBe("completed");
    expect(secondBody.published).toEqual([]);
    expect(f.complete.mock.calls.length).toBe(providerCallsAfterFirst);
    expect(f.repo.getCampaignPublishedMaterials(OWNER, f.campaign.id)!.materials.length).toBe(deliveriesAfterFirst);
    expect(f.scene.jobsByKey.size).toBe(jobsAfterFirst);
    expect(secondBody.imagesEnqueued).toHaveLength(2);
    expect(secondBody.imagesEnqueued.every((image) => image.deduped)).toBe(true);

    await f.app.close();
    f.repo.close();
  });

  it("reports a blocked opening and completes it after the campaign is fixed", async () => {
    const f = await dmFixture();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    // No starting location plus a GM-only story node reproduces the hard-blocked
    // opening: every candidate is private, so the planning gate cannot proceed.
    const content = generatedCampaignContentProviderSchema.parse({
      locations: [{ key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" }],
      storyNodes: [{ key: "secret", title: "SECRET_TITLE", description: "SECRET_BODY", visibility: "gm" }],
    });
    const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
    const draft = f.repo.createGenerationDraft(OWNER, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "d".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
      expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
      idempotencyKey: "gm-only-content",
    });
    f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
      draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
      idempotencyKey: "gm-only-apply", selectedArtifactKeys: ["harbor", "secret"],
    });

    const scene = createFakeSceneImages();
    const app = buildApp({
      campaignRepositoryFactory: () => f.repo,
      adventureAgentDependencies: dmDependencies(),
      sceneImageService: scene.service,
      sceneImageInstallationEnabled: () => true,
    });
    const url = `/api/rpg/v1/campaigns/${f.campaign.id}/rooms/${f.session.id}/startup-commands`;

    const blocked = await app.inject({ method: "POST", url, payload: {}, headers: { "content-type": "application/json" } });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json().beat.state).toBe("blocked");
    expect(blocked.json().blockers).toContain("story-public-rendering-required");
    // A blocked opening defers the image step rather than failing the command.
    expect(blocked.json().imagesEnqueued).toEqual([]);
    expect(scene.jobsByKey.size).toBe(0);

    const publicLocation = f.repo.getCampaignStartupRead(OWNER, f.campaign.id, f.session.id)!.locations[0]!;
    f.repo.designateCampaignStartingLocation(OWNER, f.campaign.id, {
      locationId: publicLocation.locationId,
      expectedRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
      idempotencyKey: "fix-starting-location",
    });

    const fixed = await app.inject({ method: "POST", url, payload: {}, headers: { "content-type": "application/json" } });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().beat.state).toBe("completed");
    expect(fixed.json().beat.runId).not.toBe(blocked.json().beat.runId);
    expect(fixed.json().imagesEnqueued).toHaveLength(1);
    expect(scene.jobsByKey.size).toBe(1);

    await app.close();
    f.repo.close();
  });

  it("skips scene images cleanly when the campaign disables them", async () => {
    const f = await startupFixture();
    await f.app.close();
    const disabled = createFakeSceneImages(false);
    const app = buildApp({
      campaignRepositoryFactory: () => f.repo,
      adventureAgentDependencies: dmDependencies(),
      sceneImageService: disabled.service,
      sceneImageInstallationEnabled: () => true,
    });
    const result = await app.inject({ method: "POST", url: f.url, payload: {}, headers: { "content-type": "application/json" } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().imagesEnqueued).toEqual([]);
    expect(disabled.service.enqueue).not.toHaveBeenCalled();
    // The opening beat still ran even though the optional image lane was off.
    expect(result.json().beat.state).toBe("completed");
    await app.close();
    f.repo.close();
  });
});
