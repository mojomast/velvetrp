import { describe, expect, it } from "vitest";
import {
  characterProgressionHttpApplyReceiptSchema,
  characterProgressionHttpApplyRequestSchema,
  characterProgressionHttpGrantXpReceiptSchema,
  characterProgressionHttpGrantXpRequestSchema,
  characterProgressionHttpPreviewSchema,
  characterProgressionHttpPreviewRequestSchema,
  characterProgressionHttpStateResponseSchema,
} from "../src/character-progression-http.js";

describe("character progression HTTP contracts", () => {
  it("requires an explicit, strict preview body", () => {
    expect(characterProgressionHttpPreviewRequestSchema.parse({ selections: [] })).toEqual({ selections: [] });
    expect(() => characterProgressionHttpPreviewRequestSchema.parse({ selections: [], actorId: "private" })).toThrow();
  });
  it("does not admit repository-private state fields", () => {
    const value = { progression: { campaignId: "campaign", campaignCharacterId: "character", actorId: "actor" } };
    expect(() => characterProgressionHttpStateResponseSchema.parse(value)).toThrow();
  });
  it("publishes the opaque preview proof under apply-safe names", () => {
    const preview = {
      campaignId: "campaign", campaignCharacterId: "character", previewRevision: 0, previewToken: "a".repeat(64),
      mode: "xp", currentLevel: 1, eligibleLevel: 1, totalXp: 0, milestoneCount: 0, pendingChoices: [], levels: [],
    };
    expect(characterProgressionHttpPreviewSchema.parse(preview)).toEqual(preview);
    expect(() => characterProgressionHttpPreviewSchema.parse({ ...preview, revision: 0 })).toThrow();
  });
  it("accepts only the domain apply proof and public apply receipt", () => {
    const request = { previewRevision: 0, previewToken: "a".repeat(64), selections: [], idempotencyKey: "apply" };
    expect(characterProgressionHttpApplyRequestSchema.parse(request)).toEqual(request);
    expect(() => characterProgressionHttpApplyRequestSchema.parse({ ...request, level: 2 })).toThrow();

    const receipt = {
      campaignCharacterId: "character", idempotencyKey: "apply", type: "apply-levels",
      revisionBefore: 0, revisionAfter: 1, occurredAt: "2030-01-01T00:00:00.000Z", appliedLevels: [],
    };
    expect(characterProgressionHttpApplyReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => characterProgressionHttpApplyReceiptSchema.parse({ ...receipt, commandId: "private" })).toThrow();
    expect(() => characterProgressionHttpApplyReceiptSchema.parse({ ...receipt, state: {} })).toThrow();
  });
  it("accepts only the domain XP grant input and public receipt", () => {
    const request = { amount: 900, reason: "Completed journey", expectedRevision: 0, idempotencyKey: "xp-grant" };
    expect(characterProgressionHttpGrantXpRequestSchema.parse(request)).toEqual(request);
    expect(() => characterProgressionHttpGrantXpRequestSchema.parse({ ...request, totalXp: 900 })).toThrow();

    const receipt = {
      campaignCharacterId: "character", idempotencyKey: "xp-grant", type: "grant-xp",
      revisionBefore: 0, revisionAfter: 1, occurredAt: "2030-01-01T00:00:00.000Z", appliedLevels: [],
    };
    expect(characterProgressionHttpGrantXpReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => characterProgressionHttpGrantXpReceiptSchema.parse({ ...receipt, commandId: "private" })).toThrow();
    expect(() => characterProgressionHttpGrantXpReceiptSchema.parse({ ...receipt, state: {} })).toThrow();
  });
});
