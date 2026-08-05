import { z } from "zod";
import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
} from "./original-starter.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  backgroundDefinitionReferenceSchema,
  classDefinitionReferenceSchema,
  definitionKindSchema,
  definitionReferenceSchema,
  raceDefinitionReferenceSchema,
  rpgContentDescriptionSchema,
  rpgContentNameSchema,
} from "./rpg-content.js";
import { actorResourceAmountSchema } from "./rpg-resource-primitives.js";

export const MAX_CHARACTER_CLASSES = 16;
export const MAX_CHARACTER_LEVEL = 100;
export const MAX_CHARACTER_ATTRIBUTES = 64;
export const MAX_CHARACTER_PROFICIENCIES = 128;
export const MAX_CHARACTER_CHOICES = 128;
export const MAX_CHARACTER_RESOURCES = 128;
export const MAX_PRIVATE_NOTES_LENGTH = 4_000;
export const MAX_CAMPAIGN_CHARACTER_PERSONAS = 1_000;
export const MAX_CAMPAIGN_CHARACTER_ROSTER = 1_000;
export const MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES = MAX_CHARACTER_RESOURCES;

export const campaignCharacterIdSchema = resourceIdSchema;
export const campaignSheetIdSchema = resourceIdSchema;
export const actorIdSchema = resourceIdSchema;
export const campaignIdSchema = resourceIdSchema;
export const principalIdSchema = resourceIdSchema;
export const legacyVelvetCharacterIdSchema = z.string().min(1);

/** JavaScript strings can contain lone UTF-16 surrogates, which are not Unicode text. */
const hasWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const legacyPersonaNameSchema = z.string().min(1).max(200)
  .refine(hasWellFormedUtf16, "persona name must contain well-formed UTF-16")
  .refine((name) => name.trim().length > 0, "persona name must not be blank");

export const campaignCharacterPersonaSummarySchema = z.object({
  characterId: legacyVelvetCharacterIdSchema,
  name: legacyPersonaNameSchema,
  alreadyUsed: z.boolean(),
}).strict();

const starterRulesProfileSchema = z.object({
  rulesProfileId: z.literal(ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId),
  name: z.literal(ORIGINAL_STARTER_RULES_PROFILE.name),
  description: z.literal(ORIGINAL_STARTER_RULES_PROFILE.description),
}).strict();

const starterPackSchema = z.object({
  packId: z.literal(ORIGINAL_STARTER_PACK.packId),
  packVersion: z.literal(ORIGINAL_STARTER_PACK.packVersion),
  rulesProfileId: z.literal(ORIGINAL_STARTER_PACK.rulesProfileId),
  name: z.literal(ORIGINAL_STARTER_PACK.name),
  description: z.literal(ORIGINAL_STARTER_PACK.description),
}).strict();

const starterRaceSchema = z.object({
  reference: z.object({
    packId: z.literal(ORIGINAL_STARTER_RACE.reference.packId),
    packVersion: z.literal(ORIGINAL_STARTER_RACE.reference.packVersion),
    definitionId: z.literal(ORIGINAL_STARTER_RACE.reference.definitionId),
    kind: z.literal(ORIGINAL_STARTER_RACE.reference.kind),
  }).strict(),
  name: z.literal(ORIGINAL_STARTER_RACE.name),
  description: z.literal(ORIGINAL_STARTER_RACE.description),
}).strict();

const starterBackgroundSchema = z.object({
  reference: z.object({
    packId: z.literal(ORIGINAL_STARTER_BACKGROUND.reference.packId),
    packVersion: z.literal(ORIGINAL_STARTER_BACKGROUND.reference.packVersion),
    definitionId: z.literal(ORIGINAL_STARTER_BACKGROUND.reference.definitionId),
    kind: z.literal(ORIGINAL_STARTER_BACKGROUND.reference.kind),
  }).strict(),
  name: z.literal(ORIGINAL_STARTER_BACKGROUND.name),
  description: z.literal(ORIGINAL_STARTER_BACKGROUND.description),
}).strict();

const starterClassSchema = z.object({
  reference: z.object({
    packId: z.literal(ORIGINAL_STARTER_CLASS.reference.packId),
    packVersion: z.literal(ORIGINAL_STARTER_CLASS.reference.packVersion),
    definitionId: z.literal(ORIGINAL_STARTER_CLASS.reference.definitionId),
    kind: z.literal(ORIGINAL_STARTER_CLASS.reference.kind),
  }).strict(),
  name: z.literal(ORIGINAL_STARTER_CLASS.name),
  description: z.literal(ORIGINAL_STARTER_CLASS.description),
  level: z.literal(1),
}).strict();

/** Basic finalized metadata records; this is not a rules-complete builder. */
export const campaignCharacterBasicStarterMetadataSchema = z.object({
  rulesProfile: starterRulesProfileSchema,
  pack: starterPackSchema,
  race: starterRaceSchema,
  background: starterBackgroundSchema,
  class: starterClassSchema,
}).strict().superRefine((starter, context) => {
  if (starter.pack.rulesProfileId !== starter.rulesProfile.rulesProfileId) {
    context.addIssue({ code: "custom", message: "starter pack must link the rules profile", path: ["pack", "rulesProfileId"] });
  }
  for (const field of ["race", "background", "class"] as const) {
    const reference = starter[field].reference;
    if (reference.packId !== starter.pack.packId || reference.packVersion !== starter.pack.packVersion) {
      context.addIssue({ code: "custom", message: `starter ${field} must link the exact pack`, path: [field, "reference"] });
    }
  }
});

export const campaignCharacterCreationOptionsResponseSchema = z.object({
  campaignId: campaignIdSchema,
  personas: z.array(campaignCharacterPersonaSummarySchema)
    .max(MAX_CAMPAIGN_CHARACTER_PERSONAS)
    .superRefine((personas, context) => {
      const seen = new Set<string>();
      personas.forEach((persona, index) => {
        if (seen.has(persona.characterId)) {
          context.addIssue({ code: "custom", message: "duplicate persona characterId", path: [index, "characterId"] });
        }
        seen.add(persona.characterId);
      });
    }),
  starter: campaignCharacterBasicStarterMetadataSchema,
}).strict();

export const publicCampaignCharacterSummarySchema = z.object({
  id: campaignCharacterIdSchema,
  characterId: legacyVelvetCharacterIdSchema,
  name: legacyPersonaNameSchema,
}).strict();

export const campaignCharacterListResponseSchema = z.object({
  characters: z.array(publicCampaignCharacterSummarySchema)
    .max(MAX_CAMPAIGN_CHARACTER_ROSTER)
    .superRefine((characters, context) => {
      const ids = new Set<string>();
      const personaIds = new Set<string>();
      characters.forEach((character, index) => {
        if (ids.has(character.id)) {
          context.addIssue({ code: "custom", message: "duplicate campaign character id", path: [index, "id"] });
        }
        if (personaIds.has(character.characterId)) {
          context.addIssue({ code: "custom", message: "duplicate persona characterId", path: [index, "characterId"] });
        }
        ids.add(character.id);
        personaIds.add(character.characterId);
      });
    }),
}).strict();

export const campaignCharacterCreateRequestSchema = z.object({
  characterId: legacyVelvetCharacterIdSchema,
}).strict();

export const campaignCharacterCreateResponseSchema = z.object({
  character: publicCampaignCharacterSummarySchema,
}).strict();

const privateNotesSchema = z.string()
  .refine(hasWellFormedUtf16, { message: "private notes must contain well-formed UTF-16" })
  .refine(
    (value) => Array.from(value).length <= MAX_PRIVATE_NOTES_LENGTH,
    { message: `private notes must contain at most ${MAX_PRIVATE_NOTES_LENGTH} Unicode code points` },
  );

export const campaignCharacterClassSchema = z.object({
  class: classDefinitionReferenceSchema,
  level: z.number().int().min(1).max(MAX_CHARACTER_LEVEL),
}).strict();

export const campaignCharacterAttributeSchema = z.object({
  attributeId: resourceIdSchema,
  value: z.number().int().min(-1_000).max(1_000),
}).strict();

export const proficiencyCategorySchema = z.enum([
  "skill",
  "saving-throw",
  "tool",
  "weapon",
  "armor",
  "language",
]);

const PROFICIENCY_LABEL_PREFIXES: Record<z.infer<typeof proficiencyCategorySchema>, string> = {
  skill: "Skill proficiency",
  "saving-throw": "Saving throw proficiency",
  tool: "Tool proficiency",
  weapon: "Weapon proficiency",
  armor: "Armor proficiency",
  language: "Language proficiency",
};

const positionalWorkspaceLabelSchema = (prefixes: readonly string[], maximum: number) => z.string()
  .max(Math.max(...prefixes.map((prefix) => prefix.length)) + 1 + String(maximum).length)
  .refine((label) => prefixes.some((prefix) => label.startsWith(`${prefix} `)), "workspace label has the wrong prefix")
  .refine((label) => {
    const prefix = prefixes.find((candidate) => label.startsWith(`${candidate} `));
    if (prefix === undefined) return false;
    const index = label.slice(prefix.length + 1);
    return /^[1-9]\d*$/.test(index) && Number(index) <= maximum;
  }, `workspace label index must be between 1 and ${maximum}`);

export const campaignCharacterWorkspaceAttributeLabelSchema = positionalWorkspaceLabelSchema(
  ["Attribute"],
  MAX_CHARACTER_ATTRIBUTES,
);
export const campaignCharacterWorkspaceProficiencyLabelSchema = positionalWorkspaceLabelSchema(
  Object.values(PROFICIENCY_LABEL_PREFIXES),
  MAX_CHARACTER_PROFICIENCIES,
);
export const campaignCharacterWorkspaceChoiceLabelSchema = positionalWorkspaceLabelSchema(
  ["Choice"],
  MAX_CHARACTER_CHOICES,
);
export const campaignCharacterWorkspaceResourceLabelSchema = positionalWorkspaceLabelSchema(
  ["Resource"],
  MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES,
);

/* Workspace content metadata reuses established bounds and adds Unicode validity. */
export const campaignCharacterWorkspaceNameSchema = rpgContentNameSchema
  .refine(hasWellFormedUtf16, "workspace name must contain well-formed UTF-16");
export const campaignCharacterWorkspaceDescriptionSchema = rpgContentDescriptionSchema
  .refine(hasWellFormedUtf16, "workspace description must contain well-formed UTF-16");

export const campaignCharacterWorkspaceNamedDescriptionSchema = z.object({
  name: campaignCharacterWorkspaceNameSchema,
  description: campaignCharacterWorkspaceDescriptionSchema,
}).strict();

export const campaignCharacterWorkspaceClassSchema = z.object({
  name: campaignCharacterWorkspaceNameSchema,
  description: campaignCharacterWorkspaceDescriptionSchema,
  level: z.number().int().min(1).max(MAX_CHARACTER_LEVEL),
}).strict();

export const campaignCharacterWorkspaceAttributeSchema = z.object({
  label: campaignCharacterWorkspaceAttributeLabelSchema,
  value: z.number().int().min(-1_000).max(1_000),
}).strict();

export const campaignCharacterWorkspaceProficiencySchema = z.object({
  category: proficiencyCategorySchema,
  label: campaignCharacterWorkspaceProficiencyLabelSchema,
}).strict().superRefine(({ category, label }, context) => {
  if (!label.startsWith(`${PROFICIENCY_LABEL_PREFIXES[category]} `)) {
    context.addIssue({ code: "custom", message: "workspace proficiency label must match its category", path: ["label"] });
  }
});

export const campaignCharacterWorkspaceChoiceSchema = z.object({
  label: campaignCharacterWorkspaceChoiceLabelSchema,
  selection: z.object({
    kind: definitionKindSchema,
    name: campaignCharacterWorkspaceNameSchema,
    description: campaignCharacterWorkspaceDescriptionSchema,
  }).strict(),
}).strict();

export const campaignCharacterWorkspaceResourceSchema = z.object({
  label: campaignCharacterWorkspaceResourceLabelSchema,
  current: actorResourceAmountSchema,
  max: actorResourceAmountSchema,
}).strict().refine(
  ({ current, max }) => current <= max,
  { message: "current must not exceed max", path: ["current"] },
);

const addWorkspaceIssues = (
  workspace: {
    classes: z.infer<typeof campaignCharacterWorkspaceClassSchema>[];
    attributes: z.infer<typeof campaignCharacterWorkspaceAttributeSchema>[];
    proficiencies: z.infer<typeof campaignCharacterWorkspaceProficiencySchema>[];
    choices: z.infer<typeof campaignCharacterWorkspaceChoiceSchema>[];
    resources: z.infer<typeof campaignCharacterWorkspaceResourceSchema>[];
  },
  context: z.RefinementCtx,
) => {
  const addDuplicate = (
    values: string[],
    field: "classes" | "attributes" | "choices" | "resources",
    leaf: "name" | "label",
  ) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({ code: "custom", message: `duplicate workspace ${leaf}`, path: [field, index, leaf] });
      }
      seen.add(value);
    });
  };

  addDuplicate(workspace.classes.map(({ name }) => name), "classes", "name");
  addDuplicate(workspace.attributes.map(({ label }) => label), "attributes", "label");
  addDuplicate(workspace.choices.map(({ label }) => label), "choices", "label");
  addDuplicate(workspace.resources.map(({ label }) => label), "resources", "label");

  const seenProficiencies = new Set<string>();
  workspace.proficiencies.forEach(({ category, label }, index) => {
    const key = `${category}\u0000${label}`;
    if (seenProficiencies.has(key)) {
      context.addIssue({
        code: "custom",
        message: "duplicate workspace proficiency category and label",
        path: ["proficiencies", index, "label"],
      });
    }
    seenProficiencies.add(key);
  });

  const requirePosition = (values: string[], prefix: string, field: "attributes" | "choices" | "resources") => {
    values.forEach((value, index) => {
      if (value !== `${prefix} ${index + 1}`) {
        context.addIssue({ code: "custom", message: `workspace ${field} label must match its position`, path: [field, index, "label"] });
      }
    });
  };
  requirePosition(workspace.attributes.map(({ label }) => label), "Attribute", "attributes");
  requirePosition(workspace.choices.map(({ label }) => label), "Choice", "choices");
  requirePosition(workspace.resources.map(({ label }) => label), "Resource", "resources");
  workspace.proficiencies.forEach(({ label }, index) => {
    if (!label.endsWith(` ${index + 1}`)) {
      context.addIssue({ code: "custom", message: "workspace proficiency label must match its position", path: ["proficiencies", index, "label"] });
    }
  });
};

/** Strict, display-only campaign-character workspace with no persisted identities. */
export const campaignCharacterWorkspaceSchema = z.object({
  name: campaignCharacterWorkspaceNameSchema,
  race: campaignCharacterWorkspaceNamedDescriptionSchema,
  background: campaignCharacterWorkspaceNamedDescriptionSchema,
  classes: z.array(campaignCharacterWorkspaceClassSchema).max(MAX_CHARACTER_CLASSES),
  attributes: z.array(campaignCharacterWorkspaceAttributeSchema).max(MAX_CHARACTER_ATTRIBUTES),
  proficiencies: z.array(campaignCharacterWorkspaceProficiencySchema).max(MAX_CHARACTER_PROFICIENCIES),
  choices: z.array(campaignCharacterWorkspaceChoiceSchema).max(MAX_CHARACTER_CHOICES),
  resources: z.array(campaignCharacterWorkspaceResourceSchema).max(MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES),
}).strict().superRefine(addWorkspaceIssues);

export const campaignCharacterWorkspaceResponseSchema = z.object({
  character: campaignCharacterWorkspaceSchema,
}).strict();

export const campaignCharacterProficiencySchema = z.object({
  category: proficiencyCategorySchema,
  proficiencyId: resourceIdSchema,
}).strict();

export const resolvedCharacterChoiceSchema = z.object({
  choiceId: resourceIdSchema,
  selection: definitionReferenceSchema,
}).strict();

const sheetChoicesShape = {
  race: raceDefinitionReferenceSchema,
  background: backgroundDefinitionReferenceSchema,
  classes: z.array(campaignCharacterClassSchema).min(1).max(MAX_CHARACTER_CLASSES),
  attributes: z.array(campaignCharacterAttributeSchema).max(MAX_CHARACTER_ATTRIBUTES),
  proficiencies: z.array(campaignCharacterProficiencySchema).max(MAX_CHARACTER_PROFICIENCIES),
  choices: z.array(resolvedCharacterChoiceSchema).max(MAX_CHARACTER_CHOICES),
};

const addDuplicateIssues = (
  input: {
    classes: z.infer<typeof campaignCharacterClassSchema>[];
    attributes: z.infer<typeof campaignCharacterAttributeSchema>[];
    proficiencies: z.infer<typeof campaignCharacterProficiencySchema>[];
    choices: z.infer<typeof resolvedCharacterChoiceSchema>[];
  },
  context: z.RefinementCtx,
) => {
  const seenClasses = new Set<string>();
  input.classes.forEach((entry, index) => {
    const reference = entry.class;
    const key = `${reference.packId}\u0000${reference.packVersion}\u0000${reference.definitionId}`;
    if (seenClasses.has(key)) {
      context.addIssue({ code: "custom", message: "duplicate class reference", path: ["classes", index, "class"] });
    }
    seenClasses.add(key);
  });

  const seenAttributes = new Set<string>();
  input.attributes.forEach((entry, index) => {
    if (seenAttributes.has(entry.attributeId)) {
      context.addIssue({ code: "custom", message: "duplicate attributeId", path: ["attributes", index, "attributeId"] });
    }
    seenAttributes.add(entry.attributeId);
  });

  const seenProficiencies = new Set<string>();
  input.proficiencies.forEach((entry, index) => {
    const key = `${entry.category}\u0000${entry.proficiencyId}`;
    if (seenProficiencies.has(key)) {
      context.addIssue({
        code: "custom",
        message: "duplicate proficiency category and proficiencyId",
        path: ["proficiencies", index, "proficiencyId"],
      });
    }
    seenProficiencies.add(key);
  });

  const seenChoices = new Set<string>();
  input.choices.forEach((entry, index) => {
    if (seenChoices.has(entry.choiceId)) {
      context.addIssue({ code: "custom", message: "duplicate choiceId", path: ["choices", index, "choiceId"] });
    }
    seenChoices.add(entry.choiceId);
  });
};

export const createCampaignCharacterInputSchema = z.object({
  campaignId: campaignIdSchema,
  characterId: legacyVelvetCharacterIdSchema,
  controllerPrincipalId: principalIdSchema,
  ...sheetChoicesShape,
  privateNotes: privateNotesSchema.refine((value) => value.length > 0, { message: "private notes must not be empty" }).optional(),
}).strict().superRefine(addDuplicateIssues);

export const campaignCharacterSchema = z.object({
  id: campaignCharacterIdSchema,
  campaignId: campaignIdSchema,
  characterId: legacyVelvetCharacterIdSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const campaignCharacterSheetSchema = z.object({
  id: campaignSheetIdSchema,
  campaignId: campaignIdSchema,
  campaignCharacterId: campaignCharacterIdSchema,
  ...sheetChoicesShape,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict().superRefine(addDuplicateIssues);

export const actorKindSchema = z.literal("player-character");
export const actorControlSchema = z.literal("principal");

const publicActorShape = {
  id: actorIdSchema,
  campaignId: campaignIdSchema,
  campaignCharacterId: campaignCharacterIdSchema,
  sheetId: campaignSheetIdSchema,
  kind: actorKindSchema,
  control: actorControlSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
};

export const publicCampaignActorSchema = z.object(publicActorShape).strict();

export const privilegedCampaignActorSchema = z.object({
  ...publicActorShape,
  controllerPrincipalId: principalIdSchema,
  privateNotes: privateNotesSchema.nullable(),
}).strict();

const validateProjectionLinks = (
  projection: {
    campaignCharacter: z.infer<typeof campaignCharacterSchema>;
    sheet: z.infer<typeof campaignCharacterSheetSchema>;
    actor: z.infer<typeof publicCampaignActorSchema>;
  },
  context: z.RefinementCtx,
) => {
  const { campaignCharacter, sheet, actor } = projection;
  if (sheet.campaignCharacterId !== campaignCharacter.id) {
    context.addIssue({ code: "custom", message: "sheet must link the campaign character", path: ["sheet", "campaignCharacterId"] });
  }
  if (actor.campaignCharacterId !== campaignCharacter.id) {
    context.addIssue({ code: "custom", message: "actor must link the campaign character", path: ["actor", "campaignCharacterId"] });
  }
  if (actor.sheetId !== sheet.id) {
    context.addIssue({ code: "custom", message: "actor must link the sheet", path: ["actor", "sheetId"] });
  }
  if (sheet.campaignId !== campaignCharacter.campaignId || actor.campaignId !== campaignCharacter.campaignId) {
    context.addIssue({ code: "custom", message: "projection resources must belong to one campaign", path: ["campaignCharacter", "campaignId"] });
  }
};

export const publicCampaignCharacterProjectionSchema = z.object({
  campaignCharacter: campaignCharacterSchema,
  sheet: campaignCharacterSheetSchema,
  actor: publicCampaignActorSchema,
}).strict().superRefine(validateProjectionLinks);

export const privilegedCampaignCharacterProjectionSchema = z.object({
  campaignCharacter: campaignCharacterSchema,
  sheet: campaignCharacterSheetSchema,
  actor: privilegedCampaignActorSchema,
}).strict().superRefine(validateProjectionLinks);

export const campaignCharacterReadSchema = z.discriminatedUnion("access", [
  z.object({
    access: z.literal("public"),
    projection: publicCampaignCharacterProjectionSchema,
  }).strict(),
  z.object({
    access: z.literal("privileged"),
    projection: privilegedCampaignCharacterProjectionSchema,
  }).strict(),
]);

export type CampaignCharacterId = z.infer<typeof campaignCharacterIdSchema>;
export type CampaignSheetId = z.infer<typeof campaignSheetIdSchema>;
export type ActorId = z.infer<typeof actorIdSchema>;
export type CampaignId = z.infer<typeof campaignIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type LegacyVelvetCharacterId = z.infer<typeof legacyVelvetCharacterIdSchema>;
export type CampaignCharacterPersonaSummary = z.infer<typeof campaignCharacterPersonaSummarySchema>;
export type CampaignCharacterWorkspaceAttributeLabel = z.infer<typeof campaignCharacterWorkspaceAttributeLabelSchema>;
export type CampaignCharacterWorkspaceProficiencyLabel = z.infer<typeof campaignCharacterWorkspaceProficiencyLabelSchema>;
export type CampaignCharacterWorkspaceChoiceLabel = z.infer<typeof campaignCharacterWorkspaceChoiceLabelSchema>;
export type CampaignCharacterWorkspaceResourceLabel = z.infer<typeof campaignCharacterWorkspaceResourceLabelSchema>;
export type CampaignCharacterWorkspaceName = z.infer<typeof campaignCharacterWorkspaceNameSchema>;
export type CampaignCharacterWorkspaceDescription = z.infer<typeof campaignCharacterWorkspaceDescriptionSchema>;
export type CampaignCharacterWorkspaceNamedDescription = z.infer<typeof campaignCharacterWorkspaceNamedDescriptionSchema>;
export type CampaignCharacterWorkspaceClass = z.infer<typeof campaignCharacterWorkspaceClassSchema>;
export type CampaignCharacterWorkspaceAttribute = z.infer<typeof campaignCharacterWorkspaceAttributeSchema>;
export type CampaignCharacterWorkspaceProficiency = z.infer<typeof campaignCharacterWorkspaceProficiencySchema>;
export type CampaignCharacterWorkspaceChoice = z.infer<typeof campaignCharacterWorkspaceChoiceSchema>;
export type CampaignCharacterWorkspaceResource = z.infer<typeof campaignCharacterWorkspaceResourceSchema>;
export type CampaignCharacterWorkspace = z.infer<typeof campaignCharacterWorkspaceSchema>;
export type CampaignCharacterWorkspaceResponse = z.infer<typeof campaignCharacterWorkspaceResponseSchema>;
export type CampaignCharacterBasicStarterMetadata = z.infer<typeof campaignCharacterBasicStarterMetadataSchema>;
export type CampaignCharacterCreationOptionsResponse = z.infer<typeof campaignCharacterCreationOptionsResponseSchema>;
export type PublicCampaignCharacterSummary = z.infer<typeof publicCampaignCharacterSummarySchema>;
export type CampaignCharacterListResponse = z.infer<typeof campaignCharacterListResponseSchema>;
export type CampaignCharacterCreateRequest = z.infer<typeof campaignCharacterCreateRequestSchema>;
export type CampaignCharacterCreateResponse = z.infer<typeof campaignCharacterCreateResponseSchema>;
export type CampaignCharacterClass = z.infer<typeof campaignCharacterClassSchema>;
export type CampaignCharacterAttribute = z.infer<typeof campaignCharacterAttributeSchema>;
export type ProficiencyCategory = z.infer<typeof proficiencyCategorySchema>;
export type CampaignCharacterProficiency = z.infer<typeof campaignCharacterProficiencySchema>;
export type ResolvedCharacterChoice = z.infer<typeof resolvedCharacterChoiceSchema>;
export type CreateCampaignCharacterInput = z.infer<typeof createCampaignCharacterInputSchema>;
export type CampaignCharacter = z.infer<typeof campaignCharacterSchema>;
export type CampaignCharacterSheet = z.infer<typeof campaignCharacterSheetSchema>;
export type ActorKind = z.infer<typeof actorKindSchema>;
export type ActorControl = z.infer<typeof actorControlSchema>;
export type PublicCampaignActor = z.infer<typeof publicCampaignActorSchema>;
export type PrivilegedCampaignActor = z.infer<typeof privilegedCampaignActorSchema>;
export type PublicCampaignCharacterProjection = z.infer<typeof publicCampaignCharacterProjectionSchema>;
export type PrivilegedCampaignCharacterProjection = z.infer<typeof privilegedCampaignCharacterProjectionSchema>;
export type CampaignCharacterRead = z.infer<typeof campaignCharacterReadSchema>;
