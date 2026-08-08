import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { CheckUnavailableError, EffectImmuneError, M16AuthorizationError, M16ConflictError, M16StaleError, PowerInsufficientResourceError, PowerUnavailableError, createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
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
    rng: { integer: (_minimum, maximum) => maximum === 21 ? 10 : Math.min(4, maximum - 1) },
  });
  const campaign = repo.createCampaign("local-owner", { name: "M1.6 behavior fixture" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const actor = (name: string, key: string) => {
    const persona = repo.createCharacter({ name, age: 31, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
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
  db.prepare("INSERT OR REPLACE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,?,?,?)").run(campaign.id, opponent, "health", 10, 10);
  db.prepare("INSERT OR REPLACE INTO rpg_actor_resource_charges_v25(campaign_id,actor_id,resource_name,current_charges,maximum_charges) VALUES(?,?,?,?,?)").run(campaign.id, source, "wand", 1, 1);
  // These are the same catalog references granted by the selected class. Seed
  // their immutable progression records explicitly so the fixture exercises
  // both ability and spell authorization independently of builder backfills.
  for (const power of [ability, spell]) {
    db.prepare("INSERT OR IGNORE INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)").run(campaignCharacter.campaign_character_id, power.kind, power.packId, power.packVersion, power.definitionId, 1, timestamp);
    db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)").run(campaign.id, power.packId, power.packVersion, power.kind, power.definitionId);
  }
  db.close();
  return { repo, campaign: campaign.id, source, opponent, idCount:()=>id, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

describe("M1.6 repository behavior", () => {
  it("reads an actor-only authoritative powers snapshot with progression provenance and M1.6 revision", () => {
    const f=fixture();
    const initial=f.repo.getActorPowerSnapshot("local-owner",f.source);
    expect(initial).not.toBeNull();
    expect(initial).toMatchObject({campaignId:f.campaign,actorId:f.source,revision:0});
    expect(initial!.known).toEqual(initial!.prepared);
    expect(initial!.known.map((power) => power.kind)).toEqual([...initial!.known.map((power) => power.kind)].sort());
    expect(initial!.slots).toContainEqual({slotId:"slot-1",level:1,current:1,max:1});
    expect(initial!.uses.every((state) => state.current>=0&&state.current<=state.max)).toBe(true);
    expect(initial!.legalNow).toHaveLength(initial!.known.length);
    expect(initial!.legalCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({powerRef:ability,targeting:"single",validTargets:[expect.objectContaining({actorId:f.opponent,label:"Briar"})],costs:[],effectKinds:["damage"]}),
      expect.objectContaining({powerRef:spell,targeting:"single",validTargets:[expect.objectContaining({actorId:f.opponent,label:"Briar"})],costs:[{kind:"slot",slotId:"slot-1",amount:1}],concentration:true,effectKinds:["modifier"]}),
    ]));
    const accessDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    for(const [principal,label] of [["powers-gm","GM"],["powers-controller","Controller"],["powers-observer","Observer"],["powers-unrelated","Unrelated"]])
      accessDb.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal,label);
    accessDb.close();
    f.advance(1_000);
    f.repo.addCampaignMembership("local-owner",f.campaign,{principalId:"powers-gm",role:"gm"});
    f.repo.addCampaignMembership("local-owner",f.campaign,{principalId:"powers-controller",role:"player"});
    f.repo.addCampaignMembership("local-owner",f.campaign,{principalId:"powers-observer",role:"observer"});
    const controllerDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    controllerDb.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='powers-controller' WHERE campaign_id=? AND actor_id=?").run(f.campaign,f.source);
    controllerDb.prepare("INSERT INTO rpg_actor_resource_bindings_v25(campaign_id,actor_id,resource_name,binding_key,binding_json) VALUES(?,?,?,?,?)")
      .run(f.campaign,f.source,"focus","ability-recovery",JSON.stringify({recovery:"long-rest"}));
    const finite=initial!.uses[0]!;
    controllerDb.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)")
      .run(f.campaign,finite.powerRef.packId,finite.powerRef.packVersion,finite.powerRef.kind,finite.powerRef.definitionId);
    controllerDb.close();
    expect(f.repo.getActorPowerSnapshot("powers-gm",f.source)).not.toBeNull();
    expect(f.repo.getActorPowerSnapshot("powers-controller",f.source)).not.toBeNull();
    expect(f.repo.getActorPowerSnapshot("powers-observer",f.source)).toBeNull();
    expect(f.repo.getActorPowerSnapshot("powers-unrelated",f.source)).toBeNull();
    expect(f.repo.getActorPowerSnapshot("local-owner","missing")).toBeNull();
    expect(f.repo.getActorEffectSnapshot("powers-gm",f.source)).toMatchObject({campaignId:f.campaign,actorId:f.source,effects:[],revision:0});
    expect(f.repo.getActorEffectSnapshot("powers-controller",f.source)).not.toBeNull();
    expect(f.repo.getActorEffectSnapshot("powers-observer",f.source)).toBeNull();
    expect(f.repo.getActorEffectSnapshot("powers-unrelated",f.source)).toBeNull();
    expect(f.repo.getActorEffectSnapshot("local-owner","missing")).toBeNull();
    f.repo.usePower("local-owner",{type:"use_power",campaignId:f.campaign,actorId:f.source,power:finite.powerRef,targetActorId:null,costs:[],expectedRevision:0,idempotencyKey:"finite",usedAt:timestamp});
    const exhausted=f.repo.getActorPowerSnapshot("local-owner",f.source)!;
    expect(exhausted.uses.find((state)=>state.powerRef.definitionId===finite.powerRef.definitionId)?.current).toBe(0);
    expect(exhausted.legalNow.find((state)=>state.powerRef.definitionId===finite.powerRef.definitionId)?.reasons).toContain("finite-uses-exhausted");
    expect(exhausted.legalCommands.some((command)=>command.powerRef.definitionId===finite.powerRef.definitionId)).toBe(false);
    f.repo.takeRest("local-owner",{type:"take_long_rest",campaignId:f.campaign,actorId:f.source,expectedRevision:0,idempotencyKey:"recover"});
    expect(f.repo.getActorPowerSnapshot("local-owner",f.source)!.uses.find((state)=>state.powerRef.definitionId===finite.powerRef.definitionId)?.current).toBe(finite.max);
    expect(f.repo.getActorPowerSnapshot("local-owner",f.source)?.revision).toBe(1);
    f.repo.close();
  });

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
    const actorOnly = {
      kind: "ability" as const, skillOrAttribute: "might", difficultyRef: "hard" as const,
      expectedRevision: 5, idempotencyKey: "actor-only",
    };
    const first = f.repo.resolveActorCheck("local-owner", f.source, actorOnly);
    expect(first.resolution.target).toEqual({ kind: "difficulty_class", value: 12 });
    expect(f.repo.resolveActorCheck("local-owner", f.source, actorOnly)).toEqual(first);
    expect(() => f.repo.resolveActorCheck("local-owner", f.source, { ...actorOnly, difficultyRef: "legendary", idempotencyKey: "unknown-difficulty" } as any)).toThrow(CheckUnavailableError);
    expect(() => f.repo.resolveActorCheck("local-owner", f.source, {
      kind: "attack", skillOrAttribute: "melee", targetActorId: "outside-campaign",
      expectedRevision: 6, idempotencyKey: "invalid-target",
    })).toThrow(CheckUnavailableError);
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

  it("executes actor-only powers with server costs, deterministic effects, target revisions, and exact replay",()=>{
    const f=fixture();
    const strike={powerRef:ability,targetIds:[f.opponent],choices:[] as [],expectedRevision:0,idempotencyKey:"actor-strike"};
    const first=f.repo.useActorPower("local-owner",f.source,strike);
    expect(first.resolution).toMatchObject({powerRef:ability,targetIds:[f.opponent],costs:[],outcomes:[{kind:"damage",targetId:f.opponent,applied:6}]});
    expect(first.actorStates).toEqual([
      expect.objectContaining({actorId:f.source,revision:1}),
      expect.objectContaining({actorId:f.opponent,revision:1,resources:expect.arrayContaining([expect.objectContaining({resourceId:"health",current:4,capacity:10})])}),
    ]);
    expect(f.repo.useActorPower("local-owner",f.source,strike)).toEqual(first);
    const glow=f.repo.useActorPower("local-owner",f.source,{powerRef:spell,targetIds:[f.opponent],choices:[],expectedRevision:1,idempotencyKey:"actor-glow"});
    expect(glow.resolution.costs).toEqual([{kind:"slot",slotId:"slot-1",amount:1}]);
    expect(glow.resolution.outcomes).toEqual([expect.objectContaining({kind:"modifier",targetId:f.opponent,statistic:"defense",amount:2})]);
    expect(glow.actorStates[0]!.resources).toContainEqual({resourceId:"slot-1",current:0,capacity:1});
    expect(glow.actorStates[1]!.activeEffects).toEqual([expect.objectContaining({source:spell,concentration:true,modifiers:[{kind:"flat",appliesToId:"defense",amount:2}]})]);
    expect(f.repo.getActorEffectSnapshot("local-owner",f.opponent)).toMatchObject({campaignId:f.campaign,actorId:f.opponent,revision:2,effects:[expect.objectContaining({source:spell,modifiers:[{kind:"flat",appliesToId:"defense",amount:2}],concentration:{kind:"required",concentrationId:"power-concentration"}})]});
    const replenish=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    replenish.prepare("UPDATE rpg_actor_resources SET current=1 WHERE campaign_id=? AND actor_id=? AND name='slot-1'").run(f.campaign,f.source);replenish.close();
    const replacement=f.repo.useActorPower("local-owner",f.source,{powerRef:spell,targetIds:[f.opponent],choices:[],expectedRevision:2,idempotencyKey:"actor-glow-replacement"});
    expect(replacement.actorStates[1]!.activeEffects).toHaveLength(1);
    expect(replacement.resolution.stateDeltas.map(delta=>delta.kind)).toEqual(["resource","effect-replaced","effect-applied"]);
    expect(()=>f.repo.useActorPower("local-owner",f.source,{...strike,idempotencyKey:"stale"})).toThrow(M16StaleError);
    expect(()=>f.repo.useActorPower("local-owner",f.source,{...strike,targetIds:[],expectedRevision:3,idempotencyKey:"bad-target"})).toThrow();
    f.repo.close();
  });

  it("stacks effects, replaces concentration atomically, applies immunity, and expires duration at query time", () => {
    const f = fixture();
    const effect = (effectId: string, modifiers: any[], duration: any, concentration: any = { kind: "none" }) => ({ effectId, campaignId: f.campaign, actorId: f.source, source: ability, modifiers, duration, recovery: "none", concentration, appliedAt: timestamp });
    const apply = (value: any, expectedRevision: number, idempotencyKey: string) => f.repo.mutateEffect("local-owner", { type: "apply_effect", campaignId: f.campaign, actorId: f.source, effect: value, expectedRevision, idempotencyKey, appliedAt: timestamp });
    expect(apply(effect("first", [{ kind: "flat", appliesToId: "might", amount: 2 }, { kind: "advantage", appliesToId: "might" }], { kind: "rounds", remaining: 2 }, { kind: "required", concentrationId: "focus" }), 0, "first").effects).toContainEqual(expect.objectContaining({ effectId: "first" }));
    apply(effect("second", [{ kind: "proficiency", appliesToId: "might", bonus: 1 }, { kind: "resistance", appliesToId: "fire" }, { kind: "vulnerability", appliesToId: "cold" }], { kind: "until_timestamp", expiresAt: "2035-01-01T00:00:01.000Z" }, { kind: "required", concentrationId: "focus" }), 1, "second");
    expect(f.repo.listActiveEffects("local-owner", f.campaign, f.source)).toEqual([expect.objectContaining({ effectId: "second" })]);
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)).toMatchObject({campaignId:f.campaign,actorId:f.source,revision:2,effects:[expect.objectContaining({effectId:"second",modifiers:[{kind:"proficiency",appliesToId:"might",bonus:1},{kind:"resistance",appliesToId:"fire"},{kind:"vulnerability",appliesToId:"cold"}],concentration:{kind:"required",concentrationId:"focus"}})]});
    apply(effect("immune", [{ kind: "immunity", appliesToId: "poison" }], { kind: "until_removed" }), 2, "immune");
    expect(() => apply(effect("poison", [{ kind: "flat", appliesToId: "poison", amount: 1 }], { kind: "until_removed" }), 3, "poison")).toThrow(EffectImmuneError);
    f.advance(1_001);
    expect(f.repo.listActiveEffects("local-owner", f.campaign, f.source).map((value) => value.effectId)).toEqual(["immune"]);
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)).toMatchObject({revision:3,effects:[expect.objectContaining({effectId:"immune"})]});
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

  it("executes strict actor-only GM effect intents with server identity, time, and exact replay",()=>{
    const f=fixture();
    const apply={kind:"apply" as const,effect:{source:ability,modifiers:[{kind:"flat" as const,appliesToId:"defense",amount:2}],duration:{kind:"rounds" as const,remaining:2},recovery:"none" as const,stacking:{kind:"concentration" as const,concentrationId:"focus"}},expectedRevision:0,idempotencyKey:"http-apply"};
    const first=f.repo.mutateActorEffect("local-owner",f.source,apply);
    expect(first.effects).toEqual([expect.objectContaining({effectId:expect.stringMatching(/^m16-/),campaignId:f.campaign,actorId:f.source,appliedAt:timestamp,concentration:{kind:"required",concentrationId:"focus"}})]);
    const generatedId=first.effects[0]!.effectId;
    const replacement=f.repo.mutateActorEffect("local-owner",f.source,{...apply,effect:{...apply.effect,source:null,modifiers:[{kind:"advantage",appliesToId:"might"}],stacking:{kind:"concentration",concentrationId:"focus"}},expectedRevision:1,idempotencyKey:"replacement"});
    expect(replacement.effects).toHaveLength(1);expect(replacement.effects[0]!.effectId).not.toBe(generatedId);
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)!.effects).toEqual(replacement.effects);
    const replacementId=replacement.effects[0]!.effectId;
    const expired=f.repo.mutateActorEffect("local-owner",f.source,{kind:"advance-duration",effectId:replacementId,rounds:2,expectedRevision:2,idempotencyKey:"expire"});
    expect(expired.effects).toEqual([]);
    const beforeReplayIds=f.idCount();
    expect(f.repo.mutateActorEffect("local-owner",f.source,apply)).toEqual(first);
    expect(f.idCount()).toBe(beforeReplayIds);
    expect(()=>f.repo.mutateActorEffect("local-owner",f.source,{...apply,effect:{...apply.effect,recovery:"short_rest"}})).toThrow(M16ConflictError);
    expect(()=>f.repo.mutateActorEffect("local-owner",f.source,{...apply,expectedRevision:0,idempotencyKey:"stale-http"})).toThrow(M16StaleError);
    expect(()=>f.repo.mutateActorEffect("local-owner",f.source,{kind:"remove",effectId:replacementId,expectedRevision:3,idempotencyKey:"inactive"})).toThrow();
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)).toMatchObject({revision:3,effects:[]});
    f.repo.close();
  });

  it("limits actor-only effect commands to canonical owner/GM authority and rolls back conflicts",()=>{
    const f=fixture();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    for(const [id,label,role] of [["effects-gm","GM","gm"],["effects-player","Player","player"],["effects-observer","Observer","observer"]] as const){
      db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(id,label);
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(f.campaign,id,role,timestamp);
    }
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='effects-player' WHERE campaign_id=? AND actor_id=?").run(f.campaign,f.source);db.close();
    const immunity={kind:"apply" as const,effect:{source:null,modifiers:[{kind:"immunity" as const,appliesToId:"poison"}],duration:{kind:"until_removed" as const},recovery:"none" as const,stacking:{kind:"coexists" as const}},expectedRevision:0,idempotencyKey:"gm-immunity"};
    const beforeDenied=f.idCount();
    expect(()=>f.repo.mutateActorEffect("effects-player",f.source,immunity)).toThrow(M16AuthorizationError);
    expect(()=>f.repo.mutateActorEffect("effects-observer",f.source,immunity)).toThrow(M16AuthorizationError);
    expect(f.idCount()).toBe(beforeDenied);
    const applied=f.repo.mutateActorEffect("effects-gm",f.source,immunity),effectId=applied.effects[0]!.effectId;
    const poison={kind:"apply" as const,effect:{...immunity.effect,modifiers:[{kind:"flat" as const,appliesToId:"poison",amount:1}]},expectedRevision:1,idempotencyKey:"immune-conflict"};
    expect(()=>f.repo.mutateActorEffect("effects-gm",f.source,poison)).toThrow(EffectImmuneError);
    expect(()=>f.repo.mutateActorEffect("effects-gm",f.source,{kind:"advance-duration",effectId,rounds:1,expectedRevision:1,idempotencyKey:"wrong-duration"})).toThrow();
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)).toMatchObject({revision:1,effects:[{effectId}]});
    expect(f.repo.mutateActorEffect("effects-gm",f.source,{kind:"remove",effectId,expectedRevision:1,idempotencyKey:"remove"}).effects).toEqual([]);
    expect(()=>f.repo.mutateActorEffect("effects-gm",f.source,{...immunity,effect:{...immunity.effect,source:{...ability,definitionId:"not-pinned"}},expectedRevision:2,idempotencyKey:"bad-source"})).toThrow();
    expect(f.repo.getActorEffectSnapshot("local-owner",f.source)).toMatchObject({revision:2,effects:[]});
    f.repo.close();
  });
});
