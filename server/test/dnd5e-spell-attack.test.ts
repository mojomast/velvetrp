import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { buildCombatPowerLegalActions } from "../src/repo/encounter/combatPowerRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

function fixture(integer: (min: number, max: number) => number) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date("2037-03-01T00:00:00.000Z") }, ids: { nextId: () => `spellatk-${++sequence}` }, rng: { integer } });
  const campaign = repo.createCampaign(OWNER, { name: "Spell attack" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Caster", age: 30, archetype: "Wizard", boundaries: "", fictionalConfirmed: true });
  const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: "caster-draft" }).draft.id,
    { expectedRevision: 0, idempotencyKey: "caster-base", selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:wizard")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "caster-final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("spellatk-session", persona.id, "2037-03-01T00:00:00.000Z");
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("spellatk-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("spellatk-session", campaign.id, "2037-03-01T00:00:00.000Z");
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'health',12,12)").run(campaign.id, actorId);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'slot-1',2,2)").run(campaign.id, actorId);
  // Pin every publicly reachable ability and spell for execution, as the reviewed setup does.
  db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
    SELECT pin.campaign_id,visibility.pack_id,visibility.pack_version,visibility.kind,visibility.definition_id FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND visibility.kind IN('ability','spell') AND visibility.publicly_reachable=1`).run(campaign.id);
  db.close();
  return { repo, campaign, actorId };
}

function advanced(repo: ReturnType<typeof createRepository>, combat: any, targetCombatantId: string) {
  let current = combat;
  for (let step = 0; step < 20 && current.currentCombatant !== targetCombatantId; step += 1) {
    const acting = current.combatants.find((entry: any) => entry.combatantId === current.currentCombatant)!;
    current = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (current.currentCombatant !== targetCombatantId) throw new Error("could not reach the caster's turn");
  return current;
}

function castCantrip(integer: (min: number, max: number) => number, spellName: string) {
  const { repo, campaign, actorId } = fixture(integer);
  const goblin = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "spellatk-session", name: "Cantrip",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const casterCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const combat = advanced(repo, started, casterCombatant);
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const action = buildCombatPowerLegalActions(db, OWNER, combat.combatId).find((candidate) => candidate.definition.name === spellName)!;
  expect(action).toBeTruthy();
  const sourceM15 = (db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id, actorId) as any)?.revision ?? 0;
  const sourceM16 = (db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaign.id, actorId) as any)?.revision ?? 0;
  const targetM15 = action.targetActorId ? (db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id, action.targetActorId) as any)?.revision ?? 0 : null;
  const targetM16 = action.targetActorId ? (db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaign.id, action.targetActorId) as any)?.revision ?? 0 : null;
  db.close();
  const result = repo.useCombatPower(OWNER, { legalActionId: action.legalActionId, powerRef: action.powerRef, targetCombatantId: action.targetCombatantId,
    expectedCombatRevision: combat.revision, expectedSourceM15Revision: sourceM15, expectedSourceM16Revision: sourceM16,
    expectedTargetM15Revision: targetM15, expectedTargetM16Revision: targetM16, idempotencyKey: `cast-${spellName.replace(/\s+/g, "-")}` });
  repo.close();
  return result;
}

describe("SRD 5.1 spell attacks", () => {
  it("resolves a Fire Bolt spell attack and doubles a critical", () => {
    const result = castCantrip((min, max) => max === 21 ? 20 : min, "Fire Bolt");
    expect(result.outcomes[0]).toMatchObject({ kind: "damage", damageType: "fire", attackRoll: 20, hit: true, critical: true });
    expect(result.outcomes[0].applied).toBeGreaterThan(0);
  });

  it("misses when the spell attack does not beat the armor class", () => {
    const result = castCantrip((min, max) => max === 21 ? 2 : min, "Fire Bolt");
    expect(result.outcomes[0]).toMatchObject({ kind: "damage", hit: false, applied: 0 });
  });
});
