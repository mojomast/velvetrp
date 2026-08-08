import {
  combatLogEntrySchema,
  combatLogQuerySchema,
  combatLogResponseSchema,
  combatReadResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { EncounterAuthorizationError, type EncounterRepository } from "../../../repo/index.js";

const LOCAL_OWNER="local-owner";
type CombatReadRepository=Pick<EncounterRepository,"getCombatState"|"listCombatLogPage">;
export interface CombatReadsHttpOptions { combatRepositoryAccessor:()=>CombatReadRepository; }

function enabled():boolean{const flags=readRpgFeatureFlags();return flags.campaign&&flags.mechanics&&flags.combat;}
function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]){
  return sendApiProblem(request,reply,404,"RPG_COMBAT_NOT_FOUND","Combat not found");
}

export const combatReadsHttpRoutes:FastifyPluginAsync<CombatReadsHttpOptions>=async(app,options)=>{
  app.get<{Params:{combatId:string};Querystring:Record<string,unknown>}>("/combats/:combatId",{
    exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled()){await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((request.raw.url??request.url).includes("?")||Object.keys(request.query).length>0)
        await sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat state does not accept query parameters");
    },
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    try{
      const combat=options.combatRepositoryAccessor().getCombatState(LOCAL_OWNER,combatId.data);
      if(combat===null)return notFound(request,reply);
      const allowed=new Set(["campaignId","encounterId","combatId","round","currentCombatant","combatants","legalActions","revision"]);
      if(Object.keys(combat).length!==allowed.size||Object.keys(combat).some((key)=>!allowed.has(key))
        ||combat.combatId!==combatId.data||combat.encounterId!==combatId.data||!resourceIdSchema.safeParse(combat.campaignId).success)
        throw new Error("combat state binding is invalid");
      return reply.code(200).send(combatReadResponseSchema.parse({round:combat.round,currentCombatant:combat.currentCombatant,
        combatants:combat.combatants,legalActions:combat.legalActions,revision:combat.revision}));
    }catch(error){
      if(error instanceof EncounterAuthorizationError)return notFound(request,reply);
      request.log.error({operation:"combat-read",method:request.method,route:request.routeOptions.url},"RPG combat read failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Combat state could not be loaded");
    }
  });

  app.get<{Params:{combatId:string};Querystring:Record<string,unknown>}>("/combats/:combatId/log",{
    exposeHeadRoute:false,onRequest:async(request,reply)=>{
      reply.header("cache-control","no-store");
      if(!enabled())await sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");
    },
  },async(request,reply)=>{
    const combatId=resourceIdSchema.safeParse(request.params.combatId);if(!combatId.success)return notFound(request,reply);
    const query=combatLogQuerySchema.safeParse(request.query);
    if(!query.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","Combat log request is invalid");
    try{
      const page=options.combatRepositoryAccessor().listCombatLogPage(LOCAL_OWNER,combatId.data,query.data.afterSequence,query.data.limit);
      if(page===null)return notFound(request,reply);
      const allowed=new Set(["campaignId","encounterId","entries","nextAfterSequence"]);
      if(Object.keys(page).length!==allowed.size||Object.keys(page).some((key)=>!allowed.has(key))
        ||page.encounterId!==combatId.data||!resourceIdSchema.safeParse(page.campaignId).success
        ||page.entries.length>query.data.limit||page.entries.some((entry)=>entry.sequence<=query.data.afterSequence))
        throw new Error("combat log page binding is invalid");
      const entries=page.entries.map((entry)=>{
        const internal=combatLogEntrySchema.parse(entry);
        if(internal.campaignId!==page.campaignId||internal.encounterId!==combatId.data)
          throw new Error("combat log entry binding is invalid");
        return {logEntryId:internal.logEntryId,sequence:internal.sequence,occurredAt:internal.occurredAt,event:internal.event};
      });
      return reply.code(200).send(combatLogResponseSchema.parse({entries,nextAfterSequence:page.nextAfterSequence}));
    }catch(error){
      if(error instanceof EncounterAuthorizationError)return notFound(request,reply);
      request.log.error({operation:"combat-log-read",method:request.method,route:request.routeOptions.url},"RPG combat log read failed");
      return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Combat log could not be loaded");
    }
  });
};
