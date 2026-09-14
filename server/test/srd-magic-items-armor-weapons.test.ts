import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema } from "@velvet/contracts";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { magicArmorWeapons } from "../src/content/srdStarter/magicItems/armor-weapons.js";
import { magicItemDefinitionFromCatalog } from "../src/repo/encounter/magicItem/index.js";

const refs = createStarterReferences("1.6.0+test");
const items = magicArmorWeapons(refs);

describe("SRD 5.1 magic armor, shields, and weapons", () => {
  it("parses every item against the catalog item schema", () => {
    for (const item of items) {
      expect(() => itemCatalogDefinitionSchema.parse(item)).not.toThrow();
    }
  });

  it("uses unique srd-5.1 item ids", () => {
    const ids = items.map((item) => item.reference.definitionId);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith("srd-5.1:item:")).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes magic mechanics on every item", () => {
    for (const item of items) {
      expect(item.mechanics.magic).toBeDefined();
    }
  });

  it("adapts every item through magicItemDefinitionFromCatalog", () => {
    for (const item of items) {
      expect(magicItemDefinitionFromCatalog(item)).not.toBeNull();
    }
  });
});
