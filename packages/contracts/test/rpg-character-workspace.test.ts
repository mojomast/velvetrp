import { describe, expect, it } from "vitest";
import {
  campaignCharacterWorkspaceResponseSchema,
  MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES,
  MAX_CHARACTER_ATTRIBUTES,
  MAX_CHARACTER_CHOICES,
  MAX_CHARACTER_CLASSES,
  MAX_CHARACTER_LEVEL,
  MAX_CHARACTER_PROFICIENCIES,
} from "../src/index.js";

const workspaceResponse = () => ({
  character: {
    name: "Mira Vale",
    race: { name: "Riverfolk", description: "Adaptable people of the river valleys." },
    background: { name: "Wayfinder", description: "A practiced reader of roads and weather." },
    classes: [{ name: "Warden", description: "A steadfast protector.", level: 3 }],
    attributes: [{ label: "Attribute 1", value: 12 }],
    proficiencies: [{ category: "skill", label: "Skill proficiency 1" }],
    choices: [{
      label: "Choice 1",
      selection: { kind: "ability", name: "Steady Hand", description: "Remain composed under pressure." },
    }],
    resources: [{ label: "Resource 1", current: 7, max: 10 }],
  },
});

const many = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describe("Slice 90 campaign-character workspace contracts", () => {
  it("accepts the complete ID-free projection and preserves ordered arrays", () => {
    const response = workspaceResponse();
    expect(campaignCharacterWorkspaceResponseSchema.parse(response)).toEqual(response);

    const empty = workspaceResponse();
    empty.character.classes = [];
    empty.character.attributes = [];
    empty.character.proficiencies = [];
    empty.character.choices = [];
    empty.character.resources = [];
    expect(campaignCharacterWorkspaceResponseSchema.parse(empty)).toEqual(empty);
  });

  it("requires every field, including every possibly empty array", () => {
    const fields = ["name", "race", "background", "classes", "attributes", "proficiencies", "choices", "resources"];
    for (const field of fields) {
      const response = workspaceResponse() as { character: Record<string, unknown> };
      delete response.character[field];
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(response).success, field).toBe(false);
    }
  });

  it("rejects unknown, identity, reference, timestamp, and private fields at every nesting layer", () => {
    const additions: Array<(value: ReturnType<typeof workspaceResponse>) => void> = [
      (value) => Object.assign(value, { campaignId: "campaign-one" }),
      (value) => Object.assign(value, { personaId: "persona-one" }),
      (value) => Object.assign(value.character, { id: "campaign-character-one" }),
      (value) => Object.assign(value.character, { characterId: "persona-one" }),
      (value) => Object.assign(value.character, { campaign: {} }),
      (value) => Object.assign(value.character, { persona: {} }),
      (value) => Object.assign(value.character, { sheet: {} }),
      (value) => Object.assign(value.character, { sheetId: "sheet-one" }),
      (value) => Object.assign(value.character, { actor: {} }),
      (value) => Object.assign(value.character, { actorId: "actor-one" }),
      (value) => Object.assign(value.character, { controllerPrincipalId: "principal-one" }),
      (value) => Object.assign(value.character, { controller: "local-owner" }),
      (value) => Object.assign(value.character, { packId: "pack-one" }),
      (value) => Object.assign(value.character, { reference: {} }),
      (value) => Object.assign(value.character, { privateNotes: "secret" }),
      (value) => Object.assign(value.character, { createdAt: "2030-04-05T06:07:08.009Z" }),
      (value) => Object.assign(value.character, { timestamp: "2030-04-05T06:07:08.009Z" }),
      (value) => Object.assign(value.character.race, { definitionId: "race-one" }),
      (value) => Object.assign(value.character.background, { reference: { packId: "pack-one" } }),
      (value) => Object.assign(value.character.classes[0]!, { classId: "class-one" }),
      (value) => Object.assign(value.character.attributes[0]!, { attributeId: "resolve" }),
      (value) => Object.assign(value.character.proficiencies[0]!, { proficiencyId: "navigation" }),
      (value) => Object.assign(value.character.choices[0]!, { choiceId: "first-discipline" }),
      (value) => Object.assign(value.character.choices[0]!.selection, { packVersion: "1.0.0" }),
      (value) => Object.assign(value.character.resources[0]!, { actorId: "actor-one" }),
    ];

    additions.forEach((add, index) => {
      const value = workspaceResponse();
      add(value);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success, `addition ${index}`).toBe(false);
    });
  });

  it("enforces established string bounds, nonblank text, and valid definition kinds", () => {
    const textCases: Array<(value: ReturnType<typeof workspaceResponse>, text: string) => void> = [
      (value, text) => { value.character.name = text; },
      (value, text) => { value.character.race.name = text; },
      (value, text) => { value.character.race.description = text; },
      (value, text) => { value.character.background.name = text; },
      (value, text) => { value.character.classes[0]!.name = text; },
      (value, text) => { value.character.classes[0]!.description = text; },
      (value, text) => { value.character.attributes[0]!.label = text; },
      (value, text) => { value.character.proficiencies[0]!.label = text; },
      (value, text) => { value.character.choices[0]!.label = text; },
      (value, text) => { value.character.choices[0]!.selection.name = text; },
      (value, text) => { value.character.choices[0]!.selection.description = text; },
      (value, text) => { value.character.resources[0]!.label = text; },
    ];
    for (const setText of textCases) {
      for (const invalid of ["", " \n\t "]) {
        const value = workspaceResponse();
        setText(value, invalid);
        expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success).toBe(false);
      }
    }

    const longName = workspaceResponse();
    longName.character.race.name = "n".repeat(201);
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(longName).success).toBe(false);
    const longDescription = workspaceResponse();
    longDescription.character.race.description = "d".repeat(4_001);
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(longDescription).success).toBe(false);
    const badKind = workspaceResponse() as unknown as { character: { choices: Array<{ selection: { kind: string } }> } };
    badKind.character.choices[0]!.selection.kind = "controller";
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(badKind).success).toBe(false);
  });

  it.each(["\ud800", "\udc00", "before\ud800after", "\ud800\ud800", "\udc00\udc00"])(
    "rejects malformed UTF-16 in every display-text position %#",
    (malformed) => {
      const setters: Array<(value: ReturnType<typeof workspaceResponse>) => void> = [
        (value) => { value.character.name = malformed; },
        (value) => { value.character.race.name = malformed; },
        (value) => { value.character.race.description = malformed; },
        (value) => { value.character.background.name = malformed; },
        (value) => { value.character.background.description = malformed; },
        (value) => { value.character.classes[0]!.name = malformed; },
        (value) => { value.character.classes[0]!.description = malformed; },
        (value) => { value.character.attributes[0]!.label = malformed; },
        (value) => { value.character.proficiencies[0]!.label = malformed; },
        (value) => { value.character.choices[0]!.label = malformed; },
        (value) => { value.character.choices[0]!.selection.name = malformed; },
        (value) => { value.character.choices[0]!.selection.description = malformed; },
        (value) => { value.character.resources[0]!.label = malformed; },
      ];
      for (const setMalformed of setters) {
        const value = workspaceResponse();
        setMalformed(value);
        expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success).toBe(false);
      }
    },
  );

  it("accepts valid astral text and applies trimmed content presentation", () => {
    const value = workspaceResponse();
    value.character.name = "Mira \u{1F9ED}";
    value.character.race.name = "  Starborn \u{1F31F}  ";
    value.character.race.description = "  Born beneath a wandering star. \u{1F31F}  ";
    const parsed = campaignCharacterWorkspaceResponseSchema.parse(value);
    expect(parsed.character.name).toBe("Mira \u{1F9ED}");
    expect(parsed.character.race.name).toBe("Starborn \u{1F31F}");
    expect(parsed.character.race.description).toBe("Born beneath a wandering star. \u{1F31F}");
  });

  it("enforces array maxima while accepting every exact maximum", () => {
    const exact = workspaceResponse();
    exact.character.classes = many(MAX_CHARACTER_CLASSES, (index) => ({ name: `Class ${index}`, description: "Class.", level: 1 }));
    exact.character.attributes = many(MAX_CHARACTER_ATTRIBUTES, (index) => ({ label: `Attribute ${index + 1}`, value: 0 }));
    exact.character.proficiencies = many(MAX_CHARACTER_PROFICIENCIES, (index) => ({ category: "skill" as const, label: `Skill proficiency ${index + 1}` }));
    exact.character.choices = many(MAX_CHARACTER_CHOICES, (index) => ({
      label: `Choice ${index + 1}`,
      selection: { kind: "ability" as const, name: `Ability ${index}`, description: "Ability." },
    }));
    exact.character.resources = many(MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES, (index) => ({ label: `Resource ${index + 1}`, current: 0, max: 0 }));
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(exact).success).toBe(true);

    for (const field of ["classes", "attributes", "proficiencies", "choices", "resources"] as const) {
      const over = structuredClone(exact);
      over.character[field].push(structuredClone(over.character[field][0]!) as never);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(over).success, field).toBe(false);
    }
  });

  it("enforces integer, level, attribute, category, and resource invariants and types", () => {
    const mutations: Array<(value: ReturnType<typeof workspaceResponse>) => void> = [
      (value) => { value.character.classes[0]!.level = 0; },
      (value) => { value.character.classes[0]!.level = MAX_CHARACTER_LEVEL + 1; },
      (value) => { value.character.classes[0]!.level = 1.5; },
      (value) => { value.character.attributes[0]!.value = -1_001; },
      (value) => { value.character.attributes[0]!.value = 1_001; },
      (value) => { value.character.attributes[0]!.value = 1.5; },
      (value) => { (value.character.proficiencies[0] as { category: string }).category = "unknown"; },
      (value) => { value.character.resources[0]!.current = -1; },
      (value) => { value.character.resources[0]!.max = 1_000_001; },
      (value) => { value.character.resources[0]!.current = 1.5; },
      (value) => { value.character.resources[0]!.current = 11; },
      (value) => { value.character.resources[0]!.max = Number.POSITIVE_INFINITY; },
      (value) => { value.character.attributes[0]!.value = Number.NaN; },
      (value) => { (value.character.resources[0] as unknown as { current: string }).current = "7"; },
    ];
    mutations.forEach((mutate, index) => {
      const value = workspaceResponse();
      mutate(value);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success, `mutation ${index}`).toBe(false);
    });
    const zero = workspaceResponse();
    zero.character.resources[0] = { label: "Resource 1", current: 0, max: 0 };
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(zero).success).toBe(true);
  });

  it("rejects wrong primitive and container types without coercion", () => {
    const mutations: Array<(value: unknown) => void> = [
      (value) => { (value as { character: unknown }).character = []; },
      (value) => { (value as { character: { name: unknown } }).character.name = 1; },
      (value) => { (value as { character: { race: unknown } }).character.race = "Riverfolk"; },
      (value) => { (value as { character: { background: unknown } }).character.background = null; },
      (value) => { (value as { character: { classes: unknown } }).character.classes = {}; },
      (value) => { (value as { character: { attributes: unknown } }).character.attributes = "Resolve"; },
      (value) => { (value as { character: { proficiencies: unknown } }).character.proficiencies = false; },
      (value) => { (value as { character: { choices: unknown } }).character.choices = null; },
      (value) => { (value as { character: { resources: unknown } }).character.resources = 0; },
      (value) => {
        (value as { character: { choices: Array<{ selection: unknown }> } }).character.choices[0]!.selection = "ability";
      },
    ];
    mutations.forEach((mutate, index) => {
      const value: unknown = workspaceResponse();
      mutate(value);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success, `type ${index}`).toBe(false);
    });
  });

  it("rejects exact normalized duplicate display identities but preserves meaningful distinctions", () => {
    const duplicateMutations: Array<(value: ReturnType<typeof workspaceResponse>) => void> = [
      (value) => { value.character.classes.push({ ...value.character.classes[0]! }); },
      (value) => { value.character.attributes.push({ ...value.character.attributes[0]! }); },
      (value) => { value.character.proficiencies.push({ ...value.character.proficiencies[0]! }); },
      (value) => { value.character.choices.push(structuredClone(value.character.choices[0]!)); },
      (value) => { value.character.resources.push({ ...value.character.resources[0]! }); },
      (value) => { value.character.resources.push({ ...value.character.resources[0]! }); },
    ];
    duplicateMutations.forEach((mutate) => {
      const value = workspaceResponse();
      mutate(value);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success).toBe(false);
    });

    const distinct = workspaceResponse();
    distinct.character.classes.push({ name: "warden", description: "A different presentation.", level: 3 });
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(distinct).success).toBe(true);
  });

  it("rejects colon, UUID, and resource-looking IDs in every label field", () => {
    const setters: Array<(value: ReturnType<typeof workspaceResponse>, label: string) => void> = [
      (value, label) => { value.character.attributes[0]!.label = label; },
      (value, label) => { value.character.proficiencies[0]!.label = label; },
      (value, label) => { value.character.choices[0]!.label = label; },
      (value, label) => { value.character.resources[0]!.label = label; },
    ];
    for (const setLabel of setters) {
      for (const id of ["attribute:resolve", "550e8400-e29b-41d4-a716-446655440000", "resource_unknown-1.test"]) {
        const value = workspaceResponse();
        setLabel(value, id);
        expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success, id).toBe(false);
      }
    }
  });

  it("accepts exact category-specific positional fallbacks for generic unknown IDs", () => {
    const value = workspaceResponse();
    value.character.attributes = many(MAX_CHARACTER_ATTRIBUTES, (index) => ({ label: `Attribute ${index + 1}`, value: 0 }));
    value.character.proficiencies = ([
      ["skill", "Skill"],
      ["saving-throw", "Saving throw"],
      ["tool", "Tool"],
      ["weapon", "Weapon"],
      ["armor", "Armor"],
      ["language", "Language"],
    ] as const).map(([category, prefix], index) => ({ category, label: `${prefix} proficiency ${index + 1}` }));
    value.character.choices = many(MAX_CHARACTER_CHOICES, (index) => ({
      label: `Choice ${index + 1}`,
      selection: { kind: "ability" as const, name: `Unknown selection ${index + 1}`, description: "Content metadata." },
    }));
    value.character.resources = many(MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES, (index) => ({
      label: `Resource ${index + 1}`,
      current: 0,
      max: 0,
    }));
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success).toBe(true);
  });

  it("rejects wrong prefixes, categories, positions, zero, and out-of-range indices", () => {
    const mutations: Array<(value: ReturnType<typeof workspaceResponse>) => void> = [
      (value) => { value.character.attributes[0]!.label = "Choice 1"; },
      (value) => { value.character.attributes[0]!.label = "Attribute 0"; },
      (value) => { value.character.attributes[0]!.label = `Attribute ${MAX_CHARACTER_ATTRIBUTES + 1}`; },
      (value) => { value.character.attributes[0]!.label = "Attribute 2"; },
      (value) => { value.character.proficiencies[0]!.label = "Language proficiency 1"; },
      (value) => { value.character.proficiencies[0]!.label = "Skill proficiency 0"; },
      (value) => { value.character.proficiencies[0]!.label = `Skill proficiency ${MAX_CHARACTER_PROFICIENCIES + 1}`; },
      (value) => { value.character.proficiencies[0]!.label = "Skill proficiency 2"; },
      (value) => { value.character.choices[0]!.label = "Choice 0"; },
      (value) => { value.character.choices[0]!.label = `Choice ${MAX_CHARACTER_CHOICES + 1}`; },
      (value) => { value.character.resources[0]!.label = "Resource 0"; },
      (value) => { value.character.resources[0]!.label = `Resource ${MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES + 1}`; },
    ];
    mutations.forEach((mutate, index) => {
      const value = workspaceResponse();
      mutate(value);
      expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success, `mutation ${index}`).toBe(false);
    });
  });

  it("keeps class, race, background, and selection names as content metadata", () => {
    const value = workspaceResponse();
    value.character.race.name = "race:unknown";
    value.character.background.name = "550e8400-e29b-41d4-a716-446655440000";
    value.character.classes[0]!.name = "class_unknown-1.test";
    value.character.choices[0]!.selection.name = "ability:unknown";
    expect(campaignCharacterWorkspaceResponseSchema.safeParse(value).success).toBe(true);
  });
});
