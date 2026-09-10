import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { generatedCampaignContentProviderSchema } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { closeRepo } from "../../server/src/repo/index.js";
import { createSettledDmDispatches, dmDependencies, dmFixture } from "../../server/test/fixtures/dmCampaign.js";

type ProvenanceMode = "record" | "omit";

async function withInspectableDirectorRun(
  page: Page,
  provenanceMode: ProvenanceMode,
  use: (fixture: {
    campaignName: string;
    runId: string;
    planningDispatchId: string;
    narrationDispatchId: string;
    dataDir: string;
    providerCalls: () => number;
  }) => Promise<void>,
) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `velvet-e2e-context-${provenanceMode}-`));
  const previous = {
    VELVET_DATA_DIR: process.env.VELVET_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN,
    FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
    FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT,
  };
  Object.assign(process.env, { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true",
    FEATURE_RPG_MECHANICS: "true", FEATURE_RPG_COMBAT: "true" });
  closeRepo();
  const fixture = await dmFixture(false, { dataDir, ...(provenanceMode === "omit" ? { contextInspectionProvenance: "omit" as const } : {}) });
  let providerCalls = 0;
  const noProvider = async (): Promise<never> => { providerCalls += 1; throw new Error("Context inspection must not call a provider"); };
  const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, campaignContentGeneration: noProvider,
    encounterGeneration: noProvider, adventureAgentDependencies: dmDependencies(noProvider) });
  try {
    const run = await createSettledDmDispatches(fixture);
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "opening", opening: "A quiet gate.", premise: "Inspect the recorded scene.", startLocationKey: "gate", visibility: "public" }],
      locations: [{ key: "gate", name: "Gate", description: "A stone gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
    });
    const context = fixture.repo.getCampaignGenerationContext("local-owner", fixture.campaign.id, [])!;
    const draft = fixture.repo.createGenerationDraft("local-owner", {
      campaignId: fixture.campaign.id, timelineId: fixture.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: fixture.options.clock.now().toISOString() },
      expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: `context-${provenanceMode}-canon`,
    });
    fixture.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    fixture.repo.applyCampaignContentGenerationDraftAtomically("local-owner", { draftId: draft.draftId, expectedDraftRevision: 0,
      expectedCampaignRevision: draft.campaignRevision, idempotencyKey: `context-${provenanceMode}-apply`, selectedArtifactKeys: ["opening", "gate"] });
    fixture.repo.updateCampaignAdministration("local-owner", fixture.campaign.id, {
      expectedRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision,
      status: "published", idempotencyKey: `context-${provenanceMode}-publish`,
    });
    const readiness = fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
    expect(readiness.blockers).toEqual([]);
    fixture.repo.activateCampaignRoom("local-owner", fixture.campaign.id, fixture.session.id, {
      expectedRevision: readiness.expectedRevision, idempotencyKey: `context-${provenanceMode}-activate`,
    });

    const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"), { readonly: true });
    const dispatches = db.prepare(`SELECT planning.claim_id planning_id, narration.claim_id narration_id
      FROM dm_dispatches planning JOIN dm_narration_dispatches narration USING(run_id) WHERE planning.run_id=?`)
      .get(run.runId) as { planning_id: string; narration_id: string };
    db.close();
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
    });
    await use({ campaignName: fixture.campaign.name, runId: run.runId, planningDispatchId: dispatches.planning_id,
      narrationDispatchId: dispatches.narration_id, dataDir, providerCalls: () => providerCalls });
  } finally {
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    await app.close(); fixture.repo.close(); closeRepo();
    rmSync(dataDir, { recursive: true, force: true });
    if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
    if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
    if (previous.FEATURE_RPG_COMBAT === undefined) delete process.env.FEATURE_RPG_COMBAT; else process.env.FEATURE_RPG_COMBAT = previous.FEATURE_RPG_COMBAT;
  }
}

async function enterDirector(page: Page, campaignName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Open campaign ${campaignName}`, exact: true }).click();
  await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
  await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
  await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
  await page.getByRole("button", { name: "Director", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Context inspection", exact: true })).toBeVisible();
}

test("GM inspects one exact persisted director dispatch without replaying provider work", async ({ page }) => {
  test.setTimeout(90_000);
  await withInspectableDirectorRun(page, "record", async ({ campaignName, runId, planningDispatchId, narrationDispatchId, dataDir, providerCalls }) => {
    const providerCapablePosts: string[] = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && (/adventure-turns\/stream$/.test(pathname) || /\/dm\/(beat-commands|runs\/[^/]+\/resume)$/.test(pathname))) providerCapablePosts.push(pathname);
    });
    await enterDirector(page, campaignName);

    const composer = page.getByRole("textbox", { name: "What do you do?", exact: true });
    await composer.fill("Unsubmitted context-inspection draft");
    const map = page.getByRole("region", { name: "Campaign maps", exact: true });
    const conversation = page.getByRole("region", { name: "Campaign narration and actions", exact: true });
    const mapHandle = await map.elementHandle();
    const conversationHandle = await conversation.elementHandle();
    const source = page.getByRole("combobox", { name: "Turn or director run", exact: true });
    await source.selectOption(`director-run:${runId}`);
    await expect(source.locator("option:checked")).toHaveText(`Director run ${runId} (open, completed)`);

    const referencesResponse = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().endsWith(`/context-inspection/references/director-run/${encodeURIComponent(runId)}`));
    await page.getByRole("button", { name: "Load dispatch references", exact: true }).click();
    const references = await referencesResponse;
    expect(references.status()).toBe(200);
    expect(await references.json()).toMatchObject({ identity: { source: { kind: "director-run", sourceId: runId } }, references: [
      { lane: "director-planning", dispatchId: planningDispatchId },
      { lane: "director-narration", dispatchId: narrationDispatchId },
    ] });

    const dispatch = page.getByRole("combobox", { name: "Recorded dispatch", exact: true });
    await dispatch.selectOption(`director-planning:${planningDispatchId}`);
    await expect(dispatch.locator("option:checked")).toHaveText(`Director planning (${planningDispatchId})`);
    const inspectionResponse = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().endsWith(`/context-inspection/director-planning/${encodeURIComponent(planningDispatchId)}`));
    await page.getByRole("button", { name: "Inspect selected dispatch", exact: true }).click();
    const inspection = await inspectionResponse;
    expect(inspection.status()).toBe(200);
    const inspectionBody = await inspection.json();
    expect(inspectionBody).toMatchObject({ identity: { lane: "director-planning", dispatchId: planningDispatchId }, availability: "available",
      dispatch: { recordedPhase: "planned", certainty: "provider-receipt-confirmed", settlement: "settled" }, recallHits: [] });
    expect(inspectionBody.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "included", kind: "other", label: "Private director context" }),
      expect.objectContaining({ status: "included", kind: "other", label: "Historical recall" }),
      expect.objectContaining({ status: "withheld", kind: "other", reason: "private-source" }),
    ]));
    const result = page.getByRole("article", { name: "Context inspection result", exact: true });
    await expect(result).toContainText("Recorded phase: planned. Certainty: provider-receipt-confirmed. Settlement: settled.");
    await expect(result).toContainText("Private director context was retained in the frozen dispatch sidecar");
    await expect(result).toContainText("other: Withheld because the source is private.");
    await expect(result).toContainText("Serialized stored request (UTF-8 bytes)Withheld or not reported");

    const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"), { readonly: true });
    try {
      expect(db.prepare(`SELECT header.recorded_phase, header.source_visibility, source.source_kind, source.authority
        FROM campaign_context_inspection_headers_v61 header JOIN campaign_context_inspection_sources_v61 source USING(dispatch_id)
        WHERE header.dispatch_id=?`).get(planningDispatchId)).toEqual({ recorded_phase: "planned", source_visibility: "private", source_kind: "none", authority: "system-safety" });
    } finally { db.close(); }
    expect(providerCapablePosts).toEqual([]);
    expect(providerCalls()).toBe(0);
    expect(await mapHandle!.evaluate(node => node.isConnected)).toBe(true);
    expect(await conversationHandle!.evaluate(node => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted context-inspection draft");

    await page.reload();
    await expect(page.getByRole("region", { name: "Campaign maps", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Campaign narration and actions", exact: true })).toContainText("A quiet moment leaves room to consider the scene.");
    await expect(page.getByRole("textbox", { name: "What do you do?", exact: true })).toBeEnabled();
    expect(providerCapablePosts).toEqual([]);
    expect(providerCalls()).toBe(0);
  });
});

test("GM sees a safe unavailable state when exact dispatch provenance was not recorded", async ({ page }) => {
  test.setTimeout(90_000);
  await withInspectableDirectorRun(page, "omit", async ({ campaignName, runId, planningDispatchId, providerCalls }) => {
    await enterDirector(page, campaignName);
    await page.getByRole("combobox", { name: "Turn or director run", exact: true }).selectOption(`director-run:${runId}`);
    await page.getByRole("button", { name: "Load dispatch references", exact: true }).click();
    await page.getByRole("combobox", { name: "Recorded dispatch", exact: true }).selectOption(`director-planning:${planningDispatchId}`);
    await page.getByRole("button", { name: "Inspect selected dispatch", exact: true }).click();
    await expect(page.locator(".dm-context-inspection").getByRole("status")).toContainText("Inspectable context was not recorded for this dispatch.");
    await expect(page.getByRole("article", { name: "Context inspection result", exact: true })).toHaveCount(0);
    expect(providerCalls()).toBe(0);
  });
});
