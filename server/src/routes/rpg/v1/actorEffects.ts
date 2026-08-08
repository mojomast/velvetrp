import { activeEffectSchema, actorEffectsResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { EffectRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";

export interface ActorEffectsHttpOptions {
  effectRepositoryAccessor: () => Pick<EffectRepository, "getActorEffectSnapshot">;
}

function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request,reply,404,"RPG_ACTOR_EFFECTS_NOT_FOUND","Actor effects not found");
}

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
        const effects=internalEffects.map((effect)=>({
          effectId:effect.effectId,source:effect.source,modifiers:effect.modifiers,duration:effect.duration,
          recovery:effect.recovery,stacking:effect.concentration.kind==="required"?"concentration" as const:"coexists" as const,
          appliedAt:effect.appliedAt,
        }));
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
};
