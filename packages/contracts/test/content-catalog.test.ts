import { describe, expect, it } from "vitest";
import {
  catalogDefinitionKindSchema,
  campaignCatalogConfigurationResultSchema,
  configureCampaignCatalogInputSchema,
  catalogDefinitionReferenceSchema,
  contentCompatibilitySchema,
  enemyTemplateCatalogDefinitionSchema,
  gmCatalogProjectionSchema,
  itemCatalogDefinitionSchema,
  playerCatalogProjectionSchema,
  publicationProvenanceSchema,
  publishContentCatalogInputSchema,
  skillCatalogDefinitionSchema,
} from "../src/index.js";

const exact = { packId: "velvet:test", packVersion: "1.0.0+123456789abc", definitionId: "velvet:test:skill", kind: "skill" } as const;

describe("M1.2 content catalog contracts", () => {
  it("owns all ten exact kinds and rejects ranges and unknown reference fields", () => {
    expect(catalogDefinitionKindSchema.options).toEqual([
      "race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template",
    ]);
    expect(catalogDefinitionReferenceSchema.parse(exact)).toEqual(exact);
    expect(catalogDefinitionReferenceSchema.safeParse({ ...exact, packVersion: undefined }).success).toBe(false);
    expect(catalogDefinitionReferenceSchema.safeParse({ ...exact, versionRange: "^1" }).success).toBe(false);
  });

  it("accepts only the closed Velvet and D&D compatibility engines and mechanics shapes", () => {
    expect(contentCompatibilitySchema.parse({ rulesEngine: "velvet-starter-v1", rulesProfileId: "velvet:rules", catalogFormat: "validated-v1" }))
      .toEqual({ rulesEngine: "velvet-starter-v1", rulesProfileId: "velvet:rules", catalogFormat: "validated-v1" });
    expect(contentCompatibilitySchema.parse({ rulesEngine: "dnd-5e", rulesEngineVersion:"1.0.0",rulesProfileId: "srd-5.1:rules:starter-v1", catalogFormat: "validated-v1" }))
      .toEqual({ rulesEngine: "dnd-5e",rulesEngineVersion:"1.0.0", rulesProfileId: "srd-5.1:rules:starter-v1", catalogFormat: "validated-v1" });
    expect(contentCompatibilitySchema.safeParse({ rulesEngine:"unknown",rulesProfileId:"unknown",catalogFormat:"validated-v1" }).success).toBe(false);
    const skill = { reference: exact, name: "Trailcraft", description: "A bounded skill.", tags: [], mechanics: { attribute: "insight" } };
    expect(skillCatalogDefinitionSchema.parse(skill)).toEqual(skill);
    for (const forbidden of [{ path: "skill.json" }, { file: "skill.json" }, { url: "https://invalid" }, { script: "run()" }, { formula: "x+1" }, { executable: true }]) {
      expect(skillCatalogDefinitionSchema.safeParse({ ...skill, ...forbidden }).success).toBe(false);
    }
  });

  it("accepts backward-compatible items and closed legal SRD equipment profiles", () => {
    const currency = { ...exact, kind: "currency", definitionId: "velvet:test:gp" } as const;
    const item = { reference: { ...exact, kind: "item", definitionId: "velvet:test:item" }, name: "Item",
      description: "A test item.", tags: [], mechanics: { category: "gear", stackable: false, slot: null,
        price: { currency, amount: 1 }, effects: [] } } as const;
    expect(itemCatalogDefinitionSchema.parse(item)).toEqual(item);
    expect(itemCatalogDefinitionSchema.safeParse({ ...item, mechanics: { ...item.mechanics, engineDetails: null } }).success).toBe(true);

    const profiles = [
      { category: "weapon", slot: "hand", profile: { kind: "weapon", proficiency: "martial", attackType: "melee",
        damage: { type: "slashing", die: { count: 1, sides: 8 } },
        properties: [{ property: "versatile", damageDie: { count: 1, sides: 10 } }] } },
      { category: "armor", slot: "body", profile: { kind: "armor", category: "light", baseArmorClass: 11,
        dexterity: { policy: "full" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } },
      { category: "armor", slot: "body", profile: { kind: "armor", category: "medium", baseArmorClass: 13,
        dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } },
      { category: "armor", slot: "body", profile: { kind: "armor", category: "heavy", baseArmorClass: 16,
        dexterity: { policy: "none" }, strengthRequirement: 13, stealthDisadvantage: true, shieldBonus: 0 } },
      { category: "armor", slot: "hand", profile: { kind: "armor", category: "shield", baseArmorClass: null,
        dexterity: { policy: "none" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 2 } },
    ] as const;
    for (const { category, slot, profile } of profiles) {
      expect(itemCatalogDefinitionSchema.safeParse({ ...item, mechanics: { ...item.mechanics, category, slot,
        engineDetails: { rulesEngine: "dnd-5e", weightPounds: 3, equipmentProfile: profile } } }).success).toBe(true);
    }
  });

  it.each([
    ["duplicate properties", "melee", [{ property: "light" }, { property: "light" }]],
    ["melee ammunition", "melee", [{ property: "ammunition", range: { normalFeet: 80, longFeet: 320 } }]],
    ["ranged reach", "ranged", [{ property: "reach", reachFeet: 10 }]],
    ["ranged versatile", "ranged", [{ property: "versatile", damageDie: { count: 1, sides: 10 } }]],
    ["loading without ammunition", "ranged", [{ property: "loading" }]],
    ["light and heavy", "melee", [{ property: "light" }, { property: "heavy" }]],
    ["light and two-handed", "melee", [{ property: "light" }, { property: "two-handed" }]],
    ["two-handed and versatile", "melee", [{ property: "two-handed" }, { property: "versatile", damageDie: { count: 1, sides: 10 } }]],
    ["non-increasing versatile die", "melee", [{ property: "versatile", damageDie: { count: 1, sides: 8 } }]],
    ["reversed range", "ranged", [{ property: "ammunition", range: { normalFeet: 320, longFeet: 80 } }]],
  ] as const)("rejects invalid SRD weapon combination: %s", (_label, attackType, properties) => {
    const currency = { ...exact, kind: "currency", definitionId: "velvet:test:gp" } as const;
    const candidate = { reference: { ...exact, kind: "item", definitionId: "velvet:test:weapon" }, name: "Weapon",
      description: "A test weapon.", tags: [], mechanics: { category: "weapon", stackable: false, slot: "hand",
        price: { currency, amount: 1 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 3,
          equipmentProfile: { kind: "weapon", proficiency: "martial", attackType,
            damage: { type: "slashing", die: { count: 1, sides: 8 } }, properties } } } };
    expect(itemCatalogDefinitionSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ["light armor with capped Dexterity", "body", { kind: "armor", category: "light", baseArmorClass: 11, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 }],
    ["medium armor without the SRD cap", "body", { kind: "armor", category: "medium", baseArmorClass: 13, dexterity: { policy: "full" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 }],
    ["shield in the body slot", "body", { kind: "armor", category: "shield", baseArmorClass: null, dexterity: { policy: "none" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 2 }],
  ] as const)("rejects invalid SRD armor combination: %s", (_label, slot, profile) => {
    const currency = { ...exact, kind: "currency", definitionId: "velvet:test:gp" } as const;
    expect(itemCatalogDefinitionSchema.safeParse({ reference: { ...exact, kind: "item", definitionId: "velvet:test:armor" },
      name: "Armor", description: "Test armor.", tags: [], mechanics: { category: "armor", stackable: false, slot,
        price: { currency, amount: 1 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 10,
          equipmentProfile: profile } } }).success).toBe(false);
  });

  it("requires provenance to distinguish original and licensed third-party data", () => {
    const provenance = { authorship: "original", author: "Author", authoredAt: "2030-01-01T00:00:00.000Z",
      reviewedBy: "Reviewer", reviewedAt: "2030-01-02T00:00:00.000Z", declaration: "Clean room.", thirdPartyData: false } as const;
    expect(publicationProvenanceSchema.parse(provenance)).toEqual(provenance);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, sourceUrl: "https://invalid" }).success).toBe(false);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, thirdPartyData: true }).success).toBe(false);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, authorship: "licensed", thirdPartyData: true,
      declaration: "Licensed source reviewed with attribution." }).success).toBe(true);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, authorship: "licensed", thirdPartyData: false }).success).toBe(false);
  });

  it("makes enemy private fields structurally impossible in the player projection", () => {
    const ability = { packId: exact.packId, packVersion: exact.packVersion, kind: "ability", definitionId: "velvet:test:ability" } as const;
    const enemy = { reference: { ...exact, kind: "enemy-template", definitionId: "velvet:test:enemy" }, name: "Mite",
      description: "An original test enemy.", tags: [], mechanics: { tier: 1, maxHp: 8, defense: 10, speed: 20,
        abilityRefs: [ability], resistances: [], vulnerabilities: [], immunities: [] },
      private: { tactics: "Wait.", gmNotes: "Secret.", hiddenAbilityRefs: [] } } as const;
    expect(enemyTemplateCatalogDefinitionSchema.parse(enemy)).toEqual(enemy);
    const publication = { packId: exact.packId, packVersion: exact.packVersion, name: "Pack", description: "Pack description.", tags: [],
      compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: "velvet:rules", catalogFormat: "validated-v1" },
      digest: "a".repeat(64), validationLevel: "validated-v1", publishedAt: "2030-01-02T00:00:00.000Z" } as const;
    expect(gmCatalogProjectionSchema.safeParse({ publication, definitions: [enemy] }).success).toBe(true);
    expect(playerCatalogProjectionSchema.safeParse({ publication, definitions: [enemy] }).success).toBe(false);
    const { private: _private, ...safeEnemy } = enemy;
    expect(playerCatalogProjectionSchema.safeParse({ publication, definitions: [safeEnemy] }).success).toBe(true);
    expect(playerCatalogProjectionSchema.safeParse({ publication, definitions: [safeEnemy], provenance: {} }).success).toBe(false);
  });

  it("requires revision and idempotency and validates authoritative catalog receipts", () => {
    const input = { rulesProfileId: "velvet:rules", contentPacks: [{ packId: "velvet:test", packVersion: "1" }],
      expectedRevision: 4, idempotencyKey: "catalog-command" };
    expect(configureCampaignCatalogInputSchema.parse(input)).toEqual(input);
    expect(configureCampaignCatalogInputSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBe(false);
    expect(configureCampaignCatalogInputSchema.safeParse({ ...input, idempotencyKey: undefined }).success).toBe(false);
    const content = { campaignId: "campaign", compatible: true, rulesProfileId: "velvet:rules",
      contentPacks: [{ packId: "velvet:test", packVersion: "1", digest: "a".repeat(64) }], issues: [] };
    const receipt = { campaignId: "campaign", commandId: "catalog-command", idempotencyKey: "catalog-command",
      revisionBefore: 4, revisionAfter: 5, configuredAt: "2030-01-02T00:00:00.000Z", content };
    expect(campaignCatalogConfigurationResultSchema.parse({ content, receipt })).toEqual({ content, receipt });
    expect(campaignCatalogConfigurationResultSchema.safeParse({ content, receipt: { ...receipt, revisionAfter: 6 } }).success).toBe(false);
  });

  it("requires explicit publication idempotency identity",()=>{
    const minimal={manifest:{packId:exact.packId,packVersion:exact.packVersion,name:"Pack",description:"Description",tags:[],
      rulesProfile:{name:"Rules",description:"Description",tags:[]},compatibility:{rulesEngine:"velvet-starter-v1",
        rulesProfileId:"velvet:rules",catalogFormat:"validated-v1"},digest:"a".repeat(64),
      provenance:{authorship:"original",author:"Author",authoredAt:"2030-01-01T00:00:00.000Z",reviewedBy:"Reviewer",
        reviewedAt:"2030-01-01T00:00:00.000Z",declaration:"Original",thirdPartyData:false}},
      definitions:[{reference:exact,name:"Skill",description:"Description",tags:[],mechanics:{attribute:"insight"}}]};
    expect(publishContentCatalogInputSchema.safeParse(minimal).success).toBe(false);
    expect(publishContentCatalogInputSchema.safeParse({...minimal,idempotencyKey:"publication-key"}).success).toBe(true);
    expect(publishContentCatalogInputSchema.safeParse({...minimal,idempotencyKey:"bad key"}).success).toBe(false);
  });
});
