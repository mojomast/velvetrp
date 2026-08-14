import { actorPlacementCommandRequestSchema,actorPlacementCommandResponseSchema,actorTravelCommandRequestSchema,actorTravelCommandResponseSchema,campaignWorldHttpResponseSchema,resourceIdSchema } from "@velvet/contracts";
import type {FastifyPluginAsync,FastifyRequest} from "fastify";
import {readRpgFeatureFlags} from "../../../features.js";
import {sendApiProblem} from "../../../http/problem.js";
import {WorldAuthorizationError,WorldConflictError,WorldStaleError,WorldUnavailableError,type WorldRepository} from "../../../repo/worldRepo.js";

const LOCAL_OWNER="local-owner";
const APPLICATION_JSON=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type WorldHttpRepository=Pick<WorldRepository,"getCampaignWorld"|"travelActor"|"placeActor">;
export interface WorldHttpOptions{worldRepositoryAccessor:()=>WorldHttpRepository;}
function enabled(){const flags=readRpgFeatureFlags();return flags.campaign&&flags.mechanics;}
function campaignNotFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]){
  return sendApiProblem(request,reply,404,"RPG_WORLD_NOT_FOUND","Campaign world not found");
}
function actorNotFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]){
  return sendApiProblem(request,reply,404,"RPG_ACTOR_WORLD_NOT_FOUND","Actor world state not found");
}

export const worldHttpRoutes:FastifyPluginAsync<WorldHttpOptions>=async(app,options)=>{
  app.post<{Params:{actorId:string};Querystring:Record<string,unknown>;Body:unknown}>("/actors/:actorId/placement-commands",{
    onRequest:async(request,reply)=>{reply.header("cache-control","no-store");if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor placement does not accept query parameters");return;}
      const contentType=request.headers["content-type"];if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Actor placement requires application/json");},
    errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor placement request is invalid")},async(request,reply)=>{
      const actorId=resourceIdSchema.safeParse(request.params.actorId),body=actorPlacementCommandRequestSchema.safeParse(request.body);if(!actorId.success)return actorNotFound(request,reply);
      if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor placement request is invalid");
      try{const result=options.worldRepositoryAccessor().placeActor(LOCAL_OWNER,actorId.data,body.data);
        return reply.code(200).send(actorPlacementCommandResponseSchema.parse({location:result.location,receipt:{idempotencyKey:result.receipt.idempotencyKey,
          revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
      }catch(error){if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return actorNotFound(request,reply);
        if(error instanceof WorldStaleError)return sendApiProblem(request,reply,409,"RPG_WORLD_STALE","World state is stale; refresh before trying again");
        if(error instanceof WorldConflictError)return sendApiProblem(request,reply,409,"RPG_PLACEMENT_CONFLICT","Actor placement conflicts with current world state");
        request.log.error({operation:"actor-placement"},"RPG actor placement failed");return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor placement could not be completed");}
    });
  app.get<{Params:{campaignId:string};Querystring:Record<string,unknown>}>("/campaigns/:campaignId/world",{
    exposeHeadRoute:false,onRequest:async(request,reply)=>{reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0)
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Campaign world does not accept query parameters");},
  },async(request,reply)=>{
    const campaignId=resourceIdSchema.safeParse(request.params.campaignId);if(!campaignId.success)return campaignNotFound(request,reply);
    try{
      const world=options.worldRepositoryAccessor().getCampaignWorld(LOCAL_OWNER,campaignId.data);if(world===null)return campaignNotFound(request,reply);
      const allowed=new Set(["campaignId","sessionId","revision","currentLocations","visibleLocations","visibleConnections"]);
      if(Object.keys(world).length!==allowed.size||Object.keys(world).some((key)=>!allowed.has(key))||world.campaignId!==campaignId.data
        ||!resourceIdSchema.safeParse(world.sessionId).success)throw new Error("campaign world binding is invalid");
      reply.header("x-world-revision",String(world.revision));
      return reply.code(200).send(campaignWorldHttpResponseSchema.parse({currentLocations:world.currentLocations,
        visibleLocations:world.visibleLocations,visibleConnections:world.visibleConnections}));
    }catch(error){
      if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return campaignNotFound(request,reply);
      if(error instanceof WorldConflictError)return sendApiProblem(request,reply,409,"RPG_WORLD_CONFLICT","Campaign world session is ambiguous");
      request.log.error({operation:"campaign-world-read",method:request.method,route:request.routeOptions.url},"RPG campaign world read failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Campaign world could not be loaded");
    }
  });

  app.post<{Params:{actorId:string};Querystring:Record<string,unknown>;Body:unknown}>("/actors/:actorId/travel-commands",{
    onRequest:async(request,reply)=>{reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor travel does not accept query parameters");return;}
      if(!resourceIdSchema.safeParse(request.params.actorId).success){await actorNotFound(request,reply);return;}
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))
        await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Actor travel requires application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor travel request is invalid"),
  },async(request,reply)=>{
    const actorId=resourceIdSchema.safeParse(request.params.actorId);if(!actorId.success)return actorNotFound(request,reply);
    const body=actorTravelCommandRequestSchema.safeParse(request.body);
    if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor travel request is invalid");
    try{
      const result=options.worldRepositoryAccessor().travelActor(LOCAL_OWNER,actorId.data,body.data);
      const allowed=new Set(["campaignId","sessionId","locations","discoveries","receipt"]);
      if(Object.keys(result).length!==allowed.size||Object.keys(result).some((key)=>!allowed.has(key))
        ||!resourceIdSchema.safeParse(result.campaignId).success||!resourceIdSchema.safeParse(result.sessionId).success
        ||!result.locations.some((location)=>location.actorId===actorId.data)
        ||JSON.stringify(result.locations.map((location)=>location.actorId))!==JSON.stringify(body.data.partyActorIds)
        ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision
        ||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("actor travel result binding is invalid");
      return reply.code(200).send(actorTravelCommandResponseSchema.parse({locations:result.locations,discoveries:result.discoveries,
        receipt:{idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,
          revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){
      if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return actorNotFound(request,reply);
      if(error instanceof WorldStaleError)return sendApiProblem(request,reply,409,"RPG_WORLD_STALE","World state is stale; refresh before trying again");
      if(error instanceof WorldConflictError)return sendApiProblem(request,reply,409,"RPG_TRAVEL_CONFLICT","Travel conflicts with current world state");
      request.log.error({operation:"actor-travel",method:request.method,route:request.routeOptions.url},"RPG actor travel failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR",
        "Travel outcome could not be confirmed; reconcile world state before retrying and do not automatically retry");
    }
  });
};
