import {gmCampaignFactionsHttpResponseSchema,playerCampaignFactionsHttpResponseSchema,createCampaignFactionHttpRequestSchema,createCampaignFactionHttpResponseSchema,
  factionReputationCommandHttpRequestSchema,factionReputationCommandHttpResponseSchema,resourceIdSchema} from "@velvet/contracts";
import type {FastifyPluginAsync,FastifyRequest} from "fastify";
import {readRpgFeatureFlags} from "../../../features.js";import {sendApiProblem} from "../../../http/problem.js";
import {WorldAuthorizationError,WorldConflictError,WorldStaleError,WorldUnavailableError,type WorldRepository} from "../../../repo/worldRepo.js";
const OWNER="local-owner",JSON_TYPE=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo=Pick<WorldRepository,"listCampaignFactions"|"createCampaignFaction"|"changeFactionReputation">;
export interface FactionHttpOptions{factionRepositoryAccessor:()=>Repo}const enabled=()=>{const f=readRpgFeatureFlags();return f.campaign&&f.mechanics;};
const missing=(req:FastifyRequest,rep:Parameters<typeof sendApiProblem>[1],faction=false)=>sendApiProblem(req,rep,404,
  faction?"RPG_FACTION_NOT_FOUND":"RPG_CAMPAIGN_FACTIONS_NOT_FOUND",faction?"Faction not found":"Campaign factions not found");
function fail(req:FastifyRequest,rep:Parameters<typeof sendApiProblem>[1],error:unknown,operation:string,faction=false){
  if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return missing(req,rep,faction);
  if(error instanceof WorldStaleError)return sendApiProblem(req,rep,409,"RPG_WORLD_STALE","World narrative state is stale; refresh before trying again");
  if(error instanceof WorldConflictError)return sendApiProblem(req,rep,409,"RPG_FACTION_CONFLICT","Faction command conflicts with current state");
  req.log.error({operation,method:req.method,route:req.routeOptions.url},"RPG faction operation failed");
  return sendApiProblem(req,rep,500,"RPG_INTERNAL_ERROR","Faction outcome could not be confirmed; reconcile faction state before retrying and do not automatically retry");
}
export const factionHttpRoutes:FastifyPluginAsync<FactionHttpOptions>=async(app,options)=>{
  app.get<{Params:{campaignId:string};Querystring:Record<string,unknown>}>("/campaigns/:campaignId/factions",{exposeHeadRoute:false,onRequest:async(req,rep)=>{
    rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
    if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length)await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Campaign factions do not accept query parameters");}},async(req,rep)=>{
    const id=resourceIdSchema.safeParse(req.params.campaignId);if(!id.success)return missing(req,rep);try{const result=options.factionRepositoryAccessor().listCampaignFactions(OWNER,id.data);if(result===null)return missing(req,rep);
      const keys=new Set(["campaignId","revision","audience","factions","standings"]);if(Object.keys(result).length!==5||Object.keys(result).some((key)=>!keys.has(key))||result.campaignId!==id.data)throw new Error("faction list binding is invalid");
      rep.header("x-world-revision",String(result.revision));const schema=result.audience==="gm"?gmCampaignFactionsHttpResponseSchema:playerCampaignFactionsHttpResponseSchema;return rep.send(schema.parse({factions:result.factions,standings:result.standings}));
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
};
