import {
  idempotencyKeySchema,
  resourceIdSchema,
  useConsumableCommandRequestSchema,
  useConsumableCommandResultSchema,
  useConsumableLegalActionSchema,
  type UseConsumableCommandRequest,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError, EncounterUnavailableError,
  type EncounterRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER="local-owner";
const APPLICATION_JSON=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type ConsumableRepository=Pick<EncounterRepository,"getUseConsumableLegalActions"|"useConsumable"|"getUseConsumableCommandResultByKey">;
export interface CombatConsumablesHttpOptions{consumableRepositoryAccessor:()=>ConsumableRepository;}

const enabled=()=>{const flags=readRpgFeatureFlags();return flags.campaign&&flags.mechanics&&flags.combat;};
const notFound=(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1])=>
  sendApiProblem(request,reply,404,"RPG_COMBAT_CONSUMABLE_NOT_FOUND","Consumable action not found");
const hasBody=(request:FastifyRequest)=>request.headers["content-length"]!==undefined||request.headers["transfer-encoding"]!==undefined;
const exactRequest=(left:UseConsumableCommandRequest,right:UseConsumableCommandRequest)=>JSON.stringify(left)===JSON.stringify(right);
const sameItem=(left:UseConsumableCommandRequest["item"],right:UseConsumableCommandRequest["item"])=>left.kind===right.kind
  &&left.packId===right.packId&&left.packVersion===right.packVersion&&left.definitionId===right.definitionId;

export const combatConsumablesHttpRoutes:FastifyPluginAsync<CombatConsumablesHttpOptions>=async(app,options)=>{
  app.get<{Params:{combatId:string};Querystring:Record<string,unknown>}>("/combats/:combatId/consumable-actions",{
    exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length||hasBody(request))
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Consumable actions do not accept a query or body");
    },
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    try{
      const actions=options.consumableRepositoryAccessor().getUseConsumableLegalActions(LOCAL_OWNER,combatId.data)
        .map((action)=>useConsumableLegalActionSchema.parse(action));
      return reply.code(200).send(actions);
    }catch(error){
      if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
      request.log.error({operation:"combat-consumable-actions",method:request.method,route:request.routeOptions.url},"RPG consumable actions failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Consumable actions could not be loaded");
    }
  });

  app.get<{Params:{combatId:string;idempotencyKey:string};Querystring:Record<string,unknown>}>(
    "/combats/:combatId/consumable-actions/results/:idempotencyKey",{exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length||hasBody(request))
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Consumable results do not accept a query or body");
    }},async(request,reply)=>{
      const combatId=resourceIdSchema.safeParse(request.params.combatId),key=idempotencyKeySchema.safeParse(request.params.idempotencyKey);
      if(!combatId.success||!key.success)return notFound(request,reply);
      try{
        const result=options.consumableRepositoryAccessor().getUseConsumableCommandResultByKey(LOCAL_OWNER,combatId.data,key.data);
        if(result===null)return notFound(request,reply);
        const response=useConsumableCommandResultSchema.parse(result);
        if(response.receipt.idempotencyKey!==key.data)throw new Error("consumable result binding is invalid");
        return reply.code(200).send(response);
      }catch(error){
        if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
        request.log.error({operation:"combat-consumable-result",method:request.method,route:request.routeOptions.url},"RPG consumable result failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Consumable result could not be loaded");
      }
    });

  app.post<{Params:{combatId:string};Querystring:Record<string,unknown>;Body:unknown}>("/combats/:combatId/consumable-actions/commands",{
    onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length){await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Consumable commands do not accept query parameters");return;}
      if(!resourceIdSchema.safeParse(request.params.combatId).success){await notFound(request,reply);return;}
      const contentType=request.headers["content-type"];
      if(typeof contentType!=="string"||!APPLICATION_JSON.test(contentType))await sendApiProblem(request,reply,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Consumable commands require application/json");
    },errorHandler:(_error,request,reply)=>sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Consumable command request is invalid"),
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    const body=useConsumableCommandRequestSchema.safeParse(request.body);
    if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Consumable command request is invalid");
    try{
      const repository=options.consumableRepositoryAccessor();
      const replay=repository.getUseConsumableCommandResultByKey(LOCAL_OWNER,combatId.data,body.data.idempotencyKey);
      if(replay!==null){
        const result=useConsumableCommandResultSchema.parse(replay);
        if(!exactRequest(result.requestBinding.requestEvidence,body.data))throw new EncounterConflictError("idempotency key was reused");
        return reply.code(200).send(result);
      }
      const action=repository.getUseConsumableLegalActions(LOCAL_OWNER,combatId.data).find((candidate)=>candidate.legalActionId===body.data.legalActionId);
      if(!action)return notFound(request,reply);
      if(action.inventoryEntryId!==body.data.inventoryEntryId||!sameItem(action.item,body.data.item)
        ||action.quantity!==body.data.quantity||action.target.combatantId!==body.data.targetCombatantId
        ||action.target.actorBacked!==body.data.targetActorBacked)
        throw new EncounterConflictError("request differs from the server-derived consumable action");
      const result=useConsumableCommandResultSchema.parse(repository.useConsumable(LOCAL_OWNER,body.data));
      if(!exactRequest(result.requestBinding.requestEvidence,body.data))throw new Error("consumable command result binding is invalid");
      return reply.code(200).send(result);
    }catch(error){
      if(error instanceof EncounterAuthorizationError||error instanceof EncounterUnavailableError)return notFound(request,reply);
      if(error instanceof EncounterStaleError)return sendApiProblem(request,reply,409,"RPG_COMBAT_STALE","Combat or actor state is stale; refresh before trying again");
      if(error instanceof EncounterConflictError||error instanceof EncounterTurnError)
        return sendApiProblem(request,reply,409,"RPG_COMBAT_CONSUMABLE_CONFLICT","Consumable action conflicts with current state");
      request.log.error({operation:"combat-consumable-command",method:request.method,route:request.routeOptions.url},"RPG consumable command failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Consumable outcome could not be confirmed. Do not retry POST while unresolved; read the exact result and refresh authoritative state");
    }
  });
};
