import { z } from "zod";
import { campaignMemberRoleSchema, resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import {
  contentPackIdSchema,
  contentPackVersionSchema,
  rpgContentDescriptionSchema,
  rpgContentNameSchema,
  rpgContentTagsSchema,
  rulesProfileIdSchema,
  rulesProfileMetadataSchema,
  MAX_CAMPAIGN_CONTENT_PACKS,
  MAX_DEFINITIONS_PER_PACK,
} from "./rpg-content.js";

/** M1.2's deliberately closed execution boundary. It is not an extensible DSL. */
export const VELVET_STARTER_RULES_ENGINE = "velvet-starter-v1" as const;
export const VELVET_STARTER_RULES_ENGINE_VERSION = "1.0.0" as const;
export const SRD_5_1_RULES_ENGINE = "dnd-5e" as const;
export const SRD_5_1_RULES_ENGINE_VERSION = "1.0.0" as const;
export const CONTENT_VALIDATION_LEVEL = "validated-v1" as const;
export const LEGACY_CONTENT_VALIDATION_LEVEL = "legacy-v10" as const;

export const catalogDefinitionKindSchema = z.enum([
  "race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template",
]);
export const catalogValidationLevelSchema = z.enum([LEGACY_CONTENT_VALIDATION_LEVEL, CONTENT_VALIDATION_LEVEL]);
export const catalogRoleSchema = campaignMemberRoleSchema;
export const contentDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const boundedMechanicIntegerSchema = z.number().int().min(-1_000_000).max(1_000_000);
export const nonNegativeMechanicIntegerSchema = z.number().int().min(0).max(1_000_000);
export const positiveMechanicIntegerSchema = z.number().int().min(1).max(1_000_000);
export const levelSchema = z.number().int().min(1).max(20);

const exactReferenceShape = {
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
  definitionId: resourceIdSchema,
};

const referenceFor = <Kind extends z.infer<typeof catalogDefinitionKindSchema>>(kind: Kind) => z.object({
  ...exactReferenceShape,
  kind: z.literal(kind),
}).strict();

export const raceCatalogReferenceSchema = referenceFor("race");
export const backgroundCatalogReferenceSchema = referenceFor("background");
export const classCatalogReferenceSchema = referenceFor("class");
export const classLevelCatalogReferenceSchema = referenceFor("class-level");
export const skillCatalogReferenceSchema = referenceFor("skill");
export const abilityCatalogReferenceSchema = referenceFor("ability");
export const spellCatalogReferenceSchema = referenceFor("spell");
export const itemCatalogReferenceSchema = referenceFor("item");
export const currencyCatalogReferenceSchema = referenceFor("currency");
export const enemyTemplateCatalogReferenceSchema = referenceFor("enemy-template");
export const catalogDefinitionReferenceSchema = z.discriminatedUnion("kind", [
  raceCatalogReferenceSchema, backgroundCatalogReferenceSchema, classCatalogReferenceSchema,
  classLevelCatalogReferenceSchema, skillCatalogReferenceSchema, abilityCatalogReferenceSchema,
  spellCatalogReferenceSchema, itemCatalogReferenceSchema, currencyCatalogReferenceSchema,
  enemyTemplateCatalogReferenceSchema,
]);

export const attributeIdSchema = z.enum([
  "might", "agility", "resolve", "insight", "presence", "craft",
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
]);
export const actionCostSchema = z.enum(["action", "bonus-action", "reaction", "passive"]);
export const recoverySchema = z.enum(["none", "short-rest", "long-rest", "encounter"]);
export const damageTypeSchema = z.enum(["physical", "bludgeoning", "piercing", "slashing", "fire", "frost", "cold", "force", "storm", "radiant", "shadow"]);
export const equipmentSlotSchema = z.enum(["hand", "body", "focus", "accessory"]);
export const targetSchema = z.enum(["self", "ally", "enemy", "single", "area"]);
const srdSizeSchema = z.enum(["Small", "Medium"]);
const srdSenseSchema = z.object({ kind: z.enum(["darkvision"]), rangeFeet: z.number().int().min(1).max(120) }).strict();
const srdSpellSchoolSchema = z.enum(["abjuration", "conjuration", "divination", "enchantment", "evocation", "illusion", "necromancy", "transmutation"]);
const srdSpellCastingTimeSchema = z.enum(["action", "bonus-action", "reaction", "1-minute", "10-minutes", "1-hour"]);
const srdSpellDurationSchema = z.enum(["instantaneous", "1-round", "1-minute", "10-minutes", "1-hour", "8-hours", "concentration"]);
const srdSpellSaveSchema = z.enum(["none", "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]);
const srdSpellAttackSchema = z.enum(["none", "melee", "ranged"]);

const modifierEffectSchema = z.object({
  type: z.literal("modifier"),
  statistic: z.enum(["check", "attack", "defense", "damage", "healing", "speed", "max-hp", "save-dc"]),
  amount: boundedMechanicIntegerSchema,
  duration: z.enum(["instant", "turn", "round", "encounter", "permanent"]),
}).strict();
const damageDieSidesSchema = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]);
const recoveryDieSidesSchema = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)]);
const damageEffectSchema = z.object({
  type: z.literal("damage"), damageType: damageTypeSchema,
  dice: z.object({ count: z.number().int().min(1).max(20), sides: damageDieSidesSchema, modifier: z.number().int().min(-100).max(100) }).strict(),
}).strict();
const healingEffectSchema = z.object({
  type: z.literal("healing"),
  dice: z.object({ count: z.number().int().min(1).max(20), sides: recoveryDieSidesSchema, modifier: z.number().int().min(0).max(100) }).strict(),
}).strict();
const resourceEffectSchema = z.object({
  type: z.literal("resource"), resource: z.enum(["health", "guard", "focus", "spell-slot"]),
  amount: boundedMechanicIntegerSchema,
}).strict();
const conditionEffectSchema = z.object({
  type: z.literal("condition"), condition: z.enum(["guarded", "slowed", "weakened", "burning", "focused"]),
  durationRounds: z.number().int().min(1).max(20),
}).strict();
export const starterEffectSchema = z.discriminatedUnion("type", [
  modifierEffectSchema, damageEffectSchema, healingEffectSchema, resourceEffectSchema, conditionEffectSchema,
]);
export const starterEffectsSchema = z.array(starterEffectSchema).max(16);

const definitionBaseShape = {
  reference: catalogDefinitionReferenceSchema,
  name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema,
  tags: rpgContentTagsSchema,
};
const typedBase = <Kind extends z.infer<typeof catalogDefinitionKindSchema>>(kind: Kind) => ({
  ...definitionBaseShape,
  reference: referenceFor(kind),
});

export const raceCatalogDefinitionSchema = z.object({
  ...typedBase("race"),
  mechanics: z.object({ size: srdSizeSchema.optional(), speed: z.number().int().min(1).max(100), attributeBonuses: z.partialRecord(attributeIdSchema, z.number().int().min(-5).max(5)), abilityRefs: z.array(abilityCatalogReferenceSchema).max(16),
    languages: z.array(z.string().trim().min(1).max(64)).max(16).optional(), proficiencies: z.array(z.string().trim().min(1).max(128)).max(16).optional(),
    damageResistances: z.array(z.enum(["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"])).max(8).optional(),
    senses: z.array(srdSenseSchema).max(8).optional(),
    resourceGrants: z.array(z.object({ resourceId: resourceIdSchema, maxIncrease: z.number().int().min(1).max(100), currentIncrease: z.number().int().min(0).max(100) }).strict()
      .refine((value) => value.currentIncrease <= value.maxIncrease, "current increase cannot exceed max increase")).max(8).optional(),
  }).strict(),
}).strict();
export const backgroundCatalogDefinitionSchema = z.object({
  ...typedBase("background"),
  mechanics: z.object({ skillRefs: z.array(skillCatalogReferenceSchema).max(16), itemRefs: z.array(itemCatalogReferenceSchema).max(16), startingCurrency: z.object({ currency: currencyCatalogReferenceSchema, amount: nonNegativeMechanicIntegerSchema }).strict() }).strict(),
}).strict();
export const classCatalogDefinitionSchema = z.object({
  ...typedBase("class"),
  mechanics: z.object({ hitDie: recoveryDieSidesSchema, primaryAttribute: attributeIdSchema, savingAttributes: z.array(attributeIdSchema).min(1).max(2), levelRefs: z.array(classLevelCatalogReferenceSchema).min(1).max(20) }).strict(),
}).strict();
export const classLevelCatalogDefinitionSchema = z.object({
  ...typedBase("class-level"),
  mechanics: z.object({
    classRef: classCatalogReferenceSchema,
    level: levelSchema,
    proficiencyBonus: z.number().int().min(1).max(10),
    hpGain: z.number().int().min(1).max(100),
    abilityRefs: z.array(abilityCatalogReferenceSchema).max(32),
    spellRefs: z.array(spellCatalogReferenceSchema).max(32),
    /** Prepared spells are intentionally separate from executable known powers. */
    preparedSpellRefs: z.array(spellCatalogReferenceSchema).max(16).optional(),
    /** Closed advancement choices. These select catalog identities only; they
     * are deliberately not executable rules or a multiclass vocabulary. */
    progressionChoices: z.array(z.object({
      choiceId: resourceIdSchema,
      kind: z.literal("ability"),
      required: z.literal(true),
      count: z.literal(1),
      options: z.array(abilityCatalogReferenceSchema).min(2).max(16).superRefine((options, context) => {
        const keys = options.map((option) => `${option.packId}\0${option.packVersion}\0${option.definitionId}`);
        if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "progression choice options must be unique" });
      }),
    }).strict()).max(8).optional().superRefine((choices, context) => {
      if (!choices) return;
      const ids = choices.map((choice) => choice.choiceId);
      if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "progression choice IDs must be unique within a level" });
    }),
    /** Fixed bounded resource-capacity grants needed by M1.4 previews. */
    resourceGrants: z.array(z.object({
      resourceId: resourceIdSchema,
      maxIncrease: z.number().int().min(1).max(100),
      currentIncrease: z.number().int().min(0).max(100),
    }).strict().refine((value) => value.currentIncrease <= value.maxIncrease,
      "current increase cannot exceed max increase")).max(8).optional(),
  }).strict(),
}).strict();
export const skillCatalogDefinitionSchema = z.object({
  ...typedBase("skill"), mechanics: z.object({ attribute: attributeIdSchema }).strict(),
}).strict();
export const abilityCatalogDefinitionSchema = z.object({
  ...typedBase("ability"), mechanics: z.object({ actionCost: actionCostSchema, recovery: recoverySchema, uses: z.number().int().min(0).max(100), target: targetSchema, effects: starterEffectsSchema }).strict(),
}).strict();
export const spellCatalogDefinitionSchema = z.object({
  ...typedBase("spell"), mechanics: z.object({ level: z.number().int().min(0).max(9), school: srdSpellSchoolSchema.optional(), castingTime: srdSpellCastingTimeSchema.optional(), actionCost: actionCostSchema, range: z.number().int().min(0).max(10_000), target: targetSchema, duration: srdSpellDurationSchema.optional(), attackType: srdSpellAttackSchema.optional(), saveType: srdSpellSaveSchema.optional(), concentration: z.boolean(), ritual: z.boolean().optional(),
    components: z.object({ verbal: z.boolean(), somatic: z.boolean(), material: z.boolean(), materialDescription: z.string().trim().min(1).max(256).optional() }).strict().optional(), ammunition: z.string().trim().min(1).max(128).optional(), effects: starterEffectsSchema }).strict(),
}).strict();

export const srdDamageTypeSchema = z.enum([
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic",
  "radiant", "slashing", "thunder",
]);
export const srdWeaponDamageDieSchema = z.object({
  count: z.number().int().min(1).max(2),
  sides: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
}).strict();
const srdWeaponRangeSchema = z.object({
  normalFeet: z.number().int().min(5).max(1_000),
  longFeet: z.number().int().min(5).max(2_000),
}).strict().refine((range) => range.longFeet >= range.normalFeet, {
  message: "long range must be at least normal range",
  path: ["longFeet"],
});
export const srdWeaponPropertySchema = z.discriminatedUnion("property", [
  z.object({ property: z.literal("finesse") }).strict(),
  z.object({ property: z.literal("light") }).strict(),
  z.object({ property: z.literal("heavy") }).strict(),
  z.object({ property: z.literal("reach"), reachFeet: z.literal(10) }).strict(),
  z.object({ property: z.literal("thrown"), range: srdWeaponRangeSchema }).strict(),
  z.object({ property: z.literal("two-handed") }).strict(),
  z.object({ property: z.literal("versatile"), damageDie: srdWeaponDamageDieSchema }).strict(),
  z.object({ property: z.literal("ammunition"), range: srdWeaponRangeSchema }).strict(),
  z.object({ property: z.literal("loading") }).strict(),
  z.object({ property: z.literal("special") }).strict(),
]);
export const srdWeaponProfileSchema = z.object({
  kind: z.literal("weapon"),
  proficiency: z.enum(["simple", "martial"]),
  attackType: z.enum(["melee", "ranged"]),
  damage: z.object({ type: srdDamageTypeSchema, die: srdWeaponDamageDieSchema }).strict(),
  properties: z.array(srdWeaponPropertySchema).max(10),
}).strict().superRefine((profile, context) => {
  const properties = new Map(profile.properties.map((property, index) => [property.property, { property, index }]));
  if (properties.size !== profile.properties.length) {
    context.addIssue({ code: "custom", message: "weapon properties must be unique", path: ["properties"] });
  }
  const reject = (property: z.infer<typeof srdWeaponPropertySchema>["property"], message: string) => {
    const entry = properties.get(property);
    if (entry) context.addIssue({ code: "custom", message, path: ["properties", entry.index] });
  };
  if (profile.attackType === "melee") {
    reject("ammunition", "melee weapons cannot have the ammunition property");
    reject("loading", "melee weapons cannot have the loading property");
  } else {
    reject("reach", "ranged weapons cannot have the reach property");
    reject("versatile", "ranged weapons cannot have the versatile property");
  }
  if (properties.has("light")) {
    reject("heavy", "a weapon cannot be both light and heavy");
    reject("two-handed", "a light weapon cannot be two-handed");
    reject("versatile", "a light weapon cannot be versatile");
  }
  if (properties.has("heavy")) reject("finesse", "a heavy weapon cannot have the finesse property");
  if (properties.has("two-handed")) reject("versatile", "a two-handed weapon cannot be versatile");
  if (properties.has("loading") && !properties.has("ammunition")) {
    reject("loading", "the loading property requires ammunition");
  }
  const versatile = properties.get("versatile")?.property;
  if (versatile?.property === "versatile") {
    const base = profile.damage.die;
    if (versatile.damageDie.count !== base.count || versatile.damageDie.sides <= base.sides) {
      context.addIssue({ code: "custom", message: "versatile damage die must be a larger die with the same count", path: ["properties", properties.get("versatile")!.index, "damageDie"] });
    }
  }
});
/** Closed metadata for tools. Tool effects remain unsupported unless another
 * runtime explicitly implements them. */
export const srdToolProfileSchema = z.object({
  kind: z.literal("tool"),
  proficiency: z.string().trim().min(1).max(128),
}).strict();
/** Ammunition is inventory state, not an executable weapon effect. */
export const srdAmmunitionProfileSchema = z.object({
  kind: z.literal("ammunition"),
  weaponCategory: z.enum(["simple", "martial"]),
}).strict();

const srdArmorBaseShape = {
  kind: z.literal("armor"),
  baseArmorClass: z.number().int().min(1).max(30),
  strengthRequirement: z.number().int().min(1).max(30).nullable(),
  stealthDisadvantage: z.boolean(),
  shieldBonus: z.literal(0),
};
export const srdArmorProfileSchema = z.discriminatedUnion("category", [
  z.object({ ...srdArmorBaseShape, category: z.literal("light"), dexterity: z.object({ policy: z.literal("full") }).strict(), strengthRequirement: z.null() }).strict(),
  z.object({ ...srdArmorBaseShape, category: z.literal("medium"), dexterity: z.object({ policy: z.literal("capped"), maxBonus: z.literal(2) }).strict(), strengthRequirement: z.null() }).strict(),
  z.object({ ...srdArmorBaseShape, category: z.literal("heavy"), dexterity: z.object({ policy: z.literal("none") }).strict() }).strict(),
  z.object({
    kind: z.literal("armor"), category: z.literal("shield"), baseArmorClass: z.null(),
    dexterity: z.object({ policy: z.literal("none") }).strict(), strengthRequirement: z.null(),
    stealthDisadvantage: z.literal(false), shieldBonus: z.number().int().min(1).max(10),
  }).strict(),
]);
export const srdItemEngineDetailsSchema = z.object({
  rulesEngine: z.literal(SRD_5_1_RULES_ENGINE),
  weightPounds: z.number().min(0).max(100_000),
  equipmentProfile: z.union([srdWeaponProfileSchema, srdArmorProfileSchema, srdToolProfileSchema, srdAmmunitionProfileSchema]).nullable(),
}).strict();
export const itemCatalogDefinitionSchema = z.object({
  ...typedBase("item"), mechanics: z.object({
    category: z.enum(["weapon", "armor", "consumable", "tool", "gear"]),
    stackable: z.boolean(),
    slot: equipmentSlotSchema.nullable(),
    price: z.object({ currency: currencyCatalogReferenceSchema, amount: nonNegativeMechanicIntegerSchema }).strict(),
    effects: starterEffectsSchema,
    engineDetails: srdItemEngineDetailsSchema.nullable().optional(),
  }).strict(),
}).strict().superRefine((item, context) => {
  const profile = item.mechanics.engineDetails?.equipmentProfile;
  if (!profile) return;
  if (profile.kind === "weapon" && item.mechanics.category !== "weapon") {
    context.addIssue({ code: "custom", message: "weapon profiles require the weapon item category", path: ["mechanics", "category"] });
  }
  if (profile.kind === "armor" && item.mechanics.category !== "armor") {
    context.addIssue({ code: "custom", message: "armor profiles require the armor item category", path: ["mechanics", "category"] });
  }
  if (profile.kind === "armor" && profile.category === "shield" && item.mechanics.slot !== "hand") {
    context.addIssue({ code: "custom", message: "shields require the hand equipment slot", path: ["mechanics", "slot"] });
  }
  if (profile.kind === "armor" && profile.category !== "shield" && item.mechanics.slot !== "body") {
    context.addIssue({ code: "custom", message: "body armor requires the body equipment slot", path: ["mechanics", "slot"] });
  }
});
export const currencyCatalogDefinitionSchema = z.object({
  ...typedBase("currency"), mechanics: z.object({ symbol: z.string().trim().min(1).max(8), minorPerMajor: positiveMechanicIntegerSchema }).strict(),
}).strict();
export const enemyTemplateCatalogDefinitionSchema = z.object({
  ...typedBase("enemy-template"),
  mechanics: z.object({ tier: z.number().int().min(1).max(20), maxHp: positiveMechanicIntegerSchema, defense: z.number().int().min(0).max(100), speed: z.number().int().min(1).max(100), abilityRefs: z.array(abilityCatalogReferenceSchema).min(1).max(32), resistances: z.array(damageTypeSchema).max(6), vulnerabilities: z.array(damageTypeSchema).max(6), immunities: z.array(damageTypeSchema).max(6),
    /** A closed executable binding, not a general monster-statblock vocabulary. */
    combatProfile: z.object({ kind: z.literal("dnd-5e-pinned-basic-attack-v1"), proficiencyBonus: z.number().int().min(0).max(10),
      attack: z.object({ abilityRef: abilityCatalogReferenceSchema, attackBonus: z.number().int().min(-20).max(30) }).strict() }).strict().optional() }).strict(),
  private: z.object({ tactics: z.string().trim().min(1).max(2_000), gmNotes: z.string().trim().max(2_000),
    hiddenAbilityRefs: z.array(abilityCatalogReferenceSchema).max(16),
    hiddenRefs: z.array(catalogDefinitionReferenceSchema).max(32).optional() }).strict(),
}).strict();

// Zod cannot discriminate on a nested key, so use a union plus exact per-kind literals.
export const catalogDefinitionSchema = z.union([
  raceCatalogDefinitionSchema, backgroundCatalogDefinitionSchema, classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema, skillCatalogDefinitionSchema, abilityCatalogDefinitionSchema,
  spellCatalogDefinitionSchema, itemCatalogDefinitionSchema, currencyCatalogDefinitionSchema,
  enemyTemplateCatalogDefinitionSchema,
]);
/** Descriptive alias retained for callers that use the full domain name. */
export const contentCatalogDefinitionSchema = catalogDefinitionSchema;

export const contentCompatibilitySchema = z.object({
  rulesEngine: z.enum([VELVET_STARTER_RULES_ENGINE, SRD_5_1_RULES_ENGINE]),
  rulesEngineVersion: z.enum([VELVET_STARTER_RULES_ENGINE_VERSION, SRD_5_1_RULES_ENGINE_VERSION]).optional(),
  rulesProfileId: rulesProfileIdSchema,
  catalogFormat: z.literal(CONTENT_VALIDATION_LEVEL),
}).strict();
const publicationProvenanceBase = {
  author: z.string().trim().min(1).max(200),
  authoredAt: utcIsoTimestampSchema,
  reviewedBy: z.string().trim().min(1).max(200),
  reviewedAt: utcIsoTimestampSchema,
  declaration: z.string().trim().min(1).max(2_000),
};
export const publicationProvenanceSchema = z.discriminatedUnion("authorship", [
  z.object({ authorship: z.literal("original"), ...publicationProvenanceBase, thirdPartyData: z.literal(false) }).strict(),
  z.object({ authorship: z.literal("licensed"), ...publicationProvenanceBase, thirdPartyData: z.literal(true) }).strict(),
]);
export const contentPublicationManifestSchema = z.object({
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
  name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema,
  tags: rpgContentTagsSchema,
  rulesProfile: rulesProfileMetadataSchema,
  compatibility: contentCompatibilitySchema,
  digest: contentDigestSchema,
  provenance: publicationProvenanceSchema,
}).strict();
export const validateContentCatalogInputSchema = z.object({
  manifest: contentPublicationManifestSchema,
  definitions: z.array(catalogDefinitionSchema).min(1).max(MAX_DEFINITIONS_PER_PACK),
}).strict().superRefine((catalog, context) => {
  catalog.definitions.forEach((definition, index) => {
    if (!("engineDetails" in definition.mechanics)) return;
    const details = definition.mechanics.engineDetails;
    if (details && details.rulesEngine !== catalog.manifest.compatibility.rulesEngine) {
      context.addIssue({ code: "custom", message: "item engine details must match the publication rules engine",
        path: ["definitions", index, "mechanics", "engineDetails", "rulesEngine"] });
    }
  });
});
export const publishContentCatalogInputSchema = validateContentCatalogInputSchema.safeExtend({
  idempotencyKey: idempotencyKeySchema,
});

export const catalogValidationIssueCodeSchema = z.enum([
  "invalid-input", "identity-mismatch", "duplicate-definition", "missing-reference", "wrong-reference-kind",
  "dependency-cycle", "incompatible", "digest-mismatch", "unsupported-mechanic", "incomplete-starter",
]);
export const catalogValidationIssueSchema = z.object({
  code: catalogValidationIssueCodeSchema,
  path: z.string().min(1).max(500),
  message: z.string().min(1).max(1_000),
  reference: catalogDefinitionReferenceSchema.optional(),
}).strict();
export const catalogDefinitionCountSchema = z.object({ kind: catalogDefinitionKindSchema, count: z.number().int().min(0).max(MAX_DEFINITIONS_PER_PACK) }).strict();
export const catalogValidationReportSchema = z.object({
  valid: z.boolean(),
  issues: z.array(catalogValidationIssueSchema).max(MAX_DEFINITIONS_PER_PACK * 8),
  normalizedSummary: z.object({ totalDefinitions: z.number().int().min(0).max(MAX_DEFINITIONS_PER_PACK), counts: z.array(catalogDefinitionCountSchema).length(catalogDefinitionKindSchema.options.length), digest: contentDigestSchema.nullable() }).strict(),
}).strict().superRefine((report, context) => {
  if (report.valid !== (report.issues.length === 0)) context.addIssue({ code: "custom", message: "valid must exactly reflect issues", path: ["valid"] });
});

export const publicationSummarySchema = z.object({
  packId: contentPackIdSchema, packVersion: contentPackVersionSchema, name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema, tags: rpgContentTagsSchema, compatibility: contentCompatibilitySchema,
  digest: contentDigestSchema, validationLevel: z.literal(CONTENT_VALIDATION_LEVEL), publishedAt: utcIsoTimestampSchema,
}).strict();
export const ownerCatalogProjectionSchema = z.object({
  publication: publicationSummarySchema,
  provenance: publicationProvenanceSchema,
  definitions: z.array(catalogDefinitionSchema).max(MAX_DEFINITIONS_PER_PACK),
}).strict();
const publicEnemySchema = enemyTemplateCatalogDefinitionSchema.omit({ private: true });
export const memberCatalogDefinitionSchema = z.union([
  raceCatalogDefinitionSchema, backgroundCatalogDefinitionSchema, classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema, skillCatalogDefinitionSchema, abilityCatalogDefinitionSchema,
  spellCatalogDefinitionSchema, itemCatalogDefinitionSchema, currencyCatalogDefinitionSchema, publicEnemySchema,
]);
/** Observer catalog entries intentionally carry presentation metadata only. */
export const observerCatalogDefinitionSchema = z.object(definitionBaseShape).strict();
export const gmCatalogProjectionSchema = z.object({ publication: publicationSummarySchema, definitions: z.array(catalogDefinitionSchema).max(MAX_DEFINITIONS_PER_PACK) }).strict();
export const playerCatalogProjectionSchema = z.object({ publication: publicationSummarySchema, definitions: z.array(memberCatalogDefinitionSchema).max(MAX_DEFINITIONS_PER_PACK) }).strict();
export const observerCatalogProjectionSchema = z.object({ publication: publicationSummarySchema, definitions: z.array(observerCatalogDefinitionSchema).max(MAX_DEFINITIONS_PER_PACK) }).strict();

export const configureCampaignCatalogInputSchema = z.object({
  rulesProfileId: rulesProfileIdSchema,
  contentPacks: z.array(z.object({ packId: contentPackIdSchema, packVersion: contentPackVersionSchema }).strict()).min(1).max(MAX_CAMPAIGN_CONTENT_PACKS),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.contentPacks.forEach((pack, index) => {
    if (seen.has(pack.packId)) context.addIssue({ code: "custom", message: "duplicate campaign content packId", path: ["contentPacks", index, "packId"] });
    seen.add(pack.packId);
  });
});
export const campaignCatalogResolutionReportSchema = z.object({
  campaignId: resourceIdSchema,
  compatible: z.boolean(),
  rulesProfileId: rulesProfileIdSchema,
  contentPacks: z.array(z.object({ packId: contentPackIdSchema, packVersion: contentPackVersionSchema, digest: contentDigestSchema }).strict()).max(MAX_CAMPAIGN_CONTENT_PACKS),
  issues: z.array(catalogValidationIssueSchema),
}).strict();
export const campaignCatalogReceiptSchema = z.object({
  campaignId: resourceIdSchema,
  commandId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: expectedRevisionSchema,
  revisionAfter: revisionSchema,
  configuredAt: utcIsoTimestampSchema,
  content: campaignCatalogResolutionReportSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({ code: "custom", message: "catalog receipt revision must advance exactly once", path: ["revisionAfter"] });
  }
  if (receipt.content.campaignId !== receipt.campaignId) {
    context.addIssue({ code: "custom", message: "catalog receipt campaign must match content", path: ["content", "campaignId"] });
  }
});
export const campaignCatalogConfigurationResultSchema = z.object({
  content: campaignCatalogResolutionReportSchema,
  receipt: campaignCatalogReceiptSchema,
}).strict();

export type CatalogDefinitionKind = z.infer<typeof catalogDefinitionKindSchema>;
export type CatalogDefinitionReference = z.infer<typeof catalogDefinitionReferenceSchema>;
export type CatalogDefinition = z.infer<typeof catalogDefinitionSchema>;
export type SrdWeaponProperty = z.infer<typeof srdWeaponPropertySchema>;
export type SrdWeaponProfile = z.infer<typeof srdWeaponProfileSchema>;
export type SrdArmorProfile = z.infer<typeof srdArmorProfileSchema>;
export type SrdItemEngineDetails = z.infer<typeof srdItemEngineDetailsSchema>;
export type MemberCatalogDefinition = z.infer<typeof memberCatalogDefinitionSchema>;
export type ObserverCatalogDefinition = z.infer<typeof observerCatalogDefinitionSchema>;
export type ContentCompatibility = z.infer<typeof contentCompatibilitySchema>;
export type PublicationProvenance = z.infer<typeof publicationProvenanceSchema>;
export type ContentPublicationManifest = z.infer<typeof contentPublicationManifestSchema>;
export type PublishContentCatalogInput = z.infer<typeof publishContentCatalogInputSchema>;
export type CatalogValidationIssue = z.infer<typeof catalogValidationIssueSchema>;
export type CatalogValidationReport = z.infer<typeof catalogValidationReportSchema>;
export type PublicationSummary = z.infer<typeof publicationSummarySchema>;
export type OwnerCatalogProjection = z.infer<typeof ownerCatalogProjectionSchema>;
export type GmCatalogProjection = z.infer<typeof gmCatalogProjectionSchema>;
export type PlayerCatalogProjection = z.infer<typeof playerCatalogProjectionSchema>;
export type ObserverCatalogProjection = z.infer<typeof observerCatalogProjectionSchema>;
export type ConfigureCampaignCatalogInput = z.infer<typeof configureCampaignCatalogInputSchema>;
export type CampaignCatalogResolutionReport = z.infer<typeof campaignCatalogResolutionReportSchema>;
export type CampaignCatalogReceipt = z.infer<typeof campaignCatalogReceiptSchema>;
export type CampaignCatalogConfigurationResult = z.infer<typeof campaignCatalogConfigurationResultSchema>;
