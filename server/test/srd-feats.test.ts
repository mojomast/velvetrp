import { describe, expect, it } from "vitest";
import { featCatalogDefinitionSchema, SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { buildFeats } from "../src/content/srdStarter/feats.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences(SRD_5_1_STARTER_IDENTITY.packVersion);
const feats = buildFeats(refs);

const SRD_5_1_FEAT_IDS = [
  "srd-5.1:feat:grappler",
  "srd-5.1:feat:great-weapon-master",
  "srd-5.1:feat:sharpshooter",
  "srd-5.1:feat:sentinel",
  "srd-5.1:feat:war-caster",
  "srd-5.1:feat:lucky",
  "srd-5.1:feat:mobile",
  "srd-5.1:feat:tough",
  "srd-5.1:feat:alert",
  "srd-5.1:feat:athlete",
  "srd-5.1:feat:actor",
  "srd-5.1:feat:charger",
  "srd-5.1:feat:crossbow-expert",
  "srd-5.1:feat:defensive-duelist",
  "srd-5.1:feat:dual-wielder",
  "srd-5.1:feat:dungeon-delver",
  "srd-5.1:feat:durable",
  "srd-5.1:feat:elemental-adept",
  "srd-5.1:feat:heavily-armored",
  "srd-5.1:feat:heavy-armor-master",
  "srd-5.1:feat:inspiring-leader",
  "srd-5.1:feat:keen-mind",
  "srd-5.1:feat:lightly-armored",
  "srd-5.1:feat:linguist",
  "srd-5.1:feat:mage-slayer",
  "srd-5.1:feat:magic-initiate",
  "srd-5.1:feat:medium-armor-master",
  "srd-5.1:feat:mounted-combatant",
  "srd-5.1:feat:observant",
  "srd-5.1:feat:polearm-master",
  "srd-5.1:feat:resilient",
  "srd-5.1:feat:ritual-caster",
  "srd-5.1:feat:savage-attacker",
  "srd-5.1:feat:shield-master",
  "srd-5.1:feat:skilled",
  "srd-5.1:feat:skulker",
  "srd-5.1:feat:spell-sniper",
  "srd-5.1:feat:tavern-brawler",
  "srd-5.1:feat:weapon-master",
];

describe("SRD 5.1 feats", () => {
  it("builds the complete SRD 5.1 feat list with unique IDs", () => {
    expect(feats).toHaveLength(39);
    const ids = feats.map((feat) => feat.reference.definitionId);
    expect(ids).toEqual(SRD_5_1_FEAT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses every feat against the feat catalog schema", () => {
    for (const feat of feats) {
      const parsed = featCatalogDefinitionSchema.parse(feat);
      expect(parsed.reference.kind).toBe("feat");
      expect(parsed.reference.packId).toBe(SRD_5_1_STARTER_IDENTITY.packId);
      expect(parsed.reference.packVersion).toBe(SRD_5_1_STARTER_IDENTITY.packVersion);
      expect(parsed.mechanics.grantedAbilityRefs).toEqual([]);
      expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "feat"]));
    }
  });

  it("references only definitions in the same pack", () => {
    for (const feat of feats) {
      for (const granted of feat.mechanics.grantedAbilityRefs) {
        expect(granted.packId).toBe(feat.reference.packId);
        expect(granted.packVersion).toBe(feat.reference.packVersion);
      }
    }
  });

  it("carries bounded mechanics for ability-score and numeric feats", () => {
    const byId = new Map(feats.map((feat) => [feat.reference.definitionId, featCatalogDefinitionSchema.parse(feat)]));
    expect(byId.get("srd-5.1:feat:actor")!.mechanics.abilityBonuses).toEqual({ charisma: 1 });
    expect(byId.get("srd-5.1:feat:durable")!.mechanics.abilityBonuses).toEqual({ constitution: 1 });
    expect(byId.get("srd-5.1:feat:tough")!.mechanics.modifiers).toEqual([{ type: "modifier", statistic: "max-hp", amount: 2, duration: "permanent" }]);
    expect(byId.get("srd-5.1:feat:mobile")!.mechanics.modifiers).toEqual([{ type: "modifier", statistic: "speed", amount: 10, duration: "permanent" }]);
  });

  it("records the expressible SRD prerequisites", () => {
    const byId = new Map(feats.map((feat) => [feat.reference.definitionId, featCatalogDefinitionSchema.parse(feat)]));
    expect(byId.get("srd-5.1:feat:grappler")!.mechanics.prerequisites).toEqual({ minimumAttribute: { attribute: "strength", value: 13 } });
    expect(byId.get("srd-5.1:feat:defensive-duelist")!.mechanics.prerequisites).toEqual({ minimumAttribute: { attribute: "dexterity", value: 13 } });
    expect(byId.get("srd-5.1:feat:inspiring-leader")!.mechanics.prerequisites).toEqual({ minimumAttribute: { attribute: "charisma", value: 13 } });
    expect(byId.get("srd-5.1:feat:ritual-caster")!.mechanics.prerequisites).toEqual({ minimumAttribute: { attribute: "intelligence", value: 13 } });
  });
});
