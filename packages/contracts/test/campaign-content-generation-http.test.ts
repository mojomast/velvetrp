import { describe, expect, it } from "vitest";
import {
  campaignContentApplyRequestSchema, campaignContentGenerationRequestSchema,
  campaignGeneratedPlanningSchema, campaignPublishedMaterialsSchema, generatedCampaignContentProviderSchema,
} from "../src/index.js";

describe("campaign content generation contracts", () => {
  it("accepts sparse section expansion without an opening or location graph", () => {
    const request=campaignContentGenerationRequestSchema.parse({campaignId:"campaign-1",brief:"Deepen the wardens",tone:"hopeful",exclusions:[],idempotencyKey:"generate-1",sections:["factions","npcs","clues"],expandArtifactKeys:["canal-gate"],revisionFeedback:"Keep accepted canon."});
    expect(request.sections).toEqual(["factions","npcs","clues"]);
    expect(generatedCampaignContentProviderSchema.parse({
      factions:[{key:"night-wardens",name:"Night Wardens",description:"Canal defenders.",visibility:"public"}],
      npcs:[{key:"warden-ila",name:"Ila",archetype:"Warden",description:"A tired sentinel.",visibility:"public",locationKey:"canal-gate",factionKeys:["night-wardens"]}],
      clues:[{key:"broken-seal",title:"Broken seal",description:"A seal was cut.",visibility:"public",locationKey:"canal-gate"}],
    }).outlines).toEqual([]);
  });

  it("requires an explicit nonempty apply selection and explicit failed-attempt acknowledgement", () => {
    expect(campaignContentApplyRequestSchema.safeParse({expectedRevision:0,idempotencyKey:"apply",selectedArtifactKeys:[]}).success).toBe(false);
    expect(campaignContentGenerationRequestSchema.parse({campaignId:"campaign-1",brief:"Retry",tone:"hopeful",exclusions:[],idempotencyKey:"generate-1",sections:["arcs"],retryFailedAttempt:{failedAttempt:1}}).retryFailedAttempt).toEqual({failedAttempt:1});
  });

  it("rejects executable fields, unbounded output, and unstable keys", () => {
    expect(generatedCampaignContentProviderSchema.safeParse({npcs:[{key:"Bad Key",name:"Bad",archetype:"Mage",description:"Bad.",visibility:"public",powers:[]}]}).success).toBe(false);
  });

  it("keeps planning strict and the player delivery shape free of private fields",()=>{
    const planning=campaignGeneratedPlanningSchema.parse({campaignId:"campaign-1",deliveryRevision:0,encounters:[],deliverables:[{artifactKey:"letter",resourceId:"resource-letter",title:"Letter",visibility:"gm",sourceDraftId:"draft-1",kind:"handout",content:"Secret",locationId:null,npcIds:[],publishedAt:null}]});expect(planning.deliverables[0]?.visibility).toBe("gm");
    expect(campaignPublishedMaterialsSchema.safeParse({campaignId:"campaign-1",revision:1,materials:[{artifactKey:"letter",resourceId:"resource-letter",kind:"handout",title:"Letter",content:"Public",publishedAt:"2026-08-14T00:00:00.000Z",visibility:"public"}]}).success).toBe(false);
  });
});
