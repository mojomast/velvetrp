import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const HOSTILE = "I attack the nearest foe!";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
});
const enableRpg = (): void => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};

/**
 * Makes the fixed route principal `local-owner` a non-owner player that does
 * not control the actor, by moving campaign ownership to a fresh principal in
 * one deferred-FK transaction. The caller asserts the resulting 404.
 */
function demoteLocalOwner(f: Fixture): void {
  const db = openDb();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('encounter-nonowner','Encounter non-owner',0)").run();
    db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id=?").run(f.campaign.id, OWNER);
    db.prepare("UPDATE campaigns SET owner_principal_id='encounter-nonowner' WHERE id=?").run(f.campaign.id);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,'owner','2036-01-01T00:00:00.000Z')")
      .run(f.campaign.id, "encounter-nonowner");
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='encounter-nonowner' WHERE campaign_id=? AND actor_id=?")
      .run(f.campaign.id, f.actorId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const encounterUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-encounter-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform encounter HTTP command", () => {
  it("materializes an encounter with a generated tactical map and durable receipts", async () => {
    enableRpg();
    const f = await dmFixture();
    const app = appFor(f);

    const response = await app.inject(post(
      encounterUrl(f.campaign.id, f.session.id, f.actorId),
      { text: HOSTILE },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-encounter" });
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized encounter");
    expect(body.materialization.candidate.visibility).toBe("public");
    expect(body.materialization.tacticalMapId).toBeTruthy();
    expect(body.materialization.createReceipt.idempotencyKey).toBeTruthy();
    expect(body.materialization.startReceipt.idempotencyKey).toBeTruthy();

    const db = openDb();
    expect(db.prepare("SELECT status,session_id FROM encounter WHERE encounter_id=?").get(body.materialization.encounterId))
      .toEqual({ status: "active", session_id: f.session.id });
    // The start command generated exactly one deterministic tactical map.
    const map = db.prepare(`SELECT map_id,active,encounter_id FROM tactical_maps_v58
      WHERE campaign_id=? AND session_id=? AND encounter_id=?`).get(f.campaign.id, f.session.id, body.materialization.encounterId) as
      { map_id: string; active: number; encounter_id: string };
    expect(map.map_id).toBe(body.materialization.tacticalMapId);
    expect(map.active).toBe(1);
    for (const receipt of [body.materialization.createReceipt, body.materialization.startReceipt]) {
      expect(db.prepare("SELECT 1 FROM combat_receipts_v27 WHERE encounter_id=? AND command_id=?")
        .get(body.materialization.encounterId, receipt.commandId)).toBeTruthy();
    }
    db.close();
    await app.close();
  });

  it("returns only the classification without hostile intent or a compatible enemy", async () => {
    enableRpg();
    const f = await dmFixture();
    const app = appFor(f);
    const url = encounterUrl(f.campaign.id, f.session.id, f.actorId);

    const none = await app.inject(post(url, { text: "I look around the market." }));
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().classification).toMatchObject({ intent: "none", reason: "no-hostile-intent" });
    expect(none.json().materialization).toBeUndefined();
    expect(none.body).not.toContain("materialization");

    // Corrupt the isolated fixture into a catalog with no reachable enemy.
    const db = openDb();
    db.exec("DROP TRIGGER rpg_catalog_visibility_immutable_update");
    db.prepare("UPDATE rpg_catalog_definition_visibility SET publicly_reachable=0 WHERE kind='enemy-template'").run();
    db.close();

    const incompatible = await app.inject(post(url, { text: HOSTILE }));
    expect(incompatible.statusCode, incompatible.body).toBe(200);
    expect(incompatible.json().classification).toMatchObject({ intent: "none", reason: "no-compatible-enemy" });
    expect(incompatible.json().materialization).toBeUndefined();
    await app.close();
  });

  it("returns 404 for a non-owner principal that does not control the actor", async () => {
    enableRpg();
    const f = await dmFixture();
    const app = appFor(f);

    // The route acts as the fixed literal `local-owner`. Demote that principal
    // to a non-owner player that does not control the actor, so the repository
    // authorization fails closed before any encounter is created.
    demoteLocalOwner(f);

    const response = await app.inject(post(
      encounterUrl(f.campaign.id, f.session.id, f.actorId),
      { text: HOSTILE },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_ENCOUNTER_NOT_FOUND" });

    const verify = openDb();
    expect(countOf(verify, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(0);
    verify.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    const app = appFor(f);

    const response = await app.inject(post(
      encounterUrl(f.campaign.id, f.session.id, f.actorId),
      { text: HOSTILE, candidateId: "ffe-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_ENCOUNTER_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges exactly once on an identical replay", async () => {
    enableRpg();
    const f = await dmFixture();
    const app = appFor(f);
    const url = encounterUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { text: HOSTILE }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized encounter");

    const second = await app.inject(post(url, { text: HOSTILE }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.materialization.status).toBe("materialized");
    if (secondBody.materialization.status !== "materialized") throw new Error("expected a replayed encounter");
    expect(secondBody.materialization.encounterId).toBe(firstBody.materialization.encounterId);
    expect(secondBody.materialization.combatId).toBe(firstBody.materialization.combatId);
    expect(secondBody.materialization.tacticalMapId).toBe(firstBody.materialization.tacticalMapId);
    expect(secondBody.materialization.createReceipt).toEqual(firstBody.materialization.createReceipt);
    expect(secondBody.materialization.startReceipt).toEqual(firstBody.materialization.startReceipt);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM tactical_maps_v58 WHERE campaign_id=? AND encounter_id=?", f.campaign.id, firstBody.materialization.encounterId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM combat_receipts_v27 WHERE encounter_id=?", firstBody.materialization.encounterId)).toBe(2);
    db.close();
    await app.close();
  });

  it("cancels the blocking preparing encounter so the freeform route no longer conflicts", async () => {
    enableRpg();
    process.env.FEATURE_RPG_COMBAT = "true";
    const f = await dmFixture();
    const app = appFor(f);
    const freeform = post(encounterUrl(f.campaign.id, f.session.id, f.actorId), { text: HOSTILE });

    // The prepared encounter occupies the session's only slot.
    const prepared = f.prepare();
    const blocked = await app.inject(freeform);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "RPG_FREEFORM_ENCOUNTER_CONFLICT" });

    // Cancel it through the encounter lifecycle route.
    const cancelled = await app.inject(post(`/api/rpg/v1/encounters/${prepared.encounterId}/cancel-commands`,
      { expectedRevision: prepared.revision, idempotencyKey: "cancel-blocking-prepare" }));
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ encounter: { encounterId: prepared.encounterId, status: "cancelled", combatId: null },
      receipt: { idempotencyKey: "cancel-blocking-prepare", revisionBefore: prepared.revision, revisionAfter: prepared.revision + 1 } });

    // The freeform route now materializes instead of conflicting.
    const materialized = await app.inject(freeform);
    expect(materialized.statusCode, materialized.body).toBe(200);
    expect(materialized.json().classification).toMatchObject({ intent: "materialize-encounter" });
    expect(materialized.json().materialization.status).toBe("materialized");

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=? AND status='active'", f.campaign.id)).toBe(1);
    expect(db.prepare("SELECT status FROM encounter WHERE encounter_id=?").get(prepared.encounterId)).toEqual({ status: "cancelled" });
    db.close();
    await app.close();
  });
});
