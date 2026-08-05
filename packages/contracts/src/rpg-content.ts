import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";

export const rpgContentNameSchema = z.string().trim().min(1).max(200);
export const rpgContentDescriptionSchema = z.string().trim().min(1).max(4_000);
export const rpgContentTagSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
export const rpgContentTagsSchema = z.array(rpgContentTagSchema).max(32);
export const MAX_DEFINITIONS_PER_KIND = 256;
export const MAX_DEFINITIONS_PER_PACK = 1_024;
export const MAX_CAMPAIGN_CONTENT_PACKS = 64;

export const rulesProfileIdSchema = resourceIdSchema;
export const contentPackIdSchema = resourceIdSchema;
export const contentPackVersionSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

export const rulesProfileIdentifierSchema = z.object({
  rulesProfileId: rulesProfileIdSchema,
}).strict();

export const rulesProfileMetadataSchema = z.object({
  name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema,
  tags: rpgContentTagsSchema,
}).strict();

export const rulesProfileSchema = z.object({
  rulesProfileId: rulesProfileIdSchema,
  ...rulesProfileMetadataSchema.shape,
}).strict();

export const definitionKindSchema = z.enum([
  "class",
  "race",
  "background",
  "item",
  "spell",
  "ability",
  "enemy",
]);

const definitionReferenceShape = {
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
  definitionId: resourceIdSchema,
};

export const classDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("class"),
}).strict();
export const raceDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("race"),
}).strict();
export const backgroundDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("background"),
}).strict();
export const itemDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("item"),
}).strict();
export const spellDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("spell"),
}).strict();
export const abilityDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("ability"),
}).strict();
export const enemyDefinitionReferenceSchema = z.object({
  ...definitionReferenceShape,
  kind: z.literal("enemy"),
}).strict();

export const definitionReferenceSchema = z.discriminatedUnion("kind", [
  classDefinitionReferenceSchema,
  raceDefinitionReferenceSchema,
  backgroundDefinitionReferenceSchema,
  itemDefinitionReferenceSchema,
  spellDefinitionReferenceSchema,
  abilityDefinitionReferenceSchema,
  enemyDefinitionReferenceSchema,
]);

const definitionShape = {
  definitionId: resourceIdSchema,
  name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema,
  tags: rpgContentTagsSchema,
};

export const classDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("class"),
}).strict();
export const raceDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("race"),
}).strict();
export const backgroundDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("background"),
}).strict();
export const itemDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("item"),
}).strict();
export const spellDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("spell"),
}).strict();
export const abilityDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("ability"),
}).strict();
export const enemyDefinitionSchema = z.object({
  ...definitionShape,
  kind: z.literal("enemy"),
}).strict();

export const rpgDefinitionSchema = z.discriminatedUnion("kind", [
  classDefinitionSchema,
  raceDefinitionSchema,
  backgroundDefinitionSchema,
  itemDefinitionSchema,
  spellDefinitionSchema,
  abilityDefinitionSchema,
  enemyDefinitionSchema,
]);

const contentPackProjectionShape = {
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
  rulesProfileId: rulesProfileIdSchema,
  name: rpgContentNameSchema,
  description: rpgContentDescriptionSchema,
  tags: rpgContentTagsSchema,
};

export const contentPackIdentifierSchema = z.object({
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
}).strict();

export const campaignContentPackIdentifiersSchema = z.array(contentPackIdentifierSchema)
  .max(MAX_CAMPAIGN_CONTENT_PACKS)
  .superRefine((packs, context) => {
    const seen = new Set<string>();
    packs.forEach((pack, index) => {
      if (seen.has(pack.packId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate campaign content packId",
          path: [index, "packId"],
        });
      }
      seen.add(pack.packId);
    });
  });

export const configureCampaignContentInputSchema = z.object({
  rulesProfileId: rulesProfileIdSchema,
  contentPacks: campaignContentPackIdentifiersSchema,
}).strict();

export const campaignContentConfigurationSchema = z.object({
  campaignId: resourceIdSchema,
  rulesProfileId: rulesProfileIdSchema,
  contentPacks: campaignContentPackIdentifiersSchema,
}).strict();

export const contentPackSchema = z.object(contentPackProjectionShape).strict();

export const installContentPackInputSchema = z.object({
  ...contentPackProjectionShape,
  rulesProfile: rulesProfileMetadataSchema,
  classes: z.array(classDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  races: z.array(raceDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  backgrounds: z.array(backgroundDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  items: z.array(itemDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  spells: z.array(spellDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  abilities: z.array(abilityDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
  enemies: z.array(enemyDefinitionSchema).max(MAX_DEFINITIONS_PER_KIND),
}).strict().superRefine((input, context) => {
  const groups = [
    ["classes", input.classes],
    ["races", input.races],
    ["backgrounds", input.backgrounds],
    ["items", input.items],
    ["spells", input.spells],
    ["abilities", input.abilities],
    ["enemies", input.enemies],
  ] as const;
  for (const [name, definitions] of groups) {
    const seen = new Set<string>();
    definitions.forEach((definition, index) => {
      if (seen.has(definition.definitionId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate ${definition.kind} definitionId`,
          path: [name, index, "definitionId"],
        });
      }
      seen.add(definition.definitionId);
    });
  }
  const totalDefinitions = groups.reduce((total, [, definitions]) => total + definitions.length, 0);
  if (totalDefinitions > MAX_DEFINITIONS_PER_PACK) {
    context.addIssue({
      code: "custom",
      message: `content pack cannot exceed ${MAX_DEFINITIONS_PER_PACK} definitions`,
      path: [],
    });
  }
});

export type RpgContentName = z.infer<typeof rpgContentNameSchema>;
export type RpgContentDescription = z.infer<typeof rpgContentDescriptionSchema>;
export type RpgContentTag = z.infer<typeof rpgContentTagSchema>;
export type RulesProfileId = z.infer<typeof rulesProfileIdSchema>;
export type RulesProfileIdentifier = z.infer<typeof rulesProfileIdentifierSchema>;
export type RulesProfileMetadata = z.infer<typeof rulesProfileMetadataSchema>;
export type RulesProfile = z.infer<typeof rulesProfileSchema>;
export type ContentPackId = z.infer<typeof contentPackIdSchema>;
export type ContentPackVersion = z.infer<typeof contentPackVersionSchema>;
export type ContentPackIdentifier = z.infer<typeof contentPackIdentifierSchema>;
export type ConfigureCampaignContentInput = z.infer<typeof configureCampaignContentInputSchema>;
export type CampaignContentConfiguration = z.infer<typeof campaignContentConfigurationSchema>;
export type DefinitionKind = z.infer<typeof definitionKindSchema>;
export type ClassDefinitionReference = z.infer<typeof classDefinitionReferenceSchema>;
export type RaceDefinitionReference = z.infer<typeof raceDefinitionReferenceSchema>;
export type BackgroundDefinitionReference = z.infer<typeof backgroundDefinitionReferenceSchema>;
export type ItemDefinitionReference = z.infer<typeof itemDefinitionReferenceSchema>;
export type SpellDefinitionReference = z.infer<typeof spellDefinitionReferenceSchema>;
export type AbilityDefinitionReference = z.infer<typeof abilityDefinitionReferenceSchema>;
export type EnemyDefinitionReference = z.infer<typeof enemyDefinitionReferenceSchema>;
export type DefinitionReference = z.infer<typeof definitionReferenceSchema>;
export type ClassDefinition = z.infer<typeof classDefinitionSchema>;
export type RaceDefinition = z.infer<typeof raceDefinitionSchema>;
export type BackgroundDefinition = z.infer<typeof backgroundDefinitionSchema>;
export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;
export type SpellDefinition = z.infer<typeof spellDefinitionSchema>;
export type AbilityDefinition = z.infer<typeof abilityDefinitionSchema>;
export type EnemyDefinition = z.infer<typeof enemyDefinitionSchema>;
export type RpgDefinition = z.infer<typeof rpgDefinitionSchema>;
export type ContentPack = z.infer<typeof contentPackSchema>;
export type InstallContentPackInput = z.infer<typeof installContentPackInputSchema>;
