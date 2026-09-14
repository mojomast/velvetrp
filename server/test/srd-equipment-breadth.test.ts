import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema } from "@velvet/contracts";
import { buildItems } from "../src/content/srdStarter/items.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("srd-5.1-test");
const items = buildItems(refs);
const parsed = items.map((item) => itemCatalogDefinitionSchema.parse(item));
const definitionId = (item: (typeof items)[number]) => item.reference.definitionId;

const EXISTING_ORDER = [
  "longsword", "leather-armor", "chain-shirt", "chain-mail", "hide-armor", "scale-mail", "breastplate", "plate",
  "shield", "explorers-pack", "acolyte-equipment", "dagger", "club", "handaxe", "mace", "quarterstaff", "spear",
  "shortbow", "light-crossbow", "rapier", "battleaxe", "greatsword", "padded-armor", "studded-leather-armor",
  "splint", "ring-mail",
].map((id) => `srd-5.1:item:${id}`);

const REQUIRED_NEW_IDS = [
  "artisans-tools-alchemists", "artisans-tools-brewers", "artisans-tools-calligraphers", "artisans-tools-carpenters",
  "artisans-tools-cartographers", "artisans-tools-cobblers", "artisans-tools-cooks", "artisans-tools-glassblowers",
  "artisans-tools-jewelers", "artisans-tools-leatherworkers", "artisans-tools-masons", "artisans-tools-painters",
  "artisans-tools-potters", "artisans-tools-smiths", "artisans-tools-tinkers", "artisans-tools-weavers",
  "artisans-tools-woodcarvers", "disguise-kit", "forgery-kit", "gaming-set-dice", "gaming-set-dragonchess",
  "gaming-set-playing-cards", "gaming-set-three-dragon-ante", "herbalism-kit", "navigators-tools", "poisoners-kit",
  "thieves-tools", "vehicles-land", "vehicles-water", "arrows", "crossbow-bolts", "blowgun-needles", "sling-bullets",
  "rope-hempen", "rope-silk", "torch", "lantern-bullseye", "lantern-hooded", "oil-flask", "rations", "waterskin",
  "bedroll", "backpack", "crowbar", "grappling-hook", "hunting-trap", "manacles", "riding-horse", "draft-horse",
  "pony", "mule", "donkey", "camel", "elephant", "warhorse", "mastiff", "carriage", "cart", "wagon", "rowboat",
  "sailing-ship", "barding-chain-mail",
].map((id) => `srd-5.1:item:${id}`);

type ExpectedDetail = {
  category: "weapon" | "armor" | "consumable" | "tool" | "gear";
  price: number;
  weight: number;
  profile: "weapon" | "armor" | "tool" | "ammunition" | null;
};

const EXPECTED_DETAILS: Array<[string, ExpectedDetail]> = [
  ["artisans-tools-alchemists", { category: "tool", price: 50, weight: 8, profile: "tool" }],
  ["thieves-tools", { category: "tool", price: 25, weight: 1, profile: "tool" }],
  ["disguise-kit", { category: "tool", price: 25, weight: 3, profile: "tool" }],
  ["forgery-kit", { category: "tool", price: 15, weight: 5, profile: "tool" }],
  ["herbalism-kit", { category: "tool", price: 5, weight: 3, profile: "tool" }],
  ["poisoners-kit", { category: "tool", price: 50, weight: 2, profile: "tool" }],
  ["navigators-tools", { category: "tool", price: 25, weight: 2, profile: "tool" }],
  ["vehicles-land", { category: "tool", price: 0, weight: 0, profile: "tool" }],
  ["arrows", { category: "gear", price: 1, weight: 1, profile: "ammunition" }],
  ["crossbow-bolts", { category: "gear", price: 1, weight: 1.5, profile: "ammunition" }],
  ["blowgun-needles", { category: "gear", price: 1, weight: 1, profile: "ammunition" }],
  ["sling-bullets", { category: "gear", price: 0, weight: 1.5, profile: "ammunition" }],
  ["backpack", { category: "gear", price: 2, weight: 5, profile: null }],
  ["bedroll", { category: "gear", price: 1, weight: 7, profile: null }],
  ["crowbar", { category: "gear", price: 2, weight: 5, profile: null }],
  ["grappling-hook", { category: "gear", price: 2, weight: 4, profile: null }],
  ["hunting-trap", { category: "gear", price: 5, weight: 25, profile: null }],
  ["manacles", { category: "gear", price: 2, weight: 6, profile: null }],
  ["rope-hempen", { category: "gear", price: 1, weight: 10, profile: null }],
  ["rope-silk", { category: "gear", price: 10, weight: 5, profile: null }],
  ["torch", { category: "gear", price: 0, weight: 1, profile: null }],
  ["lantern-bullseye", { category: "gear", price: 10, weight: 2, profile: null }],
  ["lantern-hooded", { category: "gear", price: 5, weight: 2, profile: null }],
  ["oil-flask", { category: "gear", price: 0, weight: 1, profile: null }],
  ["rations", { category: "gear", price: 0, weight: 2, profile: null }],
  ["waterskin", { category: "gear", price: 0, weight: 5, profile: null }],
  ["riding-horse", { category: "gear", price: 75, weight: 0, profile: null }],
  ["warhorse", { category: "gear", price: 400, weight: 0, profile: null }],
  ["carriage", { category: "gear", price: 100, weight: 0, profile: null }],
  ["rowboat", { category: "gear", price: 50, weight: 0, profile: null }],
  ["sailing-ship", { category: "gear", price: 10000, weight: 0, profile: null }],
  ["barding-chain-mail", { category: "gear", price: 300, weight: 110, profile: null }],
];

describe("SRD equipment breadth", () => {
  it("adds equipment without disturbing the existing weapon and armor prefix", () => {
    expect(items.length).toBeGreaterThan(EXISTING_ORDER.length + REQUIRED_NEW_IDS.length - 1);
    expect(items.slice(0, EXISTING_ORDER.length).map(definitionId)).toEqual(EXISTING_ORDER);
  });

  it("parses every mundane item against the item catalog schema", () => {
    for (const item of items) {
      expect(() => itemCatalogDefinitionSchema.parse(item)).not.toThrow();
    }
    expect(parsed).toHaveLength(items.length);
  });

  it("keeps every definition ID unique", () => {
    const ids = items.map(definitionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the required SRD 5.1 mundane equipment IDs", () => {
    const ids = new Set(items.map(definitionId));
    expect(REQUIRED_NEW_IDS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(EXPECTED_DETAILS)("represents %s with its category, price, weight, and profile", (id, expected) => {
    const item = parsed.find((entry) => entry.reference.definitionId === `srd-5.1:item:${id}`);
    expect(item).toBeDefined();
    expect(item!.mechanics.category).toBe(expected.category);
    expect(item!.mechanics.price.amount).toBe(expected.price);
    expect(item!.mechanics.engineDetails?.weightPounds).toBe(expected.weight);
    expect(item!.mechanics.engineDetails?.equipmentProfile?.kind ?? null).toBe(expected.profile);
  });

  it("uses the closed tool and ammunition profiles for the new equipment", () => {
    const tool = parsed.find((entry) => entry.reference.definitionId === "srd-5.1:item:thieves-tools")!;
    expect(tool.mechanics.engineDetails?.equipmentProfile).toEqual({ kind: "tool", proficiency: "Thieves' tools" });
    const ammo = parsed.find((entry) => entry.reference.definitionId === "srd-5.1:item:arrows")!;
    expect(ammo.mechanics.engineDetails?.equipmentProfile).toEqual({ kind: "ammunition", weaponCategory: "simple" });
  });

  it("adds breadth to every mundane category", () => {
    const counts = parsed.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.mechanics.category] = (accumulator[item.mechanics.category] ?? 0) + 1;
      return accumulator;
    }, {});
    expect(counts.weapon).toBeGreaterThanOrEqual(12);
    expect(counts.armor).toBeGreaterThanOrEqual(11);
    expect(counts.tool).toBeGreaterThanOrEqual(39);
    expect(counts.gear).toBeGreaterThanOrEqual(109);
  });
});
