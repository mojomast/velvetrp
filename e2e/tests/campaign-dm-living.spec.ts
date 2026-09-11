import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { generatedCampaignContentProviderSchema, type CampaignDmCandidate } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { closeRepo } from "../../server/src/repo/index.js";
import { createAgentObservationRepository } from "../../server/src/repo/observations/agentObservationRepo.js";
import { dmDependencies, dmFixture } from "../../server/test/fixtures/dmCampaign.js";

test("living director composes ambient/time beats, narrates without a forced question, and never pays on reload", async ({ page, playwright }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-living-"));
  const previous = { VELVET_DATA_DIR: process.env.VELVET_DATA_DIR, NODE_ENV: process.env.NODE_ENV,
    FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN, FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS, FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT };
  process.env.VELVET_DATA_DIR = dataDir; process.env.NODE_ENV = "test";
  process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
  closeRepo();
  const f = await dmFixture();
  const calls: string[] = [];
  const narrationPrompts: string[] = [];
  let mode: "transition" | "hold" = "transition";
  const complete: NonNullable<Parameters<typeof dmDependencies>[0]> = async (input) => {
    if (!input.promptVersion?.startsWith("campaign-dm")) throw new Error("unexpected provider lane");
    calls.push(input.promptVersion);
    if (input.promptVersion === "campaign-dm-narration-v1") {
      narrationPrompts.push(JSON.stringify(input.messages));
      return { message: { role: "assistant", content: null, toolCalls: [{ id: "scene", name: "submit_dm_scene",
        arguments: JSON.stringify({ atmosphere: "A hush falls over the gate as the world breathes.", dialogue: [] }) }] },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, model: { requestedModel: "fake", responseModel: "fake" } };
    }
    const data = JSON.parse(input.messages[1]!.content as string) as { candidates: CampaignDmCandidate[] };
    const ambient = data.candidates.find(candidate => candidate.action === "ambient-beat");
    const advance = data.candidates.find(candidate => candidate.action === "advance-time");
    const composition = mode === "transition" && ambient && advance ? [ambient, advance].map(c => ({ candidateId: c.candidateId, digest: c.digest })) : [];
    return { message: { role: "assistant", content: null, toolCalls: [{ id: "choice", name: "select_dm_beat",
      arguments: JSON.stringify({ composition }) }] }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: { requestedModel: "fake", responseModel: "fake" } };
  };
  const app = buildApp({
    campaignRepositoryFactory: () => f.repo,
    campaignContentGeneration: async () => { throw new Error("unexpected generation"); },
    encounterGeneration: async () => { throw new Error("unexpected generation"); },
    adventureAgentDependencies: dmDependencies(complete),
  });
  try {
    f.graph();
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "opening", opening: "A quiet gate.", premise: "Explore the road.", startLocationKey: "gate", visibility: "public" }],
      locations: [{ key: "gate", name: "Gate", description: "A stone gate.", atmosphere: "Rain on stone.", visibility: "public" }],
    });
    const context = f.repo.getCampaignGenerationContext("local-owner", f.campaign.id, [])!;
    const draft = f.repo.createGenerationDraft("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
      expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "living-canon" });
    f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    f.repo.applyCampaignContentGenerationDraftAtomically("local-owner", { draftId: draft.draftId, expectedDraftRevision: 0,
      expectedCampaignRevision: draft.campaignRevision, idempotencyKey: "living-apply", selectedArtifactKeys: ["opening", "gate"] });
    f.repo.updateCampaignAdministration("local-owner", f.campaign.id, { expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      status: "published", idempotencyKey: "living-publish" });
    const readiness = f.repo.getCampaignRoomActivationReadiness("local-owner", f.campaign.id, f.session.id);
    f.repo.activateCampaignRoom("local-owner", f.campaign.id, f.session.id, { expectedRevision: readiness.expectedRevision, idempotencyKey: "living-activate" });
    const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    const location = (db.prepare("SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key='gate'")
      .get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
    // A present public NPC with a verified ledger row so npcKnowledge reaches the narrator.
    const persona = f.repo.createCharacter({ name: "Maren", age: 40, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = f.repo.createCampaignNpc("local-owner", f.campaign.id, { personaId: persona.id, publicState: { name: "Maren", description: "The gate keeper." },
      privateState: { goals: "SECRET_GOAL", gmNotes: "SECRET_GM", merchantState: null }, expectedRevision: 0, idempotencyKey: "living-npc" }).npc;
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaign.id, sessionId: f.session.id, npcId: npc.npcId, expectedRevision: 0,
      idempotencyKey: "living-place", mutation: { kind: "place", locationId: location } });
    const ledger = createAgentObservationRepository(db, { clock: f.options.clock, ids: { nextId: (() => { let n = 0; return () => `living-obs-${++n}`; })() } });
    ledger.record({ campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, agentKind: "npc", agentId: npc.npcId,
      sourceCommandId: "living-witness", observedRevision: 1, channel: "witnessed", hopCount: 0, text: "Maren saw the party arrive at the gate.", authority: "verified" });

    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = await playwright.request.newContext({ baseURL: origin });
    const room = `/api/rpg/v1/campaigns/${f.campaign.id}/rooms/${f.session.id}/dm`;
    const writes: string[] = [];
    page.on("request", event => { if (event.method() === "POST") writes.push(new URL(event.url()).pathname); });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: `Open campaign ${f.campaign.name}`, exact: true }).click();
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
    await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
    await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await page.getByRole("button", { name: "Review AI delegation", exact: true }).click();
    await page.getByRole("button", { name: "Confirm AI delegation", exact: true }).click();
    expect(calls).toEqual([]);
    await page.getByRole("button", { name: "Open scene", exact: true }).click();
    await expect(page.getByRole("region", { name: "DM chronicle" })).toContainText("A hush falls over the gate");
    expect(calls).toEqual(["campaign-dm-v1", "campaign-dm-narration-v1"]);
    expect(narrationPrompts).toHaveLength(1);
    const narrationPrompt = narrationPrompts[0]!;
    expect(narrationPrompt).not.toContain("SECRET_");
    // The public scene is a transition and carries the NPC ledger knowledge for attribution.
    const messages = JSON.parse(narrationPrompt) as Array<{ content: string }>;
    const publicScene = (JSON.parse(messages[1]!.content) as { publicScene: { transition: boolean; npcKnowledge: unknown[] } }).publicScene;
    expect(publicScene.transition).toBe(true);
    expect(JSON.stringify(publicScene.npcKnowledge)).toContain("Maren saw the party arrive at the gate.");

    // Reload must only read state and never spend another provider call.
    const beforeReload = calls.length;
    await page.reload();
    await page.getByRole("button", { name: "Director", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue scene", exact: true })).toBeEnabled();
    expect(calls).toHaveLength(beforeReload);

    expect(db.prepare("SELECT action FROM dm_composition_receipts ORDER BY ordinal").all())
      .toEqual([{ action: "ambient-beat" }, { action: "advance-time" }]);
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?").get(f.campaign.id, f.session.id))
      .toEqual({ elapsed_minutes: 30 });
    expect(writes.filter(url => url.endsWith("/beat-commands"))).toHaveLength(1);
    await request.dispose(); db.close();
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
