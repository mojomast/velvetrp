import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema } from "@velvet/contracts";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { magicWondrousAM } from "../src/content/srdStarter/magicItems/wondrous-a-m.js";
import { magicItemDefinitionFromCatalog } from "../src/repo/encounter/magicItem/index.js";

const refs = createStarterReferences("1.6.0+test");
const items = magicWondrousAM(refs);
const parsed = items.map((item) => itemCatalogDefinitionSchema.parse(item));

describe("SRD 5.1 wondrous items (A-M)", () => {
  it("parses every item against the catalog definition schema", () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(() => itemCatalogDefinitionSchema.parse(item)).not.toThrow();
  });

  it("uses unique definition ids prefixed for the starter pack", () => {
    const ids = parsed.map((definition) => definition.reference.definitionId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("srd-5.1:item:")).toBe(true);
  });

  it("carries magic-item mechanics and category tags on every definition", () => {
    for (const definition of parsed) {
      expect(definition.mechanics.magic).toBeDefined();
      expect(definition.mechanics.category).toBe("gear");
      expect(definition.tags).toContain("srd-5.1");
      expect(definition.tags).toContain("magic-item");
    }
  });

  it("adapts every definition into a non-null engine magic item", () => {
    for (const definition of parsed) {
      expect(magicItemDefinitionFromCatalog(definition)).not.toBeNull();
    }
  });
});
