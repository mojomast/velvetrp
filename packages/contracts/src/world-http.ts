import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema } from "./rpg-characters.js";
import { locationConnectionIdSchema, locationIdSchema, MAX_TRAVEL_PARTY_SIZE } from "./world.js";

export const worldCurrentLocationHttpSchema=z.object({
  actorId:actorIdSchema,locationId:locationIdSchema,revision:revisionSchema,updatedAt:utcIsoTimestampSchema,
}).strict();
export const worldVisibleLocationHttpSchema=z.object({
  locationId:locationIdSchema,parentLocationId:locationIdSchema.nullable(),name:z.string().trim().min(1).max(200),
  description:z.string().max(4_000),
}).strict();
export const worldVisibleConnectionHttpSchema=z.object({
  connectionId:locationConnectionIdSchema,fromLocationId:locationIdSchema,toLocationId:locationIdSchema,
}).strict();
export const campaignWorldHttpResponseSchema=z.object({
  currentLocations:z.array(worldCurrentLocationHttpSchema).max(1_000),
  visibleLocations:z.array(worldVisibleLocationHttpSchema).max(10_000),
  visibleConnections:z.array(worldVisibleConnectionHttpSchema).max(10_000),
}).strict();

export const actorTravelCommandRequestSchema=z.object({
  connectionId:locationConnectionIdSchema,
  partyActorIds:z.array(actorIdSchema).min(1).max(MAX_TRAVEL_PARTY_SIZE),
  expectedRevision:expectedRevisionSchema,
  idempotencyKey:idempotencyKeySchema,
}).strict().superRefine((request,context)=>{
  if(new Set(request.partyActorIds).size!==request.partyActorIds.length)
    context.addIssue({code:"custom",message:"party actor IDs must be unique",path:["partyActorIds"]});
});
export const actorTravelDiscoveryHttpSchema=z.object({
  actorId:actorIdSchema,locationId:locationIdSchema,discoveredAt:utcIsoTimestampSchema,
}).strict();
export const worldCommandReceiptHttpSchema=z.object({
  idempotencyKey:idempotencyKeySchema,revisionBefore:revisionSchema,revisionAfter:revisionSchema,
  occurredAt:utcIsoTimestampSchema,
}).strict().refine((receipt)=>receipt.revisionAfter===receipt.revisionBefore+1,
  "a world command advances exactly one revision");
export const actorTravelCommandResponseSchema=z.object({
  locations:z.array(worldCurrentLocationHttpSchema).min(1).max(MAX_TRAVEL_PARTY_SIZE),
  discoveries:z.array(actorTravelDiscoveryHttpSchema).min(1).max(MAX_TRAVEL_PARTY_SIZE),
  receipt:worldCommandReceiptHttpSchema,
}).strict().superRefine((response,context)=>{
  const locations=response.locations.map((location)=>location.actorId);
  const discoveries=response.discoveries.map((discovery)=>discovery.actorId);
  if(new Set(locations).size!==locations.length||JSON.stringify(locations)!==JSON.stringify(discoveries))
    context.addIssue({code:"custom",message:"travel locations and discoveries must cover the same ordered party"});
  if(response.locations.some((location,index)=>location.locationId!==response.discoveries[index]?.locationId))
    context.addIssue({code:"custom",message:"travel discoveries must match resultant locations"});
});

export type CampaignWorldHttpResponse=z.infer<typeof campaignWorldHttpResponseSchema>;
export type ActorTravelCommandRequest=z.infer<typeof actorTravelCommandRequestSchema>;
export type ActorTravelCommandResponse=z.infer<typeof actorTravelCommandResponseSchema>;
export type WorldCurrentLocationHttp=z.infer<typeof worldCurrentLocationHttpSchema>;
export type ActorTravelDiscoveryHttp=z.infer<typeof actorTravelDiscoveryHttpSchema>;

export const npcPublicStateHttpSchema=z.object({name:z.string().trim().min(1).max(200)}).strict();
export const npcPrivateStateHttpSchema=z.object({
  goals:z.string().max(8_000),gmNotes:z.string().max(8_000),
  merchantState:z.record(z.string(),z.json()).nullable(),
}).strict().refine((state)=>state.merchantState===null||JSON.stringify(state.merchantState).length<=16_000,
  {message:"merchant state must fit durable storage",path:["merchantState"]});
export const campaignNpcHttpSchema=z.object({
  npcId:resourceIdSchema,personaId:resourceIdSchema.optional(),publicState:npcPublicStateHttpSchema,
  privateState:npcPrivateStateHttpSchema.optional(),createdAt:utcIsoTimestampSchema,
}).strict().refine((npc)=>(npc.personaId===undefined)===(npc.privateState===undefined),
  "persona and private state must appear together only in GM projections");
export const npcRelationshipHttpSchema=z.object({
  npcId:resourceIdSchema,subjectActorId:actorIdSchema,
  affinity:z.number().int().min(-1000).max(1000),trust:z.number().int().min(-1000).max(1000),
  fear:z.number().int().min(-1000).max(1000),updatedAt:utcIsoTimestampSchema,
}).strict();
export const campaignNpcsHttpResponseSchema=z.object({
  npcs:z.array(campaignNpcHttpSchema).max(1_000),relationships:z.array(npcRelationshipHttpSchema).max(10_000),
}).strict();
export const createCampaignNpcHttpRequestSchema=z.object({
  personaId:resourceIdSchema,publicState:npcPublicStateHttpSchema,privateState:npcPrivateStateHttpSchema,
  expectedRevision:expectedRevisionSchema,idempotencyKey:idempotencyKeySchema,
}).strict();
export const createCampaignNpcHttpResponseSchema=z.object({npc:campaignNpcHttpSchema,receipt:worldCommandReceiptHttpSchema}).strict();
export const npcRelationshipCommandHttpRequestSchema=z.object({
  subjectActorId:actorIdSchema,affinityDelta:z.number().int().min(-100).max(100),
  trustDelta:z.number().int().min(-100).max(100),fearDelta:z.number().int().min(-100).max(100),
  reason:z.string().trim().min(1).max(500),expectedRevision:expectedRevisionSchema,idempotencyKey:idempotencyKeySchema,
}).strict().refine((request)=>request.affinityDelta!==0||request.trustDelta!==0||request.fearDelta!==0,
  "at least one relationship delta is required");
export const npcRelationshipCommandHttpResponseSchema=z.object({
  relationship:npcRelationshipHttpSchema,receipt:worldCommandReceiptHttpSchema,
}).strict();

export type CampaignNpcHttp=z.infer<typeof campaignNpcHttpSchema>;
export type NpcRelationshipHttp=z.infer<typeof npcRelationshipHttpSchema>;
export type CreateCampaignNpcHttpRequest=z.infer<typeof createCampaignNpcHttpRequestSchema>;
export type NpcRelationshipCommandHttpRequest=z.infer<typeof npcRelationshipCommandHttpRequestSchema>;
