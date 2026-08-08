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
