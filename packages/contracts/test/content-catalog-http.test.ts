import { describe, expect, it } from "vitest";
import {
  contentCatalogHttpCampaignContentGetResponseSchema,
  contentCatalogHttpCampaignContentPutRequestSchema,
  contentCatalogHttpCampaignContentPutResponseSchema,
  contentCatalogHttpCampaignPackDetailResponseSchema,
  contentCatalogHttpOwnerDetailResponseSchema,
  contentCatalogHttpPublicationRequestSchema,
  contentCatalogHttpPublicationResponseSchema,
  contentCatalogHttpPublicationsQuerySchema,
  contentCatalogHttpPublicationsResponseSchema,
  contentCatalogHttpValidationRequestSchema,
  contentCatalogHttpValidationResponseSchema,
} from "../src/content-catalog-http.js";

const digest = "a".repeat(64);
const at = "2030-01-01T00:00:00.000Z";
const publication = {
  packId: "pack", packVersion: "1.0.0", name: "Pack", description: "Description", tags: ["starter"],
  compatibility: { rulesEngine: "velvet-starter-v1" as const, rulesProfileId: "profile", catalogFormat: "validated-v1" as const },
  digest, validationLevel: "validated-v1" as const, publishedAt: at,
};
const definition = {
  reference: { packId: "pack", packVersion: "1.0.0", definitionId: "race", kind: "race" as const },
  name: "Race", description: "Description", tags: [],
  mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] },
};
const provenance = { authorship: "original" as const, author: "Author", authoredAt: at, reviewedBy: "Reviewer", reviewedAt: at, declaration: "Original work", thirdPartyData: false as const };
const ownerCatalog = { publication, provenance, definitions: [definition] };
const publicationRequest = {
  idempotencyKey: "publish-1",
  manifest: {
    packId: "pack", packVersion: "1.0.0", name: "Pack", description: "Description", tags: ["starter"],
    rulesProfile: { name: "Profile", description: "Description", tags: [] },
    compatibility: publication.compatibility, digest, provenance,
  },
  definitions: [definition],
};
const content = {
  compatible: true, rulesProfileId: "profile", contentPacks: [{ packId: "pack", packVersion: "1.0.0", digest }], issues: [],
};

describe("content catalog HTTP contracts", () => {
  it("uses a strict bounded paginated publication list", () => {
    expect(contentCatalogHttpPublicationsQuerySchema.parse({ cursor: "cursor", limit: "10" })).toEqual({ cursor: "cursor", limit: 10 });
    expect(contentCatalogHttpPublicationsResponseSchema.parse({ publications: [publication], nextCursor: null })).toEqual({ publications: [publication], nextCursor: null });
    expect(contentCatalogHttpPublicationsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(contentCatalogHttpPublicationsResponseSchema.safeParse({ publications: [], nextCursor: null, extra: true }).success).toBe(false);
  });

  it("envelopes the owner detail and publication result", () => {
    expect(contentCatalogHttpOwnerDetailResponseSchema.parse({ catalog: ownerCatalog })).toEqual({ catalog: ownerCatalog });
    expect(contentCatalogHttpPublicationResponseSchema.parse({ catalog: ownerCatalog })).toEqual({ catalog: ownerCatalog });
    expect(contentCatalogHttpOwnerDetailResponseSchema.safeParse(ownerCatalog).success).toBe(false);
  });

  it("removes the caller key only from validation input", () => {
    const { idempotencyKey: _key, ...validationRequest } = publicationRequest;
    expect(contentCatalogHttpValidationRequestSchema.parse(validationRequest)).toEqual(validationRequest);
    expect(contentCatalogHttpValidationRequestSchema.safeParse(publicationRequest).success).toBe(false);
    expect(contentCatalogHttpPublicationRequestSchema.parse(publicationRequest)).toEqual(publicationRequest);
    const report = { valid: true, issues: [], normalizedSummary: { totalDefinitions: 1, counts: [
      { kind: "race", count: 1 }, { kind: "background", count: 0 }, { kind: "class", count: 0 },
      { kind: "class-level", count: 0 }, { kind: "skill", count: 0 }, { kind: "ability", count: 0 },
      { kind: "spell", count: 0 }, { kind: "item", count: 0 }, { kind: "currency", count: 0 },
      { kind: "enemy-template", count: 0 },
    ], digest } };
    expect(contentCatalogHttpValidationResponseSchema.parse({ report })).toEqual({ report });
  });

  it("keeps campaign identifiers route-owned for content reads and writes", () => {
    const request = { rulesProfileId: "profile", contentPacks: [{ packId: "pack", packVersion: "1.0.0" }], expectedRevision: 0, idempotencyKey: "configure-1" };
    const receipt = { commandId: "command", idempotencyKey: "configure-1", revisionBefore: 0, revisionAfter: 1, configuredAt: at, content };
    expect(contentCatalogHttpCampaignContentPutRequestSchema.parse(request)).toEqual(request);
    expect(contentCatalogHttpCampaignContentGetResponseSchema.parse({ content })).toEqual({ content });
    expect(contentCatalogHttpCampaignContentPutResponseSchema.parse({ content, receipt })).toEqual({ content, receipt });
    expect(contentCatalogHttpCampaignContentGetResponseSchema.safeParse({ content: { ...content, campaignId: "campaign" } }).success).toBe(false);
    expect(contentCatalogHttpCampaignContentPutResponseSchema.safeParse({ content, receipt: { ...receipt, campaignId: "campaign" } }).success).toBe(false);
  });

  it("returns the current role-filtered pack projection in a strict envelope", () => {
    const catalog = { publication, definitions: [definition] };
    expect(contentCatalogHttpCampaignPackDetailResponseSchema.parse({ catalog })).toEqual({ catalog });
    expect(contentCatalogHttpCampaignPackDetailResponseSchema.safeParse({ catalog, extra: true }).success).toBe(false);
  });
});
