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
    expect(SRD_5_1_STARTER_PACK_VERSION).toMatch(/^1\.6\.0\+[0-9a-f]{12}$/);
    expect(SRD_5_1_STARTER_ID).toBe(`srd-5.1:starter@${SRD_5_1_STARTER_PACK_VERSION}`);
    expect(Object.isFrozen(SRD_5_1_STARTER_IDENTITY)).toBe(true);
    expect(srdStarterIdentitySchema.parse(SRD_5_1_STARTER_IDENTITY)).toEqual(SRD_5_1_STARTER_IDENTITY);
    expect(campaignMechanicsStarterSetupRequestSchema.parse({ starterId: SRD_5_1_STARTER_ID }))
      .toEqual({ starterId: SRD_5_1_STARTER_ID });
  });
});
