import { describe, expect, it } from "vitest";
import { characterProgressionHttpPreviewRequestSchema, characterProgressionHttpStateResponseSchema } from "../src/character-progression-http.js";

describe("character progression HTTP contracts", () => {
  it("requires an explicit, strict preview body", () => {
    expect(characterProgressionHttpPreviewRequestSchema.parse({ selections: [] })).toEqual({ selections: [] });
    expect(() => characterProgressionHttpPreviewRequestSchema.parse({ selections: [], actorId: "private" })).toThrow();
  });
  it("does not admit repository-private state fields", () => {
    const value = { progression: { campaignId: "campaign", campaignCharacterId: "character", actorId: "actor" } };
    expect(() => characterProgressionHttpStateResponseSchema.parse(value)).toThrow();
  });
});
