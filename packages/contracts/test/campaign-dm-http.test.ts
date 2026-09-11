import { describe, expect, it } from "vitest";
import { campaignDmActionSchema, campaignDmBeatRequestSchema, campaignDmCompositionSchema, campaignDmControlSchema, campaignDmDecisionRequestSchema,
  campaignDmPrivateRunSchema, campaignDmRunSchema, campaignDmSelectionSchema } from "../src/campaign-dm-http.js";
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
  it("accepts an ordered unique composition of at most three exact candidates",()=>{
    const a={candidateId:"a",digest:"a".repeat(64)},b={candidateId:"b",digest:"b".repeat(64)},
      c={candidateId:"c",digest:"c".repeat(64)},d={candidateId:"d",digest:"d".repeat(64)};
    expect(campaignDmCompositionSchema.safeParse([a]).success).toBe(true);
    expect(campaignDmCompositionSchema.safeParse([a,b,c]).success).toBe(true);
    expect(campaignDmCompositionSchema.safeParse([]).success).toBe(false);
    expect(campaignDmCompositionSchema.safeParse([a,b,c,d]).success).toBe(false);
    expect(campaignDmCompositionSchema.safeParse([a,a]).success).toBe(false);
    expect(campaignDmCompositionSchema.safeParse([a,{...b,digest:a.digest}]).success).toBe(false);
    const run={runId:"run",campaignId:"campaign",sessionId:"room",intent:"open",mode:"ai",modeRevision:1,revision:1,state:"completed",
      narration:"The gate opens.",receipts:[{action:"reveal-node",summary:"one"},{action:"reveal-clue",summary:"two"}],
      blockers:[],createdAt:"2036-01-01T00:00:00.000Z"};
    expect(campaignDmRunSchema.safeParse(run).success).toBe(true);
    const candidate={candidateId:"a",digest:"a".repeat(64),action:"reveal-node",label:"Reveal"};
    expect(campaignDmPrivateRunSchema.parse({run,proposal:candidate}).composition).toEqual([]);
    expect(campaignDmPrivateRunSchema.parse({run,proposal:candidate,composition:[candidate]}).composition).toEqual([candidate]);
  });
  it("accepts transition beats as exact actions and receipts",()=>{
    for(const action of ["advance-time","ambient-beat"] as const)expect(campaignDmActionSchema.safeParse(action).success).toBe(true);
    expect(campaignDmActionSchema.safeParse("advance-time-arbitrary").success).toBe(false);
    const run={runId:"run",campaignId:"campaign",sessionId:"room",intent:"open",mode:"ai",modeRevision:1,revision:1,state:"completed",
      narration:"A lull settles over the road.",receipts:[{action:"advance-time",summary:"Time passes."},{action:"ambient-beat",summary:"A lull."}],
      blockers:[],createdAt:"2036-01-01T00:00:00.000Z"};
    expect(campaignDmRunSchema.safeParse(run).success).toBe(true);
  });
});
