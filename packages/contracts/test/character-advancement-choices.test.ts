import { describe, expect, it } from "vitest";
import {
  abilityProgressionChoiceSchema,
  abilityScoreIncreaseProgressionChoiceSchema,
  classLevelCatalogDefinitionSchema,
  classLevelProgressionChoiceSchema,
  classProgressionChoiceSchema,
  featProgressionChoiceSchema,
  progressionPendingChoiceSchema,
  progressionSelectionSchema,
  subclassProgressionChoiceSchema,
} from "../src/index.js";

const pack = { packId: "velvet:advancement", packVersion: "1.0.0+123456789abc" } as const;
const ability = (definitionId: string) => ({ ...pack, kind: "ability" as const, definitionId });
const score = (definitionId: string) => ({ ...pack, kind: "ability-score" as const, definitionId });
const feat = (definitionId: string) => ({ ...pack, kind: "feat" as const, definitionId });
const subclass = (definitionId: string) => ({ ...pack, kind: "subclass" as const, definitionId });
const base = { required: true, count: 1 } as const;

describe("generalized class-level progression choices", () => {
  it("keeps the ability variant byte-compatible", () => {
    const choice = { choiceId: "velvet:choice:discipline", kind: "ability", ...base, options: [ability("beacon"), ability("bulwark")] };
    expect(abilityProgressionChoiceSchema.parse(choice)).toEqual(choice);
    expect(classLevelProgressionChoiceSchema.parse(choice)).toEqual(choice);
    expect(() => abilityProgressionChoiceSchema.parse({ ...choice, extra: true })).toThrow();
    expect(() => abilityProgressionChoiceSchema.parse({ ...choice, options: [ability("beacon")] })).toThrow();
    expect(() => abilityProgressionChoiceSchema.parse({ ...choice, options: [ability("a"), ability("a")] })).toThrow(/unique/);
    expect(() => abilityProgressionChoiceSchema.parse({ ...choice, options: [ability("a"), feat("f")] })).toThrow();
  });

  it("accepts a bounded ability-score-increase distribution", () => {
    const choice = { choiceId: "velvet:choice:asi", kind: "ability-score-increase", ...base, points: 2,
      scores: ["strength", "dexterity"], options: [] };
    expect(classLevelProgressionChoiceSchema.parse(choice)).toEqual(choice);
    expect(abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, scores: ["strength"] }).scores).toEqual(["strength"]);
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, points: 3 })).toThrow();
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, points: 0 })).toThrow();
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, scores: [] })).toThrow();
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, scores: ["luck" as never] })).toThrow();
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, scores: ["strength", "strength"] })).toThrow(/unique/);
    expect(() => abilityScoreIncreaseProgressionChoiceSchema.parse({ ...choice, options: [score("strength")] })).toThrow();
  });

  it("accepts feat and subclass catalog references and rejects cross-kind options", () => {
    const featChoice = { choiceId: "velvet:choice:feat", kind: "feat", ...base, options: [feat("grappler"), feat("tough")] };
    const subclassChoice = { choiceId: "velvet:choice:subclass", kind: "subclass", ...base, options: [subclass("champion")] };
    expect(featProgressionChoiceSchema.parse(featChoice)).toEqual(featChoice);
    expect(subclassProgressionChoiceSchema.parse(subclassChoice)).toEqual(subclassChoice);
    expect(classLevelProgressionChoiceSchema.parse(featChoice)).toEqual(featChoice);
    expect(classLevelProgressionChoiceSchema.parse(subclassChoice)).toEqual(subclassChoice);
    expect(() => featProgressionChoiceSchema.parse({ ...featChoice, options: [ability("beacon")] })).toThrow();
    expect(() => subclassProgressionChoiceSchema.parse({ ...subclassChoice, options: [feat("tough")] })).toThrow();
  });

  it("accepts bounded class choices without changing existing variants", () => {
    const classRef = (definitionId: string) => ({ ...pack, kind: "class" as const, definitionId });
    const choice = { choiceId: "velvet:choice:class", kind: "class", ...base, options: [classRef("wizard"), classRef("cleric")] };
    expect(classProgressionChoiceSchema.parse(choice)).toEqual(choice);
    expect(classLevelProgressionChoiceSchema.parse(choice)).toEqual(choice);
    expect(() => classProgressionChoiceSchema.parse({ ...choice, options: [] })).toThrow();
    expect(() => classProgressionChoiceSchema.parse({ ...choice, options: [ability("beacon")] })).toThrow();
    expect(() => classProgressionChoiceSchema.parse({ ...choice, options: [classRef("wizard"), classRef("wizard")] })).toThrow(/unique/);
  });

  it("rejects an unknown choice kind", () => {
    expect(() => classLevelProgressionChoiceSchema.parse({ choiceId: "velvet:choice:bad", kind: "epic-boon", ...base, options: [feat("tough")] })).toThrow();
  });

  it("integrates generalized choices into an exact class-level definition", () => {
    const classLevel = {
      reference: { ...pack, kind: "class-level", definitionId: "velvet:advancement:class-level:lantern-4" },
      name: "Lantern Warden Level 4",
      description: "A bounded generalized advancement level.",
      tags: ["velvet:original"],
      mechanics: {
        classRef: { ...pack, kind: "class", definitionId: "velvet:advancement:class:lantern-warden" },
        level: 4,
        proficiencyBonus: 2,
        hpGain: 6,
        abilityRefs: [],
        spellRefs: [],
        progressionChoices: [
          { choiceId: "velvet:choice:asi", kind: "ability-score-increase", ...base, points: 2, scores: ["strength", "dexterity"], options: [] },
          { choiceId: "velvet:choice:feat", kind: "feat", ...base, options: [feat("tough")] },
        ],
      },
    };
    expect(classLevelCatalogDefinitionSchema.parse(classLevel)).toEqual(classLevel);
  });
});

describe("generalized pending choices", () => {
  it("keeps the ability pending choice byte-compatible", () => {
    const pending = { level: 2, choiceId: "velvet:choice:discipline", kind: "ability", required: true, options: [ability("beacon"), ability("bulwark")] };
    expect(progressionPendingChoiceSchema.parse(pending)).toEqual(pending);
    expect(() => progressionPendingChoiceSchema.parse({ ...pending, kind: "unknown" })).toThrow();
  });

  it("parses every added pending variant and rejects malformed options", () => {
    expect(progressionPendingChoiceSchema.parse({ level: 4, choiceId: "asi", kind: "ability-score-increase", required: true, points: 1, options: [score("strength")] })).toMatchObject({ kind: "ability-score-increase" });
    expect(progressionPendingChoiceSchema.parse({ level: 4, choiceId: "feat", kind: "feat", required: true, options: [feat("tough")] })).toMatchObject({ kind: "feat" });
    expect(progressionPendingChoiceSchema.parse({ level: 3, choiceId: "subclass", kind: "subclass", required: true, options: [subclass("champion")] })).toMatchObject({ kind: "subclass" });
    expect(progressionPendingChoiceSchema.parse({ level: 2, choiceId: "class", kind: "class", required: true,
      options: [{ ...pack, kind: "class", definitionId: "wizard" }] })).toMatchObject({ kind: "class" });
    expect(() => progressionPendingChoiceSchema.parse({ level: 4, choiceId: "feat", kind: "feat", required: true, options: [ability("beacon")] })).toThrow();
    expect(() => progressionPendingChoiceSchema.parse({ level: 1, choiceId: "feat", kind: "feat", required: true, options: [feat("tough")] })).toThrow();
    expect(() => progressionPendingChoiceSchema.parse({ level: 4, choiceId: "feat", kind: "feat", required: true, options: [feat("tough"), feat("tough")] })).toThrow(/unique/);
  });
});

describe("generalized selections", () => {
  it("keeps the legacy ability selection input shape byte-compatible", () => {
    const selection = { choiceId: "velvet:choice:discipline", ability: ability("beacon") };
    expect(progressionSelectionSchema.parse(selection)).toEqual({ ...selection, kind: "ability" });
  });

  it("parses added selection variants and rejects malformed input", () => {
    const increase = { choiceId: "asi", kind: "ability-score-increase", increases: [{ ability: score("strength"), amount: 2 }] };
    expect(progressionSelectionSchema.parse(increase)).toEqual(increase);
    expect(progressionSelectionSchema.parse({ choiceId: "asi", kind: "ability-score-increase", increases: [{ ability: score("strength"), amount: 1 }, { ability: score("dexterity"), amount: 1 }] })).toMatchObject({ kind: "ability-score-increase" });
    expect(progressionSelectionSchema.parse({ choiceId: "feat", kind: "feat", ability: feat("tough") })).toEqual({ choiceId: "feat", kind: "feat", ability: feat("tough") });
    expect(progressionSelectionSchema.parse({ choiceId: "subclass", kind: "subclass", ability: subclass("champion") })).toMatchObject({ kind: "subclass" });
    expect(progressionSelectionSchema.parse({ choiceId: "class", kind: "class", ability: { ...pack, kind: "class", definitionId: "cleric" } })).toMatchObject({ kind: "class" });
    expect(() => progressionSelectionSchema.parse({ ...increase, increases: [{ ability: score("strength"), amount: 3 }] })).toThrow();
    expect(() => progressionSelectionSchema.parse({ ...increase, increases: [{ ability: score("strength"), amount: 1 }, { ability: score("strength"), amount: 1 }] })).toThrow(/unique/);
    expect(() => progressionSelectionSchema.parse({ ...increase, increases: [] })).toThrow();
    expect(() => progressionSelectionSchema.parse({ choiceId: "feat", kind: "feat", ability: ability("beacon") })).toThrow();
    expect(() => progressionSelectionSchema.parse({ choiceId: "feat", kind: "feat" })).toThrow();
    expect(() => progressionSelectionSchema.parse({ ...increase, extra: true })).toThrow();
  });
});
