import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("campaign administration integrations", () => {
  it("persists conservative safety policy, idempotent receipts, and durable safety requests", () => {
    const repo = createRepository({ clock: { now: () => new Date("2035-01-01T00:00:00.000Z") } });
    const campaign = repo.createCampaign("local-owner", { name: "Safety" });
    const first = repo.updateSessionZeroSafetyPolicy("local-owner", campaign.id, { hardLimits: ["Spiders"], veils: ["Body horror"],
      pvpPolicy: "allowed", romancePolicy: "allowed", lethalityPolicy: "rules-as-written", expectedRevision: 0, idempotencyKey: "safety-one" });
    const replay = repo.updateSessionZeroSafetyPolicy("local-owner", campaign.id, { hardLimits: ["Spiders"], veils: ["Body horror"],
      pvpPolicy: "allowed", romancePolicy: "allowed", lethalityPolicy: "rules-as-written", expectedRevision: 0, idempotencyKey: "safety-one" });
    expect(replay.receipt).toEqual(first.receipt);
    const second = repo.updateSessionZeroSafetyPolicy("local-owner", campaign.id, { hardLimits: ["Harm to children"], veils: [],
      pvpPolicy: "disallowed", romancePolicy: "fade-to-black", lethalityPolicy: "nonlethal-default", expectedRevision: 1, idempotencyKey: "safety-two" });
    expect(second.administration.safety).toMatchObject({ hardLimits: ["Harm to children", "Spiders"], pvpPolicy: "disallowed",
      romancePolicy: "fade-to-black", lethalityPolicy: "nonlethal-default" });
    const paused = repo.requestCampaignSafetyAction("local-owner", campaign.id, { action: "pause", confirmed: true,
      expectedRevision: 2, idempotencyKey: "pause-one" });
    expect(paused.administration.safety.paused).toBe(true);
    const rewind = repo.requestCampaignSafetyAction("local-owner", campaign.id, { action: "rewind", confirmed: true,
      expectedRevision: 3, idempotencyKey: "rewind-one" });
    expect(rewind.receipt).toMatchObject({ checkpointWorkflowRequired: true });
    expect(rewind.receipt.outcome).toMatch(/checkpoint.*fork/i);
    repo.close();
  });

  it("discovers only compiled rulesets and locks selection after mechanical profile configuration", () => {
    const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Rules" });
    const empty = repo.getCampaignAdministrationIntegrations("local-owner", campaign.id)!;
    expect(empty.rulesets.current).toMatchObject({ rulesetId: "dnd-5e", version: "1.0.0" });
    expect(empty.rulesets.mechanicallyEmpty).toBe(true);
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "configure" });
    const configured = repo.getCampaignAdministrationIntegrations("local-owner", campaign.id)!;
    expect(configured.rulesets.current).toMatchObject({ rulesetId: "velvet-starter-v1", version: "1.0.0" });
    expect(configured.rulesets.mechanicallyEmpty).toBe(false);
    expect(() => repo.selectCampaignRuleset("local-owner", campaign.id, { rulesetId: empty.rulesets.current.rulesetId,
      version: empty.rulesets.current.version, digest: empty.rulesets.current.digest, migrationConfirmed: true,
      expectedRevision: 1, idempotencyKey: "rules-change" })).toThrow(/mechanically empty/);
    repo.close();
  });

  it("redacts draft/provider internals for players while retaining exact durable locators", () => {
    const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Recovery" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const at = "2035-01-01T00:00:00.000Z";
    db.prepare("INSERT INTO principals VALUES('player-one','Player',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?, 'player-one', 'player', ?)").run(campaign.id, at);
    db.prepare("INSERT INTO generation_drafts VALUES('draft-safe',?,?,NULL,'local-owner','content-pack',?,'{}','staged',0,0,'draft-key',?,?)")
      .run(campaign.id, campaign.activeTimelineId, JSON.stringify({ privatePrompt: "never expose", providerToken: "secret" }), at, at);
    db.prepare("INSERT INTO campaign_generation_jobs_v52 VALUES('job-safe',?,'job-key',?,'succeeded',1,'draft-safe','ok',?,?)")
      .run(campaign.id, "a".repeat(64), at, at);
    db.prepare("INSERT INTO campaign_generation_attempts_v52 VALUES('job-safe',1,0,'private-provider','private-model','private-response','campaign-generation','candidate','v1','v1',1,1,2,1,0,?,?, 'ok')")
      .run(at, at);
    db.prepare("INSERT INTO campaign_generation_candidate_artifacts_v52 VALUES('draft-safe','public-one','npc','public','{}')").run();
    db.prepare("INSERT INTO campaign_generation_candidate_artifacts_v52 VALUES('draft-safe','gm-one','npc','gm','{}')").run();
    db.close();
    const view = repo.getCampaignAdministrationIntegrations("player-one", campaign.id)!;
    expect(view.generation.drafts[0]).toMatchObject({ draftId: "draft-safe", jobId: "job-safe", artifactCount: 1 });
    expect(JSON.stringify(view)).not.toMatch(/never expose|providerToken|private-provider|private-model|private-response|local-owner/);
    expect(() => repo.updateSessionZeroSafetyPolicy("player-one", campaign.id, { hardLimits: ["limit"], veils: [],
      pvpPolicy: "disallowed", romancePolicy: "disallowed", lethalityPolicy: "nonlethal-default", expectedRevision: 0,
      idempotencyKey: "forbidden" })).toThrow();
    expect(repo.requestCampaignSafetyAction("player-one", campaign.id, { action: "skip", confirmed: true,
      expectedRevision: 0, idempotencyKey: "player-skip" }).receipt.operation).toBe("skip");
    repo.close();
  });

  it("serves GET reconciliation and explicit-confirm safety commands over HTTP", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "HTTP" });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const get = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/administration-integrations` });
    expect(get.statusCode, get.body).toBe(200);
    const rejected = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/safety-action-commands`,
      headers: { "content-type": "application/json" }, payload: { action: "pause", confirmed: false, expectedRevision: 0, idempotencyKey: "pause-http" } });
    expect(rejected.statusCode).toBe(400);
    const paused = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/safety-action-commands`,
      headers: { "content-type": "application/json" }, payload: { action: "pause", confirmed: true, expectedRevision: 0, idempotencyKey: "pause-http" } });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ receipt: { operation: "pause", revisionBefore: 0, revisionAfter: 1 }, administration: { safety: { paused: true } } });
    await app.close();
  });
});
