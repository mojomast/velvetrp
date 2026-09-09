import { describe, expect, it } from "vitest";
import {
  campaignContentApplyRequestSchema, campaignContentGenerationRequestSchema, campaignContentGenerationRecoverySchema,
  campaignGeneratedPlanningSchema, campaignPublishedMaterialsSchema, generatedCampaignContentProviderSchema,
} from "../src/index.js";

describe("campaign content generation contracts", () => {
  it("keeps runnable GM scenes and NPC secrets in existing bounded artifacts", () => {
    const scene={key:"finale",title:"Finale",visibility:"gm",prompt:"Entry: the bell rings. If refused, the envoy returns. Recover missed evidence from the keeper. End with negotiation or departure."};
    const parsed=generatedCampaignContentProviderSchema.parse({scenePrompts:[scene],arcs:[{
      key:"final-arc",title:"Last Bell",visibility:"gm",summary:"Entry, setback, alternative finales and aftermath."}],
      npcs:[{key:"keeper",name:"Keeper",archetype:"Guide",visibility:"public",description:"Speaks softly: Welcome.",privateGoals:"Protect the bell."}]});
    expect(parsed.scenePrompts[0]?.prompt).toBe(scene.prompt);
    expect(parsed.npcs[0]?.privateGoals).toBe("Protect the bell.");
    expect(generatedCampaignContentProviderSchema.safeParse({scenePrompts:[{...scene,prompt:"x".repeat(4_001)}]}).success).toBe(false);
    expect(generatedCampaignContentProviderSchema.safeParse({scenePrompts:[{...scene,executeCommand:"combat_start"}]}).success).toBe(false);
  });
  it("strictly distinguishes uncertain recovery from success and missing work", () => {
    const value={campaignId:"campaign",idempotencyKey:"exact-key",state:"outcome-uncertain",attempt:1,draftId:null};
    expect(campaignContentGenerationRecoverySchema.parse(value)).toEqual(value);
    for(const invalid of [{...value,state:"succeeded"},{...value,attempt:0},{...value,state:"not-found"},{...value,providerPayload:"private"},{...value,draftId:"draft"}])expect(campaignContentGenerationRecoverySchema.safeParse(invalid).success).toBe(false);
    expect(campaignContentGenerationRecoverySchema.safeParse({...value,state:"not-found",attempt:0}).success).toBe(true);
  });
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

  it("accepts strict reviewed content for provider-free hydration", () => {
    const request = campaignContentGenerationRequestSchema.parse({
      campaignId: "campaign-1", brief: "Reviewed", tone: "grounded", exclusions: [],
      idempotencyKey: "reviewed-1", sections: ["locations"], reviewedContent: {
        locations: [{ key: "old-road", name: "Old Road", description: "A wet road.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
      },
    });
    expect(request.reviewedContent?.locations[0]?.key).toBe("old-road");
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
