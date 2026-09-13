import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG, type Repository } from "../src/repo/index.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

function buildActor(repo: Repository, campaignId: string, definitions: typeof SRD_5_1_STARTER_CATALOG.definitions, name: string) {
  const id = name.replace(/\s+/g, "-");
  const persona = repo.createCharacter({ name, age: 30, archetype: name, boundaries: "", fictionalConfirmed: true });
  const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaignId, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: `${id}-draft` }).draft.id,
    { expectedRevision: 0, idempotencyKey: `${id}-base`, selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: `${id}-final` }).receipt.actorId;
  repo.mutateInventoryForActor(OWNER, campaignId, actorId, { kind: "equip", entryId: grantSrdEquipment(campaignId, actorId), slot: "hand", expectedRevision: 0, idempotencyKey: `${id}-equip` });
  return { actorId, personaId: persona.id };
}

async function seed() {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date("2037-01-01T00:00:00.000Z") }, ids: { nextId: () => `marker-${++sequence}` },
    rng: { integer: (min: number, max: number) => max === 21 ? 20 : min } });
  const campaign = repo.createCampaign(OWNER, { name: "Markers" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const helper = buildActor(repo, campaign.id, definitions, "Helper");
  const ally = buildActor(repo, campaign.id, definitions, "Ally");
  const session = await createSession({ characterIds: [helper.personaId, ally.personaId], title: "Marker combat" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as never);
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: session.id, name: "Marker fight",
    combatants: [{ kind: "actor", actorId: helper.actorId, team: "allies" }, { kind: "actor", actorId: ally.actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  return { repo, helper: helper.actorId, ally: ally.actorId, combat };
}

function advanceTo(repo: Repository, combat: any, targetCombatantId: string) {
  let current = combat;
  for (let step = 0; step < 30 && current.currentCombatant !== targetCombatantId; step += 1) {
    const acting = current.combatants.find((entry: { combatantId: string }) => entry.combatantId === current.currentCombatant)!;
    if (acting.kind === "enemy") current = repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: `enemy-${step}` }).combat;
    else current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (current.currentCombatant !== targetCombatantId) throw new Error("could not reach the requested combatant");
  return current;
}

describe("SRD 5.1 help and hide markers", () => {
  it("grants help advantage that the helped creature's next attack consumes", async () => {
    const { repo, helper, ally, combat } = await seed();
    const helperCombatant = combat.combatants.find((entry: any) => entry.actorId === helper)!.combatantId;
    const allyCombatant = combat.combatants.find((entry: any) => entry.actorId === ally)!.combatantId;
    const enemyCombatant = combat.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
    let current = advanceTo(repo, combat, helperCombatant);
    current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: `help:${allyCombatant}`, targetIds: [allyCombatant], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "help" }).combat;
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT source_combatant_id FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker='helped'").get(current.combatId, allyCombatant)).toEqual({ source_combatant_id: helperCombatant });
    db.close();
    current = advanceTo(repo, current, allyCombatant);
    const attack = current.legalActions.find((action: any) => action.kind === "attack")!;
    current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: attack.legalActionId, targetIds: [enemyCombatant], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "helped-attack" }).combat;
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(verify.prepare("SELECT 1 FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker='helped'").get(current.combatId, allyCombatant)).toBeUndefined();
    verify.close();
    repo.close();
  });

  it("hides on a successful Stealth check and expires help at the helper's next turn", async () => {
    const { repo, helper, ally, combat } = await seed();
    const helperCombatant = combat.combatants.find((entry: any) => entry.actorId === helper)!.combatantId;
    const allyCombatant = combat.combatants.find((entry: any) => entry.actorId === ally)!.combatantId;
    let current = advanceTo(repo, combat, helperCombatant);
    current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: `help:${allyCombatant}`, targetIds: [allyCombatant], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "help-expiry" }).combat;
    current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "helper-end" }).combat;
    current = advanceTo(repo, current, helperCombatant);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT 1 FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker='helped'").get(current.combatId, allyCombatant)).toBeUndefined();
    db.close();
    const hide = current.legalActions.find((action: any) => action.kind === "hide")!;
    current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: hide.legalActionId, targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "hide" }).combat;
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(verify.prepare("SELECT 1 FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker='hidden'").get(current.combatId, helperCombatant)).toBeTruthy();
    verify.close();
    repo.close();
  });
});
