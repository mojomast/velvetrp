import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2038-02-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;
let sequence = 0;

function fixture(className: string) {
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `rest-${++sequence}` } });
  const campaign = repo.createCampaign(OWNER, { name: `Rest ${className}` });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: `${className} Hero`, age: 30, archetype: className, boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.kind === "class" && entry.name === className)!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "final" }).receipt.actorId;
  const sessionId = `rest-session-${++sequence}`;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId, persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId, persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, AT);
  db.close();
  return { repo, campaign, actorId, sessionId };
}

function establishCamp(campaignId: string, actorId: string, sessionId: string) {
  const locationId = `camp-${campaignId}`;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT OR IGNORE INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,public_name,public_description,visibility,created_at) VALUES(?,?,NULL,'Camp','','public',?)").run(locationId, campaignId, AT);
  db.prepare("INSERT OR IGNORE INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaignId, actorId, locationId, sessionId, AT);
  db.prepare("INSERT OR REPLACE INTO world_expeditions_v60(campaign_id,session_id,elapsed_minutes,camp_location_id,camp_command_id) VALUES(?,?,1440,?,NULL)").run(campaignId, sessionId, locationId);
  db.close();
}

function binding(actorId: string, resourceName: string) {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const row = db.prepare("SELECT binding_key,binding_json FROM rpg_actor_resource_bindings_v25 WHERE actor_id=? AND resource_name=?").get(actorId, resourceName) as { binding_key: string; binding_json: string } | undefined;
  db.close();
  return row ? { key: row.binding_key, ...JSON.parse(row.binding_json) } : null;
}

describe("SRD 5.1 class hit dice and rest recharge bindings", () => {
  it("grants one hit die for every modeled class level", () => {
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const classes = new Map(definitions.filter((entry) => entry.reference.kind === "class").map((entry) => [entry.reference.definitionId, entry as any]));
    const levels = definitions.filter((entry) => entry.reference.kind === "class-level") as any[];
    for (const level of levels) {
      const klass = classes.get(level.mechanics.classRef.definitionId)!;
      const grant = (level.mechanics.resourceGrants as any[] | undefined)?.find((value) => value.resourceId === `hit-dice-d${klass.mechanics.hitDie}`);
      expect(grant, `${level.name} hit die grant`).toMatchObject({ maxIncrease: 1, currentIncrease: 1 });
    }
  });

  it("recharges long-rest class pools for Barbarian, Paladin, Cleric, and Wizard", () => {
    for (const [className, resourceName, maximum] of [["Barbarian", "rage", 2], ["Paladin", "lay-on-hands", 5], ["Cleric", "slot-1", 2], ["Wizard", "slot-1", 2]] as const) {
      const { repo, campaign, actorId, sessionId } = fixture(className);
      expect(binding(actorId, resourceName)).toMatchObject({ recovery: "long-rest" });
      const db = new DatabaseDriver(dbPath());
      expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name=?").get(actorId, resourceName)).toEqual({ current: maximum, max: maximum });
      db.prepare("UPDATE rpg_actor_resources SET current=0 WHERE actor_id=? AND name=?").run(actorId, resourceName);
      db.close();
      establishCamp(campaign.id, actorId, sessionId);
      const preview = repo.previewRests(OWNER, campaign.id, actorId);
      expect(preview).toContainEqual(expect.objectContaining({ kind: "long", recovery: { resources: expect.arrayContaining([expect.objectContaining({ resourceId: resourceName, before: 0, after: maximum })]) } }));
      const rest = repo.takeRest(OWNER, { type: "take_long_rest", campaignId: campaign.id, actorId, expectedRevision: 0, idempotencyKey: `long-${className}` });
      expect(rest.rest.recovery.resources).toContainEqual({ resourceId: resourceName, before: 0, after: maximum });
      repo.close();
    }
  }, 180_000); // Load headroom, not an assertion relaxation: four full catalog fixtures can exceed the shared 90s budget under parallel forks.

  it("creates hit-dice pools and binds them without a rest recovery binding", () => {
    const { repo, actorId } = fixture("Fighter");
    const db = new DatabaseDriver(dbPath());
    expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='hit-dice-d10'").get(actorId)).toEqual({ current: 1, max: 1 });
    db.close();
    expect(binding(actorId, "hit-dice-d10")).toBeNull();
    repo.close();
  });
});
