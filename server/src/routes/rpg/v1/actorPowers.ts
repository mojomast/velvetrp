import { actorPowerCommandRequestSchema, actorPowerCommandResponseSchema, actorPowersResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { ActorPowerConflictError, ActorPowerInsufficientError, ActorPowerNotFoundError, M16AuthorizationError, M16ConflictError, M16StaleError, PowerInsufficientResourceError, PowerUnavailableError, type PowerRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorPowersHttpOptions {
  powerRepositoryAccessor: () => Pick<PowerRepository, "getActorPowerSnapshot"|"useActorPower">;
}

function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request,reply,404,"RPG_ACTOR_POWERS_NOT_FOUND","Actor powers not found");
}

export const actorPowersHttpRoutes:FastifyPluginAsync<ActorPowersHttpOptions>=async(app,options)=>{
  app.get<{Params:{actorId:string};Querystring:Record<string,unknown>}>(
    "/actors/:actorId/powers",
    {exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      const flags=readRpgFeatureFlags();
      if(!flags.campaign||!flags.mechanics){
        await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");
        return;
      }
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor powers do not accept query parameters");
      }
    }},
    async(request,reply)=>{
      const actorId=resourceIdSchema.safeParse(request.params.actorId);
      if(!actorId.success)return notFound(request,reply);
      try{
        const snapshot=options.powerRepositoryAccessor().getActorPowerSnapshot(LOCAL_OWNER,actorId.data);
        if(snapshot===null)return notFound(request,reply);
        const allowed=new Set(["campaignId","actorId","known","prepared","slots","uses","legalNow","legalCommands","revision"]);
        if(typeof snapshot!=="object"||Object.keys(snapshot).some((key)=>!allowed.has(key)))
          throw new Error("actor power snapshot shape is invalid");
        if(snapshot.actorId!==actorId.data||!resourceIdSchema.safeParse(snapshot.campaignId).success)
          throw new Error("actor power snapshot binding is invalid");
        return reply.code(200).send(actorPowersResponseSchema.parse({
          known:snapshot.known,prepared:snapshot.prepared,slots:snapshot.slots,
          uses:snapshot.uses,legalNow:snapshot.legalNow,legalCommands:snapshot.legalCommands,revision:snapshot.revision,
        }));
      }catch{
        request.log.error({operation:"actor-powers-read",method:request.method,route:request.routeOptions.url},"RPG actor powers read failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor powers could not be loaded");
      }
    },
  );
  app.post<{Params:{actorId:string};Querystring:Record<string,unknown>;Body:unknown}>(
    "/actors/:actorId/power-commands",
    {exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");const flags=readRpgFeatureFlags();
      if(!flags.campaign||!flags.mechanics){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor power commands do not accept query parameters");return;}
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Actor power command requires application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor power command request is invalid")},
    async(request,reply)=>{
      const actorId=resourceIdSchema.safeParse(request.params.actorId);if(!actorId.success)return notFound(request,reply);
      const body=actorPowerCommandRequestSchema.safeParse(request.body);if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor power command request is invalid");
      try{
        const result=options.powerRepositoryAccessor().useActorPower(LOCAL_OWNER,actorId.data,body.data);
        const response=actorPowerCommandResponseSchema.parse({resolution:result.resolution,actorStates:result.actorStates,receipt:{idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}});
        const targetsMatch=JSON.stringify(response.resolution.targetIds)===JSON.stringify(body.data.targetIds)
          ||(body.data.targetIds.length===0&&response.resolution.targetIds.length===1&&response.resolution.targetIds[0]===actorId.data);
        if(response.actorStates[0]?.actorId!==actorId.data
          || JSON.stringify(response.resolution.powerRef)!==JSON.stringify(body.data.powerRef)
          ||!targetsMatch
          || response.receipt.idempotencyKey!==body.data.idempotencyKey
          || response.receipt.revisionBefore!==body.data.expectedRevision)throw new Error("actor power result binding is invalid");
        return reply.code(200).send(response);
      }catch(error){
        if(error instanceof ActorPowerNotFoundError||error instanceof M16AuthorizationError)return notFound(request,reply);
        if(error instanceof M16StaleError)return sendApiProblem(request,reply,409,"RPG_ACTOR_POWER_STALE","Actor power state is stale; refresh before trying again");
        if(error instanceof ActorPowerConflictError||error instanceof ActorPowerInsufficientError||error instanceof PowerUnavailableError||error instanceof PowerInsufficientResourceError||error instanceof M16ConflictError)return sendApiProblem(request,reply,409,"RPG_ACTOR_POWER_CONFLICT","Actor power command conflicts with current state");
        request.log.error({operation:"actor-power-command",method:request.method,route:request.routeOptions.url},"RPG actor power command failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor power outcome could not be confirmed; reconcile actor state before retrying and do not automatically retry");
      }
    },
  );
};
