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
    const planning=campaignGeneratedPlanningSchema.parse({campaignId:"campaign-1",deliveryRevision:0,encounters:[],lore:[],questItems:[],monsterConcepts:[],deliverables:[{artifactKey:"letter",resourceId:"resource-letter",title:"Letter",visibility:"gm",sourceDraftId:"draft-1",kind:"handout",content:"Secret",locationId:null,npcIds:[],publishedAt:null}]});expect(planning.deliverables[0]?.visibility).toBe("gm");
    expect(campaignPublishedMaterialsSchema.safeParse({campaignId:"campaign-1",revision:1,materials:[{artifactKey:"letter",resourceId:"resource-letter",kind:"handout",title:"Letter",content:"Public",publishedAt:"2026-08-14T00:00:00.000Z",visibility:"public"}]}).success).toBe(false);
  });

  it("types operational quests, campaign lore, and explicitly bound or inert concepts",()=>{
    const parsed=generatedCampaignContentProviderSchema.parse({
      quests:[{key:"bell-quest",title:"Recover the Bell",description:"Follow its trail.",visibility:"public",objectives:[{key:"find-mark",description:"Find the maker's mark.",visibility:"public"},{key:"open-tower",description:"Open the tower.",visibility:"public",dependencyObjectiveKeys:["find-mark"]}],rewards:[{key:"bell-favor",label:"Bellkeeper favor",kind:"custom",visibility:"public"}]}],
      lore:[{key:"bell-custom",title:"The Bell Custom",summary:"Bells name each district.",visibility:"public",details:["A silent bell marks exile."]}],
      questItems:[{key:"silent-clapper",name:"Silent Clapper",description:"A ceremonial clapper.",visibility:"public",questKeys:["bell-quest"],mechanics:{state:"inert",reason:"No compatible pinned item exists."}}],
      monsterConcepts:[{key:"bell-wraith",name:"Bell Wraith",description:"A resonance in the tower.",role:"guardian",visibility:"gm",mechanics:{state:"inert",reason:"No compatible pinned enemy template exists."}}],
    });
    expect(parsed.quests[0]?.objectives[1]?.dependencyObjectiveKeys).toEqual(["find-mark"]);
    expect(parsed.questItems[0]?.mechanics.state).toBe("inert");
  });
});
