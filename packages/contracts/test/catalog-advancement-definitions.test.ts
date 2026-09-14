import { describe, expect, it } from "vitest";
import {
  REQUIRED_DEFINITION_KIND_COUNT,
  catalogDefinitionKindSchema,
  catalogDefinitionSchema,
  featCatalogDefinitionSchema,
  subclassCatalogDefinitionSchema,
} from "../src/index.js";

const pack = { packId: "velvet:advancement", packVersion: "1.0.0+123456789abc" } as const;
const ability = { ...pack, kind: "ability" as const, definitionId: "velvet:advancement:ability:beacon" };
const klass = { ...pack, kind: "class" as const, definitionId: "velvet:advancement:class:lantern" };
const feat = {
  reference: { ...pack, kind: "feat" as const, definitionId: "velvet:advancement:feat:tough" },
  name: "Tough", description: "A bounded feat definition.", tags: ["velvet:original"],
  mechanics: { abilityBonuses: { resolve: 2 }, grantedAbilityRefs: [ability] },
};
const subclass = {
  reference: { ...pack, kind: "subclass" as const, definitionId: "velvet:advancement:subclass:champion" },
  name: "Champion", description: "A bounded subclass definition.", tags: ["velvet:original"],
  mechanics: { classRef: klass, level: 3, abilityRefs: [ability], spellRefs: [] },
};

describe("advancement catalog definitions", () => {
  it("parses bounded feat and subclass definitions through the definition union", () => {
    expect(featCatalogDefinitionSchema.parse(feat)).toEqual(feat);
    expect(subclassCatalogDefinitionSchema.parse(subclass)).toEqual(subclass);
    expect(catalogDefinitionSchema.parse(feat)).toEqual(feat);
    expect(catalogDefinitionSchema.parse(subclass)).toEqual(subclass);
  });

  it("rejects unbounded mechanics and cross-kind references", () => {
    expect(() => featCatalogDefinitionSchema.parse({ ...feat, mechanics: { ...feat.mechanics, abilityBonuses: { resolve: 9 } } })).toThrow();
    expect(() => featCatalogDefinitionSchema.parse({ ...feat, mechanics: { grantedAbilityRefs: [klass] } })).toThrow();
    expect(() => subclassCatalogDefinitionSchema.parse({ ...subclass, mechanics: { ...subclass.mechanics, classRef: ability } })).toThrow();
    expect(() => subclassCatalogDefinitionSchema.parse({ ...subclass, mechanics: { ...subclass.mechanics, spellRefs: [ability] } })).toThrow();
    expect(() => subclassCatalogDefinitionSchema.parse({ ...subclass, mechanics: { ...subclass.mechanics, level: 21 } })).toThrow();
  });

  it("treats feat and subclass as optional kinds over the required set", () => {
    expect(REQUIRED_DEFINITION_KIND_COUNT).toBe(10);
    expect(catalogDefinitionKindSchema.options).toHaveLength(12);
    expect(catalogDefinitionKindSchema.options).toEqual(expect.arrayContaining(["feat", "subclass"]));
  });
});
