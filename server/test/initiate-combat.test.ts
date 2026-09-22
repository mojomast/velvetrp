import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG, createRepository, createSession } from "../src/repo/index.js";
import {
  CombatInitiationError,
  createEncounterReadRepository,
  initiateCombatFromTarget,
  type CombatInitiationFailureCode,
  type EncounterWriteDependencies,
  type InitiateCombatInput,
} from "../src/repo/encounter/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const PLAYER = "initiate-player";
const PLAYER_TWO = "initiate-player-two";
const OBSERVER = "initiate-observer";
const STRANGER = "initiate-stranger";
const AT = "2038-06-01T00:00:00.000Z";

const CULTIST = "srd-5.1:enemy-template:cultist";
const CHARACTER_SELECTIONS = {
  race: "srd-5.1:race:human",
  background: "srd-5.1:background:acolyte",
  class: "srd-5.1:class:fighter",
} as const;

interface CatalogEnemy {
  reference: { kind: string; packId: string; packVersion: string; definitionId: string };
  name: string;
}

const catalogEnemies = SRD_5_1_STARTER_CATALOG.definitions as unknown as CatalogEnemy[];
const enemyTemplate = (definitionId: string): CatalogEnemy => {
  const found = catalogEnemies.find(
    (entry) => entry.reference.kind === "enemy-template" && entry.reference.definitionId === definitionId,
  );
  if (!found) throw new Error(`missing catalog enemy template ${definitionId}`);
  return found;
};

async function fixture() {
  let sequence = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `initiate-${++sequence}` },
    rng: { integer: (minimum: number) => minimum },
  });
  const campaign = repo.createCampaign(OWNER, { name: "Target-initiated combat" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "initiate-pins" });

  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const reference = (definitionId: string) =>
    definitions.find((entry) => entry.reference.definitionId === definitionId)!.reference;
  const scores = Object.fromEntries(
    SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
  );

  const createActor = (name: string, key: string): { actorId: string; personaId: string } => {
    const persona = repo.createCharacter({ name, age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft(OWNER, campaign.id, {
      personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
      allocation: { method: "standard-array", scores } as any, idempotencyKey: `${key}-draft`,
    });
    const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: 0, idempotencyKey: `${key}-select`,
      selections: {
        race: reference(CHARACTER_SELECTIONS.race),
        background: reference(CHARACTER_SELECTIONS.background),
        class: reference(CHARACTER_SELECTIONS.class),
        starterGrant: "kit",
      },
    } as any);
    const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: selected.draft.revision, idempotencyKey: `${key}-finalize`,
    }).receipt.actorId;
    return { actorId, personaId: persona.id };
  };

  const hero = createActor("Aster Vale", "initiate-hero");
  const rival = createActor("Bram the Bold", "initiate-rival");
  const session = await createSession({ characterId: hero.personaId, title: "Target-initiated room" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as any);

  let npcRevision = 0;
  const createNpc = (name: string, description: string, key: string) => {
    const persona = repo.createCharacter({ name, age: 40, archetype: "Commoner", boundaries: "", fictionalConfirmed: true });
    return repo.createCampaignNpc(OWNER, campaign.id, {
      personaId: persona.id,
      publicState: { name, description },
      privateState: { goals: "", gmNotes: "", merchantState: null },
      expectedRevision: npcRevision++,
      idempotencyKey: key,
    }).npc;
  };
  const ferryman = createNpc("Old Hob", "The village ferryman who tends the crossing.", "initiate-npc-hob");
  const watchman = createNpc("Gate Watch", "A loyal guard at the east gate.", "initiate-npc-watch");

  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  for (const [principalId, role] of [[PLAYER, "player"], [PLAYER_TWO, "player"], [OBSERVER, "observer"]] as const) {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principalId, principalId);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run(campaign.id, principalId, role, AT);
  }
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE campaign_id=? AND actor_id=?")
    .run(PLAYER, campaign.id, hero.actorId);

  const clock = { now: () => new Date(AT) };
  let depsSequence = 0;
  const deps: EncounterWriteDependencies = {
    clock,
    ids: { nextId: () => `initiate-service-${++depsSequence}` },
    rng: { integer: (minimum: number) => minimum },
    reads: createEncounterReadRepository(db, { clock }),
    assertFactoryMutation: () => {},
  };
  return { repo, campaign, session, hero, rival, ferryman, watchman, db, deps };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const input = (f: Fixture, overrides: Partial<InitiateCombatInput> = {}): InitiateCombatInput => ({
  principalId: PLAYER,
  campaignId: f.campaign.id,
  sessionId: f.session.id,
  actorId: f.hero.actorId,
  target: { kind: "npc", npcId: f.ferryman.npcId },
  ...overrides,
});

function expectInitiationFailure(run: () => unknown, code: CombatInitiationFailureCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CombatInitiationError);
    expect((error as CombatInitiationError).code).toBe(code);
    return;
  }
  throw new Error(`expected CombatInitiationError ${code}`);
}

function tacticalMap(db: DatabaseDriver.Database, encounterId: string) {
  const map = db.prepare("SELECT map_id,mode,active FROM tactical_maps_v58 WHERE encounter_id=?")
    .get(encounterId) as { map_id: string; mode: string; active: number } | undefined;
  if (!map) throw new Error("combat tactical map was not generated");
  const tokens = db.prepare(`SELECT combatant_id,label,disposition FROM tactical_map_tokens_v58
    WHERE map_id=? ORDER BY token_id`).all(map.map_id) as Array<{ combatant_id: string; label: string; disposition: string }>;
  return { map, tokens };
}

describe("initiateCombatFromTarget", () => {
  it("starts player-initiated combat against a commoner NPC with pinned template and automatic tactical map", async () => {
    const f = await fixture();
    const result = initiateCombatFromTarget(f.db, f.deps, input(f));

    expect(result.tier).toBe("commoner");
    expect(result.rationale).toContain("ferryman");
    expect(result.rationale).toContain("commoner");
    expect(result.template).toMatchObject({
      kind: "enemy-template",
      packId: enemyTemplate(CULTIST).reference.packId,
      packVersion: enemyTemplate(CULTIST).reference.packVersion,
      definitionId: CULTIST,
    });
    expect(result.combatId).toBe(result.encounterId);

    expect(f.db.prepare("SELECT status FROM encounter WHERE encounter_id=?").get(result.encounterId))
      .toEqual({ status: "active" });
    expect(f.db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(result.encounterId))
      .toEqual({ revision: result.combat.revision });

    const combatants = result.combat.combatants;
    expect(combatants).toHaveLength(2);
    expect(combatants.find((combatant) => combatant.kind === "actor")).toMatchObject({
      kind: "actor", actorId: f.hero.actorId, team: "allies",
    });
    const enemy = combatants.find((combatant) => combatant.kind === "enemy")!;
    expect(enemy).toMatchObject({ team: "enemies", template: { definitionId: CULTIST } });
    expect(enemy).toMatchObject({ displayName: "Old Hob" });
    expect(f.db.prepare("SELECT pack_id,pack_version,definition_id FROM encounter_enemy_provenance_v31 WHERE combatant_id=?")
      .get(enemy.combatantId)).toMatchObject({
        pack_id: enemyTemplate(CULTIST).reference.packId, definition_id: CULTIST,
      });

    const { map, tokens } = tacticalMap(f.db, result.encounterId);
    expect(map).toMatchObject({ mode: "combat", active: 1 });
    expect(tokens).toHaveLength(2);
    expect(tokens.find((token) => token.combatant_id === enemy.combatantId)).toEqual({
      combatant_id: enemy.combatantId, label: "Old Hob", disposition: "hostile",
    });
    expect(tokens.find((token) => token.disposition === "friendly")?.label).toBe("Aster Vale");
    expect(result.combat.encounterId).toBe(result.encounterId);
    expect(result.combat.campaignId).toBe(f.campaign.id);
  });

  it("starts combat against another actor and teams the target as an enemy", async () => {
    const f = await fixture();
    const result = initiateCombatFromTarget(f.db, f.deps, input(f, { target: { kind: "actor", actorId: f.rival.actorId } }));

    expect(result.tier).toBeUndefined();
    expect(result.template).toBeUndefined();
    expect(result.combat.combatants).toHaveLength(2);
    expect(result.combat.combatants.find((combatant) => combatant.kind === "actor" && combatant.actorId === f.hero.actorId))
      .toMatchObject({ team: "allies" });
    const enemy = result.combat.combatants.find((combatant) => combatant.kind === "actor" && combatant.actorId === f.rival.actorId);
    expect(enemy).toMatchObject({ kind: "actor", team: "enemies" });
    expect(f.db.prepare("SELECT count(*) count FROM encounter_enemy_provenance_v31 WHERE encounter_id=?")
      .get(result.encounterId)).toEqual({ count: 0 });

    const { tokens } = tacticalMap(f.db, result.encounterId);
    expect(tokens.find((token) => token.combatant_id === enemy!.combatantId)).toEqual({
      combatant_id: enemy!.combatantId, label: "Bram the Bold", disposition: "hostile",
    });
  });

  it("rejects unauthorized principals, foreign campaigns and unknown targets with typed failures", async () => {
    const f = await fixture();
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, input(f, { principalId: OBSERVER })),
      "COMBAT_INITIATION_FORBIDDEN");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, input(f, { principalId: PLAYER_TWO })),
      "COMBAT_INITIATION_FORBIDDEN");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, input(f, { campaignId: "foreign-campaign" })),
      "COMBAT_INITIATION_CAMPAIGN_NOT_FOUND");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, input(f, { principalId: STRANGER })),
      "COMBAT_INITIATION_CAMPAIGN_NOT_FOUND");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, input(f, { actorId: "missing-actor" })),
      "COMBAT_INITIATION_ACTOR_NOT_FOUND");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps,
      input(f, { target: { kind: "npc", npcId: "missing-npc" } })), "COMBAT_INITIATION_TARGET_NOT_FOUND");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps,
      input(f, { target: { kind: "actor", actorId: "missing-actor" } })), "COMBAT_INITIATION_TARGET_NOT_FOUND");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps,
      input(f, { target: { kind: "actor", actorId: f.hero.actorId } })), "COMBAT_INITIATION_CONFLICT");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps, { ...input(f), target: null } as any),
      "COMBAT_INITIATION_INVALID_INPUT");
    // Every failure above rolled back without leaving an encounter behind.
    expect(f.db.prepare("SELECT count(*) count FROM encounter").get()).toEqual({ count: 0 });
    expect(f.db.prepare("SELECT count(*) count FROM combatant").get()).toEqual({ count: 0 });
  });

  it("rejects a second encounter while one is already active and maps key reuse to a conflict", async () => {
    const f = await fixture();
    const first = initiateCombatFromTarget(f.db, f.deps, input(f, { idempotencyKey: "initiate-keyed" }));
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps,
      input(f, { target: { kind: "npc", npcId: f.watchman.npcId } })), "COMBAT_INITIATION_ACTIVE_ENCOUNTER");
    expectInitiationFailure(() => initiateCombatFromTarget(f.db, f.deps,
      input(f, { idempotencyKey: "initiate-keyed", target: { kind: "npc", npcId: f.watchman.npcId } })),
      "COMBAT_INITIATION_CONFLICT");
    expect(f.db.prepare("SELECT count(*) count FROM encounter").get()).toEqual({ count: 1 });
    expect(f.db.prepare("SELECT count(*) count FROM encounter WHERE encounter_id<>?").get(first.encounterId))
      .toEqual({ count: 0 });
  });

  it("converges on the same encounter and combat for a repeated request", async () => {
    const f = await fixture();
    const first = initiateCombatFromTarget(f.db, f.deps, input(f));
    const second = initiateCombatFromTarget(f.db, f.deps, input(f));

    expect(second.encounterId).toBe(first.encounterId);
    expect(second.combatId).toBe(first.combatId);
    expect(second.tier).toBe(first.tier);
    expect(second.template).toEqual(first.template);
    expect(second.combat).toEqual(first.combat);
    expect(f.db.prepare("SELECT count(*) count FROM encounter WHERE campaign_id=?").get(f.campaign.id))
      .toEqual({ count: 1 });
    expect(f.db.prepare("SELECT count(*) count FROM combatant WHERE encounter_id=?").get(first.encounterId))
      .toEqual({ count: 2 });
    expect(f.db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE encounter_id=?").get(first.encounterId))
      .toEqual({ count: 1 });
    expect(f.db.prepare("SELECT count(*) count FROM encounter_enemy_provenance_v31 WHERE encounter_id=?").get(first.encounterId))
      .toEqual({ count: 1 });
  });
});
