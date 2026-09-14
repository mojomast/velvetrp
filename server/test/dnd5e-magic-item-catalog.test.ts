import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema } from "@velvet/contracts";
import {
  attuneItem,
  createAttunementState,
  magicItemDefinitionFromCatalog,
  planDerivedValues,
  planGrantedPowers,
} from "../src/repo/encounter/magicItem/index.js";

const AT = "2038-01-01T00:00:00.000Z";
const PACK = "srd-5.1";
const VERSION = "1.6.0+test";
const ref = (kind: string, definitionId: string) => ({ packId: PACK, packVersion: VERSION, kind, definitionId });

const ringOfProtection = itemCatalogDefinitionSchema.parse({
  reference: ref("item", "srd-5.1:item:ring-of-protection"),
  name: "Ring of Protection",
  description: "A magic ring that grants a bonus to armor class and saving throws while worn.",
  tags: ["srd-5.1", "magic-item"],
  mechanics: {
    category: "gear", stackable: false, slot: "accessory",
    price: { currency: ref("currency", "srd-5.1:currency:gp"), amount: 3500 }, effects: [],
    magic: {
      attunement: { prerequisite: "short-rest" }, charges: null,
      passiveModifiers: [{ modifier: { kind: "flat", amount: 1, target: { kind: "armor-class" } }, requireAttunement: true }],
      grantedPowers: [],
    },
  },
});

const wandOfMagicMissiles = itemCatalogDefinitionSchema.parse({
  reference: ref("item", "srd-5.1:item:wand-of-magic-missiles"),
  name: "Wand of Magic Missiles",
  description: "A wand that spends charges to cast magic missile.",
  tags: ["srd-5.1", "magic-item"],
  mechanics: {
    category: "gear", stackable: false, slot: "focus",
    price: { currency: ref("currency", "srd-5.1:currency:gp"), amount: 8000 }, effects: [],
    magic: {
      attunement: null, charges: { maximum: 7, recharge: { kind: "roll", dieSides: 20, minimum: 20, amount: 7 } },
      passiveModifiers: [],
      grantedPowers: [{
        key: "wand-magic-missile",
        power: ref("spell", "srd-5.1:spell:magic-missile"),
        requireAttunement: false, actionCost: "action", cost: 1,
      }],
    },
  },
});

const longsword = itemCatalogDefinitionSchema.parse({
  reference: ref("item", "srd-5.1:item:longsword"),
  name: "Longsword",
  description: "A mundane martial weapon.",
  tags: ["srd-5.1"],
  mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency: ref("currency", "srd-5.1:currency:gp"), amount: 15 }, effects: [] },
});

describe("catalog magic-item adapter", () => {
  it("returns null for mundane items", () => {
    expect(magicItemDefinitionFromCatalog(longsword)).toBeNull();
  });

  it("adapts a catalog magic item into an engine definition", () => {
    const adapted = magicItemDefinitionFromCatalog(ringOfProtection);
    expect(adapted).not.toBeNull();
    expect(adapted).toMatchObject({
      name: "Ring of Protection",
      attunement: { prerequisite: "short-rest" },
      reference: { packId: PACK, packVersion: VERSION, definitionId: "srd-5.1:item:ring-of-protection" },
    });
    expect(Object.isFrozen(adapted)).toBe(true);
  });

  it("drives attunement and derived values from a catalog definition", () => {
    const adapted = magicItemDefinitionFromCatalog(ringOfProtection)!;
    const attuned = attuneItem({ state: createAttunementState("actor-1"), key: "ring-1", definition: adapted,
      prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    expect(attuned.ok).toBe(true);
    if (!attuned.ok) return;
    const plan = planDerivedValues({ attunement: attuned.state, items: [{ key: "ring-1", definition: adapted, equipped: true }] });
    expect(plan.armorClass).toBe(1);
  });

  it("exposes catalog granted powers to the engine planner", () => {
    const adapted = magicItemDefinitionFromCatalog(wandOfMagicMissiles)!;
    expect(adapted.charges).toEqual({ maximum: 7, recharge: { kind: "roll", dieSides: 20, minimum: 20, amount: 7 } });
    const plans = planGrantedPowers({ attunement: createAttunementState("actor-1"), items: [{ key: "wand-1", definition: adapted, equipped: true }] });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ powerKey: "wand-magic-missile", chargeCost: 1, executed: false,
      power: { kind: "spell", definitionId: "srd-5.1:spell:magic-missile" } });
  });
});
