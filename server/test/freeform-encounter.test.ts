import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FreeformEncounterConflictError,
  classifyFreeformEncounter,
  type FreeformEncounterEnemyTemplate,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const HOSTILE = "I attack the nearest foe!";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

type ReachableEnemy = { packId: string; packVersion: string; definitionId: string; json: string };

/** The campaign's publicly reachable, pinned enemy catalog: the only allowable hostile source. */
function reachableEnemies(db: DatabaseDriver.Database, campaignId: string): ReachableEnemy[] {
  return db.prepare(`SELECT visibility.pack_id packId,visibility.pack_version packVersion,
      visibility.definition_id definitionId,visibility.public_definition_json json
    FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility
      ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND visibility.kind='enemy-template' AND visibility.publicly_reachable=1
    ORDER BY visibility.pack_id,visibility.pack_version,visibility.definition_id`).all(campaignId) as ReachableEnemy[];
}

const matchOf = (reachable: ReachableEnemy[], enemy: { packId: string; packVersion: string; definitionId: string }) =>
  reachable.find((row) => row.packId === enemy.packId && row.packVersion === enemy.packVersion && row.definitionId === enemy.definitionId);

describe("freeform encounter classification", () => {
  it("bounds the roster to exact pinned enemy templates", async () => {
    const f = await dmFixture();
    const db = openDb();
    const reachable = reachableEnemies(db, f.campaign.id);
    expect(reachable.length).toBeGreaterThan(0);
    db.close();

    const classification = f.repo.classifyFreeformEncounterIntent(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE);
    expect(classification.intent).toBe("materialize-encounter");
    if (classification.intent !== "materialize-encounter") throw new Error("expected a materialize-encounter classification");
    expect(classification.candidates).toHaveLength(1);
    const candidate = classification.candidates[0]!;
    expect(candidate.actorId).toBe(f.actorId);
    expect(candidate.visibility).toBe("public");
    // Bounded roster, every entry an exact pinned reference.
    expect(candidate.enemies.length).toBeGreaterThanOrEqual(1);
    expect(candidate.enemies.length).toBeLessThanOrEqual(4);
    for (const enemy of candidate.enemies) {
      expect(enemy.kind).toBe("enemy-template");
      expect(matchOf(reachable, enemy)).toBeDefined();
    }
    // Deterministic identity: the same declaration always maps to the same candidate.
    expect(f.repo.classifyFreeformEncounterIntent(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE)).toEqual(classification);
    expect(() => f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE,
      { candidateId: "ffe-not-a-real-candidate" })).toThrow(FreeformEncounterConflictError);
    f.repo.close();
  });

  it("fails closed without a hostile declaration or a compatible pinned enemy", () => {
    const template: FreeformEncounterEnemyTemplate = {
      reference: { kind: "enemy-template", packId: "srd-5.1", packVersion: "1.0.0", definitionId: "srd-5.1:enemy-template:goblin" },
      name: "Goblin", challengeRating: 0.25,
    };
    const base = { identity: "cid:session:actor", actorId: "actor", actorName: "Hero", locationName: null, enemies: [template] };
    expect(classifyFreeformEncounter({ ...base, text: "I look around the market." }))
      .toMatchObject({ intent: "none", reason: "no-hostile-intent" });
    expect(classifyFreeformEncounter({ ...base, text: HOSTILE, enemies: [] }))
      .toMatchObject({ intent: "none", reason: "no-compatible-enemy" });
    // A reference that is not an exact enemy-template reference never satisfies the roster.
    const invalid = { ...template, reference: { ...template.reference, kind: "monster" as never } };
    expect(classifyFreeformEncounter({ ...base, text: HOSTILE, enemies: [invalid] }))
      .toMatchObject({ intent: "none", reason: "no-compatible-enemy" });
    const classification = classifyFreeformEncounter({ ...base, text: "I attack the elite champion!" });
    if (classification.intent !== "materialize-encounter") throw new Error("expected a materialize-encounter classification");
    const enemies = classification.candidates[0]!.enemies;
    expect(enemies.length).toBeGreaterThanOrEqual(1);
    expect(enemies.length).toBeLessThanOrEqual(4);
    expect(enemies.every((enemy) => enemy.packId === template.reference.packId
      && enemy.packVersion === template.reference.packVersion
      && enemy.definitionId === template.reference.definitionId)).toBe(true);
  });
});

describe("freeform encounter materialization", () => {
  it("creates and starts one encounter with a generated tactical map and durable receipts", async () => {
    const f = await dmFixture();
    const db = openDb();
    const reachable = reachableEnemies(db, f.campaign.id);
    const result = f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE);
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized encounter");

    // The encounter is active and owned by the session.
    expect(db.prepare("SELECT status,session_id FROM encounter WHERE encounter_id=?").get(result.encounterId))
      .toEqual({ status: "active", session_id: f.session.id });

    // Allies: the initiating actor. Enemies: exactly the candidate's exact pinned references.
    const combatants = db.prepare("SELECT combatant_kind,team,actor_id FROM combatant WHERE encounter_id=? ORDER BY combatant_kind,combatant_id")
      .all(result.encounterId) as Array<{ combatant_kind: string; team: string; actor_id: string | null }>;
    expect(combatants.filter((row) => row.combatant_kind === "actor")).toEqual([{ combatant_kind: "actor", team: "allies", actor_id: f.actorId }]);
    const provenance = db.prepare("SELECT pack_id,pack_version,definition_id FROM encounter_enemy_provenance_v31 WHERE encounter_id=?")
      .all(result.encounterId) as Array<{ pack_id: string; pack_version: string; definition_id: string }>;
    expect(provenance).toHaveLength(result.candidate.enemies.length);
    for (const row of provenance) {
      expect(matchOf(reachable, { packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id })).toBeDefined();
    }

    // The start command generated exactly one deterministic tactical map with tokens.
    const map = db.prepare(`SELECT map_id,active,seed,algorithm,encounter_id FROM tactical_maps_v58
      WHERE campaign_id=? AND session_id=? AND encounter_id=?`).get(f.campaign.id, f.session.id, result.encounterId) as
      { map_id: string; active: number; seed: string; algorithm: string; encounter_id: string };
    expect(map.map_id).toBe(result.tacticalMapId);
    expect(map.active).toBe(1);
    expect(map.seed).toBe(`combat:${result.encounterId}`);
    expect(countOf(db, "SELECT count(*) n FROM tactical_map_tokens_v58 WHERE map_id=?", result.tacticalMapId)).toBe(combatants.length);

    // Durable combat receipts for both the create and the start commands.
    for (const receipt of [result.createReceipt, result.startReceipt]) {
      expect(db.prepare("SELECT 1 FROM combat_receipts_v27 WHERE encounter_id=? AND command_id=?")
        .get(result.encounterId, receipt.commandId)).toBeTruthy();
    }
    expect(db.prepare("SELECT count(*) n FROM combat_commands_v27 WHERE encounter_id=? AND command_type='start'").get(result.encounterId))
      .toEqual({ n: 2 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("reports a bounded conflict when the session already has an open encounter", async () => {
    const f = await dmFixture();
    const first = f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE);
    expect(first.status).toBe("materialized");
    if (first.status !== "materialized") throw new Error("expected a materialized encounter");
    const firstRoster = JSON.stringify(first.candidate.enemies);
    // The create idempotency key is derived from the exact roster, so only a
    // different roster is a genuinely new encounter: the already-open one makes
    // the engine refuse, and that refusal must surface as the bounded conflict.
    const alternate = ["I attack the swarm of rats!", "I attack the elite champion!", "I attack the goblins!",
      "I attack the shapes in the fog!", "I draw my sword and attack the foe!"].find((text) => {
      const classification = f.repo.classifyFreeformEncounterIntent(OWNER, f.campaign.id, f.session.id, f.actorId, text);
      return classification.intent === "materialize-encounter"
        && JSON.stringify(classification.candidates[0]?.enemies) !== firstRoster;
    });
    expect(alternate).toBeDefined();
    expect(() => f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, alternate!))
      .toThrow(FreeformEncounterConflictError);
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    const first = f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE);
    const second = f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE);
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.encounterId).toBe(first.encounterId);
    expect(second.combatId).toBe(first.combatId);
    expect(second.tacticalMapId).toBe(first.tacticalMapId);
    expect(second.createReceipt).toEqual(first.createReceipt);
    expect(second.startReceipt).toEqual(first.startReceipt);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM tactical_maps_v58 WHERE campaign_id=? AND encounter_id=?", f.campaign.id, first.encounterId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM combat_receipts_v27 WHERE encounter_id=?", first.encounterId)).toBe(2);
    db.close();
    f.repo.close();
  });

  it("fails closed when the pinned catalog has no reachable enemy", async () => {
    const f = await dmFixture();
    const db = openDb();
    // The catalog projection is immutable by design; drop its update guard to corrupt this
    // isolated fixture into a "no reachable enemy" catalog for the fail-closed path.
    db.exec("DROP TRIGGER rpg_catalog_visibility_immutable_update");
    db.prepare("UPDATE rpg_catalog_definition_visibility SET publicly_reachable=0 WHERE kind='enemy-template'").run();
    expect(f.repo.classifyFreeformEncounterIntent(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE))
      .toMatchObject({ intent: "none", reason: "no-compatible-enemy" });
    expect(f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE))
      .toEqual({ status: "declined", reason: "no-compatible-enemy" });
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    f.repo.close();
  });

  it("rolls the whole encounter back when start fails", async () => {
    const f = await dmFixture();
    const db = openDb();
    // Fail after the encounter is created, while the start command generates the tactical map.
    db.exec(`CREATE TRIGGER freeform_encounter_inject_failure BEFORE INSERT ON tactical_maps_v58
      BEGIN SELECT RAISE(ABORT,'injected freeform encounter failure'); END;`);
    expect(() => f.repo.materializeFreeformEncounter(OWNER, f.campaign.id, f.session.id, f.actorId, HOSTILE)).toThrow();
    db.exec("DROP TRIGGER freeform_encounter_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM combatant WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM encounter_enemy_provenance_v31 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM combat_commands_v27")).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM combat_receipts_v27")).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM tactical_maps_v58 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    f.repo.close();
  });
});
