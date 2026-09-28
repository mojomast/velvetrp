import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FREEFORM_ENCOUNTER_FRAMINGS,
  FREEFORM_FACTION_DETAILS,
  FREEFORM_FACTION_PRIVATE_ANGLES,
  FREEFORM_LOCATION_FEATURES,
  FREEFORM_LOCATION_MOODS,
  FREEFORM_LORE_SECRETS,
  FREEFORM_LORE_TEXTURES,
  FREEFORM_NPC_DETAILS,
  FREEFORM_NPC_MOODS,
  FREEFORM_NPC_PRIVATE_ANGLES,
  FREEFORM_QUEST_COMPLICATIONS,
  FREEFORM_QUEST_REWARD_LABELS,
  FREEFORM_QUEST_TEXTURES,
  FREEFORM_RUMOR_TEXTURES,
  FREEFORM_RUMOR_TRUTHS,
  FREEFORM_SHOP_ATMOSPHERES,
  classifyFreeformEncounter,
  classifyFreeformFaction,
  classifyFreeformLore,
  classifyFreeformNpc,
  classifyFreeformQuest,
  classifyFreeformRumor,
  classifyFreeformTravel,
  freeformShopNotice,
  isFlavorOnly,
  pickVariation,
  variationIndex,
  type VariationPool,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/** A spread of distinct durable identities with the same phrase, to sample variation. */
const identities = (label: string, count = 24): string[] =>
  Array.from({ length: count }, (_value, index) => `campaign:session:${label}-${index}`);

const distinctCount = (values: readonly string[]): number => new Set(values).size;

const locationContext = { locationId: "rain-harbor", name: "Rain Harbor", visibility: "public" as const, artifactKey: "harbor" };
const factionContext = { ...locationContext, factionNames: ["Tidewatch"] };

/** Seeds one generated public location ("harbor") and places the actor there. */
function seedHarbor(f: Fixture): string {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{ key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-variation-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-variation-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-variation",
  });
  return locationId;
}

describe("freeform variation primitive", () => {
  it("is a pure function of its seed and bounds the index", () => {
    expect(pickVariation("seed-a", FREEFORM_NPC_MOODS)).toBe(pickVariation("seed-a", FREEFORM_NPC_MOODS));
    expect(variationIndex("x", 1)).toBe(0);
    expect(() => variationIndex("x", 0)).toThrow();
    // Across a spread of identities the picker actually varies.
    expect(distinctCount(identities("primitive").map((id) => pickVariation(id, FREEFORM_NPC_MOODS)))).toBeGreaterThan(1);
  });

  it("keeps every flavor pool free of invented mechanics and prices", () => {
    const pools: Array<VariationPool<string>> = [
      FREEFORM_NPC_DETAILS, FREEFORM_NPC_MOODS, FREEFORM_NPC_PRIVATE_ANGLES,
      FREEFORM_FACTION_DETAILS, FREEFORM_FACTION_PRIVATE_ANGLES,
      FREEFORM_QUEST_TEXTURES, FREEFORM_QUEST_REWARD_LABELS, FREEFORM_QUEST_COMPLICATIONS,
      FREEFORM_RUMOR_TEXTURES, FREEFORM_RUMOR_TRUTHS,
      FREEFORM_LORE_TEXTURES, FREEFORM_LORE_SECRETS,
      FREEFORM_LOCATION_MOODS, FREEFORM_LOCATION_FEATURES,
      FREEFORM_SHOP_ATMOSPHERES, FREEFORM_ENCOUNTER_FRAMINGS,
    ];
    for (const pool of pools) for (const value of pool) expect(isFlavorOnly(value), value).toBe(true);
  });
});

describe("freeform oracle variation", () => {
  it("gives distinct NPC identities distinct, stable public details and keeps GM goals separate", () => {
    const descriptions = identities("npc").map((identity) => {
      const first = classifyFreeformNpc({ identity, text: "I ask the glassblower about the road", currentLocation: locationContext, knownNpcs: [] });
      const second = classifyFreeformNpc({ identity, text: "I ask the glassblower about the road", currentLocation: locationContext, knownNpcs: [] });
      expect(second).toEqual(first);
      if (first.intent !== "materialize-npc") throw new Error("expected a materialize-npc classification");
      const candidate = first.candidates[0]!;
      // The public text never carries a GM-only angle.
      for (const angle of FREEFORM_NPC_PRIVATE_ANGLES) expect(candidate.description).not.toContain(angle);
      expect(isFlavorOnly(candidate.description)).toBe(true);
      return candidate.description;
    });
    expect(distinctCount(descriptions)).toBeGreaterThan(1);
    // The base archetype sentence survives the appended variation.
    expect(descriptions[0]).toContain("artisan of Rain Harbor");
  });

  it("varies faction descriptions while preserving the base and the GM-only separation", () => {
    const descriptions = identities("faction").map((identity) => {
      const classification = classifyFreeformFaction({ identity, text: "I look for the local thieves' guild", knownFactions: [], locationName: "Rain Harbor" });
      if (classification.intent !== "materialize-faction") throw new Error("expected a materialize-faction classification");
      const candidate = classification.candidates[0]!;
      for (const angle of FREEFORM_FACTION_PRIVATE_ANGLES) expect(candidate.description).not.toContain(angle);
      expect(candidate.gmAgenda.trim().length).toBeGreaterThan(0);
      return candidate.description;
    });
    expect(distinctCount(descriptions)).toBeGreaterThan(1);
    expect(descriptions[0]).toContain("A public trade guild of Rain Harbor");
  });

  it("varies quest flavor and reward labels while keeping objectives public and the reward inert", () => {
    const details = identities("quest").map((identity) => {
      const classification = classifyFreeformQuest({ identity, text: "I ask around for work", currentLocation: locationContext, knownQuestTitles: [] });
      if (classification.intent !== "materialize-quest") throw new Error("expected a materialize-quest classification");
      const candidate = classification.candidates[0]!;
      expect(candidate.objectives.every((objective) => objective.visibility === "public")).toBe(true);
      expect(candidate.reward).toMatchObject({ kind: "custom", amount: null });
      expect(candidate.objectives[0]!.dependencyObjectiveKeys).toEqual([]);
      for (const complication of FREEFORM_QUEST_COMPLICATIONS) expect(candidate.description).not.toContain(complication);
      return `${candidate.description}::${candidate.reward.label}::${candidate.gmTwist}`;
    });
    expect(distinctCount(details)).toBeGreaterThan(1);
  });

  it("varies rumor hearsay while keeping the public text and GM-only truth disjoint", () => {
    const texts = identities("rumor").map((identity) => {
      const classification = classifyFreeformRumor({ identity, text: "I listen for gossip about the salt witch", currentLocation: factionContext, knownRumorTitles: [] });
      if (classification.intent !== "materialize-rumor") throw new Error("expected a materialize-rumor classification");
      const candidate = classification.candidates[0]!;
      expect(candidate.publicText).toContain("Rain Harbor");
      expect(candidate.gmTruth).toContain("Tidewatch");
      for (const truth of FREEFORM_RUMOR_TRUTHS) expect(candidate.publicText).not.toContain(truth);
      expect(candidate.publicText).not.toContain(candidate.gmTruth);
      return candidate.publicText;
    });
    expect(distinctCount(texts)).toBeGreaterThan(1);
  });

  it("varies lore text while keeping the public clue and GM-only secret disjoint", () => {
    const texts = identities("lore").map((identity) => {
      const classification = classifyFreeformLore({ identity, text: "I recall the legend of the salt witch", currentLocation: factionContext, knownLoreTitles: [] });
      if (classification.intent !== "materialize-lore") throw new Error("expected a materialize-lore classification");
      const candidate = classification.candidates[0]!;
      expect(candidate.publicText).toContain("Rain Harbor");
      expect(candidate.gmSecret).toContain("Tidewatch");
      for (const secret of FREEFORM_LORE_SECRETS) expect(candidate.publicText).not.toContain(secret);
      expect(candidate.publicText).not.toContain(candidate.gmSecret);
      return candidate.publicText;
    });
    expect(distinctCount(texts)).toBeGreaterThan(1);
  });

  it("varies new location descriptions from the same destination phrase", () => {
    const descriptions = identities("travel").map((identity) => {
      const classification = classifyFreeformTravel({ identity, text: "I go to the glassblower's district", currentLocation: locationContext, locations: [] });
      if (classification.intent !== "materialize-location") throw new Error("expected a materialize-location classification");
      const candidate = classification.candidates[0]!;
      expect(candidate.description).toContain("glassblower's district");
      expect(candidate.description).toContain("Rain Harbor");
      expect(isFlavorOnly(candidate.description)).toBe(true);
      return candidate.description;
    });
    expect(distinctCount(descriptions)).toBeGreaterThan(1);
  });

  it("varies the shop notice flavor without touching catalog prices", () => {
    const notices = identities("shop").map((identity) => freeformShopNotice("Mara's wares", identity));
    expect(distinctCount(notices)).toBeGreaterThan(1);
    expect(notices[0]).toContain("A public stall of Mara");
    expect(isFlavorOnly(notices[0]!)).toBe(true);
  });

  it("varies encounter framing without changing the pinned roster", () => {
    const template = {
      reference: { kind: "enemy-template" as const, packId: "srd-5.1", packVersion: "1.0.0", definitionId: "srd-5.1:enemy-template:goblin" },
      name: "Goblin", challengeRating: 0.25,
    };
    const names = identities("encounter").map((identity) => {
      const classification = classifyFreeformEncounter({ identity, actorId: "actor", actorName: "Hero", locationName: "Rain Harbor", text: "I attack the nearest foe!", enemies: [template] });
      if (classification.intent !== "materialize-encounter") throw new Error("expected a materialize-encounter classification");
      const candidate = classification.candidates[0]!;
      expect(candidate.enemies.every((enemy) => enemy.definitionId === template.reference.definitionId)).toBe(true);
      return candidate.encounterName;
    });
    expect(names.every((value) => value.includes("Hero"))).toBe(true);
    expect(distinctCount(names)).toBeGreaterThan(1);
  });
});

describe("freeform variation replay", () => {
  it("materializes the exact classified content once and returns it unchanged on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const declaration = "I ask the glassblower about the road";
    const identity = `${f.campaign.id}:${f.session.id}:${f.actorId}`;
    const classified = classifyFreeformNpc({ identity, text: declaration, currentLocation: { ...locationContext, artifactKey: "harbor" }, knownNpcs: [] });
    if (classified.intent !== "materialize-npc") throw new Error("expected a materialize-npc classification");
    const expected = classified.candidates[0]!.description;

    const first = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, declaration);
    const second = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, declaration);
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.npcId).toBe(first.npcId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.gmGoalsArtifactKey).toBe(first.gmGoalsArtifactKey);

    const db = openDb();
    const npcArtifact = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='npc' AND server_resource_id=?`).get(f.campaign.id, first.npcId) as { canonical_json: string };
    const stored = JSON.parse(npcArtifact.canonical_json) as { description: string };
    // The stored public content is exactly what the deterministic classifier produced.
    expect(stored.description).toBe(expected);
    // Re-run classification after commit: the same identity yields the same bytes.
    const reclassified = classifyFreeformNpc({ identity, text: declaration, currentLocation: { ...locationContext, artifactKey: "harbor" }, knownNpcs: ["glassblower"] });
    // The committed NPC is now known canon, so classification is a bounded duplicate rather than a second candidate.
    expect(reclassified).toMatchObject({ intent: "none", reason: "known-npc" });

    // Replay created no second persona, draft or artifact.
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND source_draft_id=?", f.campaign.id, first.draftId)).toBe(2);
    // The public artifact carries no GM-only angle.
    for (const angle of FREEFORM_NPC_PRIVATE_ANGLES) expect(npcArtifact.canonical_json).not.toContain(angle);
    expect(npcArtifact.canonical_json.toLowerCase()).not.toContain("gm-only");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });
});
