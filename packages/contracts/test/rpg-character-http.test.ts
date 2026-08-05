import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CampaignCharacterBasicStarterMetadata,
  CampaignCharacterCreateRequest,
  CampaignCharacterCreateResponse,
  CampaignCharacterCreationOptionsResponse,
  CampaignCharacterListResponse,
  PublicCampaignCharacterSummary,
} from "../src/index.js";
import {
  campaignCharacterBasicStarterMetadataSchema,
  campaignCharacterCreateRequestSchema,
  campaignCharacterCreateResponseSchema,
  campaignCharacterCreationOptionsResponseSchema,
  campaignCharacterListResponseSchema,
  MAX_CAMPAIGN_CHARACTER_PERSONAS,
  MAX_CAMPAIGN_CHARACTER_ROSTER,
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
  publicCampaignCharacterSummarySchema,
} from "../src/index.js";

const starter = {
  rulesProfile: ORIGINAL_STARTER_RULES_PROFILE,
  pack: ORIGINAL_STARTER_PACK,
  race: ORIGINAL_STARTER_RACE,
  background: ORIGINAL_STARTER_BACKGROUND,
  class: { ...ORIGINAL_STARTER_CLASS, level: 1 as const },
};

const summary = {
  id: "campaign-character-one",
  characterId: " legacy/persona id ",
  name: "Aster",
};

describe("campaign-character HTTP contracts", () => {
  it("exports exact frozen basic starter metadata without changing manifest identity", () => {
    expect(ORIGINAL_STARTER_PACK.packId).toBe(ORIGINAL_STARTER_PACK_ID);
    expect(ORIGINAL_STARTER_PACK.packVersion).toBe(ORIGINAL_STARTER_PACK_VERSION);
    expect(ORIGINAL_STARTER_PACK).toMatchObject({
      rulesProfileId: "velvet:rules:original-narrative",
      name: "Velvet Original Starter",
    });
    expect(ORIGINAL_STARTER_RACE.reference).toEqual({
      packId: ORIGINAL_STARTER_PACK_ID,
      packVersion: ORIGINAL_STARTER_PACK_VERSION,
      definitionId: "velvet:original-starter:race:avelune",
      kind: "race",
    });
    expect(ORIGINAL_STARTER_BACKGROUND.reference.definitionId)
      .toBe("velvet:original-starter:background:rainledger");
    expect(ORIGINAL_STARTER_CLASS.reference.definitionId)
      .toBe("velvet:original-starter:class:pathmender");

    for (const record of [
      ORIGINAL_STARTER_RULES_PROFILE,
      ORIGINAL_STARTER_PACK,
      ORIGINAL_STARTER_RACE,
      ORIGINAL_STARTER_BACKGROUND,
      ORIGINAL_STARTER_CLASS,
    ]) {
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(Object.isFrozen(ORIGINAL_STARTER_RACE.reference)).toBe(true);
    expect(campaignCharacterBasicStarterMetadataSchema.parse(starter)).toEqual(starter);
  });

  it("requires every exact starter literal, complete reference, and level one", () => {
    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      ["rules profile", (value) => { value.rulesProfile.rulesProfileId = "rules-other"; }],
      ["profile metadata", (value) => { value.rulesProfile.name = "Other"; }],
      ["pack identity", (value) => { value.pack.packVersion = "1.0.1"; }],
      ["pack profile link", (value) => { value.pack.rulesProfileId = "rules-other"; }],
      ["race pack link", (value) => { value.race.reference.packId = "pack-other"; }],
      ["race kind", (value) => { value.race.reference.kind = "class"; }],
      ["background definition", (value) => { value.background.reference.definitionId = "background-other"; }],
      ["class version link", (value) => { value.class.reference.packVersion = "2"; }],
      ["class level", (value) => { value.class.level = 2; }],
    ];
    for (const [, mutate] of mutations) {
      const changed = structuredClone(starter) as unknown as Record<string, any>;
      mutate(changed);
      expect(campaignCharacterBasicStarterMetadataSchema.safeParse(changed).success).toBe(false);
    }

    const incomplete = structuredClone(starter) as Record<string, any>;
    delete incomplete.race.reference.packVersion;
    expect(campaignCharacterBasicStarterMetadataSchema.safeParse(incomplete).success).toBe(false);
    expect(campaignCharacterBasicStarterMetadataSchema.safeParse({ ...starter, mechanics: {} }).success).toBe(false);
    expect(campaignCharacterBasicStarterMetadataSchema.safeParse({
      ...starter,
      race: { ...starter.race, reference: { ...starter.race.reference, path: "/rules/race" } },
    }).success).toBe(false);
  });

  it("accepts opaque persona IDs unchanged in strict safe option summaries", () => {
    const response = {
      campaignId: "campaign-one",
      personas: [
        { characterId: " persona/with spaces?and=query ", name: "Aster", alreadyUsed: false },
        { characterId: "opaque\nlegacy", name: "Briar", alreadyUsed: true },
      ],
      starter,
    };
    expect(campaignCharacterCreationOptionsResponseSchema.parse(response)).toEqual(response);
    expect(Object.keys(campaignCharacterCreationOptionsResponseSchema.shape)).toEqual([
      "campaignId", "personas", "starter",
    ]);
  });

  it("rejects blank persona names without normalizing supported names", () => {
    const response = {
      campaignId: "campaign-one",
      personas: [{ characterId: "persona-one", name: "  Aster  ", alreadyUsed: false }],
      starter,
    };
    expect(campaignCharacterCreationOptionsResponseSchema.parse(response)).toEqual(response);
    for (const name of ["", " ".repeat(200), "\t\n"]) {
      expect(campaignCharacterCreationOptionsResponseSchema.safeParse({
        ...response,
        personas: [{ ...response.personas[0], name }],
      }).success).toBe(false);
    }
  });

  it("requires well-formed UTF-16 names in every strict safe persona output", () => {
    const astralName = "Valid \u{1F9D9} persona";
    const loneSurrogates = ["Malformed \ud800 marker", "Malformed \udc00 marker"];
    const optionsResponse = {
      campaignId: "campaign-one",
      personas: [{ characterId: "persona-one", name: astralName, alreadyUsed: false }],
      starter,
    };
    const listResponse = { characters: [{ ...summary, name: astralName }] };
    const createResponse = { character: { ...summary, name: astralName } };
    expect(campaignCharacterCreationOptionsResponseSchema.parse(optionsResponse)).toEqual(optionsResponse);
    expect(campaignCharacterListResponseSchema.parse(listResponse)).toEqual(listResponse);
    expect(campaignCharacterCreateResponseSchema.parse(createResponse)).toEqual(createResponse);
    for (const name of loneSurrogates) {
      expect(campaignCharacterCreationOptionsResponseSchema.safeParse({
        ...optionsResponse, personas: [{ ...optionsResponse.personas[0], name }],
      }).success).toBe(false);
      expect(campaignCharacterListResponseSchema.safeParse({
        characters: [{ ...summary, name }],
      }).success).toBe(false);
      expect(campaignCharacterCreateResponseSchema.safeParse({
        character: { ...summary, name },
      }).success).toBe(false);
    }
  });

  it("rejects duplicate personas with a precise issue path", () => {
    const result = campaignCharacterCreationOptionsResponseSchema.safeParse({
      campaignId: "campaign-one",
      personas: [
        { characterId: "same", name: "Aster", alreadyUsed: false },
        { characterId: "same", name: "Other display name", alreadyUsed: true },
      ],
      starter,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["personas", 1, "characterId"] }));
  });

  it("bounds creation-option personas and rejects unknown or unsafe legacy fields", () => {
    const personas = Array.from({ length: MAX_CAMPAIGN_CHARACTER_PERSONAS }, (_, index) => ({
      characterId: `persona-${index}`,
      name: `Persona ${index}`,
      alreadyUsed: false,
    }));
    expect(campaignCharacterCreationOptionsResponseSchema.safeParse({ campaignId: "campaign-one", personas, starter }).success)
      .toBe(true);
    expect(campaignCharacterCreationOptionsResponseSchema.safeParse({
      campaignId: "campaign-one",
      personas: [...personas, { characterId: "overflow", name: "Overflow", alreadyUsed: false }],
      starter,
    }).success).toBe(false);
    for (const privateField of ["age", "archetype", "boundaries", "isRealPerson", "createdAt"] as const) {
      expect(campaignCharacterCreationOptionsResponseSchema.safeParse({
        campaignId: "campaign-one",
        personas: [{ characterId: "persona-one", name: "Aster", alreadyUsed: false, [privateField]: "private" }],
        starter,
      }).success).toBe(false);
    }
    expect(campaignCharacterCreationOptionsResponseSchema.safeParse({
      campaignId: "campaign-one", personas: [], starter, controllerPrincipalId: "local-owner",
    }).success).toBe(false);
  });

  it("defines the minimum strict public roster summary and envelope", () => {
    expect(publicCampaignCharacterSummarySchema.parse(summary)).toEqual(summary);
    expect(campaignCharacterListResponseSchema.parse({ characters: [summary] })).toEqual({ characters: [summary] });
    expect(campaignCharacterListResponseSchema.parse({ characters: [] })).toEqual({ characters: [] });
    expect(Object.keys(publicCampaignCharacterSummarySchema.shape)).toEqual(["id", "characterId", "name"]);

    for (const privateField of [
      "campaignId", "controllerPrincipalId", "privateNotes", "sheet", "actor", "createdAt", "updatedAt", "raw",
    ] as const) {
      expect(publicCampaignCharacterSummarySchema.safeParse({ ...summary, [privateField]: "private" }).success).toBe(false);
    }
    expect(campaignCharacterListResponseSchema.safeParse({ characters: [summary], campaignId: "campaign-one" }).success)
      .toBe(false);
  });

  it("rejects duplicate roster aggregate and persona identities with precise paths", () => {
    const duplicateId = campaignCharacterListResponseSchema.safeParse({
      characters: [summary, { ...summary, characterId: "other-persona" }],
    });
    expect(duplicateId.success).toBe(false);
    if (!duplicateId.success) expect(duplicateId.error.issues).toContainEqual(expect.objectContaining({ path: ["characters", 1, "id"] }));

    const duplicatePersona = campaignCharacterListResponseSchema.safeParse({
      characters: [summary, { ...summary, id: "campaign-character-two" }],
    });
    expect(duplicatePersona.success).toBe(false);
    if (!duplicatePersona.success) {
      expect(duplicatePersona.error.issues)
        .toContainEqual(expect.objectContaining({ path: ["characters", 1, "characterId"] }));
    }
  });

  it("bounds the public roster", () => {
    const characters = Array.from({ length: MAX_CAMPAIGN_CHARACTER_ROSTER }, (_, index) => ({
      id: `campaign-character-${index}`,
      characterId: `persona-${index}`,
      name: `Persona ${index}`,
    }));
    expect(campaignCharacterListResponseSchema.safeParse({ characters }).success).toBe(true);
    expect(campaignCharacterListResponseSchema.safeParse({
      characters: [...characters, { id: "overflow", characterId: "overflow", name: "Overflow" }],
    }).success).toBe(false);
  });

  it("reduces creation input to exactly one opaque persona identity", () => {
    const request = { characterId: " persona/with spaces?and=query " };
    expect(campaignCharacterCreateRequestSchema.parse(request)).toEqual(request);
    for (const field of ["campaignId", "controllerPrincipalId", "race", "background", "classes", "privateNotes"] as const) {
      expect(campaignCharacterCreateRequestSchema.safeParse({ ...request, [field]: "spoof" }).success).toBe(false);
    }
    expect(campaignCharacterCreateRequestSchema.safeParse({ characterId: "" }).success).toBe(false);
    expect(campaignCharacterCreateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("reuses only the public summary in the strict creation response", () => {
    const response = { character: summary };
    expect(campaignCharacterCreateResponseSchema.parse(response)).toEqual(response);
    expect(campaignCharacterCreateResponseSchema.shape.character).toBe(publicCampaignCharacterSummarySchema);
    expect(campaignCharacterCreateResponseSchema.safeParse({
      character: { ...summary, campaignId: "campaign-one" },
    }).success).toBe(false);
    expect(campaignCharacterCreateResponseSchema.safeParse({
      character: { ...summary, controllerPrincipalId: "local-owner", privateNotes: "secret" },
    }).success).toBe(false);
    expect(campaignCharacterCreateResponseSchema.safeParse({ ...response, raw: {} }).success).toBe(false);
  });

  it("infers only the approved HTTP wire fields", () => {
    expectTypeOf<CampaignCharacterCreateRequest>().toEqualTypeOf<{ characterId: string }>();
    expectTypeOf<PublicCampaignCharacterSummary>().toEqualTypeOf<{
      id: string;
      characterId: string;
      name: string;
    }>();
    expectTypeOf<CampaignCharacterCreateResponse>().toEqualTypeOf<{
      character: PublicCampaignCharacterSummary;
    }>();
    expectTypeOf<CampaignCharacterListResponse>().toEqualTypeOf<{
      characters: PublicCampaignCharacterSummary[];
    }>();
    expectTypeOf<CampaignCharacterCreationOptionsResponse>().toMatchTypeOf<{
      campaignId: string;
      personas: Array<{ characterId: string; name: string; alreadyUsed: boolean }>;
      starter: CampaignCharacterBasicStarterMetadata;
    }>();
  });
});
