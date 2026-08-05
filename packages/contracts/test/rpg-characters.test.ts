import { describe, expect, it } from "vitest";
import {
  actorControlSchema,
  actorKindSchema,
  campaignCharacterAttributeSchema,
  campaignCharacterClassSchema,
  campaignCharacterProficiencySchema,
  campaignCharacterReadSchema,
  createCampaignCharacterInputSchema,
  legacyVelvetCharacterIdSchema,
  MAX_CHARACTER_ATTRIBUTES,
  MAX_CHARACTER_CHOICES,
  MAX_CHARACTER_CLASSES,
  MAX_CHARACTER_LEVEL,
  MAX_CHARACTER_PROFICIENCIES,
  MAX_PRIVATE_NOTES_LENGTH,
  privilegedCampaignActorSchema,
  privilegedCampaignCharacterProjectionSchema,
  proficiencyCategorySchema,
  publicCampaignActorSchema,
  publicCampaignCharacterProjectionSchema,
  resolvedCharacterChoiceSchema,
} from "../src/index.js";

const timestamp = "2030-04-05T06:07:08.009Z";
const reference = (kind: "class" | "race" | "background" | "item" | "spell" | "ability") => ({
  packId: "velvet-starter",
  packVersion: "1.0.0",
  kind,
  definitionId: `${kind}-one`,
});

const input = {
  campaignId: "campaign-one",
  characterId: " legacy/persona id with spaces ",
  controllerPrincipalId: "principal-one",
  race: reference("race"),
  background: reference("background"),
  classes: [{ class: reference("class"), level: 1 }],
  attributes: [{ attributeId: "resolve", value: 12 }],
  proficiencies: [{ category: "skill", proficiencyId: "navigation" }],
  choices: [{ choiceId: "starter-ability", selection: reference("ability") }],
  privateNotes: "Known only to authorized readers.",
} as const;

const campaignCharacter = {
  id: "campaign-character-one",
  campaignId: input.campaignId,
  characterId: input.characterId,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const sheet = {
  id: "sheet-one",
  campaignId: input.campaignId,
  campaignCharacterId: campaignCharacter.id,
  race: input.race,
  background: input.background,
  classes: input.classes,
  attributes: input.attributes,
  proficiencies: input.proficiencies,
  choices: input.choices,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const publicActor = {
  id: "actor-one",
  campaignId: input.campaignId,
  campaignCharacterId: campaignCharacter.id,
  sheetId: sheet.id,
  kind: "player-character",
  control: "principal",
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const privilegedActor = {
  ...publicActor,
  controllerPrincipalId: input.controllerPrincipalId,
  privateNotes: input.privateNotes,
};

describe("v11 campaign-character contracts", () => {
  it("preserves opaque nonempty legacy persona IDs without resource-ID rules or trimming", () => {
    expect(legacyVelvetCharacterIdSchema.parse(input.characterId)).toBe(input.characterId);
    expect(legacyVelvetCharacterIdSchema.parse("/ persona\nidentifier ")).toBe("/ persona\nidentifier ");
    expect(legacyVelvetCharacterIdSchema.safeParse("").success).toBe(false);
    expect(createCampaignCharacterInputSchema.parse(input).characterId).toBe(input.characterId);
  });

  it("requires resource IDs and canonical timestamps for all new identities", () => {
    for (const field of ["campaignId", "controllerPrincipalId"] as const) {
      expect(createCampaignCharacterInputSchema.safeParse({ ...input, [field]: "invalid id" }).success).toBe(false);
    }
    expect(publicCampaignCharacterProjectionSchema.safeParse({
      campaignCharacter: { ...campaignCharacter, id: "bad/id" }, sheet, actor: publicActor,
    }).success).toBe(false);
    expect(publicCampaignCharacterProjectionSchema.safeParse({
      campaignCharacter: { ...campaignCharacter, createdAt: "2030-04-05T06:07:08Z" }, sheet, actor: publicActor,
    }).success).toBe(false);
  });

  it("requires exact race, background, class, and resolved-choice references", () => {
    expect(createCampaignCharacterInputSchema.parse(input)).toEqual(input);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, race: reference("background") }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, background: reference("race") }).success).toBe(false);
    expect(campaignCharacterClassSchema.safeParse({ class: reference("race"), level: 1 }).success).toBe(false);
    expect(resolvedCharacterChoiceSchema.safeParse({
      choiceId: "choice-one", selection: { ...reference("ability"), packVersion: undefined },
    }).success).toBe(false);
    expect(resolvedCharacterChoiceSchema.safeParse({
      choiceId: "choice-one", selection: { ...reference("ability"), versionRange: "^1.0.0" },
    }).success).toBe(false);
  });

  it("requires a complete strict creation payload while allowing optional private notes", () => {
    for (const field of [
      "campaignId", "characterId", "controllerPrincipalId", "race", "background", "classes", "attributes",
      "proficiencies", "choices",
    ] as const) {
      const incomplete: Record<string, unknown> = { ...input };
      delete incomplete[field];
      expect(createCampaignCharacterInputSchema.safeParse(incomplete).success).toBe(false);
    }
    const { privateNotes: _privateNotes, ...withoutNotes } = input;
    expect(createCampaignCharacterInputSchema.parse(withoutNotes)).toEqual(withoutNotes);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, privateNotes: "" }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, privateNotes: "x".repeat(MAX_PRIVATE_NOTES_LENGTH + 1) }).success)
      .toBe(false);
  });

  it("counts private-note maxima in Unicode code points for creation and privileged reads", () => {
    const astral = "\u{1F9B9}";
    const accepted = astral.repeat(MAX_PRIVATE_NOTES_LENGTH);
    const rejected = astral.repeat(MAX_PRIVATE_NOTES_LENGTH + 1);
    const privilegedRead = {
      access: "privileged",
      projection: { campaignCharacter, sheet, actor: { ...privilegedActor, privateNotes: accepted } },
    } as const;

    expect(Array.from(accepted)).toHaveLength(MAX_PRIVATE_NOTES_LENGTH);
    expect(accepted).toHaveLength(MAX_PRIVATE_NOTES_LENGTH * 2);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, privateNotes: accepted }).success).toBe(true);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, privateNotes: rejected }).success).toBe(false);
    expect(campaignCharacterReadSchema.safeParse(privilegedRead).success).toBe(true);
    expect(campaignCharacterReadSchema.safeParse({
      ...privilegedRead,
      projection: { ...privilegedRead.projection, actor: { ...privilegedRead.projection.actor, privateNotes: rejected } },
    }).success).toBe(false);
    expect(privilegedCampaignActorSchema.safeParse({ ...privilegedActor, privateNotes: null }).success).toBe(true);
  });

  it.each([
    "\ud800",
    "\udc00",
    "before\ud800after",
    "before\udc00after",
    "\ud800\ud800",
    "\udc00\udc00",
  ])("rejects malformed UTF-16 private notes %#", (privateNotes) => {
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, privateNotes }).success).toBe(false);
    expect(privilegedCampaignActorSchema.safeParse({ ...privilegedActor, privateNotes }).success).toBe(false);
  });

  it("enforces class levels, entry bounds, categories, and array maxima", () => {
    expect(campaignCharacterClassSchema.safeParse({ class: reference("class"), level: 0 }).success).toBe(false);
    expect(campaignCharacterClassSchema.safeParse({ class: reference("class"), level: MAX_CHARACTER_LEVEL + 1 }).success)
      .toBe(false);
    expect(campaignCharacterAttributeSchema.safeParse({ attributeId: "resolve", value: 1_001 }).success).toBe(false);
    expect(campaignCharacterAttributeSchema.safeParse({ attributeId: "resolve", value: 1.5 }).success).toBe(false);
    expect(campaignCharacterProficiencySchema.safeParse({ category: "unknown", proficiencyId: "resolve" }).success)
      .toBe(false);
    expect(proficiencyCategorySchema.options).toEqual([
      "skill", "saving-throw", "tool", "weapon", "armor", "language",
    ]);

    const many = (count: number, make: (index: number) => unknown) => Array.from({ length: count }, (_, index) => make(index));
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      classes: many(MAX_CHARACTER_CLASSES, (index) => ({
        class: { ...reference("class"), definitionId: `class-${index}` }, level: 1,
      })),
      attributes: many(MAX_CHARACTER_ATTRIBUTES, (index) => ({ attributeId: `attribute-${index}`, value: 1 })),
      proficiencies: many(MAX_CHARACTER_PROFICIENCIES, (index) => ({ category: "skill", proficiencyId: `skill-${index}` })),
      choices: many(MAX_CHARACTER_CHOICES, (index) => ({
        choiceId: `choice-${index}`,
        selection: { ...reference("ability"), definitionId: `ability-${index}` },
      })),
    }).success).toBe(true);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      classes: many(MAX_CHARACTER_CLASSES + 1, (index) => ({
        class: { ...reference("class"), definitionId: `class-${index}` }, level: 1,
      })),
    }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input, attributes: many(MAX_CHARACTER_ATTRIBUTES + 1, (index) => ({ attributeId: `attribute-${index}`, value: 1 })),
    }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      proficiencies: many(MAX_CHARACTER_PROFICIENCIES + 1, (index) => ({ category: "skill", proficiencyId: `skill-${index}` })),
    }).success).toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      choices: many(MAX_CHARACTER_CHOICES + 1, (index) => ({ choiceId: `choice-${index}`, selection: reference("ability") })),
    }).success).toBe(false);
  });

  it("rejects duplicate identities but permits multi-class entries without totaling levels", () => {
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, classes: [...input.classes, ...input.classes] }).success)
      .toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, attributes: [...input.attributes, ...input.attributes] }).success)
      .toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, proficiencies: [...input.proficiencies, ...input.proficiencies] }).success)
      .toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({ ...input, choices: [...input.choices, ...input.choices] }).success)
      .toBe(false);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      classes: [
        { class: reference("class"), level: MAX_CHARACTER_LEVEL },
        { class: { ...reference("class"), definitionId: "class-two" }, level: MAX_CHARACTER_LEVEL },
      ],
    }).success).toBe(true);
    expect(createCampaignCharacterInputSchema.safeParse({
      ...input,
      proficiencies: [
        { category: "skill", proficiencyId: "common" },
        { category: "language", proficiencyId: "common" },
      ],
    }).success).toBe(true);
  });

  it("defines only the first principal-controlled player-character actor", () => {
    expect(actorKindSchema.parse("player-character")).toBe("player-character");
    expect(actorControlSchema.parse("principal")).toBe("principal");
    expect(publicCampaignActorSchema.parse(publicActor)).toEqual(publicActor);
    expect(privilegedCampaignActorSchema.parse(privilegedActor)).toEqual(privilegedActor);
    expect(publicCampaignActorSchema.safeParse({ ...publicActor, kind: "npc" }).success).toBe(false);
    expect(publicCampaignActorSchema.safeParse({ ...publicActor, control: "ai" }).success).toBe(false);
  });

  it("keeps private control and notes impossible in public projections", () => {
    const publicProjection = { campaignCharacter, sheet, actor: publicActor };
    const privilegedProjection = { campaignCharacter, sheet, actor: privilegedActor };
    expect(publicCampaignCharacterProjectionSchema.parse(publicProjection)).toEqual(publicProjection);
    expect(privilegedCampaignCharacterProjectionSchema.parse(privilegedProjection)).toEqual(privilegedProjection);
    expect(publicCampaignActorSchema.safeParse(privilegedActor).success).toBe(false);
    expect(publicCampaignCharacterProjectionSchema.safeParse(privilegedProjection).success).toBe(false);
    expect(privilegedCampaignCharacterProjectionSchema.safeParse(publicProjection).success).toBe(false);
  });

  it("wraps public and privileged reads with a strict access discriminator", () => {
    const publicRead = { access: "public", projection: { campaignCharacter, sheet, actor: publicActor } } as const;
    const privilegedRead = {
      access: "privileged", projection: { campaignCharacter, sheet, actor: privilegedActor },
    } as const;
    expect(campaignCharacterReadSchema.parse(publicRead)).toEqual(publicRead);
    expect(campaignCharacterReadSchema.parse(privilegedRead)).toEqual(privilegedRead);
    expect(campaignCharacterReadSchema.safeParse({ ...publicRead, access: "privileged" }).success).toBe(false);
    expect(campaignCharacterReadSchema.safeParse({ ...privilegedRead, access: "public" }).success).toBe(false);
    expect(campaignCharacterReadSchema.safeParse({ ...publicRead, extra: true }).success).toBe(false);
  });

  it("requires actor, sheet, campaign character, and campaign links to agree", () => {
    const projection = { campaignCharacter, sheet, actor: publicActor };
    expect(publicCampaignCharacterProjectionSchema.safeParse({
      ...projection, actor: { ...publicActor, sheetId: "sheet-two" },
    }).success).toBe(false);
    expect(publicCampaignCharacterProjectionSchema.safeParse({
      ...projection, actor: { ...publicActor, campaignCharacterId: "campaign-character-two" },
    }).success).toBe(false);
    expect(publicCampaignCharacterProjectionSchema.safeParse({
      ...projection, sheet: { ...sheet, campaignId: "campaign-two" },
    }).success).toBe(false);
  });

  it("rejects persona editing and unrequested mechanics everywhere", () => {
    for (const field of ["name", "archetype", "boundaries", "safeWord", "hp", "inventory", "xp", "resources", "draft", "allocationMode"] as const) {
      expect(createCampaignCharacterInputSchema.safeParse({ ...input, [field]: field }).success).toBe(false);
      expect(publicCampaignCharacterProjectionSchema.safeParse({
        campaignCharacter: { ...campaignCharacter, [field]: field }, sheet, actor: publicActor,
      }).success).toBe(false);
    }
  });
});
