import { activeEffectSchema, actorEffectCommandRequestSchema, actorEffectCommandResponseSchema, actorEffectsResponseSchema, resourceIdSchema, type ActiveEffect } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { EffectImmuneError, EffectUnavailableError, M16AuthorizationError, M16ConflictError, M16StaleError, type EffectRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorEffectsHttpOptions {
  effectRepositoryAccessor: () => Pick<EffectRepository, "getActorEffectSnapshot"|"mutateActorEffect">;
}

function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request,reply,404,"RPG_ACTOR_EFFECTS_NOT_FOUND","Actor effects not found");
}

const publicEffect=(effect:ActiveEffect)=>({
  effectId:effect.effectId,source:effect.source,modifiers:effect.modifiers,duration:effect.duration,
  recovery:effect.recovery,stacking:effect.concentration.kind==="required"?"concentration" as const:"coexists" as const,
  appliedAt:effect.appliedAt,
});

export const actorEffectsHttpRoutes:FastifyPluginAsync<ActorEffectsHttpOptions>=async(app,options)=>{
  app.get<{Params:{actorId:string};Querystring:Record<string,unknown>}>(
    "/actors/:actorId/effects",
    {exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      const flags=readRpgFeatureFlags();
      if(!flags.campaign||!flags.mechanics){
        await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");
        return;
      }
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor effects do not accept query parameters");
      }
    }},
    async(request,reply)=>{
      const actorId=resourceIdSchema.safeParse(request.params.actorId);
      if(!actorId.success)return notFound(request,reply);
      try{
        const snapshot=options.effectRepositoryAccessor().getActorEffectSnapshot(LOCAL_OWNER,actorId.data);
        if(snapshot===null)return notFound(request,reply);
        const allowed=new Set(["campaignId","actorId","effects","revision"]);
        if(typeof snapshot!=="object"||Object.keys(snapshot).length!==allowed.size
          ||Object.keys(snapshot).some((key)=>!allowed.has(key)))throw new Error("actor effect snapshot shape is invalid");
        if(snapshot.actorId!==actorId.data||!resourceIdSchema.safeParse(snapshot.campaignId).success)
          throw new Error("actor effect snapshot binding is invalid");
        const internalEffects=snapshot.effects.map((value)=>activeEffectSchema.parse(value));
        if(internalEffects.some((effect)=>effect.campaignId!==snapshot.campaignId||effect.actorId!==actorId.data))
          throw new Error("actor effect entry binding is invalid");
        const effects=internalEffects.map(publicEffect);
        const concentration=internalEffects
          .flatMap((effect)=>effect.concentration.kind==="required"
            ?[{effectId:effect.effectId,concentrationId:effect.concentration.concentrationId}]:[])
          .sort((left,right)=>left.effectId.localeCompare(right.effectId));
        return reply.code(200).send(actorEffectsResponseSchema.parse({effects,concentration,revision:snapshot.revision}));
      }catch{
        request.log.error({operation:"actor-effects-read",method:request.method,route:request.routeOptions.url},"RPG actor effects read failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor effects could not be loaded");
      }
    },
  );
  app.post<{Params:{actorId:string};Querystring:Record<string,unknown>;Body:unknown}>(
    "/actors/:actorId/effect-commands",
    {exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      const flags=readRpgFeatureFlags();
      if(!flags.campaign||!flags.mechanics){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor effect commands do not accept query parameters");return;
      }
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))
        await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Actor effect command requires application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor effect command request is invalid")},
    async(request,reply)=>{
      const actorId=resourceIdSchema.safeParse(request.params.actorId);
      if(!actorId.success)return notFound(request,reply);
      const body=actorEffectCommandRequestSchema.safeParse(request.body);
      if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Actor effect command request is invalid");
      try{
        const result=options.effectRepositoryAccessor().mutateActorEffect(LOCAL_OWNER,actorId.data,body.data);
        const internalEffects=result.effects.map((value)=>activeEffectSchema.parse(value));
        if(result.actorId!==actorId.data||!resourceIdSchema.safeParse(result.campaignId).success
          ||internalEffects.some((effect)=>effect.actorId!==actorId.data||effect.campaignId!==result.campaignId)
          ||result.receipt.idempotencyKey!==body.data.idempotencyKey
          ||result.receipt.revisionBefore!==body.data.expectedRevision
          ||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("actor effect result binding is invalid");
        return reply.code(200).send(actorEffectCommandResponseSchema.parse({effects:internalEffects.map(publicEffect),receipt:{
          idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,
          revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt,
        }}));
      }catch(error){
        if(error instanceof M16AuthorizationError)return notFound(request,reply);
        if(error instanceof M16StaleError)return sendApiProblem(request,reply,409,"RPG_ACTOR_EFFECT_STALE","Actor effect state is stale; refresh before trying again");
        if(error instanceof M16ConflictError||error instanceof EffectUnavailableError||error instanceof EffectImmuneError)
          return sendApiProblem(request,reply,409,"RPG_ACTOR_EFFECT_CONFLICT","Actor effect command conflicts with current state");
        request.log.error({operation:"actor-effect-command",method:request.method,route:request.routeOptions.url},"RPG actor effect command failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor effect outcome could not be confirmed; reconcile actor state before retrying and do not automatically retry");
      }
    },
  );
};
