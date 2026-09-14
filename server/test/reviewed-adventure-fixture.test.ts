import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDataDirs, makeTmpDir } from "./helpers.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { createReviewedAdventure, REVIEWED_ADVENTURE_MANIFEST, REVIEWED_ADVENTURE_MANIFEST_DIGEST, REVIEWED_ADVENTURE_PRIVATE_SENTINEL } from "./fixtures/reviewedAdventure.js";

describe("reviewed Last Harbor Light fixture", () => {
  afterEach(cleanupTmpDataDirs);

  it("has a stable manifest and creates only an unearned provider-free initial state", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const directory = makeTmpDir("reviewed-harbor-");
    process.env.VELVET_DATA_DIR = directory;
    expect(REVIEWED_ADVENTURE_MANIFEST_DIGEST).toBe("4665b0901489e481b8a33ed803cf6fd6147b555e965b3eac87e7cebb7fc029ab");
    const fixture = await createReviewedAdventure(directory);
    expect(fixture.providerDispatches).toBe(0);
    expect(fixture.optionalEncounterInstanceId).toBe(fixture.resourceIds["optional-encounter-instance"]);
    expect(fixture.inventoryReceipt).toMatchObject({
      idempotencyKey: "harbor-equip-longsword", revisionBefore: 0, revisionAfter: 1,
    });
    const inventory = fixture.repo.getActorInventorySnapshot("local-owner", fixture.campaignId, fixture.actorId)!;
    expect(inventory).toMatchObject({
      revision: fixture.inventoryReceipt.revisionAfter,
      equipment: [{ slot: "hand", entryId: fixture.longswordEntryId, hand: "main", grip: "one-handed" }],
    });
    expect(inventory.inventory.items.filter(item => item.kind === "instanced" && item.item.definitionId === "srd-5.1:item:longsword")).toEqual([
      expect.objectContaining({
        kind: "instanced", entryId: fixture.longswordEntryId,
        item: { kind: "item", packId: REVIEWED_ADVENTURE_MANIFEST.catalog.packId,
          packVersion: REVIEWED_ADVENTURE_MANIFEST.catalog.packVersion, definitionId: "srd-5.1:item:longsword" },
      }),
    ]);
    expect(Object.keys(fixture.resourceIds)).toEqual(expect.arrayContaining([
      ...REVIEWED_ADVENTURE_MANIFEST.keys.locations, REVIEWED_ADVENTURE_MANIFEST.keys.npc,
      REVIEWED_ADVENTURE_MANIFEST.keys.quest, ...REVIEWED_ADVENTURE_MANIFEST.keys.storyNodes,
      REVIEWED_ADVENTURE_MANIFEST.keys.clue, REVIEWED_ADVENTURE_MANIFEST.keys.encounter,
      "secure-lens", "relight-beacon", "optional-encounter-instance",
    ]));
    expect(REVIEWED_ADVENTURE_MANIFEST.expectedReadinessWarnings).toEqual([
      "private-artifact", "awaiting-play-evidence",
    ]);
    expect(REVIEWED_ADVENTURE_MANIFEST.documentedBranchReadinessExpectation).toBe("optional-disconnected-content");
    expect(REVIEWED_ADVENTURE_MANIFEST.catalog).toMatchObject({
      rulesProfileId: "srd-5.1:rules:starter-v1",
      packId: SRD_5_1_STARTER_CATALOG.manifest.packId,
      packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion,
      raceDefinitionId: "srd-5.1:race:human",
      backgroundDefinitionId: "srd-5.1:background:acolyte",
      classDefinitionId: "srd-5.1:class:fighter",
      enemyDefinitionId: "srd-5.1:enemy-template:goblin",
    });
    expect(REVIEWED_ADVENTURE_MANIFEST.bindings).toEqual([
      { node: "lens-recovered", evidenceKind: "quest-objective", targetObjective: "secure-lens" },
      { node: "harbor-finale", evidenceKind: "quest-objective", targetObjective: "relight-beacon" },
    ]);
    expect(REVIEWED_ADVENTURE_MANIFEST.branches.every(step => Object.values(step).every(value => JSON.stringify(value).toLowerCase().includes("first candidate") === false))).toBe(true);
    expect(JSON.stringify(REVIEWED_ADVENTURE_MANIFEST.branches)).toContain("active-combat retreat");
    expect(JSON.stringify(REVIEWED_ADVENTURE_MANIFEST.branches)).toContain("durable social agreement");
    const publicWorld = fixture.repo.getCampaignWorld("local-owner", fixture.campaignId)!;
    expect(JSON.stringify(publicWorld)).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
    const readiness = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaignId, fixture.sessionId);
    const warningCodes = readiness.issues.filter(issue => issue.severity === "warning").map(issue => issue.code);
    const reviewCodes = readiness.issues.filter(issue => issue.severity === "review").map(issue => issue.code);
    expect(readiness.activationReadiness).toMatchObject({ ready: true, active: true });
    expect(warningCodes).toEqual(["private-artifact"]);
    expect(reviewCodes).toEqual(expect.arrayContaining(["awaiting-play-evidence", "awaiting-play-evidence"]));
    const privateArtifact = readiness.issues.find(issue => issue.code === "private-artifact");
    expect(privateArtifact).toMatchObject({ severity: "warning", reference: { kind: "artifact" } });
    expect(readiness.issues.filter(issue => issue.code === "awaiting-play-evidence" && issue.severity === "review")).toHaveLength(2);
    expect(JSON.stringify(readiness)).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
    const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT progress,completed_at FROM quest_objective_progress_v33 WHERE campaign_id=?").all(fixture.campaignId)).toEqual(expect.arrayContaining([expect.objectContaining({ progress: 0, completed_at: null })]));
      expect(db.prepare("SELECT * FROM dm_story_evidence WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT status FROM encounter WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{ status: "preparing" }]);
      expect(db.prepare("SELECT * FROM dm_encounter_bindings WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT * FROM quest_reward_claims_v33 WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT count(*) count FROM dm_review_scene_bindings WHERE campaign_id=?").get(fixture.campaignId)).toEqual({ count: 2 });
      expect(db.prepare("SELECT node_id,evidence_kind,target_id FROM dm_review_scene_bindings WHERE campaign_id=?").all(fixture.campaignId)).toEqual(expect.arrayContaining([
        { node_id: fixture.resourceIds["harbor-finale"], evidence_kind: "quest-objective", target_id: fixture.resourceIds["relight-beacon"] },
        { node_id: fixture.resourceIds["lens-recovered"], evidence_kind: "quest-objective", target_id: fixture.resourceIds["secure-lens"] },
      ]));
      expect(db.prepare("SELECT status FROM story_node_state_v34 WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{ status: "hidden" }, { status: "hidden" }, { status: "hidden" }]);
      expect(db.prepare("SELECT count(*) count FROM campaign_actors WHERE campaign_id=?").get(fixture.campaignId)).toEqual({ count: 1 });
      expect(db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{ rules_profile_id: REVIEWED_ADVENTURE_MANIFEST.catalog.rulesProfileId }]);
      expect(db.prepare("SELECT race_definition_id,background_definition_id FROM rpg_campaign_sheets WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{
        race_definition_id: REVIEWED_ADVENTURE_MANIFEST.catalog.raceDefinitionId,
        background_definition_id: REVIEWED_ADVENTURE_MANIFEST.catalog.backgroundDefinitionId,
      }]);
      expect(db.prepare("SELECT definition_id FROM rpg_character_classes WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{
        definition_id: REVIEWED_ADVENTURE_MANIFEST.catalog.classDefinitionId,
      }]);
      expect(db.prepare("SELECT attribute_id,value FROM rpg_character_attributes WHERE campaign_id=? ORDER BY position").all(fixture.campaignId)).toEqual([
        { attribute_id: "strength", value: 16 }, { attribute_id: "dexterity", value: 15 }, { attribute_id: "constitution", value: 14 },
        { attribute_id: "intelligence", value: 13 }, { attribute_id: "wisdom", value: 11 }, { attribute_id: "charisma", value: 9 },
      ]);
      expect(db.prepare("SELECT pack_id,pack_version FROM campaign_catalog_current_pins WHERE campaign_id=?").all(fixture.campaignId)).toEqual([{ pack_id: REVIEWED_ADVENTURE_MANIFEST.catalog.packId, pack_version: REVIEWED_ADVENTURE_MANIFEST.catalog.packVersion }]);
    } finally { db.close(); fixture.repo.close(); }
  });

  it("leaves the optional encounter unmaterialized for the player travel journey", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const directory = makeTmpDir("reviewed-harbor-journey-");
    const fixture = await createReviewedAdventure(directory, { prepareOptionalEncounter: false });
    expect(fixture.providerDispatches).toBe(0);
    expect(fixture.optionalEncounterInstanceId).toBeNull();
    expect(fixture.resourceIds).not.toHaveProperty("optional-encounter-instance");
    expect(fixture.resourceIds[REVIEWED_ADVENTURE_MANIFEST.keys.encounter]).toBeTruthy();
    expect(fixture.inventoryReceipt).toMatchObject({
      idempotencyKey: "harbor-equip-longsword", revisionBefore: 0, revisionAfter: 1,
    });
    const inventory = fixture.repo.getActorInventorySnapshot("local-owner", fixture.campaignId, fixture.actorId)!;
    expect(inventory).toMatchObject({
      revision: fixture.inventoryReceipt.revisionAfter,
      equipment: [{ slot: "hand", entryId: fixture.longswordEntryId, hand: "main", grip: "one-handed" }],
    });
    expect(inventory.inventory.items.filter(item => item.kind === "instanced" && item.item.definitionId === "srd-5.1:item:longsword")).toEqual([
      expect.objectContaining({
        kind: "instanced", entryId: fixture.longswordEntryId,
        item: expect.objectContaining({ definitionId: "srd-5.1:item:longsword" }),
      }),
    ]);
    const planning = fixture.repo.getCampaignGeneratedPlanning("local-owner", fixture.campaignId)!;
    expect(planning.encounters).toEqual([expect.objectContaining({
      artifactKey: REVIEWED_ADVENTURE_MANIFEST.keys.encounter,
      resourceId: fixture.resourceIds[REVIEWED_ADVENTURE_MANIFEST.keys.encounter],
      locationId: fixture.resourceIds["breakwater-cave"],
      enemyReferences: [{
        kind: "enemy-template",
        packId: REVIEWED_ADVENTURE_MANIFEST.catalog.packId,
        packVersion: REVIEWED_ADVENTURE_MANIFEST.catalog.packVersion,
        definitionId: REVIEWED_ADVENTURE_MANIFEST.catalog.enemyDefinitionId,
      }],
    })]);
    const readiness = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaignId, fixture.sessionId);
    expect(readiness.activationReadiness).toMatchObject({ ready: true, active: true });
    expect(JSON.stringify(fixture.repo.getCampaignWorld("local-owner", fixture.campaignId))).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
    const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT * FROM encounter WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT * FROM dm_encounter_bindings WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT progress,completed_at FROM quest_objective_progress_v33 WHERE campaign_id=?").all(fixture.campaignId)).toEqual(expect.arrayContaining([expect.objectContaining({ progress: 0, completed_at: null })]));
      expect(db.prepare("SELECT * FROM dm_story_evidence WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT * FROM quest_reward_claims_v33 WHERE campaign_id=?").all(fixture.campaignId)).toEqual([]);
      expect(db.prepare("SELECT node_id,evidence_kind,target_id FROM dm_review_scene_bindings WHERE campaign_id=?").all(fixture.campaignId)).toEqual(expect.arrayContaining([
        { node_id: fixture.resourceIds["harbor-finale"], evidence_kind: "quest-objective", target_id: fixture.resourceIds["relight-beacon"] },
        { node_id: fixture.resourceIds["lens-recovered"], evidence_kind: "quest-objective", target_id: fixture.resourceIds["secure-lens"] },
      ]));
      expect(db.prepare("SELECT count(*) count FROM campaign_actors WHERE campaign_id=?").get(fixture.campaignId)).toEqual({ count: 1 });
    } finally { db.close(); fixture.repo.close(); }
  });

  it("refuses a nonempty target rather than reusing or repairing it", async () => {
    const directory = makeTmpDir("reviewed-harbor-nonempty-");
    writeFileSync(path.join(directory, "existing"), "do not touch");
    await expect(createReviewedAdventure(directory)).rejects.toThrow("target directory must be empty");
    expect(existsSync(path.join(directory, "existing"))).toBe(true);
  });

  it("uses the supplied target instead of the environment data directory", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const environmentDirectory = makeTmpDir("reviewed-harbor-environment-");
    const suppliedDirectory = makeTmpDir("reviewed-harbor-supplied-");
    const environmentSentinel = path.join(environmentDirectory, "environment-sentinel");
    writeFileSync(environmentSentinel, "leave this environment storage untouched");
    process.env.VELVET_DATA_DIR = environmentDirectory;
    const fixture = await createReviewedAdventure(suppliedDirectory);
    try {
      expect(existsSync(path.join(suppliedDirectory, "velvet.sqlite"))).toBe(true);
      expect(existsSync(path.join(environmentDirectory, "velvet.sqlite"))).toBe(false);
      expect(readFileSync(environmentSentinel, "utf8")).toBe("leave this environment storage untouched");
    } finally { fixture.repo.close(); }
  });
});
