import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { createRepository, M16StaleError, SpellcastingComponentError, SpellcastingRangeError, SpellcastingUnavailableError, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { createSession } from "../src/repo/sessionRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2036-01-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
const ref = (definitionId: string) => ({ kind: "spell" as const, packId: SRD_5_1_STARTER_CATALOG.manifest.packId, packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion, definitionId });

describe("spellcasting vertical slice", () => {
  it("finalizes Cleric/Wizard actors, discovers prepared spells, executes effects, and replays after restart", () => {
    let sequence = 0;
    const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `spell-${++sequence}` }, rng: { integer: () => 4 } });
    const campaign = repo.createCampaign("local-owner", { name: "Spellcasting" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const createActor = (name: string, classId: string, preparedSpells?: ReturnType<typeof ref>[]) => {
      const persona = repo.createCharacter({ name, age: 30, archetype: name, boundaries: "", fictionalConfirmed: true });
      const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft` });
      const base = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-base`, selections: {
        race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
        background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
        class: definitions.find((entry) => entry.reference.definitionId === classId)!.reference,
        starterGrant: "kit",
      } } as never);
      const selected = preparedSpells ? repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: `${name}-spells`, selections: { preparedSpells } } as never) : base;
      return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId;
    };
     const bless = ref("srd-5.1:spell:bless"), cure = ref("srd-5.1:spell:cure-wounds"), healingWord = ref("srd-5.1:spell:healing-word");
     const cleric = createActor("Cleric", "srd-5.1:class:cleric", [bless, cure, healingWord]);
    const wizard = createActor("Wizard", "srd-5.1:class:wizard");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("UPDATE rpg_actor_resources SET current=1 WHERE campaign_id=? AND actor_id=? AND name='health'").run(campaign.id, wizard);
    expect(db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'").get(campaign.id, cleric)).toEqual({ current: 2 });
    db.close();

    const components = { verbal: true, somatic: true, material: false };
    const cureCommand = { powerRef: cure, targetIds: [wizard], choices: [] as [], components, expectedRevision: 0, idempotencyKey: "cure" };
    const healed = repo.castSpell("local-owner", cleric, cureCommand);
    expect(healed.resolution.outcomes).toContainEqual(expect.objectContaining({ kind: "healing", targetId: wizard, roll: expect.objectContaining({ total: 4 }), applied: 4 }));
    expect(healed.resolution.costs).toEqual([{ kind: "slot", slotId: "slot-1", amount: 1 }]);

    const blessCommand = { powerRef: bless, targetIds: [wizard], choices: [] as [], components: { verbal: true, somatic: true, material: true }, expectedRevision: 1, idempotencyKey: "bless" };
    const blessed = repo.castSpell("local-owner", cleric, blessCommand);
    expect(blessed.resolution.stateDeltas).toContainEqual(expect.objectContaining({ kind: "effect-applied", actorId: wizard }));
    expect(blessed.actorStates[1]!.activeEffects).toContainEqual(expect.objectContaining({ source: bless, concentration: true }));
    const stateDb = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(stateDb.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'").get(campaign.id, cleric)).toEqual({ current: 0 });
    stateDb.close();
    expect(() => repo.castSpell("local-owner", cleric, { ...blessCommand, expectedRevision: 0, idempotencyKey: "stale" })).toThrow(M16StaleError);
    expect(() => repo.castSpell("local-owner", cleric, { ...blessCommand, expectedRevision: 2, idempotencyKey: "missing-component", components: { verbal: true, somatic: true, material: false } })).toThrow(SpellcastingComponentError);
    expect(() => repo.castSpell("local-owner", cleric, { ...blessCommand, expectedRevision: 2, idempotencyKey: "unprepared", powerRef: ref("srd-5.1:spell:light") })).toThrow(SpellcastingUnavailableError);
    repo.close();

    const reopened = createRepository({ clock: { now: () => new Date(at) }, rng: { integer: () => 8 } });
    expect(reopened.castSpell("local-owner", cleric, blessCommand)).toEqual(blessed);
    reopened.close();
  });

  it("validates supported ranged spells against authoritative maps and replays receipts", async () => {
    let sequence = 0;
    const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `ranged-${++sequence}` }, rng: { integer: () => 4 } });
    const campaign = repo.createCampaign("local-owner", { name: "Ranged spellcasting" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "ranged-pins" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const rangedSpell = ref("srd-5.1:spell:healing-word");
    const createActor = (name: string, classId: string, preparedSpells?: ReturnType<typeof ref>[]) => {
      const persona = repo.createCharacter({ name, age: 30, archetype: name, boundaries: "", fictionalConfirmed: true });
      const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft` });
      const base = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-base`, selections: {
        race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
        background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
        class: definitions.find((entry) => entry.reference.definitionId === classId)!.reference,
        starterGrant: "kit",
      } } as never);
      const selected = preparedSpells ? repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: `${name}-spells`, selections: { preparedSpells } } as never) : base;
      return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId;
    };
     const caster = createActor("RangedCleric", "srd-5.1:class:cleric", [ref("srd-5.1:spell:bless"), ref("srd-5.1:spell:cure-wounds"), rangedSpell]);
    const target = createActor("RangedTarget", "srd-5.1:class:wizard");
    const sessionCharacter = repo.createCharacter({ name: "MapCharacter", age: 30, archetype: "MapCharacter", boundaries: "", fictionalConfirmed: true });
    const sessions = await Promise.all(["too-far", "unrelated", "authoritative", "ambiguous-a", "ambiguous-b", "blocked"].map((title) => createSession({ characterId: sessionCharacter.id, title })));
    for (const session of sessions) repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id });
    const map = (sessionId: string, targetPosition: { x: number; y: number }, targetToken = true, keepActive = false) => {
      const snapshot = repo.generateTacticalMapForSession("local-owner", campaign.id, sessionId, {
      mode: "exploration", encounterId: null, kind: "arena", seed: sessionId, width: 20, height: 10,
      tokens: [
        { tokenId: `${sessionId}-caster`, actorId: caster, combatantId: null, label: "caster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false },
        ...(targetToken ? [{ tokenId: `${sessionId}-target`, actorId: target, combatantId: null, label: "target", position: targetPosition, footprint: { width: 1, height: 1 }, disposition: "hostile" as const, hidden: false }] : []),
      ], idempotencyKey: `${sessionId}-generate`,
      });
      if (!keepActive) {
        const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
        db.prepare("UPDATE tactical_maps_v58 SET active=0 WHERE map_id<>?").run(snapshot.projection.mapId);
        db.close();
      }
      return snapshot;
    };
    const command = { powerRef: rangedSpell, targetIds: [target], choices: [] as [], components: { verbal: true, somatic: false, material: false }, expectedRevision: 0, idempotencyKey: "ranged-cast" };
    map(sessions[0]!.id, { x: 15, y: 1 });
    expect(() => repo.castSpell("local-owner", caster, command)).toThrow(SpellcastingRangeError);
    map(sessions[1]!.id, { x: 15, y: 1 }, false);
    map(sessions[2]!.id, { x: 4, y: 1 });
    const first = repo.castSpell("local-owner", caster, command);
    expect(repo.castSpell("local-owner", caster, command)).toEqual(first);

    map(sessions[3]!.id, { x: 4, y: 1 }, true, true);
    map(sessions[4]!.id, { x: 4, y: 1 }, true, true);
    expect(() => repo.castSpell("local-owner", caster, { ...command, expectedRevision: 1, idempotencyKey: "ambiguous-cast" })).toThrow(SpellcastingRangeError);

    const blocked = map(sessions[5]!.id, { x: 4, y: 1 });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const tiles = JSON.parse((db.prepare("SELECT tiles_json FROM tactical_maps_v58 WHERE map_id=?").get(blocked.projection.mapId) as { tiles_json: string }).tiles_json) as Array<{ position: { x: number; y: number }; blocksSight: boolean }>;
    for (const tile of tiles) if (tile.position.y === 1 && (tile.position.x === 2 || tile.position.x === 3)) tile.blocksSight = true;
    db.prepare("UPDATE tactical_maps_v58 SET tiles_json=? WHERE map_id=?").run(JSON.stringify(tiles), blocked.projection.mapId);
    db.close();
    expect(() => repo.castSpell("local-owner", caster, { ...command, expectedRevision: 1, idempotencyKey: "blocked-cast" })).toThrow(SpellcastingRangeError);
    repo.close();
  });
});
