import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  generatedCampaignContentProviderSchema,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../../src/content/srdStarterCatalog.js";
import { createDeterministicE2ERepository } from "../../src/repo/testing/deterministicE2EFixtureRepo.js";
import { createSession, addMessage } from "../../src/repo/index.js";
import {
  PLAYTEST_WORLD_CONTENT,
  PLAYTEST_WORLD_LOCATION_KEYS,
  PLAYTEST_WORLD_START_LOCATION_KEY,
  PLAYTEST_WORLD_VENDOR_NPC_KEY,
} from "./playtestWorldContent.js";

const OWNER = "local-owner";
const DATABASE_FILE = "velvet.sqlite";

export const PLAYTEST_WORLD_CAMPAIGN_NAME = "The Hollowford Reach [playtest:hollowford-v1]";
export const PLAYTEST_WORLD_ROOM_TITLE = "Hollowford Reach - Live Table";
export const PLAYTEST_WORLD_SEED_VERSION = "hollowford-v1";
export const PLAYTEST_WORLD_DM_MODE = "ai" as const;

/** Party personas; finalized into durable campaign characters with level-one sheets. */
export const PLAYTEST_WORLD_PARTY = [
  { name: "Tamsin Rook", archetype: "Warden scout" },
  { name: "Halvard Grim", archetype: "Mine guard" },
  { name: "Ysolde Fen", archetype: "Chapel scholar" },
] as const;

export interface BuildPlaytestWorldOptions {
  /** Absolute or relative data directory; created if missing. */
  dataDir: string;
}

export interface PlaytestWorldActor {
  personaId: string;
  actorId: string;
  campaignCharacterId: string;
  name: string;
}

export interface PlaytestWorldResult {
  status: "created" | "already-present";
  dataDir: string;
  campaignId: string;
  campaignName: string;
  sessionId: string;
  actors: PlaytestWorldActor[];
  startingLocation: { artifactKey: string; locationId: string; name: string };
  locationIds: Record<string, string>;
  encounterAnchor: { artifactKey: string; locationId: string; name: string };
  vendor: { npcKey: string; npcId: string; shopId: string; shopName: string; stockLines: number };
  counts: {
    acceptedArtifacts: number;
    publicLocationArtifacts: number;
    publicFactionArtifacts: number;
    publicNpcArtifacts: number;
    publicQuestArtifacts: number;
    publicRumorArtifacts: number;
    publicEncounterArtifacts: number;
    connections: number;
    shopStock: number;
    presenceEvents: number;
    npcRelationships: number;
  };
}

function openReadonly(dataDir: string): DatabaseDriver.Database {
  return new DatabaseDriver(path.join(dataDir, DATABASE_FILE), { readonly: true, fileMustExist: true });
}

function attributeScores(): CharacterBuilderAttributeScores {
  return Object.fromEntries(
    SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
  ) as CharacterBuilderAttributeScores;
}

function starterReference(kind: "race" | "background" | "class", index = 0) {
  const definitions = SRD_5_1_STARTER_CATALOG.definitions.filter((definition) => definition.reference.kind === kind);
  const definition = definitions[index % definitions.length];
  if (!definition) throw new Error(`SRD starter ${kind} is unavailable`);
  return definition.reference;
}

function acceptedLocationId(db: DatabaseDriver.Database, campaignId: string, key: string): string {
  const row = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key=? AND artifact_kind='location' AND visibility='public'`).get(campaignId, key) as
    | { server_resource_id: string | null }
    | undefined;
  if (!row?.server_resource_id) throw new Error(`playtest location artifact is unavailable: ${key}`);
  return row.server_resource_id;
}

/** Builds the provider-free Hollowford Reach world in an empty data directory. Idempotent per campaign name. */
export async function buildPlaytestWorld(options: BuildPlaytestWorldOptions): Promise<PlaytestWorldResult> {
  const dataDir = path.resolve(options.dataDir);
  process.env.VELVET_DATA_DIR = dataDir;

  const composition = createDeterministicE2ERepository({ dataDir });
  const { repository } = composition;
  try {
    const existing = repository.listCampaigns(OWNER).filter((campaign) => campaign.name === PLAYTEST_WORLD_CAMPAIGN_NAME);
    if (existing.length > 1) throw new Error(`multiple playtest worlds exist for ${PLAYTEST_WORLD_CAMPAIGN_NAME}`);
    if (existing.length === 1) {
      const result = summarizePlaytestWorld(dataDir, existing[0]!.id);
      return result;
    }

    if (repository.listCampaigns(OWNER).length > 0) {
      throw new Error("data directory already contains campaigns; use a new empty VELVET_DATA_DIR for the playtest world");
    }

    const content = generatedCampaignContentProviderSchema.parse(PLAYTEST_WORLD_CONTENT);
    const campaign = repository.createCampaign(OWNER, { name: PLAYTEST_WORLD_CAMPAIGN_NAME });
    repository.installSrdStarterCatalog(OWNER);
    repository.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "playtest.catalog.configure" });

    // Party sheets: finalized SRD level-one characters.
    const scores = attributeScores();
    const actors: PlaytestWorldActor[] = [];
    for (const [index, persona] of PLAYTEST_WORLD_PARTY.entries()) {
      const created_persona = repository.createCharacter({
        name: persona.name,
        age: 27 + index,
        archetype: persona.archetype,
        boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.",
        fictionalConfirmed: true,
      });
      const draft = repository.createCharacterDraft(OWNER, campaign.id, {
        personaId: created_persona.id,
        controllerPrincipalId: OWNER,
        durability: "durable",
        allocation: { method: "standard-array", scores },
        idempotencyKey: `playtest.party.${index}.draft`,
      });
      const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, {
        expectedRevision: draft.draft.revision,
        idempotencyKey: `playtest.party.${index}.selections`,
        selections: {
          race: starterReference("race", index),
          background: starterReference("background", index),
          class: starterReference("class", index),
          starterGrant: "kit",
        },
      } as never);
      const finalized = repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
        expectedRevision: selected.draft.revision,
        idempotencyKey: `playtest.party.${index}.finalize`,
      });
      actors.push({
        personaId: created_persona.id,
        actorId: finalized.receipt.actorId,
        campaignCharacterId: finalized.receipt.campaignCharacterId,
        name: persona.name,
      });
    }

    const session = await createSession({
      characterIds: actors.map((actor) => actor.personaId),
      primaryCharacterId: actors[0]!.personaId,
      title: PLAYTEST_WORLD_ROOM_TITLE,
      presetId: "default",
    });
    repository.transitionSession(session.id, "active", "Hollowford Reach playtest seed started");
    repository.addConsentEvent(session.id, "campaign-safety", true, "Fictional adults; strict respect for boundaries.");
    repository.updateSessionContextSource(session.id,
      "The Hollowford Reach, a dnd-5e frontier valley. Begin at the well in Hollowford Village. All places and people are fictional.");
    await addMessage(session.id, "system", "Hollowford Village, first frost approaching. The harvest fair is quiet and the ward-stone is cracked.");
    await addMessage(session.id, "user", "Tamsin reads the crack in the ward-stone while the others ask after the overdue miners.");
    await addMessage(session.id, "character",
      "That crack runs against the grain of the stone. We should speak with Warden Thorn before we walk into the wood.",
      { speakerCharacterId: actors[0]!.personaId });
    repository.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id });

    // Provider-free generation: the reviewed world is staged and applied as if a
    // region pack had returned it, with explicit non-provider provenance.
    const administrationAtGeneration = repository.getCampaignAdministration(OWNER, campaign.id);
    const generationContext = repository.getCampaignGenerationContext(OWNER, campaign.id, []);
    if (!administrationAtGeneration || !generationContext) throw new Error("playtest generation context is unavailable");
    const generationKey = "playtest.hollowford.generation";
    const requestDigest = "a".repeat(64);
    const call = repository.beginCampaignGenerationCall(campaign.id, generationKey, requestDigest, {
      provider: "reviewed-static-seed",
      model: "none",
      operation: "campaign-content-generation",
      stage: "complete-world",
      promptVersion: PLAYTEST_WORLD_SEED_VERSION,
      schemaVersion: "v52",
      jobId: "hollowford-v1-generation-job",
    }, null);
    if (!call.acquired) throw new Error("fresh playtest generation call was not acquired");
    const draft = repository.createGenerationDraft(OWNER, {
      campaignId: campaign.id,
      timelineId: campaign.activeTimelineId,
      kind: "content-pack",
      stagedContent: {
        kind: "campaign-content",
        requestDigest,
        baseContentRevision: generationContext.revision,
        dependencyDigests: {},
        ...content,
      },
      validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
      expectedCampaignRevision: administrationAtGeneration.revision,
      idempotencyKey: generationKey,
    });
    repository.recordCampaignGenerationCandidate(draft.draftId, content, generationContext.artifacts);
    repository.finishCampaignGenerationCall(campaign.id, generationKey, call.attempt, draft.draftId, "ok", {
      responseModel: "reviewed-static-seed",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      estimatedCostUsd: 0,
    });
    const selectedKeys = [
      ...content.outlines, ...content.locations, ...content.connections, ...content.factions,
      ...content.npcs, ...content.quests, ...content.encounters, ...content.clues,
      ...content.storyNodes, ...content.storyRelationships, ...content.lore, ...content.handouts,
      ...content.scenePrompts,
    ].map((artifact) => artifact.key);
    repository.applyCampaignContentGenerationDraftAtomically(OWNER, {
      draftId: draft.draftId,
      expectedDraftRevision: draft.revision,
      expectedCampaignRevision: draft.campaignRevision,
      idempotencyKey: "playtest.hollowford.generation.apply",
      selectedArtifactKeys: selectedKeys,
    });

    // Publish the public handouts/scene prompts so a player-facing delivery exists.
    let planning = repository.getCampaignGeneratedPlanning(OWNER, campaign.id);
    if (planning) {
      for (const material of planning.deliverables.filter((candidate) => candidate.visibility === "public")) {
        const published = repository.publishCampaignMaterial(OWNER, campaign.id, {
          artifactKey: material.artifactKey,
          expectedRevision: planning.deliveryRevision,
          idempotencyKey: `playtest.hollowford.publish.${material.artifactKey}`,
        });
        planning = { ...planning, deliveryRevision: published.receipt.revisionAfter };
      }
    }

    const dbPath = path.join(dataDir, DATABASE_FILE);
    const db = new DatabaseDriver(dbPath);
    db.pragma("foreign_keys=ON");
    let result: PlaytestWorldResult;
    try {
      const locationIds = Object.fromEntries(PLAYTEST_WORLD_LOCATION_KEYS.map((key) => [key, acceptedLocationId(db, campaign.id, key)]));
      const startRow = db.prepare(`SELECT start.location_id,location.public_name FROM campaign_starting_locations_v51 start
        JOIN campaign_locations_v28 location ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
        WHERE start.campaign_id=?`).get(campaign.id) as { location_id: string; public_name: string } | undefined;
      if (!startRow) throw new Error("playtest starting location was not designated by the outline");
      const startArtifactKey = Object.entries(locationIds).find(([, id]) => id === startRow.location_id)?.[0];
      if (startArtifactKey !== PLAYTEST_WORLD_START_LOCATION_KEY) throw new Error("playtest starting location does not match the outline");

      // Vendor: bind a deterministic server-authored shop to the smith NPC.
      const vendorNpcId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_key=? AND artifact_kind='npc'`).get(campaign.id, PLAYTEST_WORLD_VENDOR_NPC_KEY) as
        { server_resource_id: string | null } | undefined)?.server_resource_id;
      if (!vendorNpcId) throw new Error("playtest vendor NPC is unavailable");
      const shop = repository.materializeFreeformShop(OWNER, campaign.id, session.id, actors[0]!.actorId, vendorNpcId);

      // NPC presence and a few relationships.
      let cast = repository.getNpcCast(OWNER, campaign.id, session.id);
      if (!cast) throw new Error("playtest NPC cast is unavailable");
      const npcResource = (key: string): string => {
        const row = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='npc'`).get(campaign.id, key) as { server_resource_id: string | null } | undefined;
        if (!row?.server_resource_id) throw new Error(`playtest NPC artifact is unavailable: ${key}`);
        return row.server_resource_id;
      };
      const presencePlan: Array<[string, string]> = [
        ["npc-mayor-edda", "loc-hollowford"],
        ["npc-innkeeper-tom", "loc-hollowford"],
        ["npc-smith-bran", "loc-market-cross"],
        ["npc-warden-kael", "loc-warden-tower"],
      ];
      for (const [npcKey, locationKey] of presencePlan) {
        const npcId = npcResource(npcKey);
        const existingPresence = db.prepare("SELECT location_id FROM campaign_npc_presence_v43 WHERE campaign_id=? AND session_id=? AND npc_id=?")
          .get(campaign.id, session.id, npcId) as { location_id: string } | undefined;
        if (existingPresence) continue;
        repository.mutateNpcPresence(OWNER, {
          campaignId: campaign.id,
          sessionId: session.id,
          npcId,
          expectedRevision: cast.sessionRevision,
          idempotencyKey: `playtest.hollowford.presence.${npcKey}`,
          mutation: { kind: "place", locationId: locationIds[locationKey]! },
        });
        cast = repository.getNpcCast(OWNER, campaign.id, session.id);
        if (!cast) throw new Error("playtest NPC cast is unavailable after placement");
      }
      const npcNarrativeRevision = () => repository.listCampaignNpcs(OWNER, campaign.id)!.revision;
      repository.changeNpcRelationship(OWNER, npcResource("npc-warden-kael"), {
        subjectActorId: actors[0]!.actorId,
        affinityDelta: 1,
        trustDelta: 2,
        fearDelta: 0,
        reason: "The party offered to scout the cinder camp for the Wardens.",
        expectedRevision: npcNarrativeRevision(),
        idempotencyKey: "playtest.hollowford.relationship.kael",
      });
      repository.changeNpcRelationship(OWNER, npcResource("npc-mayor-edda"), {
        subjectActorId: actors[0]!.actorId,
        affinityDelta: 2,
        trustDelta: 1,
        fearDelta: 0,
        reason: "The party took the mayor's request seriously.",
        expectedRevision: npcNarrativeRevision(),
        idempotencyKey: "playtest.hollowford.relationship.edda",
      });

      // Place the whole party at the designated starting location.
      for (const [index, actor] of actors.entries()) {
        const existingPlacement = db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?")
          .get(campaign.id, actor.actorId);
        if (existingPlacement) continue;
        const expectedRevision = (db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?")
          .get(campaign.id, session.id) as { revision: number } | undefined)?.revision ?? 0;
        repository.setActorLocation(OWNER, session.id, {
          type: "set_actor_location",
          campaignId: campaign.id,
          actorId: actor.actorId,
          locationId: locationIds[PLAYTEST_WORLD_START_LOCATION_KEY]!,
          expectedRevision,
          idempotencyKey: `playtest.hollowford.place.${index}`,
        });
      }

      const administration = repository.getCampaignAdministration(OWNER, campaign.id);
      if (administration && administration.status !== "published" && administration.status !== "completed") {
        repository.updateCampaignAdministration(OWNER, campaign.id, {
          expectedRevision: administration.revision,
          status: "published",
          idempotencyKey: "playtest.hollowford.publish-campaign",
        });
      }
      const dmControl = repository.getDmControl(OWNER, campaign.id);
      if (dmControl.mode !== PLAYTEST_WORLD_DM_MODE) {
        repository.setDmControl(OWNER, campaign.id, {
          mode: PLAYTEST_WORLD_DM_MODE,
          expectedRevision: dmControl.revision,
          idempotencyKey: "playtest.hollowford.dm-mode",
        });
      }
      result = { ...summarizePlaytestWorld(dataDir, campaign.id), status: "created" };
    } finally {
      db.close();
    }
    return result;
  } finally {
    composition.repository.close();
  }
}

/** Reads back the persisted world without writing. Throws when the sentinel is incomplete. */
export function summarizePlaytestWorld(dataDir: string, campaignId: string): PlaytestWorldResult {
  const db = openReadonly(dataDir);
  try {
    const campaign = db.prepare("SELECT id,name,lifecycle_status lifeCycle FROM campaigns WHERE id=?").get(campaignId) as
      | { id: string; name: string; lifeCycle: string }
      | undefined;
    if (!campaign) throw new Error(`playtest campaign is absent: ${campaignId}`);
    const session = db.prepare(`SELECT attached.session_id FROM campaign_sessions attached
      WHERE attached.campaign_id=? ORDER BY attached.attached_at,session_id LIMIT 1`).get(campaignId) as { session_id: string } | undefined;
    if (!session) throw new Error("playtest room is unavailable");
    const actors = (db.prepare(`SELECT actor.id actor_id,actor.campaign_character_id,campaign_character.character_id persona_id
      FROM campaign_actors actor JOIN campaign_characters campaign_character
        ON campaign_character.id=actor.campaign_character_id AND campaign_character.campaign_id=actor.campaign_id
      WHERE actor.campaign_id=? ORDER BY actor.id`).all(campaignId) as Array<{ actor_id: string; campaign_character_id: string; persona_id: string }>)
      .map((row, index) => ({
        actorId: row.actor_id,
        campaignCharacterId: row.campaign_character_id,
        personaId: row.persona_id,
        name: PLAYTEST_WORLD_PARTY[index]?.name ?? `actor-${index + 1}`,
      }));
    if (actors.length === 0) throw new Error("playtest party is unavailable");

    const start = db.prepare(`SELECT start.location_id,location.public_name FROM campaign_starting_locations_v51 start
      JOIN campaign_locations_v28 location ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
      WHERE start.campaign_id=?`).get(campaignId) as { location_id: string; public_name: string } | undefined;
    if (!start) throw new Error("playtest starting location is unavailable");
    const locationIds = Object.fromEntries(PLAYTEST_WORLD_LOCATION_KEYS.map((key) => [key, acceptedLocationId(db, campaignId, key)]));
    const startArtifactKey = Object.entries(locationIds).find(([, id]) => id === start.location_id)?.[0];
    if (startArtifactKey === undefined) throw new Error("starting location is not one of the required playtest locations");

    const vendorRow = db.prepare(`SELECT artifact.server_resource_id npc_id,binding.shop_id,shop.name shop_name
      FROM campaign_generation_accepted_artifacts_v52 artifact
      JOIN campaign_npc_shop_bindings_v57 binding
        ON binding.campaign_id=artifact.campaign_id AND binding.npc_id=artifact.server_resource_id
      JOIN rpg_shop_definitions_v25 shop ON shop.campaign_id=binding.campaign_id AND shop.shop_id=binding.shop_id
      WHERE artifact.campaign_id=? AND artifact.artifact_key=? AND artifact.artifact_kind='npc'`).get(campaignId, PLAYTEST_WORLD_VENDOR_NPC_KEY) as
      | { npc_id: string; shop_id: string; shop_name: string }
      | undefined;
    if (!vendorRow) throw new Error("playtest vendor shop is unavailable");

    const count = (sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { count: number }).count;
    const counts = {
      acceptedArtifacts: count("SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=?", campaignId),
      publicLocationArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='location' AND visibility='public'`, campaignId),
      publicFactionArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='faction' AND visibility='public'`, campaignId),
      publicNpcArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='npc' AND visibility='public'`, campaignId),
      publicQuestArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='quest' AND visibility='public'`, campaignId),
      publicRumorArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'`, campaignId),
      publicEncounterArtifacts: count(`SELECT count(*) count FROM campaign_generation_accepted_artifacts_v52
        WHERE campaign_id=? AND artifact_kind='encounter' AND visibility='public'`, campaignId),
      connections: count("SELECT count(*) count FROM campaign_location_connections_v28 WHERE campaign_id=?", campaignId),
      shopStock: count("SELECT count(*) count FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=?", campaignId, vendorRow.shop_id),
      presenceEvents: count("SELECT count(*) count FROM npc_presence_events_v43 WHERE campaign_id=?", campaignId),
      npcRelationships: count(`SELECT count(*) count FROM world_narrative_events_v32
        WHERE campaign_id=? AND event_type='npc_relationship_changed'`, campaignId),
    };

    return {
      status: "already-present",
      dataDir,
      campaignId,
      campaignName: campaign.name,
      sessionId: session.session_id,
      actors,
      startingLocation: { artifactKey: startArtifactKey, locationId: start.location_id, name: start.public_name },
      locationIds,
      encounterAnchor: {
        artifactKey: "loc-cinder-camp",
        locationId: locationIds["loc-cinder-camp"]!,
        name: "The Cinder Camp",
      },
      vendor: { npcKey: PLAYTEST_WORLD_VENDOR_NPC_KEY, npcId: vendorRow.npc_id, shopId: vendorRow.shop_id, shopName: vendorRow.shop_name, stockLines: counts.shopStock },
      counts,
    };
  } finally {
    db.close();
  }
}

/** Creates the world only when the target database is absent or empty; never repairs an existing store. */
