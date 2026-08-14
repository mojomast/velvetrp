import {
  combatActionCommandRequestSchema,
  combatActionCommandResponseSchema,
  combatEndCommandRequestSchema,
  combatEndCommandResponseSchema,
  combatCommandResultResponseSchema,
  combatRewardClaimRequestSchema,
  combatRewardClaimResponseSchema,
  combatRewardClaimResultResponseSchema,
  idempotencyKeySchema,
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
type CombatCommandRepository=Pick<EncounterRepository,"resolveCombatAction"|"endCombat"|"getCombatCommandResult"|"claimCombatReward"|"listCombatRewards"|"getCombatRewardClaimResult">;
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
  app.get<{Params:{campaignId:string;combatId:string;rewardBundleId:string;claimIdentity:string};Querystring:Record<string,unknown>}>(
    "/campaigns/:campaignId/combats/:combatId/rewards/:rewardBundleId/claim-results/:claimIdentity",{exposeHeadRoute:false,
      onRequest:async(request,reply)=>{reply.header("cache-control","no-store");if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
        if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0)await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat reward claim result does not accept query parameters");}},
    async(request,reply)=>{
      const campaignId=resourceIdSchema.safeParse(request.params.campaignId),combatId=resourceIdSchema.safeParse(request.params.combatId),
        bundleId=resourceIdSchema.safeParse(request.params.rewardBundleId),identity=idempotencyKeySchema.safeParse(request.params.claimIdentity);
      if(!campaignId.success||!combatId.success||!bundleId.success||!identity.success)return notFound(request,reply);
      try{const result=options.combatCommandRepositoryAccessor().getCombatRewardClaimResult(LOCAL_OWNER,campaignId.data,combatId.data,bundleId.data,identity.data);
        if(result===null)return notFound(request,reply);const response=combatRewardClaimResultResponseSchema.parse(result),binding=response.requestBinding;
        if(binding.campaignId!==campaignId.data||binding.combatId!==combatId.data||binding.rewardBundleId!==bundleId.data
            ||(binding.requestEvidence.idempotencyKey!==identity.data&&binding.requestEvidence.rewardClaimId!==identity.data))throw new Error("claim result route binding is invalid");
        return reply.code(200).send(response);
      }catch{request.log.error({operation:"combat-reward-claim-result"},"RPG combat reward claim result read failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Combat reward claim result could not be loaded");}
    });
  app.post<{Params:{combatId:string;rewardBundleId:string};Querystring:Record<string,unknown>;Body:unknown}>("/combats/:combatId/rewards/:rewardBundleId/claim-commands",{
    onRequest:async(request,reply)=>{reply.header("cache-control","no-store");if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0){await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat reward claim does not accept query parameters");return;}
      const contentType=request.headers["content-type"];if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Combat reward claim requires application/json");},
    errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat reward claim request is invalid")},async(request,reply)=>{
      const combatId=resourceIdSchema.safeParse(request.params.combatId),bundleId=resourceIdSchema.safeParse(request.params.rewardBundleId),body=combatRewardClaimRequestSchema.safeParse(request.body);
      if(!combatId.success||!bundleId.success)return notFound(request,reply);if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat reward claim request is invalid");
      try{const result=options.combatCommandRepositoryAccessor().claimCombatReward(LOCAL_OWNER,combatId.data,bundleId.data,body.data);
        const reward=options.combatCommandRepositoryAccessor().listCombatRewards(LOCAL_OWNER,combatId.data)?.find((value)=>value.rewardBundleId===bundleId.data);
        if(!reward||reward.claim.state!=="claimed")throw new Error("claimed reward projection is unavailable");
        return reply.code(200).send(combatRewardClaimResponseSchema.parse({reward,receipt:{idempotencyKey:result.receipt.idempotencyKey,
          revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
      }catch(error){if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
        if(error instanceof EncounterStaleError)return sendApiProblem(request,reply,409,"RPG_COMBAT_STALE","Combat state is stale; refresh before trying again");
        if(error instanceof EncounterConflictError)return sendApiProblem(request,reply,409,"RPG_REWARD_CLAIM_CONFLICT","Combat reward is already claimed or conflicts with current state");
        request.log.error({operation:"combat-reward-claim"},"RPG combat reward claim failed");return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Combat reward claim outcome could not be confirmed");}
    });
  app.get<{Params:{campaignId:string;combatId:string;idempotencyKey:string};Querystring:Record<string,unknown>}>(
    "/campaigns/:campaignId/combats/:combatId/command-results/:idempotencyKey",{exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0)
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat command result does not accept query parameters");
    }},async(request,reply)=>{
      const campaignId=resourceIdSchema.safeParse(request.params.campaignId),combatId=resourceIdSchema.safeParse(request.params.combatId),key=idempotencyKeySchema.safeParse(request.params.idempotencyKey);
      if(!campaignId.success||!combatId.success||!key.success)return notFound(request,reply);
      try{
        const result=options.combatCommandRepositoryAccessor().getCombatCommandResult("local-owner",campaignId.data,combatId.data,key.data);
        if(result===null)return notFound(request,reply);
        const response=combatCommandResultResponseSchema.parse(result);
        const bound=response.operation==="action"?response.result.combat.combatId===combatId.data&&response.result.receipt.idempotencyKey===key.data
          :response.result.encounter.encounterId===combatId.data&&response.result.receipt.idempotencyKey===key.data;
        if(!bound)throw new Error("combat command result binding is invalid");
        return reply.code(200).send(response);
      }catch{
        request.log.error({operation:"combat-command-result",method:request.method,route:request.routeOptions.url},"RPG combat command result read failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Combat command result could not be loaded");
      }
    });
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
        const allowed=new Set(["campaignId","encounterId","rewardBundleId","recipientActorId","createdAt","rewards","claim"]);
        if(Object.keys(reward).length!==allowed.size||Object.keys(reward).some((key)=>!allowed.has(key)))
          throw new Error("combat reward shape is invalid");
        return {rewardBundleId:reward.rewardBundleId,recipientActorId:reward.recipientActorId,
          createdAt:reward.createdAt,rewards:reward.rewards,claim:reward.claim};
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
