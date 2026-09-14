import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema } from "@velvet/contracts";
import { magicItemDefinitionFromCatalog } from "../src/repo/encounter/magicItem/index.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { magicWondrousNZ } from "../src/content/srdStarter/magicItems/wondrous-n-z.js";

const refs = createStarterReferences("1.6.0+test");
const items = magicWondrousNZ(refs);

describe("SRD 5.1 wondrous items N-Z", () => {
  it("parses every wondrous item against the item catalog schema", () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const parsed = itemCatalogDefinitionSchema.parse(item);
      expect(parsed.reference.definitionId).toBe(item.reference.definitionId);
    }
  });

  it("mints unique, namespaced item definitionIds", () => {
    const ids = items.map((item) => item.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:item:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tags every item as wondrous magic gear with mechanics.magic present", () => {
    for (const item of items) {
      const parsed = itemCatalogDefinitionSchema.parse(item);
      expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "magic-item", "wondrous"]));
      expect(parsed.mechanics.magic).toBeDefined();
      expect(parsed.mechanics.category).toBe("gear");
    }
  });

  it("adapts every item into a non-null encounter magic-item definition", () => {
    for (const item of items) {
      const adapted = magicItemDefinitionFromCatalog(item);
      expect(adapted).not.toBeNull();
      expect(adapted?.reference.definitionId).toBe(item.reference.definitionId);
    }
  });
});
