import { describe, expect, it } from "vitest";
import { campaignDmBeatRequestSchema, campaignDmControlSchema, campaignDmDecisionRequestSchema,
  campaignDmRunSchema, campaignDmSelectionSchema } from "../src/campaign-dm-http.js";
describe("campaign DM HTTP contracts",()=>{
  it("accepts explicit mode and strict bounded intent, never authority or mechanics",()=>{
    expect(campaignDmControlSchema.parse({campaignId:"campaign",mode:"human",revision:0}).mode).toBe("human");
    const request={intent:"open",expectedModeRevision:0,idempotencyKey:"open"};
    expect(campaignDmBeatRequestSchema.safeParse(request).success).toBe(true);
    for(const extra of [{principalId:"owner"},{mode:"ai"},{destination:"vault"},{declaration:"I win"}])expect(campaignDmBeatRequestSchema.safeParse({...request,...extra}).success).toBe(false);
    expect(campaignDmDecisionRequestSchema.safeParse({decision:"approved",expectedRevision:1,idempotencyKey:"approve",candidateId:"swapped"}).success).toBe(false);
    expect(campaignDmSelectionSchema.safeParse({candidateId:"candidate",digest:"a".repeat(64)}).success).toBe(true);
    expect(campaignDmSelectionSchema.safeParse({candidateId:"candidate",digest:"a".repeat(64),targetId:"override"}).success).toBe(false);
  });
  it("public run rejects private plans and provider prose",()=>{
    const run={runId:"run",campaignId:"campaign",sessionId:"room",intent:"open",mode:"ai",modeRevision:1,revision:1,state:"completed",
      narration:"The gate opens.",receipts:[],blockers:[],createdAt:"2036-01-01T00:00:00.000Z"};
    expect(campaignDmRunSchema.safeParse(run).success).toBe(true);
    expect(campaignDmRunSchema.safeParse({...run,proposal:{}}).success).toBe(false);
    expect(campaignDmRunSchema.safeParse({...run,providerResponse:"secret"}).success).toBe(false);
  });
});
