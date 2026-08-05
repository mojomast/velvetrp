import { describe, expect, it } from "vitest";
import {
  catalogDefinitionKindSchema,
  campaignCatalogConfigurationResultSchema,
  configureCampaignCatalogInputSchema,
  catalogDefinitionReferenceSchema,
  contentCompatibilitySchema,
  enemyTemplateCatalogDefinitionSchema,
  gmCatalogProjectionSchema,
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

  it("accepts only the closed velvet-starter-v1 compatibility and mechanics shapes", () => {
    expect(contentCompatibilitySchema.parse({ rulesEngine: "velvet-starter-v1", rulesProfileId: "velvet:rules", catalogFormat: "validated-v1" }))
      .toEqual({ rulesEngine: "velvet-starter-v1", rulesProfileId: "velvet:rules", catalogFormat: "validated-v1" });
    const skill = { reference: exact, name: "Trailcraft", description: "A bounded skill.", tags: [], mechanics: { attribute: "insight" } };
    expect(skillCatalogDefinitionSchema.parse(skill)).toEqual(skill);
    for (const forbidden of [{ path: "skill.json" }, { file: "skill.json" }, { url: "https://invalid" }, { script: "run()" }, { formula: "x+1" }, { executable: true }]) {
      expect(skillCatalogDefinitionSchema.safeParse({ ...skill, ...forbidden }).success).toBe(false);
    }
  });

  it("requires honest original provenance without URLs or third-party data", () => {
    const provenance = { authorship: "original", author: "Author", authoredAt: "2030-01-01T00:00:00.000Z",
      reviewedBy: "Reviewer", reviewedAt: "2030-01-02T00:00:00.000Z", declaration: "Clean room.", thirdPartyData: false } as const;
    expect(publicationProvenanceSchema.parse(provenance)).toEqual(provenance);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, sourceUrl: "https://invalid" }).success).toBe(false);
    expect(publicationProvenanceSchema.safeParse({ ...provenance, thirdPartyData: true }).success).toBe(false);
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
