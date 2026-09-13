import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  SRD_5_1_STARTER_IDENTITY,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

const at = "2036-01-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => [
  id, CHARACTER_BUILDER_STANDARD_ARRAY[index],
])) as CharacterBuilderAttributeScores;

describe("campaign-bound SRD 5.1 starter", () => {
  it("requires the exact Cleric preparation set and finalizes slot capacity without granting inert powers", () => {
    const repo = createRepository();
    const campaign = repo.createCampaign("local-owner", { name: "Cleric preparation" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "cleric-pins" });
    const persona = repo.createCharacter({ name: "Cleric", age: 30, archetype: "Cleric", boundaries: "", fictionalConfirmed: true });
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "cleric-draft" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const cleric = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:cleric")!;
     const spells = definitions.filter((entry) => ["srd-5.1:spell:bless", "srd-5.1:spell:cure-wounds", "srd-5.1:spell:healing-word"].includes(entry.reference.definitionId)).map((entry) => entry.reference);
    const incomplete = repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "cleric-base", selections: { race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference, class: cleric.reference, starterGrant: "kit" } } as never);
    expect(incomplete.draft.completion.issues).toContainEqual(expect.objectContaining({ code: "missing-prepared-spells" }));
    const selected = repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 1, idempotencyKey: "cleric-spells", selections: { preparedSpells: spells } } as never);
    expect(selected.draft.completion.complete).toBe(true);
    const finalized = repo.finalizeCharacterDraft("local-owner", created.draft.id, { expectedRevision: 2, idempotencyKey: "cleric-final" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT name,current,max FROM rpg_actor_resources WHERE actor_id=? AND name='slot-1'").get(finalized.receipt.actorId)).toEqual({ name: "slot-1", current: 2, max: 2 });
     expect(db.prepare("SELECT COUNT(*) count FROM character_known_powers_v23 WHERE campaign_character_id=? AND kind='spell'").get(finalized.receipt.campaignCharacterId)).toEqual({ count: 3 });
    db.close(); repo.close();
  });

  it("shares live armor and shield AC between gameplay, sheet and combat without rewriting snapshots", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const rolls = [20, 0, 1, 0, 12];
    const repo = createRepository({ rng: { integer: (min, max) => {
      const roll = rolls.shift();
      if (roll === undefined || roll < min || roll >= max) throw new Error("unexpected armor-test RNG");
      return roll;
    } } });
    const campaign = repo.createCampaign("local-owner", { name: "Live armor" });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const gameplayAc = async (actorId: string) => {
      const response = await app.inject({ method: "GET", url: `/api/rpg/v1/actors/${actorId}/gameplay-sheet` });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().derived.armorClass;
    };
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const createActor = (name: string) => {
      const persona = repo.createCharacter({ name, age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
      const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id,
        controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: name });
      const definitions = SRD_5_1_STARTER_CATALOG.definitions;
      const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-select`,
        selections: { race: definitions.find(d => d.reference.kind === "race")!.reference,
          background: definitions.find(d => d.reference.kind === "background")!.reference,
          class: definitions.find(d => d.reference.kind === "class")!.reference, starterGrant: "kit" } } as never);
      return { persona, ...repo.finalizeCharacterDraft("local-owner", draft.draft.id,
        { expectedRevision: selected.draft.revision, idempotencyKey: `${name}-final` }).receipt };
    };
    const attacker = createActor("Attacker"), target = createActor("Target");
    const equip = (actorId: string, item: string, slot: string) => repo.mutateInventoryForActor("local-owner", campaign.id, actorId,
      { kind: "equip", entryId: grantSrdEquipment(campaign.id, actorId, item), slot,
        expectedRevision: repo.getActorInventorySnapshot("local-owner", campaign.id, actorId)!.revision, idempotencyKey: `${actorId}-${item}` });
    equip(attacker.actorId, "longsword", "hand");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const stored = () => db.prepare("SELECT derived_json FROM character_progression_v23 WHERE actor_id=?").get(target.actorId);
    const before = stored();
    equip(target.actorId, "chain-mail", "body");
    equip(target.actorId, "shield", "hand");
    expect(await gameplayAc(target.actorId)).toBe(18);
    expect(repo.getCampaignCharacterSheetSnapshot("local-owner", campaign.id, target.campaignCharacterId)!.progression.derived.armorClass).toBe(18);
    const session = await createSession({ characterId: attacker.persona.id, title: "Armor combat" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as never);
    const encounter = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Armored duel",
      combatants: [{ kind: "actor", actorId: attacker.actorId, team: "allies" }, { kind: "actor", actorId: target.actorId, team: "enemies" }], idempotencyKey: "duel" });
    const combat = repo.startEncounter("local-owner", encounter.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
    const action = combat.legalActions.find(a => a.kind === "attack")!;
    const command = { legalActionId: action.legalActionId, targetIds: action.targetIds, choices: [] as [], expectedRevision: combat.revision, idempotencyKey: "attack" };
    // Invalid target equipment must fail before even the attack d20 is consumed.
    db.prepare("UPDATE rpg_inventory_entries_v25 SET slot_key='head' WHERE actor_id=? AND slot_key='body'").run(target.actorId);
    expect(() => repo.resolveCombatAction("local-owner", combat.combatId, command)).toThrow(/target equipment/);
    expect(rolls).toEqual([12]);
    db.prepare("UPDATE rpg_inventory_entries_v25 SET slot_key='body' WHERE actor_id=? AND slot_key='head'").run(target.actorId);
    const result = repo.resolveCombatAction("local-owner", combat.combatId, command);
    expect(result.resolution.outcomes[0]).toMatchObject({ armorClass: 18, attackTotal: 17, hit: false, damageType: "slashing", damageRolls: [], requested: 0 });
    repo.mutateInventoryForActor("local-owner", campaign.id, target.actorId, { kind: "unequip", slot: "hand", expectedRevision: 2, idempotencyKey: "shield-off" });
    expect(await gameplayAc(target.actorId)).toBe(16);
    repo.mutateInventoryForActor("local-owner", campaign.id, target.actorId, { kind: "unequip", slot: "body", expectedRevision: 3, idempotencyKey: "armor-off" });
    expect(await gameplayAc(target.actorId)).toBe(12);
    expect(stored()).toEqual(before);
    expect(rolls).toEqual([]);
    db.close(); await app.close(); repo.close();
  });

  it("selects the recommended starter through strict campaign setup and locks later switching", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repo = createRepository();
    const campaign = repo.createCampaign("local-owner", { name: "SRD route" });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "PUT", url: `/api/rpg/v1/campaigns/${campaign.id}/mechanics-starter-setup`,
      headers: { "content-type": "application/json" }, payload: { starterId: SRD_5_1_STARTER_IDENTITY.starterId } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ campaign: { content: { status: "configured",
      rulesProfileId: SRD_5_1_STARTER_IDENTITY.rulesProfileId, contentPacks: [{ packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion }] } } });
    const view = repo.getCampaignAdministrationIntegrations("local-owner", campaign.id)!;
    const legacy = view.rulesets.available.find(({ rulesetId }) => rulesetId === "velvet-starter-v1")!;
    expect(() => repo.selectCampaignRuleset("local-owner", campaign.id, { rulesetId: legacy.rulesetId, version: legacy.version,
      digest: legacy.digest, migrationConfirmed: true, expectedRevision: view.revision, idempotencyKey: "late-switch" }))
      .toThrow(/mechanically empty/);
    await app.close();
    repo.close();
  });

  it("creates, checks, attacks, and replays after restart without changing Velvet behavior", async () => {
    let id = 0;
    const rolls = [6, 12, 20, 0, 1, 0, 15, 8];
    const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `srd-id-${++id}` },
      rng: { integer: (minimum, maximum) => { const value = rolls.shift();
        if (value === undefined || value < minimum || value >= maximum) throw new Error("unexpected SRD RNG request"); return value; } } });
    const campaign = repo.createCampaign("local-owner", { name: "SRD integration" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "srd-pins" });
    const administration = repo.getCampaignAdministrationIntegrations("local-owner", campaign.id)!;
    expect(administration.rulesets.current).toMatchObject({ rulesetId: "dnd-5e", version: "1.0.0" });
    expect(administration.rulesets.rulesProfileId).toBe(SRD_5_1_STARTER_IDENTITY.rulesProfileId);

    const persona = repo.createCharacter({ name: "SRD Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id,
      controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores },
      idempotencyKey: "srd-draft" });
    expect(created.draft).toMatchObject({ rulesetId: "dnd-5e", rulesetVersion: "1.0.0" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const background = definitions.find((entry) => entry.reference.kind === "background")!;
    expect(background).toMatchObject({
      reference: { definitionId: "srd-5.1:background:acolyte" },
      name: "Acolyte",
      mechanics: {
        skillRefs: [{ definitionId: "insight" }, { definitionId: "religion" }],
        itemRefs: [{ definitionId: "srd-5.1:item:acolyte-equipment" }],
        startingCurrency: { amount: 15 },
      },
    });
    expect(definitions.find((entry) => entry.reference.definitionId === "velvet:test-fixture:enemy-template:training-dummy"))
      .toMatchObject({ tags: ["velvet:test-fixture", "original", "non-srd"] });
    const selected = repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0,
      idempotencyKey: "srd-select", selections: {
        race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
        background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
        class: definitions.find((entry) => entry.reference.kind === "class")!.reference,
        starterGrant: "kit",
      } } as never);
    expect(selected.draft.derivedPreview).toMatchObject({ rulesetId: "dnd-5e", rulesetVersion: "1.0.0",
      maxHp: 12, armorClass: 12, initiative: 2, speed: 30, proficiencyBonus: 2 });
    const finalized = repo.finalizeCharacterDraft("local-owner", created.draft.id, { expectedRevision: selected.draft.revision,
      idempotencyKey: "srd-final" });
    const stateDb = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(stateDb.prepare("SELECT name,current,max FROM rpg_actor_resources WHERE actor_id=? AND name IN ('hit-dice-d10','exhaustion') ORDER BY name").all(finalized.receipt.actorId)).toEqual([
      { name: "exhaustion", current: 0, max: 6 }, { name: "hit-dice-d10", current: 1, max: 1 },
    ]);
    stateDb.close();
    const aggregate = repo.getCampaignCharacter("local-owner", campaign.id, finalized.receipt.campaignCharacterId)!;
    expect(aggregate.projection.sheet.proficiencies).toEqual([
      { category: "skill", proficiencyId: "insight" },
      { category: "skill", proficiencyId: "religion" },
      { category: "saving-throw", proficiencyId: "strength" },
      { category: "saving-throw", proficiencyId: "constitution" },
    ]);
    expect(finalized.receipt.startingGrants).toHaveLength(2);
    expect(finalized.receipt.startingGrants).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item", quantity: 1, reference: expect.objectContaining({ definitionId: "srd-5.1:item:acolyte-equipment" }) }),
      expect.objectContaining({ kind: "item", quantity: 1, source: "class-starter-kit", reference: expect.objectContaining({ definitionId: "srd-5.1:item:longsword" }) }),
    ]));
    expect(repo.grantCharacterXp("local-owner", finalized.receipt.campaignCharacterId,
      { amount: 300, reason: "level-two threshold", expectedRevision: 0, idempotencyKey: "srd-xp" }).progression.totalXp)
      .toBe(300);
    repo.changeActorResourceForActor("local-owner", campaign.id, finalized.receipt.actorId,
      { kind: "change", resourceName: "health", amount: -4, expectedRevision: 0, idempotencyKey: "srd-damage" });
    expect(repo.previewRests("local-owner", campaign.id, finalized.receipt.actorId)).toEqual([
      { kind: "short", revision: 1, hitDiceToSpend: 1, recovery: { resources: [{ resourceId: "hit-dice-d10", before: 1, after: 0 }] } },
    ]);
    const shortCommand = { type: "take_short_rest" as const, campaignId: campaign.id, actorId: finalized.receipt.actorId,
      hitDiceToSpend: 1, expectedRevision: 1, idempotencyKey: "srd-short-rest" };
    const short = repo.takeRest("local-owner", shortCommand);
    expect(short.rest).toMatchObject({ kind: "short", hitDice: { dieSize: 10, spent: 1, rolls: [6], constitutionModifier: 2,
      hitPointsRecovered: 4 }, recovery: { resources: [{ resourceId: "health", before: 8, after: 12 },
        { resourceId: "hit-dice-d10", before: 1, after: 0 }] } });
    expect(repo.takeRest("local-owner", shortCommand)).toEqual(short);

    const check = repo.resolveActorCheck("local-owner", finalized.receipt.actorId, { kind: "skill", skillOrAttribute: "religion",
      difficultyRef: "standard", expectedRevision: 0, idempotencyKey: "srd-check" });
    expect(check.resolution).toMatchObject({ total: 15, target: { value: 15 }, outcome: "success" });

    const session = await createSession({ characterId: persona.id, title: "SRD combat" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as never);
    const enemy = { kind: "enemy-template" as const, packId: SRD_5_1_STARTER_IDENTITY.packId,
      packVersion: SRD_5_1_STARTER_IDENTITY.packVersion, definitionId: "velvet:test-fixture:enemy-template:training-dummy" };
    const encounter = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Training",
      combatants: [{ kind: "actor", actorId: finalized.receipt.actorId, team: "allies" }, { kind: "enemy", template: enemy, team: "enemies" }],
      idempotencyKey: "srd-encounter" });
    const started = repo.startEncounter("local-owner", encounter.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "srd-start" });
    const target = started.combat.combatants.find((entry) => entry.kind === "enemy")!;
    expect(started.combat.legalActions.find(action => action.kind === "attack")).toMatchObject({ legalActionId: "attack:unarmed" });
    const remainingRolls = [...rolls];
    expect(() => repo.resolveCombatAction("local-owner", started.combat.combatId, { legalActionId: "attack:basic",
      targetIds: [target.combatantId], choices: [], expectedRevision: started.combat.revision, idempotencyKey: "unarmed" })).toThrow(/not legal/);
    expect(rolls).toEqual(remainingRolls);
    const entryId = grantSrdEquipment(campaign.id, finalized.receipt.actorId);
    const equip = (kind: "equip" | "unequip", key: string) => repo.mutateInventoryForActor("local-owner", campaign.id,
      finalized.receipt.actorId, { kind, entryId, slot: "hand", expectedRevision: repo.getActorInventorySnapshot("local-owner",
        campaign.id, finalized.receipt.actorId)!.revision, idempotencyKey: key });
    equip("equip", "equip");
    const oldAction = repo.getCombatState("local-owner", started.combat.combatId)!.legalActions.find(action => action.kind === "attack")!;
    equip("unequip", "unequip");
    expect(repo.getCombatState("local-owner", started.combat.combatId)!.legalActions.some(action => action.legalActionId === oldAction.legalActionId)).toBe(false);
    equip("equip", "reequip");
    expect(() => repo.resolveCombatAction("local-owner", started.combat.combatId, { legalActionId: oldAction.legalActionId,
      targetIds: [target.combatantId], choices: [], expectedRevision: started.combat.revision, idempotencyKey: "stale-equipment" })).toThrow(/not legal/);
    expect(rolls).toEqual(remainingRolls);
    const request = { legalActionId: repo.getCombatState("local-owner", started.combat.combatId)!.legalActions.find(action => action.kind === "attack")!.legalActionId, targetIds: [target.combatantId], choices: [] as [],
      expectedRevision: started.combat.revision, idempotencyKey: "srd-attack" };
    const attack = repo.resolveCombatAction("local-owner", started.combat.combatId, request);
    expect(attack.resolution.outcomes[0]).toMatchObject({ rulesetId: "dnd-5e", rulesetVersion: "1.0.0",
      damageType: "slashing", attackRoll: 15, attackTotal: 20, armorClass: 10, hit: true, critical: false, damageRolls: [8], requested: 11, applied: 8 });
    expect(rolls).toEqual([]);
    equip("unequip", "after-attack");
    repo.close();

    const reopened = createRepository({ clock: { now: () => new Date(at) }, rng: { integer: () => { throw new Error("replay must not roll"); } } });
    expect(reopened.takeRest("local-owner", shortCommand)).toEqual(short);
    expect(reopened.resolveCombatAction("local-owner", started.combat.combatId, request)).toEqual(attack);
    expect(reopened.getCharacterDraft("local-owner", created.draft.id)).toMatchObject({ rulesetId: "dnd-5e", rulesetVersion: "1.0.0" });
    reopened.close();
  });
});
