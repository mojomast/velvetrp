import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { requestedCampaignContentProviderSchema, sectionFields, validateContent } from "../src/routes/rpg/v1/campaignContentGeneration.js";

function world() {
  return generatedCampaignContentProviderSchema.parse({
    outlines:[{key:"opening",opening:"Two roads lead out of the market.",premise:"Choose whom to help.",startLocationKey:"market",visibility:"public"}],
    arcs:[{key:"tension",title:"Rising tolls",summary:"Independent factions seek leverage.",visibility:"gm"}],
    locations:["market","harbor","ridge"].map((key)=>({key,name:key,description:"An accessible place.",visibility:"public"})),
    connections:[{key:"road",fromLocationKey:"market",toLocationKey:"ridge",description:"Uphill",visibility:"public"},{key:"canal",fromLocationKey:"market",toLocationKey:"harbor",description:"Towpath",visibility:"public"}],
    factions:[{key:"guild",name:"Guild",description:"Carriers",visibility:"public"}],
    npcs:[{key:"guide",name:"Guide",archetype:"Scout",description:"Offers routes",locationKey:"market",visibility:"public"}],
    quests:[{key:"delivery",title:"Deliver a letter",description:"Find a willing recipient",objectives:[{key:"deliver",description:"Bring the letter to the harbor",visibility:"public"}],visibility:"public"}],
    encounters:[{key:"debate",title:"Toll debate",description:"Negotiate passage",visibility:"public"}],
    clues:[{key:"notice",title:"Notice",description:"A new toll",visibility:"public"}],
    storyNodes:[{key:"arrival",title:"Arrival",description:"The market opens",visibility:"public"}],
    lore:[{key:"custom",title:"Hospitality",summary:"Travelers share news",visibility:"public"}],
    questItems:[{key:"letter",name:"Letter",description:"A sealed letter",mechanics:{state:"inert",reason:"Narrative prop"},visibility:"public"}],
    monsterConcepts:[{key:"beast",name:"Ridge beast",description:"A rumored beast",role:"Rumor",mechanics:{state:"inert",reason:"No catalog match"},visibility:"gm"}],
    handouts:[{key:"map",title:"Map",content:"Roads from the market",visibility:"public"}],
    scenePrompts:[{key:"bargain",title:"Bargain",prompt:"Ask which route the players want",visibility:"gm"}],
  });
}
const validate=(content:ReturnType<typeof world>)=>validateContent(content,Object.keys(sectionFields),new Map(),new Set());

describe("complete-world structural guarantees",()=>{
  it("allows a branching public graph and inert narrative concepts",()=>{
    expect(validate(world()).locations).toHaveLength(3);
  });
  it("requires a public start and reachable public places, not secret-only paths",()=>{
    const missing=world();delete missing.outlines[0]!.startLocationKey;
    expect(()=>validate(missing)).toThrow(/public starting location/);
    const disconnected=world();disconnected.connections.pop();
    expect(()=>validate(disconnected)).toThrow(/connected/);
    const secret=world();secret.connections[0]!.visibility="gm";
    expect(()=>validate(secret)).toThrow(/connected/);
    const reversed=world();reversed.connections[1]!.fromLocationKey="harbor";reversed.connections[1]!.toLocationKey="market";
    expect(()=>validate(reversed)).toThrow(/directed paths/);
  });
  it("requires NPC placement and actionable quests for full coverage but allows sparse concepts",()=>{
    const unplaced=world();delete unplaced.npcs[0]!.locationKey;
    expect(()=>validate(unplaced)).toThrow(/NPCs require locations/);
    const empty=world();empty.quests[0]!.objectives=[];
    expect(()=>validate(empty)).toThrow(/quests require actionable objectives/);
    const sparse=generatedCampaignContentProviderSchema.parse({npcs:unplaced.npcs,quests:empty.quests});
    expect(()=>validateContent(sparse,["npcs","quests"],new Map(),new Set())).not.toThrow();
    expect(()=>validateContent(sparse,["npcs","quests"],new Map(),new Set(),{npcs:1})).toThrow(/NPCs require locations/);
    expect(()=>validateContent(sparse,["npcs","quests"],new Map(),new Set(),{quests:1})).toThrow(/quests require actionable objectives/);
  });
  it("rejects cross-kind keys even when the key exists and has compatible visibility",()=>{
    const content=world();content.npcs[0]!.locationKey="guild";
    expect(()=>validate(content)).toThrow(/locationKey must reference location/);
    const quest=world();quest.quests[0]!.arcKey="market";
    expect(()=>validate(quest)).toThrow(/arcKey must reference arc/);
  });
  it("expresses declared count minimums and existing caps in the sparse provider schema",()=>{
    const schema=z.toJSONSchema(requestedCampaignContentProviderSchema(["locations"],{locations:4,connections:3}));
    expect(schema.properties).toMatchObject({locations:{minItems:4,maxItems:16},connections:{minItems:3,maxItems:24}});
    expect(Object.keys(schema.properties!)).toEqual(["locations","connections"]);
  });
});
