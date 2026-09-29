import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { validateRegionPack } from "../src/startup/regionPack.js";
import {
  PLAYTEST_WORLD_CONNECTION_PAIRS,
  PLAYTEST_WORLD_CONTENT,
  PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY,
  PLAYTEST_WORLD_LOCATION_KEYS,
  PLAYTEST_WORLD_START_LOCATION_KEY,
  PLAYTEST_WORLD_VENDOR_NPC_KEY,
} from "./fixtures/playtestWorldContent.js";
import {
  PLAYTEST_WORLD_CAMPAIGN_NAME,
  PLAYTEST_WORLD_DM_MODE,
  PLAYTEST_WORLD_PARTY,
  buildPlaytestWorld,
  summarizePlaytestWorld,
} from "./fixtures/playtestWorld.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

interface AcceptedArtifact {
  artifact_key: string;
  artifact_kind: string;
  visibility: string;
  server_resource_id: string | null;
  canonical_json: string;
}

function openDb(): DatabaseDriver.Database {
  return new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true, fileMustExist: true });
}

describe("playtest world fixture", () => {
  it("builds a provider-free, connected, freeform-ready Hollowford Reach and is idempotent", async () => {
    const dataDir = process.env.VELVET_DATA_DIR!;
    const created = await buildPlaytestWorld({ dataDir });

    expect(created.status).toBe("created");
    expect(created.campaignName).toBe(PLAYTEST_WORLD_CAMPAIGN_NAME);
    expect(created.actors.length).toBeGreaterThanOrEqual(2);
    expect(created.actors.length).toBeLessThanOrEqual(4);
    expect(created.startingLocation.artifactKey).toBe(PLAYTEST_WORLD_START_LOCATION_KEY);
    expect(created.counts.publicLocationArtifacts).toBeGreaterThanOrEqual(8);
    expect(created.counts.publicLocationArtifacts).toBeLessThanOrEqual(12);

    // A second build against the same directory makes no second campaign.
    const replayed = await buildPlaytestWorld({ dataDir });
    expect(replayed.status).toBe("already-present");
    expect(replayed.campaignId).toBe(created.campaignId);
    expect(summarizePlaytestWorld(dataDir, created.campaignId).counts.acceptedArtifacts).toBe(created.counts.acceptedArtifacts);

    // The reviewed content is itself a valid single region pack: one outline, all
    // locations/connections public, connected, and self-anchored. This reuses the
    // 671241c region-pack validator provider-free.
    const reviewed = generatedCampaignContentProviderSchema.parse(PLAYTEST_WORLD_CONTENT);
    expect(() => validateRegionPack(reviewed, {
      locationCount: PLAYTEST_WORLD_LOCATION_KEYS.length,
      anchorRequired: false,
      acceptedLocationKeys: new Set<string>(),
    })).not.toThrow();

    const db = openDb();
    try {
      const campaign = db.prepare("SELECT id,name,lifecycle_status lifeCycle FROM campaigns WHERE name=?").get(PLAYTEST_WORLD_CAMPAIGN_NAME) as
        | { id: string; name: string; lifeCycle: string }
        | undefined;
      expect(campaign?.id).toBe(created.campaignId);
      expect(campaign?.lifeCycle).toBe("published");

      const dm = db.prepare("SELECT mode FROM dm_control WHERE campaign_id=?").get(created.campaignId) as { mode: string } | undefined;
      expect(dm?.mode).toBe(PLAYTEST_WORLD_DM_MODE);

      const session = db.prepare("SELECT state,stopped_at stoppedAt FROM sessions WHERE id=?").get(created.sessionId) as
        | { state: string; stoppedAt: string | null }
        | undefined;
      expect(session?.state).toBe("active");
      expect(session?.stoppedAt).toBeNull();
      expect((db.prepare("SELECT count(*) count FROM campaign_sessions WHERE campaign_id=?").get(created.campaignId) as { count: number }).count).toBe(1);

      // Real SRD party with finalized level-one sheets.
      const actors = db.prepare(`SELECT actor.id actor_id,actor.campaign_character_id,sheet.id sheet_id
        FROM campaign_actors actor
        LEFT JOIN rpg_campaign_sheets sheet
          ON sheet.campaign_id=actor.campaign_id AND sheet.campaign_character_id=actor.campaign_character_id
        WHERE actor.campaign_id=?`).all(created.campaignId) as Array<{ actor_id: string; campaign_character_id: string; sheet_id: string | null }>;
      expect(actors.length).toBeGreaterThanOrEqual(2);
      expect(actors.length).toBeLessThanOrEqual(4);
      for (const actor of actors) expect(actor.sheet_id, `sheet for ${actor.actor_id}`).not.toBeNull();

      // Every required location has a public accepted artifact with a resource id.
      for (const key of PLAYTEST_WORLD_LOCATION_KEYS) {
        const artifact = db.prepare(`SELECT artifact_key,artifact_kind,visibility,server_resource_id,canonical_json
          FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key=?`).get(created.campaignId, key) as
          | AcceptedArtifact
          | undefined;
        expect(artifact?.artifact_kind, key).toBe("location");
        expect(artifact?.visibility, key).toBe("public");
        expect(artifact?.server_resource_id, key).toBeTruthy();
        const location = db.prepare("SELECT visibility FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
          .get(created.campaignId, artifact!.server_resource_id) as { visibility: string } | undefined;
        expect(location?.visibility, key).toBe("public");
      }

      // Reciprocal open public connections for two-way travel.
      for (const [left, right] of PLAYTEST_WORLD_CONNECTION_PAIRS) {
        const directed = (from: string, to: string): number => (db.prepare(`SELECT count(*) count FROM campaign_location_connections_v28
          WHERE campaign_id=? AND from_location_id=? AND to_location_id=? AND visibility='public' AND route_state='open'`)
          .get(created.campaignId, created.locationIds[from]!, created.locationIds[to]!) as { count: number }).count;
        expect(directed(left, right), `${left}->${right}`).toBe(1);
        expect(directed(right, left), `${right}->${left}`).toBe(1);
      }

      // Starting location designated, public, and matching the outline.
      const start = db.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?").get(created.campaignId) as
        | { location_id: string }
        | undefined;
      expect(start?.location_id).toBe(created.locationIds[PLAYTEST_WORLD_START_LOCATION_KEY]);

      // Freeform prerequisites: public factions, located NPCs, quests with objectives, rumors/lore.
      const artifacts = db.prepare(`SELECT artifact_key,artifact_kind,visibility,server_resource_id,canonical_json
        FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=?`).all(created.campaignId) as AcceptedArtifact[];
      const byKey = new Map(artifacts.map((artifact) => [artifact.artifact_key, artifact]));
      const locationIds = new Set(PLAYTEST_WORLD_LOCATION_KEYS.map((key) => created.locationIds[key]));

      const publicFactions = artifacts.filter((artifact) => artifact.artifact_kind === "faction" && artifact.visibility === "public");
      expect(publicFactions.length).toBeGreaterThanOrEqual(2);

      const publicNpcs = artifacts.filter((artifact) => artifact.artifact_kind === "npc" && artifact.visibility === "public");
      expect(publicNpcs.length).toBeGreaterThanOrEqual(8);
      for (const npc of publicNpcs) {
        const value = JSON.parse(npc.canonical_json) as { locationKey?: string };
        expect(value.locationKey, npc.artifact_key).toBeTruthy();
        expect(byKey.get(value.locationKey!)?.artifact_kind, npc.artifact_key).toBe("location");
      }

      const publicQuests = artifacts.filter((artifact) => artifact.artifact_kind === "quest" && artifact.visibility === "public");
      expect(publicQuests.length).toBeGreaterThanOrEqual(4);
      for (const quest of publicQuests) {
        const value = JSON.parse(quest.canonical_json) as { objectives: unknown[]; locationKeys: string[] };
        expect(value.objectives.length, quest.artifact_key).toBeGreaterThan(0);
        for (const locationKey of value.locationKeys) expect(byKey.has(locationKey), `${quest.artifact_key}:${locationKey}`).toBe(true);
      }

      const rumors = artifacts.filter((artifact) => artifact.artifact_kind === "lore" && artifact.visibility === "public");
      expect(rumors.length).toBeGreaterThanOrEqual(3);
      for (const rumor of rumors) expect((JSON.parse(rumor.canonical_json) as { title?: string }).title).toBeTruthy();

      // Encounter anchor: a public encounter at the anchor location with an exact pinned hostile.
      const anchor = artifacts.find((artifact) => artifact.artifact_kind === "encounter" && artifact.visibility === "public");
      expect(anchor).toBeDefined();
      const anchorValue = JSON.parse(anchor!.canonical_json) as { locationKey?: string; enemyReferences: unknown[] };
      expect(anchorValue.locationKey).toBe(PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY);
      expect(anchorValue.enemyReferences.length).toBeGreaterThan(0);
      expect(locationIds.has(created.locationIds[PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY]!)).toBe(true);

      // Vendor with stock bound to the smith NPC.
      expect(created.vendor.npcKey).toBe(PLAYTEST_WORLD_VENDOR_NPC_KEY);
      expect(created.counts.shopStock).toBeGreaterThan(0);
      const binding = db.prepare("SELECT shop_id FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND npc_id=?")
        .get(created.campaignId, created.vendor.npcId) as { shop_id: string } | undefined;
      expect(binding?.shop_id).toBe(created.vendor.shopId);

      // Commerce is provisioned: every party actor holds a positive wallet in the
      // vendor's priced currency and the bound vendor has a buy policy on stock.
      const vendorCurrency = (db.prepare(`SELECT currency_code FROM rpg_shop_stock_v25
        WHERE campaign_id=? AND shop_id=? AND unit_price_minor>0 ORDER BY stock_id LIMIT 1`)
        .get(created.campaignId, created.vendor.shopId) as { currency_code: string } | undefined)?.currency_code;
      expect(vendorCurrency).toBeTruthy();
      expect(created.counts.partyWallets).toBeGreaterThanOrEqual(created.actors.length);
      expect(created.counts.shopBuyPolicies).toBeGreaterThanOrEqual(1);
      const policy = db.prepare(`SELECT currency_code,payout_unit_minor FROM rpg_shop_buy_policies_v57
        WHERE campaign_id=? AND shop_id=? ORDER BY stock_id LIMIT 1`)
        .get(created.campaignId, created.vendor.shopId) as { currency_code: string; payout_unit_minor: number } | undefined;
      expect(policy?.currency_code).toBe(vendorCurrency);
      for (const actor of created.actors) {
        const wallet = db.prepare(`SELECT balance_minor FROM rpg_wallets_v25
          WHERE campaign_id=? AND actor_id=? AND currency_code=?`)
          .get(created.campaignId, actor.actorId, vendorCurrency!) as { balance_minor: number } | undefined;
        expect(wallet?.balance_minor, `wallet for ${actor.name}`).toBeGreaterThan(0);
        // The reported name must track the authoritative persona row, not actor order.
        const persona = db.prepare(`SELECT persona.name name FROM campaign_actors actor
          JOIN campaign_characters cc ON cc.id=actor.campaign_character_id AND cc.campaign_id=actor.campaign_id
          JOIN characters persona ON persona.id=cc.character_id
          WHERE actor.campaign_id=? AND actor.id=?`)
          .get(created.campaignId, actor.actorId) as { name: string } | undefined;
        expect(actor.personaId, `persona id for ${actor.name}`).toBeTruthy();
        expect(actor.name, `reported name for actor ${actor.actorId}`).toBe(persona?.name);
      }
      expect(created.actors.map((actor) => actor.name).sort()).toEqual(
        PLAYTEST_WORLD_PARTY.map((persona) => persona.name).sort());

      // Party is standing on a public accepted-artifact-backed location, and each
      // actor has discovered it so the agent context has a current location.
      expect(created.counts.locationDiscoveries).toBeGreaterThanOrEqual(created.actors.length);
      for (const actor of created.actors) {
        const placement = db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?")
          .get(created.campaignId, actor.actorId) as { location_id: string } | undefined;
        expect(placement?.location_id, actor.name).toBe(created.locationIds[PLAYTEST_WORLD_START_LOCATION_KEY]);
        const discovery = db.prepare("SELECT 1 FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id=? AND location_id=?")
          .get(created.campaignId, actor.actorId, created.locationIds[PLAYTEST_WORLD_START_LOCATION_KEY]);
        expect(discovery, `discovery for ${actor.name}`).toBeTruthy();
        const backing = db.prepare(`SELECT 1 FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public'`)
          .get(created.campaignId, placement!.location_id);
        expect(backing, actor.name).toBeTruthy();
      }

      // Presence and relationships exist for the cast.
      expect(created.counts.presenceEvents).toBeGreaterThanOrEqual(4);
      expect(created.counts.npcRelationships).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});
