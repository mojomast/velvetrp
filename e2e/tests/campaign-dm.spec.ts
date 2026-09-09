import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { campaignDmHistorySchema, campaignDmRunSchema, generatedCampaignContentProviderSchema, type CampaignDmCandidate } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { closeRepo } from "../../server/src/repo/index.js";
import { dmCompletion, dmDependencies, dmFixture } from "../../server/test/fixtures/dmCampaign.js";

test("director persists explicit delegation, bounded scenes and human review without read replay", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-dm-"));
  const previous = {
    VELVET_DATA_DIR: process.env.VELVET_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN,
    FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
    FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT,
  };
  process.env.VELVET_DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
  closeRepo();
  const f = await dmFixture();
  let action: CampaignDmCandidate["action"] = "reveal-node";
  const calls: string[] = [];
  const publicPrompts: string[] = [];
  const noProvider = async (): Promise<never> => { throw new Error("Unexpected provider lane in director acceptance"); };
  const app = buildApp({
    campaignRepositoryFactory: () => f.repo,
    campaignContentGeneration: noProvider,
    encounterGeneration: noProvider,
    adventureAgentDependencies: dmDependencies(async input => {
      if (!input.promptVersion?.startsWith("campaign-dm")) throw new Error("Unexpected adventure provider call");
      calls.push(input.promptVersion);
      if (input.promptVersion === "campaign-dm-narration-v1") publicPrompts.push(JSON.stringify(input.messages));
      return dmCompletion(input, action);
    }),
  });
  try {
    f.graph();
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "opening", opening: "A quiet gate.", premise: "Explore the road.", startLocationKey: "gate", visibility: "public" }],
      locations: [{ key: "gate", name: "Gate", description: "A stone gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
    });
    const context = f.repo.getCampaignGenerationContext("local-owner", f.campaign.id, [])!;
    const draft = f.repo.createGenerationDraft("local-owner", {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
      expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "dm-canon",
    });
    f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    f.repo.applyCampaignContentGenerationDraftAtomically("local-owner", {
      draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
      idempotencyKey: "dm-apply", selectedArtifactKeys: ["opening", "gate"],
    });
    f.repo.updateCampaignAdministration("local-owner", f.campaign.id, {
      expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      status: "published", idempotencyKey: "dm-e2e-publish",
    });
    const readiness = f.repo.getCampaignRoomActivationReadiness("local-owner", f.campaign.id, f.session.id);
    expect(readiness.blockers).toEqual([]);
    f.repo.activateCampaignRoom("local-owner", f.campaign.id, f.session.id, { expectedRevision: readiness.expectedRevision, idempotencyKey: "dm-activate" });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = await playwright.request.newContext({ baseURL: origin });
    const base = `/api/rpg/v1/campaigns/${f.campaign.id}`;
    const room = `${base}/rooms/${f.session.id}/dm`;
    const writes: string[] = [];
    page.on("request", event => { if (event.method() === "POST") writes.push(new URL(event.url()).pathname); });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
    });
    const enter = async () => {
      await page.goto("/");
      await page.getByRole("button", { name: `Open campaign ${f.campaign.name}`, exact: true }).click();
      await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
      await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
      await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
      await page.getByRole("button", { name: "Director", exact: true }).click();
      await expect(page.getByRole("button", { name: "Refresh DM state", exact: true })).toBeEnabled();
    };
    const history = async () => {
      const response = await request.get(room);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toContain("no-store");
      const text = await response.text();
      expect(text).not.toContain("SECRET_");
      return campaignDmHistorySchema.parse(JSON.parse(text));
    };
    await enter();
    await expect(page.getByRole("heading", { name: "Human DM", exact: true })).toBeVisible();
    expect((await history()).control).toMatchObject({ mode: "human", revision: 0 });
    expect(writes).toEqual([]); expect(calls).toEqual([]);
    const composer = page.getByRole("textbox", { name: "What do you do?" });
    await composer.fill("My unsubmitted player choice");
    const map = await page.getByRole("region", { name: "Campaign maps", exact: true }).elementHandle();
    await page.getByRole("button", { name: "Review AI delegation", exact: true }).click();
    await expect(composer).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Map actor", exact: true })).toBeDisabled();
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "Confirm AI delegation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "AI DM / no human DM", exact: true })).toBeVisible();
    expect((await history()).control).toMatchObject({ mode: "ai", revision: 1 });
    expect(calls).toEqual([]);
    await page.getByRole("button", { name: "Open scene", exact: true }).click();
    await expect(page.getByRole("region", { name: "DM chronicle" })).toContainText("stone gate");
    await expect(page.getByRole("button", { name: "Continue scene", exact: true })).toBeEnabled();
    expect(calls).toEqual(["campaign-dm-v1", "campaign-dm-narration-v1"]);
    await page.getByRole("button", { name: "Close Director", exact: true }).click();
    await expect(composer).toHaveValue("My unsubmitted player choice");
    expect(await map!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.getByRole("region", { name: "DM chronicle" })).toBeVisible();
    await expect(page.getByRole("log")).not.toContainText("SECRET_");
    // No matching encounter candidate: the fake explicitly holds for a player choice.
    action = "encounter-start";
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await page.getByRole("button", { name: "Continue scene", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue scene", exact: true })).toBeEnabled();
    expect(calls).toHaveLength(4);
    const continued = await history();
    expect(continued.runs).toHaveLength(2);
    expect(continued.runs.every(run => run.state === "completed" && run.receipts.length <= 1)).toBe(true);
    await page.getByRole("button", { name: "Take over", exact: true }).click();
    await page.getByRole("button", { name: "Confirm human takeover", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Human DM", exact: true })).toBeVisible();
    expect((await history()).control).toMatchObject({ mode: "human", revision: 2 });
    expect(calls).toHaveLength(4);
    action = "reveal-clue";
    await page.getByRole("button", { name: "Continue scene", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reject proposal", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Close Director", exact: true }).click();
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveValue("My unsubmitted player choice");
    await expect(page.getByRole("combobox", { name: "Map actor", exact: true })).toBeDisabled();
    expect(await map!.evaluate(node => node.isConnected)).toBe(true);
    const awaiting = (await history()).runs.find(run => run.state === "awaiting-approval")!;
    const writesBeforeRead = [...writes];
    // Reload restores the exact saved run through GET, never another planning POST.
    await page.reload();
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reject proposal", exact: true })).toBeEnabled();
    const focusedRead = page.waitForResponse(response => response.url().endsWith(room) && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await focusedRead;
    expect(writes).toEqual(writesBeforeRead); expect(calls).toHaveLength(5);
    const recovered = await request.get(`${room}/runs/${awaiting.runId}`);
    expect(campaignDmRunSchema.parse(await recovered.json())).toEqual(awaiting);
    await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue scene", exact: true })).toBeEnabled();
    expect(calls).toHaveLength(5);
    await page.getByRole("button", { name: "Continue scene", exact: true }).click();
    await page.getByRole("button", { name: "Approve exact proposal", exact: true }).click();
    await expect(page.getByRole("region", { name: "DM chronicle" })).toContainText("brass key");
    await expect(page.getByRole("button", { name: "Continue scene", exact: true })).toBeEnabled();
    expect(calls).toHaveLength(7);
    expect(publicPrompts).toHaveLength(3);
    expect(publicPrompts.join("\n")).not.toContain("SECRET_");
    expect(writes.filter(url => url.endsWith("/beat-commands"))).toHaveLength(4);
    expect(writes.filter(url => url.endsWith("/mode-commands"))).toHaveLength(2);
    expect(writes.filter(url => url.endsWith("/decision-commands"))).toHaveLength(2);
    expect(writes).toHaveLength(8);
    await expect(page.getByRole("region", { name: "DM chronicle" })).not.toContainText("SECRET_");
    const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM adventure_turns").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT mode,revision FROM dm_control WHERE campaign_id=?").get(f.campaign.id)).toEqual({ mode: "human", revision: 2 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
    expect((await history()).control).toMatchObject({ mode: "human", revision: 2 });
    await request.dispose();
  } finally {
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    await app.close(); f.repo.close(); closeRepo();
    rmSync(dataDir, { recursive: true, force: true });
    if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
    if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
    if (previous.FEATURE_RPG_COMBAT === undefined) delete process.env.FEATURE_RPG_COMBAT; else process.env.FEATURE_RPG_COMBAT = previous.FEATURE_RPG_COMBAT;
  }
});
