import { describe, expect, it } from "vitest";
import {
  SRD_5_1_STARTER_ID,
  SRD_5_1_STARTER_IDENTITY,
  SRD_5_1_STARTER_PACK_VERSION,
  campaignMechanicsStarterSetupRequestSchema,
  srdStarterIdentitySchema,
} from "../src/index.js";

describe("SRD 5.1 starter identity", () => {
  it("exports the exact immutable corrected publication identity", () => {
    // Pinned to the CURRENT published pack identity. This was bumped to 1.7.0 in
    // edbdc42 ("integrate verified SRD 5.1 catalog additions"); the older 1.6.0
    // assertion in this file predated that bump and was never updated. The pack
    // version is an intentional immutable publication identity: content additions
    // bump it deliberately. Downgrading the pack to satisfy a stale assertion would
    // corrupt already-published references, so the assertion moves forward instead.
    // When the pack content legitimately changes, bump this pin in the same commit
    // that changes SRD_5_1_STARTER_PACK_VERSION.
    expect(SRD_5_1_STARTER_PACK_VERSION).toBe("1.7.0+a870b31918ec");
    // Shape invariant: semver triple plus 12 lowercase hex build metadata.
    expect(SRD_5_1_STARTER_PACK_VERSION).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(SRD_5_1_STARTER_ID).toBe(`srd-5.1:starter@${SRD_5_1_STARTER_PACK_VERSION}`);
    expect(Object.isFrozen(SRD_5_1_STARTER_IDENTITY)).toBe(true);
    expect(srdStarterIdentitySchema.parse(SRD_5_1_STARTER_IDENTITY)).toEqual(SRD_5_1_STARTER_IDENTITY);
    expect(campaignMechanicsStarterSetupRequestSchema.parse({ starterId: SRD_5_1_STARTER_ID }))
      .toEqual({ starterId: SRD_5_1_STARTER_ID });
  });
});
