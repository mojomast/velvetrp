import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { campaignDmHistorySchema, campaignDmReadinessResponseSchema, campaignPlayBootstrapSchema, generatedCampaignContentProviderSchema } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { closeRepo } from "../../server/src/repo/index.js";
import { dmDependencies, dmFixture } from "../../server/test/fixtures/dmCampaign.js";

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

test("GM inspects provider-free readiness and repairs a story obstacle through HTTP", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-dm-readiness-"));
  const previous = {
    VELVET_DATA_DIR: process.env.VELVET_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN,
    FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
  };
  Object.assign(process.env, { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true", FEATURE_RPG_MECHANICS: "true" });
  closeRepo();
  const fixture = await dmFixture();
  let providerCalls = 0;
  const noProvider = async (): Promise<never> => {
    providerCalls += 1;
    throw new Error("Readiness acceptance must not call a provider");
  };
  const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, campaignContentGeneration: noProvider,
    encounterGeneration: noProvider, adventureAgentDependencies: dmDependencies(noProvider) });
  let request: Awaited<ReturnType<typeof playwright.request.newContext>> | undefined;
  try {
    fixture.graph();
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "opening", opening: "A quiet gate.", premise: "Explore the road.", startLocationKey: "gate", visibility: "public" }],
      locations: [{ key: "gate", name: "Gate", description: "A stone gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
    });
    const context = fixture.repo.getCampaignGenerationContext("local-owner", fixture.campaign.id, [])!;
    const draft = fixture.repo.createGenerationDraft("local-owner", {
      campaignId: fixture.campaign.id, timelineId: fixture.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: fixture.options.clock.now().toISOString() },
      expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision, idempotencyKey: "readiness-draft",
    });
    fixture.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    fixture.repo.applyCampaignContentGenerationDraftAtomically("local-owner", { draftId: draft.draftId, expectedDraftRevision: 0,
      expectedCampaignRevision: draft.campaignRevision, idempotencyKey: "readiness-apply", selectedArtifactKeys: ["opening", "gate"] });
    fixture.repo.updateCampaignAdministration("local-owner", fixture.campaign.id, {
      expectedRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision,
      status: "published", idempotencyKey: "readiness-publish",
    });
    const activation = fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
    expect(activation).toMatchObject({ ready: true, blockers: [] });
    fixture.repo.activateCampaignRoom("local-owner", fixture.campaign.id, fixture.session.id, { expectedRevision: activation.expectedRevision, idempotencyKey: "readiness-activate" });

    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    request = await playwright.request.newContext({ baseURL: origin });
    const root = `/api/rpg/v1/campaigns/${fixture.campaign.id}`;
    const room = `${root}/rooms/${fixture.session.id}`;
    const readinessPath = `${room}/dm/preparation-readiness`;
    const writes: string[] = [];
    const readinessGets: string[] = [];
    let delayReadiness = false;
    let delayedRequest: (() => void) | undefined;
    let releaseDelayedResponse: (() => void) | undefined;
    let projectPlayerBootstrap = false;
    let playerProjectionUsed = false;
    page.on("request", event => {
      const url = new URL(event.url());
      if (url.pathname.startsWith("/api/") && event.method() !== "GET" && event.method() !== "HEAD") writes.push(`${event.method()} ${url.pathname}`);
      if (url.pathname === readinessPath) readinessGets.push(event.method());
    });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/play-bootstrap") && projectPlayerBootstrap) {
        playerProjectionUsed = true;
        // UI role-projection coverage only: server route/repository tests own authorization.
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` });
        const bootstrap = campaignPlayBootstrapSchema.parse(await response.json());
        expect(bootstrap).toMatchObject({ campaignId: fixture.campaign.id, sessionId: fixture.session.id });
        await route.fulfill({ status: response.status(), headers: response.headers(), body: JSON.stringify({ ...bootstrap,
          principal: { role: "player", control: "controlled" } }) });
        return;
      }
      if (url.pathname === readinessPath && delayReadiness) {
        delayReadiness = false;
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` });
        delayedRequest?.();
        await new Promise<void>(resolve => { releaseDelayedResponse = resolve; });
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
    });

    await page.goto("/");
    await page.getByRole("button", { name: `Open campaign ${fixture.campaign.name}`, exact: true }).click();
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
    await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
    await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adventure room", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation readiness", exact: true })).toBeVisible();
    expect(readinessGets).toEqual([]);
    expect(writes).toEqual([]);
    await expect(page.getByRole("button", { name: "Inspect preparation", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Inspect preparation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation diagnostics", exact: true })).toBeVisible();
    expect(readinessGets).toEqual(["GET"]);

    const read = async () => {
      const response = await request!.get(readinessPath);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      return campaignDmReadinessResponseSchema.parse(await response.json());
    };
    const before = await read();
    expect(before.activationReadiness).toMatchObject({ ready: true, active: true, blockers: [] });
    expect(before.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "room-obstacle", severity: "blocker", scope: "current-room",
      reference: { kind: "story-node", id: "finale" }, remediation: "activation" })]));
    expect(JSON.stringify(before)).not.toMatch(/SECRET|digest|candidate/);
    await expect(page.getByRole("heading", { name: "Activation readiness", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Inspection coverage: complete", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Manual review limitations", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "DM chronicle" })).not.toContainText("SECRET_");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(mobile).toEqual({ viewport: 390, document: 390, body: 390 });
    for (const control of [page.getByRole("button", { name: "Inspect preparation", exact: true }),
      page.getByRole("heading", { name: "Preparation diagnostics", exact: true }),
      page.getByRole("heading", { name: "Manual review limitations", exact: true })]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    delayReadiness = true;
    const delayed = new Promise<void>(resolve => { delayedRequest = resolve; });
    await page.getByRole("button", { name: "Inspect preparation", exact: true }).click();
    await delayed;
    await page.getByRole("button", { name: "Back to campaign", exact: true }).click();
    await expect(page.getByTestId("campaign-rooms")).toBeVisible();
    releaseDelayedResponse!();
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
    await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
    await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation readiness", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preparation diagnostics", exact: true })).toHaveCount(0);

    const story = "/api/rpg/v1/storylines/story/commands";
    const current = await request.get(`${root}/story`);
    expect(current.status()).toBe(200);
    const revision = Number(current.headers()["x-story-revision"]);
    const reveal = await request.post(story, { data: { kind: "reveal-node", targetId: "gate", data: {}, expectedRevision: revision, idempotencyKey: "readiness-reveal" } });
    expect(reveal.status(), await reveal.text()).toBe(200);
    const resolved = await request.post(story, { data: { kind: "resolve-node", targetId: "gate", data: {}, expectedRevision: revision + 1, idempotencyKey: "readiness-resolve" } });
    expect(resolved.status(), await resolved.text()).toBe(200);
    const after = await read();
    expect(after.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "room-obstacle", reference: { kind: "story-node", id: "finale" } })]));
    expect(after.issues.length).toBeLessThan(before.issues.length);
    await page.getByRole("button", { name: "Inspect preparation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation diagnostics", exact: true })).toBeVisible();
    await expect(page.getByText("Room obstacle", { exact: true })).toHaveCount(0);

    const history = await request.get(`${room}/dm`);
    const sharedHistory = campaignDmHistorySchema.parse(await history.json());
    expect(JSON.stringify(sharedHistory)).not.toMatch(/SECRET|digest|candidate/);
    const writesBeforeReload = [...writes];
    await page.reload();
    const enterAdventure = page.getByRole("button", { name: "Enter adventure", exact: true });
    if (await enterAdventure.isVisible()) {
      await expect(enterAdventure).toBeVisible();
      await enterAdventure.click();
    } else {
      await expect(page.getByRole("heading", { name: "Adventure room", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await page.getByRole("button", { name: "Inspect preparation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation diagnostics", exact: true })).toBeVisible();
    expect(writes).toEqual(writesBeforeReload);
    expect(readinessGets).toEqual(["GET", "GET", "GET", "GET"]);
    await page.getByRole("button", { name: "Back to campaign", exact: true }).click();
    await expect(page.getByTestId("campaign-rooms")).toBeVisible();
    projectPlayerBootstrap = true;
    const readinessBeforePlayer = [...readinessGets];
    await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
    await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adventure room", exact: true })).toBeVisible();
    expect(playerProjectionUsed).toBe(true);
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await expect(page.getByRole("button", { name: "Inspect preparation", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Preparation readiness", exact: true })).toHaveCount(0);
    expect(readinessGets).toEqual(readinessBeforePlayer);
    expect(writes).toEqual(writesBeforeReload);
    expect(providerCalls).toBe(0);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    await request?.dispose();
    await app.close();
    fixture.repo.close();
    closeRepo();
    rmSync(dataDir, { recursive: true, force: true });
    if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
    if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
  }
});
