import {gmCampaignFactionsHttpResponseSchema,playerCampaignFactionsHttpResponseSchema,createCampaignFactionHttpRequestSchema,createCampaignFactionHttpResponseSchema,
  factionReputationCommandHttpRequestSchema,factionReputationCommandHttpResponseSchema,
  factionReactionCommandHttpRequestSchema,factionReactionCommandHttpResponseSchema,
  factionRelationCommandHttpRequestSchema,factionRelationCommandHttpResponseSchema,
  actorFactionMembershipCommandHttpRequestSchema,actorFactionMembershipCommandHttpResponseSchema,
  npcFactionMembershipCommandHttpRequestSchema,npcFactionMembershipCommandHttpResponseSchema,resourceIdSchema} from "@velvet/contracts";
import type {FastifyPluginAsync,FastifyReply,FastifyRequest} from "fastify";
import {readRpgFeatureFlags} from "../../../features.js";import {sendApiProblem} from "../../../http/problem.js";
import {WorldAuthorizationError,WorldConflictError,WorldStaleError,WorldUnavailableError,type WorldRepository} from "../../../repo/worldRepo.js";
const OWNER="local-owner",JSON_TYPE=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo=Pick<WorldRepository,"listCampaignFactions"|"createCampaignFaction"|"changeFactionReputation"|"resolveFactionReaction"|"setFactionRelation"|"changeActorFactionMembership"|"changeNpcFactionMembership">;
export interface FactionHttpOptions{factionRepositoryAccessor:()=>Repo}const enabled=()=>{const f=readRpgFeatureFlags();return f.campaign&&f.mechanics;};
const missing=(req:FastifyRequest,rep:FastifyReply,faction=false)=>sendApiProblem(req,rep,404,
  faction?"RPG_FACTION_NOT_FOUND":"RPG_CAMPAIGN_FACTIONS_NOT_FOUND",faction?"Faction not found":"Campaign factions not found");
function fail(req:FastifyRequest,rep:FastifyReply,error:unknown,operation:string,faction=false){
  if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return missing(req,rep,faction);
  if(error instanceof WorldStaleError)return sendApiProblem(req,rep,409,"RPG_WORLD_STALE","World narrative state is stale; refresh before trying again");
  if(error instanceof WorldConflictError)return sendApiProblem(req,rep,409,"RPG_FACTION_CONFLICT","Faction command conflicts with current state");
  req.log.error({operation,method:req.method,route:req.routeOptions.url},"RPG faction operation failed");
  return sendApiProblem(req,rep,500,"RPG_INTERNAL_ERROR","Faction outcome could not be confirmed; reconcile faction state before retrying and do not automatically retry");
}
/** Shared onRequest gate for faction command routes: feature flag, query, ID, and media type. */
async function commandGate(req:FastifyRequest,rep:FastifyReply,label:string,id:string,description:string,hasId:boolean):Promise<boolean>{
  rep.header("cache-control","no-store");
  if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return false;}
  if((req.raw.url??req.url).includes("?")||Object.keys(req.query as Record<string,unknown>).length){
    await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST",`${description} does not accept query parameters`);return false;}
  if(!hasId){await missing(req,rep,true);return false;}
  const type=req.headers["content-type"];
  if(typeof type!=="string"||!JSON_TYPE.test(type)){await sendApiProblem(req,rep,415,"RPG_UNSUPPORTED_MEDIA_TYPE",`${label} requires application/json`);return false;}
  return true;
}
export const factionHttpRoutes:FastifyPluginAsync<FactionHttpOptions>=async(app,options)=>{
  app.get<{Params:{campaignId:string};Querystring:Record<string,unknown>}>("/campaigns/:campaignId/factions",{exposeHeadRoute:false,onRequest:async(req,rep)=>{
    rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
    if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length)await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Campaign factions do not accept query parameters");}},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.campaignId);if(!id.success)return missing(req,rep);try{const result=options.factionRepositoryAccessor().listCampaignFactions(OWNER,id.data);if(result===null)return missing(req,rep);
      const keys=new Set(["campaignId","revision","audience","factions","standings","memberships","relations"]);if(Object.keys(result).length!==7||Object.keys(result).some((key)=>!keys.has(key))||result.campaignId!==id.data)throw new Error("faction list binding is invalid");
      rep.header("x-world-revision",String(result.revision));const schema=result.audience==="gm"?gmCampaignFactionsHttpResponseSchema:playerCampaignFactionsHttpResponseSchema;return rep.send(schema.parse({factions:result.factions,standings:result.standings,memberships:result.memberships,relations:result.relations}));
    }catch(error){return fail(req,rep,error,"faction-list");}});
  app.post<{Params:{campaignId:string};Querystring:Record<string,unknown>;Body:unknown}>("/campaigns/:campaignId/factions",{onRequest:async(req,rep)=>{
    rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
    if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length){await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction creation does not accept query parameters");return;}
    if(!resourceIdSchema.safeParse(req.params.campaignId).success){await missing(req,rep);return;}const type=req.headers["content-type"];if(typeof type!=="string"||!JSON_TYPE.test(type))await sendApiProblem(req,rep,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Faction creation requires application/json");},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction creation request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.campaignId),body=createCampaignFactionHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction creation request is invalid");
    try{const result=options.factionRepositoryAccessor().createCampaignFaction(OWNER,id.data,body.data);if(!("privateState" in result.faction)||result.campaignId!==id.data||result.faction.name!==body.data.name
      ||JSON.stringify(result.faction.publicState)!==JSON.stringify(body.data.publicState)||JSON.stringify(result.faction.privateState)!==JSON.stringify(body.data.privateState)
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction creation binding is invalid");
      return rep.code(201).send(createCampaignFactionHttpResponseSchema.parse({faction:result.faction,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-create");}});
  app.post<{Params:{factionId:string};Querystring:Record<string,unknown>;Body:unknown}>("/factions/:factionId/reputation-commands",{onRequest:async(req,rep)=>{
    rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
    if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length){await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction reputation command does not accept query parameters");return;}
    if(!resourceIdSchema.safeParse(req.params.factionId).success){await missing(req,rep,true);return;}const type=req.headers["content-type"];if(typeof type!=="string"||!JSON_TYPE.test(type))await sendApiProblem(req,rep,415,"RPG_UNSUPPORTED_MEDIA_TYPE","Faction reputation command requires application/json");},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction reputation request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.factionId),body=factionReputationCommandHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep,true);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction reputation request is invalid");
    try{const result=options.factionRepositoryAccessor().changeFactionReputation(OWNER,id.data,body.data);if(result.factionId!==id.data||result.standing.factionId!==id.data||result.standing.subjectActorId!==body.data.subjectActorId
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction reputation binding is invalid");
      return rep.send(factionReputationCommandHttpResponseSchema.parse({standing:result.standing,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-reputation",true);}});
  app.post<{Params:{factionId:string};Querystring:Record<string,unknown>;Body:unknown}>("/factions/:factionId/reaction-commands",{onRequest:async(req,rep)=>{
    if(!await commandGate(req,rep,"Faction reaction command",req.params.factionId,"Faction reaction command",resourceIdSchema.safeParse(req.params.factionId).success))return;},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction reaction request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.factionId),body=factionReactionCommandHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep,true);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction reaction request is invalid");
    try{const result=options.factionRepositoryAccessor().resolveFactionReaction(OWNER,id.data,body.data);if(result.factionId!==id.data||result.standing.factionId!==id.data||result.standing.subjectActorId!==body.data.subjectActorId
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction reaction binding is invalid");
      return rep.send(factionReactionCommandHttpResponseSchema.parse({standing:result.standing,sourceObservationId:result.sourceObservationId,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-reaction",true);}});
  app.post<{Params:{factionId:string};Querystring:Record<string,unknown>;Body:unknown}>("/factions/:factionId/relation-commands",{onRequest:async(req,rep)=>{
    if(!await commandGate(req,rep,"Faction relation command",req.params.factionId,"Faction relation command",resourceIdSchema.safeParse(req.params.factionId).success))return;},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction relation request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.factionId),body=factionRelationCommandHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep,true);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction relation request is invalid");
    try{const result=options.factionRepositoryAccessor().setFactionRelation(OWNER,id.data,body.data);if(result.fromFactionId!==id.data||result.relation.fromFactionId!==id.data||result.relation.toFactionId!==body.data.toFactionId||result.relation.disposition!==body.data.disposition
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction relation binding is invalid");
      return rep.send(factionRelationCommandHttpResponseSchema.parse({relation:result.relation,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-relation",true);}});
  app.post<{Params:{factionId:string};Querystring:Record<string,unknown>;Body:unknown}>("/factions/:factionId/actor-membership-commands",{onRequest:async(req,rep)=>{
    if(!await commandGate(req,rep,"Faction actor membership command",req.params.factionId,"Faction actor membership command",resourceIdSchema.safeParse(req.params.factionId).success))return;},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction actor membership request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.factionId),body=actorFactionMembershipCommandHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep,true);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction actor membership request is invalid");
    try{const result=options.factionRepositoryAccessor().changeActorFactionMembership(OWNER,id.data,body.data);if(result.factionId!==id.data||result.membership.factionId!==id.data||result.membership.actorId!==body.data.actorId||result.membership.role!==body.data.role
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction actor membership binding is invalid");
      return rep.send(actorFactionMembershipCommandHttpResponseSchema.parse({membership:result.membership,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-actor-membership",true);}});
  app.post<{Params:{factionId:string};Querystring:Record<string,unknown>;Body:unknown}>("/factions/:factionId/npc-membership-commands",{onRequest:async(req,rep)=>{
    if(!await commandGate(req,rep,"Faction NPC membership command",req.params.factionId,"Faction NPC membership command",resourceIdSchema.safeParse(req.params.factionId).success))return;},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction NPC membership request is invalid")},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.factionId),body=npcFactionMembershipCommandHttpRequestSchema.safeParse(req.body);if(!id.success)return missing(req,rep,true);if(!body.success)return sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Faction NPC membership request is invalid");
    try{const result=options.factionRepositoryAccessor().changeNpcFactionMembership(OWNER,id.data,body.data);if(result.factionId!==id.data||result.membership.factionId!==id.data||result.membership.npcId!==body.data.npcId||result.membership.role!==body.data.role
      ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)throw new Error("faction NPC membership binding is invalid");
      return rep.send(npcFactionMembershipCommandHttpResponseSchema.parse({membership:result.membership,receipt:{idempotencyKey:result.receipt.idempotencyKey,
        revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return fail(req,rep,error,"faction-npc-membership",true);}});
};
