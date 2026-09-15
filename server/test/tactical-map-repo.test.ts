import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MECHANICS_STARTER_CATALOG, SRD_5_1_STARTER_CATALOG, TacticalMapConflictError, TacticalMapStaleError, createRepository } from "../src/repo/index.js";
import { createSession, transitionSession } from "../src/repo/sessionRepo.js";
import { useTmpDataDir } from "./helpers.js";
import { generateTacticalMap } from "../src/map/generation.js";
import { buildApp } from "../src/app.js";

useTmpDataDir();
const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };

async function fixture(dnd = false) {
  const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Map campaign" });
  if (dnd) {
    repo.installSrdStarterCatalog("local-owner"); repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "map-pins" });
  } else {
    repo.installMechanicsStarterCatalog("local-owner"); repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "map-pins" });
  }
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.prepare("INSERT INTO principals VALUES('reader','Reader',0)").run(); db.close();
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "reader", role: "player" });
  const persona = repo.createCharacter({ name: "Aster", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "reader", durability: "durable", allocation: { method: "standard-array", scores: dnd ? { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 } : scores }, idempotencyKey: "map-draft" });
  const definitions = (dnd ? SRD_5_1_STARTER_CATALOG : MECHANICS_STARTER_CATALOG).definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "map-select", selections: {
    race: definitions.find((value) => value.reference.kind === "race")!.reference,
    background: definitions.find((value) => value.reference.kind === "background")!.reference,
    class: definitions.find((value) => value.reference.kind === "class")!.reference,
    starterGrant: "kit",
  } } as never);
  const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "map-final" }).receipt.actorId;
  const session = await createSession({ characterId: persona.id, title: "Map room" }); await transitionSession(session.id, "active", "test");
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id }); return { repo, campaignId: campaign.id, sessionId: session.id, actorId };
}

describe("tactical map repository", () => {
  it("binds v2 generation to persisted session location, preserves replay, and rejects travel-stale moves", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const request = { mode: "exploration" as const, encounterId: null, kind: "cave" as const, seed: "private-seed", width: 12, height: 10,
      grounding: { actorId, expectedLocationId: "map-location", expectedLocationRevision: 0 },
      tokens: [{ tokenId: actorId, actorId, combatantId: null, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 2, height: 2 }, disposition: "friendly" as const, hidden: false }], idempotencyKey: "grounded" };
    try {
      expect(() => repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request)).toThrow(/location/);
      db.prepare("INSERT INTO campaign_locations_v28 VALUES(?,?,NULL,?,'Prose is not mechanics','public',?)").run("map-location", campaignId, "Accepted place", "2030-01-01T00:00:00.000Z");
      db.prepare("INSERT INTO campaign_locations_v28 VALUES(?,?,NULL,?,'','public',?)").run("other-location", campaignId, "Other place", "2030-01-01T00:00:00.000Z");
      repo.setActorLocation("local-owner", sessionId, { type: "set_actor_location", campaignId, actorId, locationId: "map-location", expectedRevision: 0, idempotencyKey: "initial-place" });
      expect(() => repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...request, grounding: { ...request.grounding, expectedLocationRevision: 1 } })).toThrow(TacticalMapStaleError);
      const generated = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request);
      expect(generated.locationBinding).toEqual({ locationId: "map-location" });
      expect(db.prepare("SELECT algorithm FROM tactical_maps_v58 WHERE map_id=?").get(generated.projection.mapId)).toEqual({ algorithm: "cave-v2" });
      expect(() => db.prepare("UPDATE tactical_map_contexts_v2 SET context_json='{}'").run()).toThrow(/immutable/);
      const before = repo.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)!;
      expect(before.locationBinding).toEqual(generated.locationBinding);
      expect(JSON.stringify(before)).not.toMatch(/private-seed|context|provenance|Prose|blocksMovement/);
      const previewRequest = { actorId, destination: { x: 1, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 };
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "exploration", previewRequest);
      const move = { ...previewRequest, previewId: preview.previewId, idempotencyKey: "grounded-move" };
      repo.setActorLocation("local-owner", sessionId, { type: "set_actor_location", campaignId, actorId, locationId: "other-location", expectedRevision: 1, idempotencyKey: "leave" });
      expect(() => repo.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)).toThrow(/current location/);
      expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "exploration", previewRequest)).toThrow(/current location/);
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", move)).toThrow(/current location/);
      repo.setActorLocation("local-owner", sessionId, { type: "set_actor_location", campaignId, actorId, locationId: "map-location", expectedRevision: 2, idempotencyKey: "return" });
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", move)).toThrow(TacticalMapStaleError);
      // Editing canonical prose never changes persisted geometry, nor does idempotent generation re-resolve inputs.
      db.prepare("UPDATE campaign_locations_v28 SET public_description='Secret lava dragons' WHERE location_id='map-location'").run();
      expect(repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request).projection).toEqual(generated.projection);
      repo.close();
      const reopened = createRepository();
      try { expect(reopened.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)?.projection).toEqual(before.projection); }
      finally { reopened.close(); }
    } finally { db.close(); repo.close(); }
  });

  it("rejects illegal v2 footprints without replacing the active map", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    try {
      db.prepare("INSERT INTO campaign_locations_v28 VALUES('map-location',?,NULL,'Place','','public',?)").run(campaignId, "2030-01-01T00:00:00.000Z");
      db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'map-location',?,0,?)").run(campaignId, actorId, sessionId, "2030-01-01T00:00:00.000Z");
      const request = { mode: "exploration" as const, encounterId: null, kind: "dungeon" as const, seed: "seed", width: 12, height: 10,
        grounding: { actorId, expectedLocationId: "map-location", expectedLocationRevision: 0 },
        tokens: [{ tokenId: actorId, actorId, combatantId: null, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const, hidden: false }], idempotencyKey: "valid" };
      const original = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request);
      expect(() => repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...request, idempotencyKey: "invalid", tokens: [{ ...request.tokens[0]!, position: { x: 0, y: 0 } }] })).toThrow(TacticalMapConflictError);
      expect(repo.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)?.projection.mapId).toBe(original.projection.mapId);
      expect(db.prepare("SELECT count(*) count FROM tactical_map_contexts_v2").get()).toEqual({ count: 1 });
    } finally { db.close(); repo.close(); }
  });

  it("keeps unknown D&D bindings fail closed without mutation", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture(true);
    const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "D&D map combat",
      combatants: [{ kind: "actor", actorId, team: "allies" }], idempotencyKey: "dnd-map-encounter" });
    const combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "dnd-map-start" }).combat;
    const generated = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { mode: "combat", encounterId: prepared.encounter.encounterId,
      kind: "arena", seed: "dnd-map", width: 12, height: 10, idempotencyKey: "dnd-map-generate",
      tokens: [{ tokenId: actorId, actorId, combatantId: combat.combatants[0]!.combatantId, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false }] });
    const snapshot = repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)!;
    expect(snapshot.movement).toEqual({ policy: "combat-current-turn-speed", budgetFeet: 30 });
    expect(snapshot.projection.mapId).toBe(generated.projection.mapId);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const state = () => ["tactical_maps_v58", "tactical_map_tokens_v58", "tactical_map_previews_v58", "tactical_map_commands_v58",
      "tactical_map_exploration_v58", "tactical_map_combat_movement_v58", "combat_turn_economy_v60", "encounter"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    try {
      for (const invalidBinding of [true]) {
        if (invalidBinding) {
          // Simulate corrupt persisted authority, bypassing the normal write protection.
          db.exec("DROP TRIGGER campaign_ruleset_bindings_v60_immutable_update");
          db.prepare("UPDATE campaign_ruleset_bindings_v60 SET ruleset_id='velvet-starter-v1' WHERE campaign_id=?").run(campaignId);
        }
        const before = state();
        const message = "campaign ruleset binding is unavailable";
        // Even a zero-cost request must not create a preview or commit.
        for (const destination of [{ x: 1, y: 1 }, { x: 2, y: 1 }]) {
          const request = { actorId, destination, expectedMapRevision: 0, expectedTokenRevision: 0 };
          expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request)).toThrow(message);
          expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", { ...request, previewId: "unintegrated-preview", idempotencyKey: "blocked-map-move" })).toThrow(message);
        }
        if (invalidBinding) expect(() => repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)).toThrow(message);
        expect(state()).toEqual(before);
      }
    } finally { db.close(); repo.close(); }
  });

  it("persists exact generation, role-safe fog, previews, revisions, exploration, and idempotent moves", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const request = { mode: "exploration" as const, encounterId: null, kind: "arena" as const, seed: "exact-map-seed", width: 12, height: 10,
      tokens: [{ tokenId: actorId, actorId, combatantId: null, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const, hidden: false },
        { tokenId: "hidden-enemy", actorId: null, combatantId: null, label: "Secret enemy", position: { x: 8, y: 7 }, footprint: { width: 1, height: 1 }, disposition: "hostile" as const, hidden: true }], idempotencyKey: "map-generate" };
    const generated = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request);
    expect(repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request).projection.mapId).toBe(generated.projection.mapId);
    const player = repo.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)!;
    expect(player.movement).toEqual({ policy: "exploration-60-feet", budgetFeet: 60 });
    expect(player.projection.tokens.map((token) => token.label)).toEqual(["Aster"]);
    expect(JSON.stringify(player)).not.toMatch(/Secret enemy|blocksMovement|blocksSight|movementCost|provenance/);
    const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "exploration", { actorId, destination: { x: 2, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 });
    expect(preview.pathCostFeet).toBe(5); expect(preview.projection.authoritativePath?.at(-1)).toEqual({ x: 2, y: 1 });
    const move = { actorId, destination: { x: 2, y: 1 }, previewId: preview.previewId, expectedMapRevision: 0, expectedTokenRevision: 0, idempotencyKey: "map-move" };
    const moved = repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", move); expect(moved.receipt.tokenRevisionAfter).toBe(1);
    expect(repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", move).receipt).toEqual(moved.receipt);
    expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "exploration", { actorId, destination: { x: 3, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 })).toThrow(TacticalMapStaleError);
    expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", { ...move, destination: { x: 3, y: 1 } })).toThrow(TacticalMapConflictError);
    repo.close();
    // Reconstruct the exact pre-v2 map schema around real retained map/preview/receipt rows.
    const legacy = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    legacy.pragma("foreign_keys = OFF");
    legacy.transaction(() => {
      legacy.exec("DROP TABLE tactical_map_contexts_v2");
      for (const table of ["tactical_maps_v58", "tactical_map_previews_v58"]) {
        const objects = legacy.prepare("SELECT type,sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY type DESC").all(table) as { type: string; sql: string }[];
        const sql = objects.find((object) => object.type === "table")!.sql.replace(",'dungeon-v2','cave-v2','arena-v2','underwater-v1','underwater-v2'", "").replace("  actor_location_revision INTEGER,\n", "");
        const columns = (legacy.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).filter((column) => column.name !== "actor_location_revision").map((column) => column.name).join(",");
        legacy.exec(`CREATE TEMP TABLE old_map_backup AS SELECT ${columns} FROM ${table}`);
        legacy.exec(`DROP TABLE ${table}`); legacy.exec(sql);
        legacy.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM old_map_backup`);
        legacy.exec("DROP TABLE old_map_backup");
        for (const object of objects.filter((object) => object.type !== "table")) legacy.exec(object.sql);
      }
    })();
    legacy.close();
    const upgraded = createRepository();
    try {
      expect(upgraded.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)?.projection).toEqual(moved.snapshot.projection);
      expect(upgraded.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", move).receipt).toEqual(moved.receipt);
    } finally { upgraded.close(); }
  });

  it("keeps only one active map per room and mode while retaining revisions", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture(); const base = { mode: "exploration" as const, encounterId: null, kind: "arena" as const, width: 10, height: 10,
      tokens: [{ tokenId: actorId, actorId, combatantId: null, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const, hidden: false }] };
    repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...base, seed: "first", idempotencyKey: "first" });
    const second = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...base, seed: "second", idempotencyKey: "second" }); expect(second.mapRevision).toBe(1);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE session_id=? AND mode='exploration'").get(sessionId)).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE session_id=? AND mode='exploration' AND active=1").get(sessionId)).toEqual({ count: 1 }); db.close(); repo.close();
  });

  it("fails combat movement closed outside the current turn and consumes persisted speed", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const template = { kind: "enemy-template" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:enemy-template:gloam-mite" };
    const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Map combat", combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template, team: "enemies" }], idempotencyKey: "map-encounter" });
    let combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "map-start" }).combat;
    const actorCombatant = combat.combatants.find((value) => value.kind === "actor")!;
    repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { mode: "combat", encounterId: prepared.encounter.encounterId, kind: "arena", seed: "combat-map", width: 12, height: 10,
      tokens: [{ tokenId: actorId, actorId, combatantId: actorCombatant.combatantId, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false }], idempotencyKey: "combat-map-generate" });
    if (combat.currentCombatant !== actorCombatant.combatantId) {
      expect(() => repo.getTacticalMap("local-owner", campaignId, sessionId, "combat", actorId)).toThrow(TacticalMapConflictError);
      combat = repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: combat.revision, idempotencyKey: "map-enemy-end" }).combat;
    }
    expect(combat.currentCombatant).toBe(actorCombatant.combatantId);
    const current = repo.getTacticalMap("local-owner", campaignId, sessionId, "combat", actorId)!; expect(current.movement?.budgetFeet).toBe(30);
    const priorRound = repo.previewTacticalMapMove("local-owner", campaignId, sessionId, "combat", { actorId, destination: { x: 2, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 });
    combat = repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: combat.revision, idempotencyKey: "map-actor-end" }).combat;
    combat = repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: combat.revision, idempotencyKey: "map-enemy-next-end" }).combat;
    expect(combat.currentCombatant).toBe(actorCombatant.combatantId);
    expect(() => repo.moveTacticalMapToken("local-owner", campaignId, sessionId, "combat", { actorId, destination: { x: 2, y: 1 }, previewId: priorRound.previewId, expectedMapRevision: 0, expectedTokenRevision: 0, idempotencyKey: "stale-round-map-move" })).toThrow(TacticalMapConflictError);
    const preview = repo.previewTacticalMapMove("local-owner", campaignId, sessionId, "combat", { actorId, destination: { x: 7, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 }); expect(preview.pathCostFeet).toBe(30);
    repo.moveTacticalMapToken("local-owner", campaignId, sessionId, "combat", { actorId, destination: { x: 7, y: 1 }, previewId: preview.previewId, expectedMapRevision: 0, expectedTokenRevision: 0, idempotencyKey: "combat-map-move" });
    expect(repo.getTacticalMap("local-owner", campaignId, sessionId, "combat", actorId)?.movement?.budgetFeet).toBe(0);
    expect(() => repo.previewTacticalMapMove("local-owner", campaignId, sessionId, "combat", { actorId, destination: { x: 8, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 1 })).toThrow(TacticalMapConflictError);
    repo.close();
  });
});

async function dndMapFixture(withEnemy = false) {
  const base = await fixture(true);
  const { repo, campaignId, sessionId, actorId } = base;
  const template = SRD_5_1_STARTER_CATALOG.definitions.find(value => value.reference.kind === "enemy-template")!.reference;
  const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Movement", combatants: [{ kind: "actor", actorId, team: "allies" }, ...(withEnemy ? [{ kind: "enemy" as const, template: { ...template, kind: "enemy-template" as const }, team: "enemies" as const }] : [])], idempotencyKey: "encounter" });
  let combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  if (combat.currentCombatant !== combat.combatants.find(value => value.kind === "actor")!.combatantId) combat = repo.executeCombatEnemyTurn("local-owner", combat.combatId, { expectedRevision: combat.revision, idempotencyKey: "initial-enemy-end" }).combat;
  const generation = { mode: "combat" as const, encounterId: combat.combatId, kind: "arena" as const, seed: "movement", width: 12, height: 10, idempotencyKey: "generate",
    tokens: [{ tokenId: actorId, actorId, combatantId: combat.currentCombatant, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const, hidden: false }] };
  repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, generation);
  const request = { actorId, destination: { x: 2, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 };
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const state = () => ["tactical_maps_v58", "tactical_map_tokens_v58", "tactical_map_previews_v58", "tactical_map_commands_v58", "tactical_map_exploration_v58", "tactical_map_combat_movement_v58", "combat_turn_economy_v60", "encounter", "combat_mutation_revisions_v27"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  return { ...base, combat, generation, request, db, state };
}

describe("D&D tactical movement economy", () => {
  it("returns off-turn zero snapshots and stored replay, rejects old previews after a real round advance", async () => {
    const { repo, campaignId, sessionId, actorId, combat, request, db } = await dndMapFixture(true);
    try {
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request);
      const move = { ...request, previewId: preview.previewId, idempotencyKey: "move" };
      const result = repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move);
      const next = { ...request, expectedTokenRevision: 1, destination: { x: 3, y: 1 } };
      const stale = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", next);
      let current = repo.getCombatState("local-owner", combat.combatId)!;
      current = repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: current.revision, idempotencyKey: "actor-end" }).combat;
      expect(repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)?.movement?.budgetFeet).toBe(0);
      expect(repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move)).toMatchObject({ receipt: result.receipt, snapshot: { movement: { budgetFeet: 0 } } });
      expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", next)).toThrow("actor turn");
      current = repo.executeCombatEnemyTurn("local-owner", combat.combatId, { expectedRevision: current.revision, idempotencyKey: "enemy-end" }).combat;
      expect(current.turnEconomy!.turnId).not.toBe(combat.turnEconomy!.turnId);
      expect(repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)?.movement?.budgetFeet).toBe(30);
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", { ...next, previewId: stale.previewId, idempotencyKey: "old-round" })).toThrow("current preview");
    } finally { db.close(); repo.close(); }
  });
  it("spends partial and full budgets over HTTP, persists replay across restart, and never refills on regeneration", async () => {
    const { repo, campaignId, sessionId, actorId, combat, generation, request, db } = await dndMapFixture();
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    try {
      const url = `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/tactical-maps/combat`;
      const preview = await app.inject({ method: "POST", url: `${url}/previews`, payload: request });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().pathCostFeet).toBe(5);
      expect(db.prepare("SELECT turn_id FROM tactical_map_previews_v58 WHERE preview_id=?").get(preview.json().previewId)).toEqual({ turn_id: combat.turnEconomy!.turnId });
      const move = { ...request, previewId: preview.json().previewId, idempotencyKey: "partial" };
      const response = await app.inject({ method: "POST", url: `${url}/move-commands`, payload: move });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().snapshot.movement.budgetFeet).toBe(25);
      const current = repo.getCombatState("local-owner", combat.combatId)!;
      expect(current.revision).toBe(combat.revision + 1);
      expect(current.turnEconomy).toMatchObject({ action: { available: true }, bonusAction: { available: true }, reaction: { available: true }, movement: { usedFeet: 5, remainingFeet: 25 } });
      expect(() => repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: combat.revision, idempotencyKey: "stale-action" })).toThrow();
      repo.close();
      const reopened = createRepository();
      try {
        expect(reopened.moveTacticalMapToken("local-owner", campaignId, sessionId, "combat", move).receipt).toEqual(response.json().receipt);
        reopened.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...generation, idempotencyKey: "regenerate" });
        expect(reopened.getTacticalMap("local-owner", campaignId, sessionId, "combat", actorId)?.movement?.budgetFeet).toBe(25);
        // Spending an action does not spend or prevent movement.
        db.prepare("UPDATE combat_turn_economy_v60 SET action_used=1 WHERE turn_id=?").run(combat.turnEconomy!.turnId);
        const full = { ...request, expectedMapRevision: 1, destination: { x: 6, y: 1 } };
        const exact = reopened.previewTacticalMapMove("local-owner", campaignId, sessionId, "combat", full);
        expect(exact.pathCostFeet).toBe(25);
        expect(reopened.moveTacticalMapToken("local-owner", campaignId, sessionId, "combat", { ...full, previewId: exact.previewId, idempotencyKey: "full" }).snapshot.movement?.budgetFeet).toBe(0);
        expect(reopened.getCombatState("local-owner", combat.combatId)?.turnEconomy?.action.used).toBe(true);
        expect(() => reopened.previewTacticalMapMove("local-owner", campaignId, sessionId, "combat", { ...full, expectedTokenRevision: 1, destination: { x: 7, y: 1 } })).toThrow("budget");
        expect(db.prepare("SELECT * FROM tactical_map_combat_movement_v58").all()).toEqual([]);
      } finally { reopened.close(); }
    } finally { await app.close(); db.close(); repo.close(); delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; }
  });

  it("binds exact turn identity even when revision, actor, round and budget match", async () => {
    const { repo, campaignId, sessionId, combat, request, db, state } = await dndMapFixture();
    try {
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request);
      db.prepare("UPDATE combat_turn_economy_v60 SET ended_at=started_at WHERE turn_id=?").run(combat.turnEconomy!.turnId);
      // Simulate contradictory persisted history while retaining the old preview FK.
      db.exec("DROP TRIGGER combat_turn_economy_v60_guard");
      db.prepare("UPDATE combat_turn_economy_v60 SET round_number=round_number+1 WHERE turn_id=?").run(combat.turnEconomy!.turnId);
      db.prepare(`INSERT INTO combat_turn_economy_v60(turn_id,encounter_id,combatant_id,round_number,movement_allowance_feet,started_at)
        SELECT 'replacement-turn',encounter_id,combatant_id,round_number-1,movement_allowance_feet,started_at FROM combat_turn_economy_v60 WHERE turn_id=?`).run(combat.turnEconomy!.turnId);
      const before = state();
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", { ...request, previewId: preview.previewId, idempotencyKey: "old-turn" })).toThrow("authority changed");
      expect(state()).toEqual(before);
    } finally { db.close(); repo.close(); }
  });

  it("rolls back preview and all move effects on late transaction failures", async () => {
    const { repo, campaignId, sessionId, request, db, state } = await dndMapFixture();
    try {
      db.exec(`CREATE TRIGGER fail_preview AFTER INSERT ON tactical_map_previews_v58 BEGIN UPDATE tactical_map_tokens_v58 SET width=0; END`);
      const initial = state();
      expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request)).toThrow();
      expect(state()).toEqual(initial); db.exec("DROP TRIGGER fail_preview");
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request);
      db.exec("CREATE TRIGGER refuse_spend BEFORE UPDATE OF movement_used_feet ON combat_turn_economy_v60 BEGIN SELECT RAISE(IGNORE); END");
      const unspent = state();
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", { ...request, previewId: preview.previewId, idempotencyKey: "refused" })).toThrow("authority changed");
      expect(state()).toEqual(unspent); db.exec("DROP TRIGGER refuse_spend");
      db.exec("CREATE TRIGGER fail_move BEFORE INSERT ON tactical_map_commands_v58 WHEN NEW.command_type='move' BEGIN SELECT RAISE(ABORT,'injected late failure'); END");
      const before = state();
      const move = { ...request, previewId: preview.previewId, idempotencyKey: "rollback" };
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move)).toThrow("injected late failure");
      expect(state()).toEqual(before); db.exec("DROP TRIGGER fail_move");
      expect(repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move).snapshot.movement?.budgetFeet).toBe(25);
    } finally { db.close(); repo.close(); }
  });

  it("rejects contradictory round, missing economy and token bindings, and blocks exploration bypass", async () => {
    const { repo, campaignId, sessionId, actorId, combat, generation, request, db, state } = await dndMapFixture();
    try {
      // Corruption tests deliberately bypass lifecycle write guards.
      db.exec("DROP TRIGGER encounter_state_guard_v27; DROP TRIGGER combatant_state_guard_v27; DROP TRIGGER combat_turn_economy_v60_guard");
      for (const [mutation, restore] of [
        ["UPDATE encounter SET round_number=round_number+1", "UPDATE encounter SET round_number=round_number-1"],
        ["UPDATE combat_turn_economy_v60 SET ended_at=started_at", "UPDATE combat_turn_economy_v60 SET ended_at=NULL"],
        ["UPDATE tactical_map_tokens_v58 SET combatant_id=NULL", "UPDATE tactical_map_tokens_v58 SET combatant_id=(SELECT current_turn_combatant_id FROM encounter)"],
        ["UPDATE combatant SET status='defeated'", "UPDATE combatant SET status='active'"],
      ] as const) {
        db.exec(mutation);
        const before = state();
        expect(() => repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)).toThrow(TacticalMapConflictError);
        expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", request)).toThrow(TacticalMapConflictError);
        expect(state()).toEqual(before); db.exec(restore);
      }
      repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...generation, mode: "exploration", encounterId: null, tokens: generation.tokens.map(token => ({ ...token, combatantId: null })) });
      expect(repo.getTacticalMap("reader", campaignId, sessionId, "exploration", actorId)?.movement?.budgetFeet).toBe(0);
      expect(() => repo.previewTacticalMapMove("reader", campaignId, sessionId, "exploration", request)).toThrow("exploration movement");
      expect(() => repo.moveTacticalMapToken("reader", campaignId, sessionId, "exploration", { ...request, previewId: "bypass", idempotencyKey: "bypass" })).toThrow("exploration movement");
      // The DB guard also works when the active combat has corrupt/missing economy.
      db.prepare("UPDATE combat_turn_economy_v60 SET ended_at=started_at WHERE turn_id=?").run(combat.turnEconomy!.turnId);
      expect(() => db.exec("UPDATE tactical_map_tokens_v58 SET x=2 WHERE map_id IN(SELECT map_id FROM tactical_maps_v58 WHERE mode='exploration')")).toThrow("exploration movement");
    } finally { db.close(); repo.close(); }
  });

  it("binds opportunity results to the persisted movement transition and replays idempotently", async () => {
    const { repo, campaignId, sessionId, actorId, combat, request, db } = await dndMapFixture(true);
    try {
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", { ...request, destination: { x: 3, y: 1 } });
      const move = { ...request, destination: { x: 3, y: 1 }, previewId: preview.previewId, idempotencyKey: "reaction-move" };
      const result = repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move);
      const transition = db.prepare("SELECT transition_id,movement_key,reaction_results_json FROM combat_movement_transitions_v63 WHERE encounter_id=? AND movement_key=?")
        .get(combat.combatId, move.idempotencyKey) as { transition_id: string; movement_key: string; reaction_results_json: string };
      expect(transition.transition_id).toBeTruthy();
      expect(transition.movement_key).toBe(move.idempotencyKey);
      expect(JSON.parse(transition.reaction_results_json)).toEqual([]);
      expect(repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", move).receipt).toEqual(result.receipt);
      expect(db.prepare("SELECT count(*) AS count FROM combat_movement_transitions_v63 WHERE encounter_id=?").get(combat.combatId)).toEqual({ count: 1 });
    } finally { db.close(); repo.close(); }
  });

  it("charges difficult terrain from the authoritative path", async () => {
    const { repo, campaignId, sessionId, actorId, generation, request, db } = await dndMapFixture();
    try {
      const options = { kind: "cave" as const, seed: "terrain", width: 30, height: 30 };
      const map = generateTacticalMap(options);
      const target = map.tiles.find(tile => tile.difficult && !tile.blocksMovement && map.tiles.some(other => !other.blocksMovement && Math.abs(other.position.x-tile.position.x)+Math.abs(other.position.y-tile.position.y)===1))!;
      expect(target).toBeDefined();
      const origin = map.tiles.find(tile => !tile.blocksMovement && Math.abs(tile.position.x-target.position.x)+Math.abs(tile.position.y-target.position.y)===1)!;
      repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, { ...generation, ...options, idempotencyKey: "terrain-map", tokens: generation.tokens.map(token => ({ ...token, position: origin.position })) });
      const input = { ...request, destination: target.position, expectedMapRevision: 1 };
      const preview = repo.previewTacticalMapMove("reader", campaignId, sessionId, "combat", input);
      expect(preview.pathCostFeet).toBe(10);
      repo.moveTacticalMapToken("reader", campaignId, sessionId, "combat", { ...input, previewId: preview.previewId, idempotencyKey: "terrain" });
      expect(repo.getTacticalMap("reader", campaignId, sessionId, "combat", actorId)?.movement?.budgetFeet).toBe(20);
    } finally { db.close(); repo.close(); }
  });
});
