import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { EffectImmuneError, M16AuthorizationError, M16ConflictError, M16StaleError, PowerInsufficientResourceError, PowerUnavailableError, createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const timestamp = "2035-01-01T00:00:00.000Z";
const scores: CharacterBuilderAttributeScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;
const ability = { kind: "ability" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:ability:steady-strike" };
const spell = { kind: "spell" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:spell:sheltering-glow" };

/** Use real finalized actors; only mutable combat state is seeded directly. */
function fixture() {
  let now = new Date(timestamp);
  let id = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => now },
    ids: { nextId: () => `m16-${++id}` },
    rng: { integer: () => 10 },
  });
  const campaign = repo.createCampaign("local-owner", { name: "M1.6 behavior fixture" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const actor = (name: string, key: string) => {
    const persona = repo.createCharacter({ name, age: 31, archetype: "Warden", boundaries: "", safeWord: "pause", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${key}-draft` });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${key}-select`, selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference as any,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference as any,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference as any,
      starterGrant: "kit",
    } } as any);
    return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${key}-final` }).receipt.actorId;
  };
  const source = actor("Aster", "source");
  const opponent = actor("Briar", "opponent");
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys = ON");
  const sheet = db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaign.id, source) as { sheet_id: string };
  const campaignCharacter = db.prepare("SELECT campaign_character_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaign.id, source) as { campaign_character_id: string };
   for (const [position, key] of ["might", "agility", "resolve", "insight", "presence", "craft", "melee", "ranged", "spell", "defense"].entries()) {
     db.prepare("INSERT OR REPLACE INTO rpg_character_attributes(campaign_id,sheet_id,position,attribute_id,value) VALUES(?,?,?,?,?)").run(campaign.id, sheet.sheet_id, 50 + position, key, 3);
  }
  for (const [position, category, key] of [[51, "skill", "insight"], [52, "saving-throw", "resolve"], [53, "weapon", "melee"]] as const) {
    db.prepare("INSERT OR IGNORE INTO rpg_character_proficiencies(campaign_id,sheet_id,position,category,proficiency_id) VALUES(?,?,?,?,?)").run(campaign.id, sheet.sheet_id, position, category, key);
  }
  for (const [name, current, max] of [["focus", 2, 4], ["slot-1", 1, 1], ["health", 8, 10], ["wand", 1, 1]] as const) db.prepare("INSERT OR REPLACE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,?,?,?)").run(campaign.id, source, name, current, max);
  db.prepare("INSERT OR REPLACE INTO rpg_actor_resource_charges_v25(campaign_id,actor_id,resource_name,current_charges,maximum_charges) VALUES(?,?,?,?,?)").run(campaign.id, source, "wand", 1, 1);
  // These are the same catalog references granted by the selected class. Seed
  // their immutable progression records explicitly so the fixture exercises
  // both ability and spell authorization independently of builder backfills.
  for (const power of [ability, spell]) {
    db.prepare("INSERT OR IGNORE INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)").run(campaignCharacter.campaign_character_id, power.kind, power.packId, power.packVersion, power.definitionId, 1, timestamp);
    db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)").run(campaign.id, power.packId, power.packVersion, power.kind, power.definitionId);
  }
  db.close();
  return { repo, campaign: campaign.id, source, opponent, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

describe("M1.6 repository behavior", () => {
  it("accepts only server-derived checks and resolves deterministic ability, skill, save, attack, and opposed terms", () => {
    const f = fixture();
    // A check command contains intent only. Resolution and timestamps are server-owned.
    const base = { campaignId: f.campaign, actorId: f.source, expectedRevision: 0, idempotencyKey: "ability" };
    expect(() => f.repo.resolveCheck("local-owner", { ...base, kind: "ability", abilityId: "might" } as any)).not.toThrow();
    expect(() => f.repo.resolveCheck("local-owner", { ...base, idempotencyKey: "extra", kind: "ability", abilityId: "might", resolvedAt: timestamp } as any)).toThrow();
    expect(() => f.repo.resolveCheck("local-owner", { ...base, idempotencyKey: "extra-resolution", kind: "ability", abilityId: "might", resolution: { total: 999 } } as any)).toThrow();
    const cases: Array<[any, number, string]> = [
      [{ ...base, kind: "ability", abilityId: "might" }, 13, "success"],
      [{ ...base, expectedRevision: 1, idempotencyKey: "skill", kind: "skill", skillId: "insight" }, 15, "success"],
      [{ ...base, expectedRevision: 2, idempotencyKey: "save", kind: "save", abilityId: "resolve" }, 15, "success"],
      [{ ...base, expectedRevision: 3, idempotencyKey: "attack", kind: "attack", attackId: "melee", targetActorId: f.opponent }, 15, "success"],
      [{ ...base, expectedRevision: 4, idempotencyKey: "opposed", kind: "opposed", opponentActorId: f.opponent }, 13, "failure"],
    ];
    for (const [command, total, outcome] of cases) {
      const result = f.repo.resolveCheck("local-owner", command).resolution;
      expect(result).toMatchObject({ total, outcome });
      expect(result.terms).toEqual(expect.arrayContaining([{ kind: "roll", roll: expect.objectContaining({ expression: "1d20", total: 10 }) }]));
    }
    f.repo.close();
  });

  it("uses the exact known-and-pinned ability/spell allowlist and atomically rolls back insufficient resource, slot, and charge costs", () => {
    const f = fixture();
    const use = (power: typeof ability | typeof spell, costs: any[], expectedRevision: number, idempotencyKey: string) => f.repo.usePower("local-owner", { type: "use_power", campaignId: f.campaign, actorId: f.source, power, targetActorId: null, costs, expectedRevision, idempotencyKey, usedAt: timestamp });
    expect(use(ability, [{ kind: "resource", resourceId: "focus", amount: 1 }], 0, "ability").powerUseId).toMatch(/^m16-/);
    expect(use(spell, [{ kind: "slot", slotId: "slot-1", amount: 1 }, { kind: "charge", chargeId: "wand", amount: 1 }], 1, "spell").receipt.revisionAfter).toBe(2);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    const before = db.prepare("SELECT name,current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(f.campaign, f.source);
    const chargesBefore = db.prepare("SELECT current_charges FROM rpg_actor_resource_charges_v25 WHERE campaign_id=? AND actor_id=? AND resource_name='wand'").get(f.campaign, f.source);
    db.close();
    expect(() => use(ability, [{ kind: "resource", resourceId: "focus", amount: 2 }, { kind: "slot", slotId: "slot-1", amount: 1 }], 2, "insufficient")).toThrow(PowerInsufficientResourceError);
    expect(() => use({ ...ability, definitionId: "velvet:mechanics:ability:not-known" }, [], 2, "unknown")).toThrow(PowerUnavailableError);
    const after = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(after.prepare("SELECT name,current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(f.campaign, f.source)).toEqual(before);
    expect(after.prepare("SELECT current_charges FROM rpg_actor_resource_charges_v25 WHERE campaign_id=? AND actor_id=? AND resource_name='wand'").get(f.campaign, f.source)).toEqual(chargesBefore);
    after.close(); f.repo.close();
  });

  it("stacks effects, replaces concentration atomically, applies immunity, and expires duration at query time", () => {
    const f = fixture();
    const effect = (effectId: string, modifiers: any[], duration: any, concentration: any = { kind: "none" }) => ({ effectId, campaignId: f.campaign, actorId: f.source, source: ability, modifiers, duration, recovery: "none", concentration, appliedAt: timestamp });
    const apply = (value: any, expectedRevision: number, idempotencyKey: string) => f.repo.mutateEffect("local-owner", { type: "apply_effect", campaignId: f.campaign, actorId: f.source, effect: value, expectedRevision, idempotencyKey, appliedAt: timestamp });
    expect(apply(effect("first", [{ kind: "flat", appliesToId: "might", amount: 2 }, { kind: "advantage", appliesToId: "might" }], { kind: "rounds", remaining: 2 }, { kind: "required", concentrationId: "focus" }), 0, "first").effects).toContainEqual(expect.objectContaining({ effectId: "first" }));
    apply(effect("second", [{ kind: "proficiency", appliesToId: "might", bonus: 1 }, { kind: "resistance", appliesToId: "fire" }, { kind: "vulnerability", appliesToId: "cold" }], { kind: "until_timestamp", expiresAt: "2035-01-01T00:00:01.000Z" }, { kind: "required", concentrationId: "focus" }), 1, "second");
    expect(f.repo.listActiveEffects("local-owner", f.campaign, f.source)).toEqual([expect.objectContaining({ effectId: "second" })]);
    apply(effect("immune", [{ kind: "immunity", appliesToId: "poison" }], { kind: "until_removed" }), 2, "immune");
    expect(() => apply(effect("poison", [{ kind: "flat", appliesToId: "poison", amount: 1 }], { kind: "until_removed" }), 3, "poison")).toThrow(EffectImmuneError);
    f.advance(1_001);
    expect(f.repo.listActiveEffects("local-owner", f.campaign, f.source).map((value) => value.effectId)).toEqual(["immune"]);
    f.repo.close();
  });

  it("returns exact retries before stale checks and rejects stale or unauthorized commands without mutation", () => {
    const f = fixture();
    const command: any = { type: "apply_effect", campaignId: f.campaign, actorId: f.source, expectedRevision: 0, idempotencyKey: "retry", appliedAt: timestamp, effect: { effectId: "retry-effect", campaignId: f.campaign, actorId: f.source, source: ability, modifiers: [{ kind: "flat", appliesToId: "might", amount: 1 }], duration: { kind: "until_removed" }, recovery: "none", concentration: { kind: "none" }, appliedAt: timestamp } };
    const first = f.repo.mutateEffect("local-owner", command);
    expect(f.repo.mutateEffect("local-owner", command)).toEqual(first);
    expect(() => f.repo.mutateEffect("local-owner", { ...command, expectedRevision: 1 })).toThrow(M16ConflictError);
    expect(() => f.repo.mutateEffect("local-owner", { ...command, idempotencyKey: "stale" })).toThrow(M16StaleError);
    expect(() => f.repo.mutateEffect("not-a-member", { ...command, idempotencyKey: "forbidden" })).toThrow(M16AuthorizationError);
    f.repo.close();
  });
});
