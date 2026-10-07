import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { closeRepo, createRepository, SRD_5_1_STARTER_CATALOG } from "../../server/src/repo/index.js";
import { hydrateSintermarkCampaign } from "../hydrate-sintermark-campaign.js";

const OWNER = "local-owner";

test("Sintermark is restart-safe and its prepared wizard can spend a slot in real SRD combat", async () => {
  const directory = mkdtempSync("/tmp/opencode/sintermark-test-");
  const previousDirectory = process.env.VELVET_DATA_DIR;
  let repository: ReturnType<typeof createRepository> | undefined;
  let db: Database.Database | undefined;
  try {
    const seeded = await hydrateSintermarkCampaign(directory);
    const again = await hydrateSintermarkCampaign(directory);
    assert.equal(again.campaignId, seeded.campaignId);
    assert.equal(again.sessionId, seeded.sessionId);
    assert.deepEqual(again.heroes, seeded.heroes);

    repository = createRepository({ dataDir: directory, rng: { integer: (minimum) => minimum } });
    assert.equal(repository.listCampaignCharacters(OWNER, seeded.campaignId).length, 2);
    assert.equal(repository.getCampaignAdministration(OWNER, seeded.campaignId)?.status, "published");
    assert.equal(repository.getSession(seeded.sessionId)?.state, "active");
    db = new Database(join(directory, "velvet.sqlite"));
    const scalar = (sql: string): number => (db!.prepare(sql).get(seeded.campaignId) as { n: number }).n;
    assert.equal(scalar("SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND visibility='public'"), 26);
    assert.equal(scalar("SELECT count(*) n FROM campaign_actor_locations_v28 WHERE campaign_id=?"), 2);
    assert.ok(scalar("SELECT count(*) n FROM world_route_event_profiles_v1 WHERE campaign_id=?") >= 13);
    assert.equal(scalar(`SELECT count(*) n FROM campaign_material_deliveries_v53 delivery
      JOIN campaign_generation_accepted_artifacts_v52 artifact USING(campaign_id,artifact_key)
      WHERE campaign_id=? AND json_extract(artifact.canonical_json,'$.visibility')='gm'`), 0);
    const locations = db.prepare("SELECT location_id FROM campaign_locations_v28 WHERE campaign_id=? AND visibility='public'")
      .all(seeded.campaignId) as Array<{ location_id: string }>;
    const routes = db.prepare(`SELECT from_location_id,to_location_id FROM campaign_location_connections_v28
      WHERE campaign_id=? AND visibility='public' AND route_state='open' AND requirement_kind='none'`)
      .all(seeded.campaignId) as Array<{ from_location_id: string; to_location_id: string }>;
    const start = db.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?")
      .get(seeded.campaignId) as { location_id: string };
    const reachable = new Set([start.location_id]);
    for (const location of reachable) {
      for (const route of routes) if (route.from_location_id === location) reachable.add(route.to_location_id);
    }
    assert.equal(reachable.size, locations.length, "closed and reputation-gated shortcuts must leave every public place reachable");
    assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);

    const wizard = seeded.heroes.find((hero) => hero.name === "Tessel Venn");
    assert.ok(wizard);
    const health = db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .get(seeded.campaignId, wizard.actorId);
    assert.deepEqual(health, { current: 1_000, max: 1_000 });
    assert.equal(repository.getTacticalMap(OWNER, seeded.campaignId, seeded.sessionId, "exploration", wizard.actorId)?.locationBinding?.locationId,
      start.location_id);
    const known = db.prepare("SELECT definition_id FROM character_known_powers_v23 WHERE campaign_character_id=?")
      .all(wizard.campaignCharacterId) as Array<{ definition_id: string }>;
    assert.ok(known.some((power) => power.definition_id === "srd-5.1:spell:magic-missile"));

    const enemy = SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === "enemy-template"
      && definition.reference.definitionId === "srd-5.1:enemy-template:water-elemental");
    assert.ok(enemy && enemy.reference.kind === "enemy-template");
    for (const prepared of repository.listEncounters(OWNER, seeded.campaignId) ?? []) {
      if (prepared.status === "preparing") repository.cancelPreparingEncounter(OWNER, prepared.encounterId, {
        expectedRevision: prepared.revision, idempotencyKey: `sintermark.test.cancel.${prepared.encounterId}`,
      });
    }
    const encounter = repository.createEncounter(OWNER, seeded.campaignId, {
      sessionId: seeded.sessionId, name: "Isolated toy validation",
      combatants: [{ kind: "actor", actorId: wizard.actorId, team: "allies" },
        { kind: "enemy", template: enemy.reference, team: "enemies" }], idempotencyKey: "sintermark.test.prepare",
    });
    let combat = repository.startEncounter(OWNER, encounter.encounter.encounterId, {
      expectedRevision: encounter.encounter.revision, idempotencyKey: "sintermark.test.start",
    }).combat;
    const caster = combat.combatants.find((combatant) => combatant.kind === "actor" && combatant.actorId === wizard.actorId);
    assert.ok(caster);
    for (let step = 0; combat.currentCombatant !== caster.combatantId && step < 20; step++) {
      combat = repository.executeCombatEnemyTurn(OWNER, combat.combatId, {
        expectedRevision: combat.revision, idempotencyKey: `sintermark.test.enemy.${step}`,
      }).combat;
    }
    assert.equal(combat.currentCombatant, caster.combatantId);
    const action = repository.getCombatPowerLegalActions(OWNER, combat.combatId)
      .find((candidate) => candidate.powerRef.definitionId === "srd-5.1:spell:magic-missile");
    assert.ok(action, "prepared leveled spell must be a legal combat action");
    const revision = (family: "m15" | "m16", actorId: string): number =>
      (db!.prepare(`SELECT revision FROM rpg_${family}_mutation_revisions_v${family === "m15" ? "25" : "26"} WHERE campaign_id=? AND actor_id=?`)
        .get(seeded.campaignId, actorId) as { revision: number } | undefined)?.revision ?? 0;
    const request = {
      legalActionId: action.legalActionId, powerRef: action.powerRef, targetCombatantId: action.targetCombatantId,
      expectedCombatRevision: combat.revision,
      expectedSourceM15Revision: revision("m15", wizard.actorId), expectedSourceM16Revision: revision("m16", wizard.actorId),
      expectedTargetM15Revision: action.targetActorId ? revision("m15", action.targetActorId) : null,
      expectedTargetM16Revision: action.targetActorId ? revision("m16", action.targetActorId) : null,
      idempotencyKey: "sintermark.test.magic-missile",
    };
    const result = repository.useCombatPower(OWNER, request);
    assert.ok(result.outcomes.some((outcome) => outcome.kind === "damage" && outcome.applied > 0));
    assert.deepEqual(repository.useCombatPower(OWNER, request), result, "replay must not spend another slot");
    const slots = db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'")
      .get(seeded.campaignId, wizard.actorId) as { current: number };
    assert.equal(slots.current, 99);
    assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
  } finally {
    db?.close();
    repository?.close();
    closeRepo();
    if (previousDirectory === undefined) delete process.env.VELVET_DATA_DIR;
    else process.env.VELVET_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Sintermark refuses unrelated storage without changing the existing campaign", async () => {
  const directory = mkdtempSync("/tmp/opencode/sintermark-foreign-test-");
  const previousDirectory = process.env.VELVET_DATA_DIR;
  try {
    process.env.VELVET_DATA_DIR = directory;
    closeRepo();
    const repository = createRepository({ dataDir: directory });
    const campaign = repository.createCampaign(OWNER, { name: "Existing player world" });
    repository.close();
    await assert.rejects(hydrateSintermarkCampaign(directory), /different campaign|refusing/);
    const readOnly = new Database(join(directory, "velvet.sqlite"), { readonly: true });
    try {
      assert.deepEqual(readOnly.prepare("SELECT id,name FROM campaigns").all(), [{ id: campaign.id, name: campaign.name }]);
      assert.equal((readOnly.prepare("SELECT count(*) n FROM characters").get() as { n: number }).n, 0);
    } finally { readOnly.close(); }
  } finally {
    closeRepo();
    if (previousDirectory === undefined) delete process.env.VELVET_DATA_DIR;
    else process.env.VELVET_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});
