import {
  combatActionCommandRequestSchema,
  combatActionCommandResponseSchema,
  combatEndCommandRequestSchema,
  combatEndCommandResponseSchema,
  resourceIdSchema,
  type CombatState,
  type EncounterPublic,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
  type EncounterRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER="local-owner";
const APPLICATION_JSON=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type CombatCommandRepository=Pick<EncounterRepository,"resolveCombatAction"|"endCombat">;
export interface CombatCommandsHttpOptions{combatCommandRepositoryAccessor:()=>CombatCommandRepository;}

function enabled():boolean{const flags=readRpgFeatureFlags();return flags.campaign&&flags.mechanics&&flags.combat;}
function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]){
  return sendApiProblem(request,reply,404,"RPG_COMBAT_NOT_FOUND","Combat not found");
}
function publicCombat(value:ReturnType<CombatCommandRepository["resolveCombatAction"]>["combat"]):CombatState{
  const allowed=new Set(["campaignId","encounterId","combatId","round","currentCombatant","combatants","legalActions","revision"]);
  if(Object.keys(value).length!==allowed.size||Object.keys(value).some((key)=>!allowed.has(key)))throw new Error("combat result shape is invalid");
  return {combatId:value.combatId,round:value.round,currentCombatant:value.currentCombatant,combatants:value.combatants,
    legalActions:value.legalActions,revision:value.revision};
}
function publicEncounter(value:ReturnType<CombatCommandRepository["endCombat"]>["encounter"]):EncounterPublic{
  const allowed=new Set(["campaignId","encounterId","sessionId","name","status","combatId","combatants","revision","createdAt","updatedAt"]);
  if(Object.keys(value).length!==allowed.size||Object.keys(value).some((key)=>!allowed.has(key)))throw new Error("encounter result shape is invalid");
  return {encounterId:value.encounterId,sessionId:value.sessionId,name:value.name,status:value.status,combatId:value.combatId,
    combatants:value.combatants,revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt};
}

export const combatCommandsHttpRoutes:FastifyPluginAsync<CombatCommandsHttpOptions>=async(app,options)=>{
  app.post<{Params:{combatId:string};Querystring:Record<string,unknown>;Body:unknown}>("/combats/:combatId/action-commands",{
    onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat action does not accept query parameters");return;
      }
      if(!resourceIdSchema.safeParse(request.params.combatId).success){await notFound(request,reply);return;}
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))
        await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Combat action requires application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat action request is invalid"),
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    const body=combatActionCommandRequestSchema.safeParse(request.body);
    if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat action request is invalid");
    try{
      const result=options.combatCommandRepositoryAccessor().resolveCombatAction(LOCAL_OWNER,combatId.data,body.data);
      if(result.encounterId!==combatId.data||result.combat.encounterId!==combatId.data||result.combat.combatId!==combatId.data
        ||result.campaignId!==result.combat.campaignId||result.resolution.legalActionId!==body.data.legalActionId
        ||JSON.stringify(result.resolution.targetIds)!==JSON.stringify(body.data.targetIds)
        ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision
        ||result.receipt.revisionAfter!==body.data.expectedRevision+1||result.combat.revision!==result.receipt.revisionAfter)
        throw new Error("combat action result binding is invalid");
      return reply.code(200).send(combatActionCommandResponseSchema.parse({resolution:result.resolution,
        combat:publicCombat(result.combat),receipt:{idempotencyKey:result.receipt.idempotencyKey,
          revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){
      if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
      if(error instanceof EncounterStaleError)return sendApiProblem(request,reply,409,"RPG_COMBAT_STALE","Combat state is stale; refresh before trying again");
      if(error instanceof EncounterConflictError||error instanceof EncounterTurnError)
        return sendApiProblem(request,reply,409,"RPG_COMBAT_ACTION_CONFLICT","Combat action conflicts with current state");
      request.log.error({operation:"combat-action",method:request.method,route:request.routeOptions.url},"RPG combat action failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR",
        "Combat action outcome could not be confirmed; reconcile combat state before retrying and do not automatically retry");
    }
  });

  app.post<{Params:{combatId:string};Querystring:Record<string,unknown>;Body:unknown}>("/combats/:combatId/end-commands",{
    onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat end does not accept query parameters");return;
      }
      if(!resourceIdSchema.safeParse(request.params.combatId).success){await notFound(request,reply);return;}
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))
        await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Combat end requires application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat end request is invalid"),
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    const body=combatEndCommandRequestSchema.safeParse(request.body);
    if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat end request is invalid");
    try{
      const result=options.combatCommandRepositoryAccessor().endCombat(LOCAL_OWNER,combatId.data,body.data);
      if(result.encounterId!==combatId.data||result.encounter.encounterId!==combatId.data||result.encounter.combatId!==combatId.data
        ||result.encounter.campaignId!==result.campaignId||result.encounter.status!=="completed"
        ||result.rewards.some((reward)=>reward.campaignId!==result.campaignId||reward.encounterId!==combatId.data)
        ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision
        ||result.receipt.revisionAfter!==body.data.expectedRevision+1||result.encounter.revision!==result.receipt.revisionAfter)
        throw new Error("combat end result binding is invalid");
      const rewards=result.rewards.map((reward)=>{
        const allowed=new Set(["campaignId","encounterId","rewardBundleId","recipientActorId","createdAt","rewards"]);
        if(Object.keys(reward).length!==allowed.size||Object.keys(reward).some((key)=>!allowed.has(key)))
          throw new Error("combat reward shape is invalid");
        return {rewardBundleId:reward.rewardBundleId,recipientActorId:reward.recipientActorId,
          createdAt:reward.createdAt,rewards:reward.rewards};
      });
      return reply.code(200).send(combatEndCommandResponseSchema.parse({encounter:publicEncounter(result.encounter),rewards,
        receipt:{idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,
          revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){
      if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
      if(error instanceof EncounterStaleError)return sendApiProblem(request,reply,409,"RPG_COMBAT_STALE","Combat state is stale; refresh before trying again");
      if(error instanceof EncounterConflictError||error instanceof EncounterTurnError)
        return sendApiProblem(request,reply,409,"RPG_COMBAT_END_CONFLICT","Combat cannot be ended in its current state");
      request.log.error({operation:"combat-end",method:request.method,route:request.routeOptions.url},"RPG combat end failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR",
        "Combat end outcome could not be confirmed; reconcile encounter and reward state before retrying and do not automatically retry");
    }
  });
};
