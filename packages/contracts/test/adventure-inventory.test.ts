import { describe,expect,it } from "vitest";
import { adventureInventoryCandidateSchema,adventureInventoryPublicReceiptSchema,adventureInventorySelectionSchema } from "../src/index.js";

const at="2035-01-01T00:00:00.000Z";
describe("adventure inventory contracts",()=>{
  it("accepts only opaque provider selection fields",()=>{expect(adventureInventorySelectionSchema.parse({candidateId:"candidate",digest:"a".repeat(64)})).toEqual({candidateId:"candidate",digest:"a".repeat(64)});
    expect(adventureInventorySelectionSchema.safeParse({candidateId:"candidate",digest:"a".repeat(64),entryId:"private",quantity:99}).success).toBe(false);});
  it("binds exact public action details and non-effectful consume semantics",()=>{expect(adventureInventoryCandidateSchema.parse({candidateId:"candidate",digest:"a".repeat(64),itemLabel:"Waylamp",action:"consume",quantity:1,slot:null,recipient:null,confirmationRequired:true,effect:"none"}).effect).toBe("none");
    expect(adventureInventoryCandidateSchema.safeParse({candidateId:"candidate",digest:"a".repeat(64),itemLabel:"Waylamp",action:"consume",quantity:1,slot:null,recipient:null,confirmationRequired:false,effect:"inventory-only"}).success).toBe(false);});
  it("keeps the public receipt narrow and revision exact",()=>{const receipt={itemLabel:"Waylamp",action:"gift",quantity:1,slot:null,recipient:"Briar",revisionBefore:2,revisionAfter:3,occurredAt:at} as const;
    expect(adventureInventoryPublicReceiptSchema.parse(receipt)).toEqual(receipt);expect(adventureInventoryPublicReceiptSchema.safeParse({...receipt,revisionAfter:4,entryId:"private"}).success).toBe(false);});
});
