import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { seedLivingWorld } from "./fixtures/livingWorld.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
/** The exact declaration S3 flagged as a discoverability dead-end in the seed world. */
const PROBE = "I approach a hooded stranger leaning on a bollard and demand to know their name and business.";
const dbFile = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

type Fixture = Awaited<ReturnType<typeof dmFixture>>;
let sequence = 0;

/** A provider that must never run for a pure unknown-person declaration. */
function noDispatch(dispatches: { count: number }): AdventureAgentDependencies {
  return {
    complete: async () => { dispatches.count += 1; throw new Error("provider must not dispatch for an unknown-person declaration"); },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
    getHarness: async () => defaultHarnessSettings(), now: () => new Date("2036-01-01T00:00:00.000Z"),
  };
}

function turn(f: Fixture, declaration: string) {
  return f.repo.createAdventureTurn(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id, actorId: f.actorId,
    declaration, expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: `unknown-person-${++sequence}`,
  });
}

/**
 * Seeds one generated public location through the ordinary accept path and places the actor there,
 * so the freeform classifier has a generated public source location to anchor an ad-hoc persona.
 * Mirrors `server/test/freeform-npc.test.ts`.
 */
function seedHarbor(f: Fixture): void {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{ key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "unknown-person-harbor",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "unknown-person-harbor-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = new DatabaseDriver(dbFile());
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, { type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId,
    locationId, expectedRevision: 0, idempotencyKey: "unknown-person-place-hero" });
}

function checkCounts(campaignId: string): { batches: number; executions: number } {
  const db = new DatabaseDriver(dbFile(), { readonly: true });
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE campaign_id=?`).get(campaignId) as { n: number }).n;
  const value = { batches: count("adventure_check_candidate_batches_v54"), executions: count("adventure_check_executions_v54") };
  db.close();
  return value;
}

describe("unknown-person declaration resolution", () => {
  it("holds, and never advertises or commits a check, when the current place cannot anchor a persona", async () => {
    const f = await dmFixture(true);
    seedLivingWorld(f, 7);
    const created = turn(f, PROBE);
    const dispatches = { count: 0 };
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, noDispatch(dispatches));
    // The declaration is classified as an unknown person with no generated public place, so the
    // server holds with a machine reason rather than fabricating a social check against a stranger.
    expect(result.outcome).toBe("completed");
    expect(result.hold).toMatchObject({ reason: "unknown-person", suggestedCandidateId: null, suggestedNextStep: null });
    expect(result.hold?.message).toMatch(/not part of the campaign yet/i);
    expect(result.turn.toolCalls).toEqual([]);
    expect(result.turn.receiptLinks).toEqual([]);
    expect(dispatches.count).toBe(0);
    // No check candidate batch and no check execution were ever created for the turn.
    expect(checkCounts(f.campaign.id)).toEqual({ batches: 0, executions: 0 });
    f.repo.close();
  });

  it("materializes the unknown person through the freeform lane and commits no check", async () => {
    const f = await dmFixture(true);
    seedHarbor(f);
    const created = turn(f, PROBE);
    const dispatches = { count: 0 };
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, noDispatch(dispatches));
    expect(result.outcome).toBe("completed");
    expect(result.hold).toMatchObject({ reason: "unknown-person", suggestedCandidateId: null });
    expect(result.hold?.message).toMatch(/new face appears/i);
    expect(result.turn.toolCalls).toEqual([]);
    expect(result.turn.receiptLinks).toEqual([]);
    expect(dispatches.count).toBe(0);
    expect(checkCounts(f.campaign.id)).toEqual({ batches: 0, executions: 0 });

    // The server-authored public persona exists, read through the repository's own connection
    // (a separate read connection can lag the write-ahead log).
    const npcs = f.repo.listCampaignNpcs(OWNER, f.campaign.id)?.npcs ?? [];
    expect(npcs.map((npc) => (npc as { publicState: { name: string } }).publicState.name.toLocaleLowerCase("en-US")))
      .toContain("hooded stranger leaning");
    // Public/GM split: only the public persona is exposed; the GM-only goals artifact is separate.
    const db = new DatabaseDriver(dbFile(), { readonly: true });
    const artifacts = db.prepare(`SELECT artifact_kind,visibility FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind IN ('npc','lore') ORDER BY artifact_kind`).all(f.campaign.id) as Array<{ artifact_kind: string; visibility: string }>;
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact_kind: "npc", visibility: "public" }),
      expect.objectContaining({ artifact_kind: "lore", visibility: "gm" }),
    ]));
    db.close();

    // A second orchestrator pass over the same still-declared turn replays the idempotent
    // materialization instead of dispatching a provider that could now fabricate a check against
    // the newly known person.
    const replay = await orchestrateAdventureTurn(f.repo, created.turnId, noDispatch(dispatches));
    expect(replay.hold).toMatchObject({ reason: "unknown-person" });
    expect(replay.turn.toolCalls).toEqual([]);
    expect(dispatches.count).toBe(0);
    expect((f.repo.listCampaignNpcs(OWNER, f.campaign.id)?.npcs ?? []).filter((npc) =>
      (npc as { publicState: { name: string } }).publicState.name.toLocaleLowerCase("en-US").includes("hooded stranger")))
      .toHaveLength(1);
    f.repo.close();
  });

  it("does not intercept a declaration that names a known campaign person", async () => {
    const f = await dmFixture(true);
    seedLivingWorld(f, 8);
    const created = turn(f, "I greet Maren.");
    const dispatches = { count: 0 };
    const dependencies: AdventureAgentDependencies = {
      complete: async () => { dispatches.count += 1; return { message: { role: "assistant", content: "A quiet greeting passes between them." },
        usage: null, model: { requestedModel: "fake", responseModel: "fake" } }; },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
      getHarness: async () => defaultHarnessSettings(), now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, dependencies);
    // A known person is in the campaign, so normal planning still runs and the unknown-person hold
    // is never produced.
    expect(dispatches.count).toBe(1);
    expect(result.hold?.reason).not.toBe("unknown-person");
    f.repo.close();
  });
});
