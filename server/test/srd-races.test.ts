import { describe, expect, it } from "vitest";
import {
  abilityCatalogDefinitionSchema,
  raceCatalogDefinitionSchema,
  SRD_5_1_STARTER_IDENTITY,
} from "@velvet/contracts";
import { buildAbilities } from "../src/content/srdStarter/abilities.js";
import { buildRaces } from "../src/content/srdStarter/races.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences(SRD_5_1_STARTER_IDENTITY.packVersion);
const races = buildRaces(refs);
const abilities = buildAbilities(refs);

const referenceKey = (reference: { packId: string; packVersion: string; kind: string; definitionId: string }) =>
  `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;

describe("SRD 5.1 races", () => {
  it("builds the complete nine-race SRD 5.1 list", () => {
    expect(races).toHaveLength(9);
    expect(races.map((race) => race.name)).toEqual([
      "Human", "Dwarf", "Elf", "Halfling", "Dragonborn", "Gnome", "Half-Orc", "Half-Elf", "Tiefling",
    ]);
    expect(races.map((race) => race.reference.definitionId)).toEqual([
      "srd-5.1:race:human", "srd-5.1:race:dwarf", "srd-5.1:race:elf", "srd-5.1:race:halfling",
      "srd-5.1:race:dragonborn", "srd-5.1:race:gnome", "srd-5.1:race:half-orc", "srd-5.1:race:half-elf",
      "srd-5.1:race:tiefling",
    ]);
  });

  it("defines the Half-Elf with SRD 5.1 mechanics", () => {
    const halfElf = raceCatalogDefinitionSchema.parse(races.find((race) => race.name === "Half-Elf")!);
    expect(halfElf.reference).toMatchObject({ kind: "race", definitionId: "srd-5.1:race:half-elf" });
    expect(halfElf.mechanics).toMatchObject({
      size: "Medium",
      speed: 30,
      attributeBonuses: { charisma: 2 },
      languages: ["Common", "Elvish", "one language of choice"],
      proficiencies: [],
      damageResistances: [],
      senses: [{ kind: "darkvision", rangeFeet: 60 }],
    });
    expect(halfElf.tags).toEqual(expect.arrayContaining(["srd-5.1", "metadata-only"]));
  });

  it("defines the Tiefling with SRD 5.1 mechanics", () => {
    const tiefling = raceCatalogDefinitionSchema.parse(races.find((race) => race.name === "Tiefling")!);
    expect(tiefling.reference).toMatchObject({ kind: "race", definitionId: "srd-5.1:race:tiefling" });
    expect(tiefling.mechanics).toMatchObject({
      size: "Medium",
      speed: 30,
      attributeBonuses: { charisma: 2, intelligence: 1 },
      languages: ["Common", "Infernal"],
      proficiencies: [],
      damageResistances: ["fire"],
      senses: [{ kind: "darkvision", rangeFeet: 60 }],
    });
    expect(tiefling.tags).toEqual(expect.arrayContaining(["srd-5.1", "metadata-only"]));
  });

  it("resolves every racial trait reference to an ability in the same pack", () => {
    const abilityKeys = new Set(abilities.map((ability) => referenceKey(ability.reference)));
    const ruleKeys = new Set(abilities.map((ability) => `${ability.reference.kind}:${ability.reference.definitionId}`));
    for (const race of races) {
      for (const trait of race.mechanics.abilityRefs) {
        expect(abilityKeys.has(referenceKey(trait)), `${race.name} -> ${trait.definitionId}`).toBe(true);
        expect(ruleKeys.has(`${trait.kind}:${trait.definitionId}`), `${race.name} -> ${trait.definitionId}`).toBe(true);
      }
    }
  });

  it("registers the new Half-Elf and Tiefling trait abilities", () => {
    const abilityIds = new Set(abilities.map((ability) => ability.reference.definitionId));
    expect([...abilityIds]).toEqual(expect.arrayContaining([
      "srd-5.1:ability:half-elf-fey-ancestry",
      "srd-5.1:ability:half-elf-skill-versatility",
      "srd-5.1:ability:half-elf-darkvision",
      "srd-5.1:ability:tiefling-hellish-resistance",
      "srd-5.1:ability:tiefling-infernal-legacy",
      "srd-5.1:ability:tiefling-darkvision",
    ]));
    const halfElf = races.find((race) => race.name === "Half-Elf")!;
    const tiefling = races.find((race) => race.name === "Tiefling")!;
    const traitIds = [...halfElf.mechanics.abilityRefs, ...tiefling.mechanics.abilityRefs].map((trait) => trait.definitionId);
    for (const definitionId of traitIds) {
      const ability = abilities.find((entry) => entry.reference.definitionId === definitionId);
      expect(ability, definitionId).toBeDefined();
      abilityCatalogDefinitionSchema.parse(ability);
      expect(ability!.tags).toEqual(expect.arrayContaining(["srd-5.1", "ancestry-trait"]));
    }
  });
});
