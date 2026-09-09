import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { generatedCampaignContentProviderSchema } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import type { ProviderCompletionInput } from "../../server/src/provider/index.js";
import { closeRepo, MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";
import { dmDependencies, dmFixture } from "../../server/test/fixtures/dmCampaign.js";

test("declaration recalls an old exchange across HTTP without private memory or reload replay", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-memory-"));
  const overrides = { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true",
    FEATURE_RPG_MECHANICS: "true", FEATURE_RPG_COMBAT: "true" };
  const previous = { VELVET_DATA_DIR: process.env.VELVET_DATA_DIR, NODE_ENV: process.env.NODE_ENV,
    FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN, FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
    FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT };
  Object.assign(process.env, overrides);
  closeRepo();
  const f = await dmFixture();
  const calls: ProviderCompletionInput[] = [];
  const narration = "At the Gate, you recall the ferryman's claim that the silver heron arrives at dusk. The road is quiet. What do you ask next?";
  const noProvider = async (): Promise<never> => { throw new Error("Unexpected provider lane in memory acceptance"); };
  const app = buildApp({
    campaignRepositoryFactory: () => f.repo,
    campaignContentGeneration: noProvider,
    encounterGeneration: noProvider,
    adventureAgentDependencies: { ...dmDependencies(async input => {
      calls.push(input);
      return {
        message: input.tools?.some(tool => tool.name === "submit_adventure_narration")
          ? { role: "assistant", content: null, toolCalls: [{ id: "memory-narration", name: "submit_adventure_narration", arguments: JSON.stringify({ narration }) }] }
          : { role: "assistant", content: "No mechanical action requested.", toolCalls: [] },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: { requestedModel: "fake-dm", responseModel: "fake-dm" },
      };
    }), now: f.options.clock.now },
  });
  let request: APIRequestContext | undefined;
  try {
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "opening", opening: "A quiet gate.", premise: "Explore the road.", startLocationKey: "gate", visibility: "public" }],
      locations: [{ key: "gate", name: "Gate", description: "A stone gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
    });
    const context = f.repo.getCampaignGenerationContext("local-owner", f.campaign.id, [])!;
    const draft = f.repo.createGenerationDraft("local-owner", {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
      stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
      expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "memory-canon",
    });
    f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    f.repo.applyCampaignContentGenerationDraftAtomically("local-owner", {
      draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
      idempotencyKey: "memory-apply", selectedArtifactKeys: ["opening", "gate"],
    });

    const other = f.repo.createCharacter({ name: "Other Hero", age: 30, archetype: "Scout", boundaries: "", fictionalConfirmed: true });
    const otherDraft = f.repo.createCharacterDraft("local-owner", f.campaign.id, {
      personaId: other.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "standard-array", scores: { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 } },
      idempotencyKey: "other-draft",
    });
    const reference = (kind: "race" | "background" | "class") => MECHANICS_STARTER_CATALOG.definitions.find(definition => definition.reference.kind === kind)!.reference;
    const selected = f.repo.updateCharacterDraft("local-owner", otherDraft.draft.id, {
      expectedRevision: 0, idempotencyKey: "other-select", selections: {
        race: { ...reference("race"), kind: "race" }, background: { ...reference("background"), kind: "background" },
        class: { ...reference("class"), kind: "class" }, starterGrant: "kit",
      },
    });
    const otherActor = f.repo.finalizeCharacterDraft("local-owner", otherDraft.draft.id, {
      expectedRevision: selected.draft.revision, idempotencyKey: "other-final",
    }).receipt.actorId;
    const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
    try { db.prepare("INSERT INTO session_characters VALUES(?,?,1)").run(f.session.id, other.id); }
    finally { db.close(); }

    // Seed durable source records, not a recall packet or a provider response cache.
    const exchange = (declaration: string, text: string, key: string, actorId = f.actorId) => {
      f.advance();
      let turn = f.repo.createAdventureTurn("local-owner", {
        campaignId: f.campaign.id, sessionId: f.session.id, timelineId: f.campaign.activeTimelineId,
        actorId, declaration, expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
        idempotencyKey: key,
      });
      turn = f.repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${key}-start`, narrationStatus: "in-progress" });
      return f.repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${key}-finish`, narrationStatus: "completed",
        terminalState: "completed", fallbackNarration: text });
    };
    const oldIntent = "I ask the ferryman about the silver heron";
    const oldReply = 'The ferryman claims, "The silver heron arrives at dusk."';
    const old = exchange(oldIntent, oldReply, "old-heron");
    for (let i = 0; i < 105; i++) exchange(`I inspect ordinary cobblestone number ${i}`, `An ordinary paving stone numbered ${i}.`, `noise-${i}`);
    exchange("silver heron OTHER_ACTOR_SECRET", "The silver heron OTHER_ACTOR_REPLY_SECRET", "other-secret", otherActor);
    f.repo.createCampaignRecap("local-owner", f.campaign.id, {
      timelineId: f.campaign.activeTimelineId, throughRevision: 0, selectedSessionIds: [f.session.id], visibility: "gm-only",
      text: "silver heron GM_RECAP_SECRET", expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      idempotencyKey: "gm-secret",
    });
    const recent = f.repo.getAdventureTurnTranscript("local-owner", f.campaign.id, f.session.id);
    expect(recent.length).toBeLessThanOrEqual(32);
    expect(recent.some(turn => turn.turnId === old.turnId)).toBe(false);
    expect(JSON.stringify(recent)).not.toContain(oldReply);

    f.repo.updateCampaignAdministration("local-owner", f.campaign.id, {
      expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      status: "published", idempotencyKey: "memory-publish",
    });
    const readiness = f.repo.getCampaignRoomActivationReadiness("local-owner", f.campaign.id, f.session.id);
    expect(readiness.blockers).toEqual([]);
    f.repo.activateCampaignRoom("local-owner", f.campaign.id, f.session.id, { expectedRevision: readiness.expectedRevision, idempotencyKey: "memory-activate" });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    request = await playwright.request.newContext({ baseURL: origin });
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
    expect(calls).toEqual([]);
    const declaration = "What did the ferryman say about the silver heron?";
    await page.getByRole("textbox", { name: "What do you do?", exact: true }).fill(declaration);
    const streamed = page.waitForResponse(response => response.url().endsWith("/adventure-turns/stream") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Declare action", exact: true }).click();
    const response = await streamed;
    expect(response.status()).toBe(200);
    await expect(page.getByRole("log")).toContainText(narration);
    expect(calls).toHaveLength(2);
    const narrationInput = calls.find(input => input.promptVersion === "adventure-narration-v1")!;
    expect(narrationInput).toBeDefined();
    const data = narrationInput.messages.find(message => typeof message.content === "string" && message.content.startsWith("SERVER-LABELED NARRATION DATA"))!;
    const packet = JSON.parse((data.content as string).split("\n\n").at(-1)!);
    expect(packet.publicCampaignContext.historicalRecall).toMatchObject({ query: "what did the ferryman say about the silver heron",
      hits: expect.arrayContaining([
        expect.objectContaining({ sourceKind: "declaration", sourceId: old.turnId, rootTurnId: old.turnId, actorId: f.actorId, authority: "intent", text: oldIntent }),
        expect.objectContaining({ sourceKind: "presentation", rootTurnId: old.turnId, actorId: f.actorId, authority: "noncanonical-presentation", text: oldReply }),
      ]),
    });
    for (const input of calls) {
      expect(JSON.stringify(input.messages)).not.toMatch(/OTHER_ACTOR_.*SECRET|GM_RECAP_SECRET/);
      const history = input.messages.find(message => typeof message.content === "string" && message.content.startsWith("UNTRUSTED PRIOR ROOM ADVENTURE HISTORY DATA"));
      expect(history).toBeDefined();
      expect(JSON.stringify(history)).not.toContain("arrives at dusk");
    }
    const turnId = response.headers()["x-adventure-turn-id"];
    expect(turnId).toBeTruthy();
    const saved = await request.get(`/api/rpg/v1/adventure-turns/${turnId}`);
    expect(saved.status()).toBe(200);
    expect(await saved.text()).toContain(narration);
    expect(await saved.text()).not.toMatch(/OTHER_ACTOR_.*SECRET|GM_RECAP_SECRET/);
    const writesBeforeReload = [...writes];
    await page.reload();
    await expect(page.getByRole("log")).toContainText(narration);
    const reconciled = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes("adventure-turns"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await reconciled;
    const reread = await request.get(`/api/rpg/v1/adventure-turns/${turnId}`);
    expect(await reread.json()).toEqual(await saved.json());
    expect(writes).toEqual(writesBeforeReload);
    expect(writes.filter(url => url.endsWith("/adventure-turns/stream"))).toHaveLength(1);
    expect(calls).toHaveLength(2);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    await request?.dispose();
    await app.close(); f.repo.close(); closeRepo();
    rmSync(dataDir, { recursive: true, force: true });
    if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
    if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
    if (previous.FEATURE_RPG_COMBAT === undefined) delete process.env.FEATURE_RPG_COMBAT; else process.env.FEATURE_RPG_COMBAT = previous.FEATURE_RPG_COMBAT;
  }
});
