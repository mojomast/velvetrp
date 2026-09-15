import { describe, expect, it } from "vitest";
import { boundDirectorPreparation, DM_PREPARATION_CONTEXT_MAX_CHARS } from "../src/repo/campaignDmRepo.js";

const oversized = () => ({
  campaignId: "campaign", deliveryRevision: 3,
  encounters: Array.from({ length: 40 }, (_, index) => ({ artifactKey: `enc-${index}`, title: `Encounter ${index}`, body: "e".repeat(300) })),
  lore: Array.from({ length: 40 }, (_, index) => ({ artifactKey: `lore-${index}`, title: `Lore ${index}`, body: "l".repeat(300) })),
  questItems: [], monsterConcepts: [], deliverables: [],
});

describe("director preparation bound", () => {
  it("leaves a small preparation untouched", () => {
    const small = { campaignId: "campaign", deliveryRevision: 0, encounters: [{ artifactKey: "enc", title: "Enc" }] };
    expect(boundDirectorPreparation(small)).toBe(small);
  });

  it("bounds an oversized generated world under the planning prompt cap without dropping arrays", () => {
    const value = oversized();
    expect(JSON.stringify(value).length).toBeGreaterThan(DM_PREPARATION_CONTEXT_MAX_CHARS);
    const bounded = boundDirectorPreparation(value)!;
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(DM_PREPARATION_CONTEXT_MAX_CHARS);
    expect(bounded.encounters.length).toBeLessThan(value.encounters.length);
    expect(bounded.lore.length).toBeLessThan(value.lore.length);
    expect(bounded.deliveryRevision).toBe(3);
  });

  it("keeps a missing preparation missing", () => {
    expect(boundDirectorPreparation(null)).toBeNull();
  });
});
