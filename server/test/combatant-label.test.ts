import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG, createRepository, createSession } from "../src/repo/index.js";
import {
  createEncounterReadRepository,
  initiateCombatFromTarget,
  type EncounterWriteDependencies,
} from "../src/repo/encounter/index.js";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const PLAYER = "label-player";
const AT = "2038-06-01T00:00:00.000Z";
const CULTIST = "srd-5.1:enemy-template:cultist";
const CHARACTER_SELECTIONS = {
  race: "srd-5.1:race:human",
  background: "srd-5.1:background:acolyte",
  class: "srd-5.1:class:fighter",
} as const;

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
/** Every composed schema asset except the combatant-label sidecar under test. */
const predecessorSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql",
  "contextInspectionProvenanceSchema.sql", "npcKnowledgeSchema.sql", "combatMarkerSchema.sql",
  "attunementSchema.sql", "combatReadyActionSchema.sql", "systemOneSchema.sql"].map(asset).join("\n");

async function fixture() {
  let sequence = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `label-${++sequence}` },
    rng: { integer: (minimum: number) => minimum },
  });
  const campaign = repo.createCampaign(OWNER, { name: "Combatant labels" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "label-pins" });

  const reference = (definitionId: string) =>
    SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.definitionId === definitionId)!.reference;
  const scores = Object.fromEntries(
    SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
  );

  const persona = repo.createCharacter({ name: "Aster Vale", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, {
    personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores } as any, idempotencyKey: "label-draft",
  });
  const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, {
    expectedRevision: 0, idempotencyKey: "label-select",
    selections: {
      race: reference(CHARACTER_SELECTIONS.race),
      background: reference(CHARACTER_SELECTIONS.background),
      class: reference(CHARACTER_SELECTIONS.class),
      starterGrant: "kit",
    },
  } as any);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, {
    expectedRevision: selected.draft.revision, idempotencyKey: "label-finalize",
  }).receipt.actorId;
  const session = await createSession({ characterId: persona.id, title: "Labeled room" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as any);

  const npcPersona = repo.createCharacter({ name: "Hob Corr", age: 40, archetype: "Commoner", boundaries: "", fictionalConfirmed: true });
  const npc = repo.createCampaignNpc(OWNER, campaign.id, {
    personaId: npcPersona.id,
    publicState: { name: "Hob Corr", description: "The village ferryman who tends the crossing." },
    privateState: { goals: "", gmNotes: "", merchantState: null },
    expectedRevision: 0,
    idempotencyKey: "label-npc",
  }).npc;

  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(PLAYER, PLAYER);
  db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
    .run(campaign.id, PLAYER, "player", AT);
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE campaign_id=? AND actor_id=?")
    .run(PLAYER, campaign.id, actorId);

  const clock = { now: () => new Date(AT) };
  let depsSequence = 0;
  const deps: EncounterWriteDependencies = {
    clock,
    ids: { nextId: () => `label-service-${++depsSequence}` },
    rng: { integer: (minimum: number) => minimum },
    reads: createEncounterReadRepository(db, { clock }),
    assertFactoryMutation: () => {},
  };
  return { repo, campaign, session, actorId, npc, db, deps, clock };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const cultistName = (): string =>
  (SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.definitionId === CULTIST) as any).name;

function enemyOf(combat: { combatants: Array<any> }) {
  const enemy = combat.combatants.find((combatant) => combatant.kind === "enemy");
  if (!enemy) throw new Error("combat has no enemy combatant");
  return enemy;
}

function mapToken(f: Fixture, encounterId: string, combatantId: string) {
  const row = f.db.prepare(`SELECT token.label FROM tactical_map_tokens_v58 token
    JOIN tactical_maps_v58 map ON map.map_id=token.map_id
    WHERE map.encounter_id=? AND token.combatant_id=?`).get(encounterId, combatantId) as { label: string } | undefined;
  if (!row) throw new Error("combatant has no tactical-map token");
  return row.label;
}

describe("template-backed NPC combatant labels", () => {
  it("shows the NPC name for an attacked NPC in the combat snapshot and map token", async () => {
    const f = await fixture();
    const result = initiateCombatFromTarget(f.db, f.deps, {
      principalId: PLAYER, campaignId: f.campaign.id, sessionId: f.session.id,
      actorId: f.actorId, target: { kind: "npc", npcId: f.npc.npcId },
    });

    const enemy = enemyOf(result.combat);
    expect(enemy.template).toMatchObject({ definitionId: CULTIST });
    expect(enemy.displayName).toBe("Hob Corr");
    expect(enemy.displayName).not.toBe(cultistName());

    // The authoritative active-combat projection is the read repository, not the returned receipt.
    const snapshot = f.deps.reads.getCombatState(PLAYER, result.encounterId)!;
    expect(enemyOf(snapshot).displayName).toBe("Hob Corr");
    expect(mapToken(f, result.encounterId, enemy.combatantId)).toBe("Hob Corr");

    expect(f.db.prepare(`SELECT combatant_id,encounter_id,campaign_id,label FROM encounter_combatant_label_v67`)
      .get()).toMatchObject({ combatant_id: enemy.combatantId, encounter_id: result.encounterId,
        campaign_id: f.campaign.id, label: "Hob Corr" });

    // Replay converges on the same single immutable label row.
    const replay = initiateCombatFromTarget(f.db, f.deps, {
      principalId: PLAYER, campaignId: f.campaign.id, sessionId: f.session.id,
      actorId: f.actorId, target: { kind: "npc", npcId: f.npc.npcId },
    });
    expect(replay.combat).toEqual(result.combat);
    expect(f.db.prepare("SELECT count(*) count FROM encounter_combatant_label_v67").get()).toEqual({ count: 1 });
  });

  it("keeps the template name for a GM-created encounter without a label", async () => {
    const f = await fixture();
    const created = f.repo.createEncounter(OWNER, f.campaign.id, {
      sessionId: f.session.id, name: "Cult ambush",
      combatants: [{ kind: "enemy", template: referenceTo(CULTIST), team: "enemies" }],
      idempotencyKey: "label-gm-create",
    });
    f.repo.startEncounter(OWNER, created.encounter.encounterId,
      { expectedRevision: created.receipt.revisionAfter, idempotencyKey: "label-gm-start" });

    const snapshot = f.repo.getCombatState(OWNER, created.encounter.encounterId)!;
    const enemy = enemyOf(snapshot);
    expect(enemy.displayName).toBe(cultistName());
    expect(mapToken(f, created.encounter.encounterId, enemy.combatantId)).toBe(cultistName());
    expect(f.db.prepare("SELECT count(*) count FROM encounter_combatant_label_v67").get()).toEqual({ count: 0 });
  });

  it("installs the label sidecar on an existing world without backfill", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(predecessorSql());
    db.transaction(() => {
      db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("durable-campaign", "Durable", "durable-timeline", "local-owner", AT, AT);
      db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
        .run("durable-timeline", "durable-campaign", AT);
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
        .run("durable-campaign", "local-owner", "owner", AT);
    })();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='encounter_combatant_label_v67'").get()).toBeUndefined();

    ensureCurrentSchema(db, ":memory:");

    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("durable-campaign")).toEqual({ name: "Durable" });
    expect(db.prepare("SELECT count(*) count FROM encounter_combatant_label_v67").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='encounter_combatant_label_v67_immutable_update'").get()).toBeTruthy();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    ensureCurrentSchema(db, ":memory:");
    db.close();
  });
});

function referenceTo(definitionId: string) {
  const entry = SRD_5_1_STARTER_CATALOG.definitions.find((candidate) => candidate.reference.definitionId === definitionId)!;
  return entry.reference as { kind: "enemy-template"; packId: string; packVersion: string; definitionId: string };
}
