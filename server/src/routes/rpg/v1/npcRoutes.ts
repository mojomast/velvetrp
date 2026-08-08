import {campaignNpcsHttpResponseSchema,createCampaignNpcHttpRequestSchema,createCampaignNpcHttpResponseSchema,
  npcRelationshipCommandHttpRequestSchema,npcRelationshipCommandHttpResponseSchema,resourceIdSchema} from "@velvet/contracts";
import type {FastifyPluginAsync,FastifyRequest} from "fastify";
import {readRpgFeatureFlags} from "../../../features.js";import {sendApiProblem} from "../../../http/problem.js";
import {WorldAuthorizationError,WorldConflictError,WorldStaleError,WorldUnavailableError,type WorldRepository} from "../../../repo/worldRepo.js";
const LOCAL_OWNER="local-owner",JSON_TYPE=/^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type NpcRepository=Pick<WorldRepository,"listCampaignNpcs"|"createCampaignNpc"|"changeNpcRelationship">;
export interface NpcHttpOptions{npcRepositoryAccessor:()=>NpcRepository;}
const enabled=()=>{const f=readRpgFeatureFlags();return f.campaign&&f.mechanics;};
const missing=(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1],npc=false)=>sendApiProblem(request,reply,404,
  npc?"RPG_NPC_NOT_FOUND":"RPG_CAMPAIGN_NPCS_NOT_FOUND",npc?"NPC not found":"Campaign NPCs not found");
function failure(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1],error:unknown,operation:string,npc=false){
  if(error instanceof WorldAuthorizationError||error instanceof WorldUnavailableError)return missing(request,reply,npc);
  if(error instanceof WorldStaleError)return sendApiProblem(request,reply,409,"RPG_WORLD_STALE","World narrative state is stale; refresh before trying again");
  if(error instanceof WorldConflictError)return sendApiProblem(request,reply,409,"RPG_NPC_CONFLICT","NPC command conflicts with current state");
  request.log.error({operation,method:request.method,route:request.routeOptions.url},"RPG NPC operation failed");
  return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","NPC outcome could not be confirmed; reconcile NPC state before retrying and do not automatically retry");
}
export const npcHttpRoutes:FastifyPluginAsync<NpcHttpOptions>=async(app,options)=>{
  app.get<{Params:{campaignId:string};Querystring:Record<string,unknown>}>("/campaigns/:campaignId/npcs",{exposeHeadRoute:false,
    onRequest:async(req,rep)=>{rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length)await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","Campaign NPCs do not accept query parameters");}},
  async(request,reply)=>{const campaignId=resourceIdSchema.safeParse(request.params.campaignId);if(!campaignId.success)return missing(request,reply);
    try{const result=options.npcRepositoryAccessor().listCampaignNpcs(LOCAL_OWNER,campaignId.data);if(result===null)return missing(request,reply);
      const allowed=new Set(["campaignId","revision","npcs","relationships"]);if(Object.keys(result).length!==allowed.size||Object.keys(result).some((key)=>!allowed.has(key))||result.campaignId!==campaignId.data)throw new Error("NPC list binding is invalid");
      reply.header("x-world-revision",String(result.revision));return reply.send(campaignNpcsHttpResponseSchema.parse({npcs:result.npcs,relationships:result.relationships}));
    }catch(error){return failure(request,reply,error,"npc-list");}});

  app.post<{Params:{campaignId:string};Querystring:Record<string,unknown>;Body:unknown}>("/campaigns/:campaignId/npcs",{
    onRequest:async(req,rep)=>{rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length){await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","NPC creation does not accept query parameters");return;}
      if(!resourceIdSchema.safeParse(req.params.campaignId).success){await missing(req,rep);return;}const type=req.headers["content-type"];
      if(typeof type!=="string"||!JSON_TYPE.test(type))await sendApiProblem(req,rep,415,"RPG_UNSUPPORTED_MEDIA_TYPE","NPC creation requires application/json");},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","NPC creation request is invalid")},
  async(request,reply)=>{const campaignId=resourceIdSchema.safeParse(request.params.campaignId);if(!campaignId.success)return missing(request,reply);
    const body=createCampaignNpcHttpRequestSchema.safeParse(request.body);if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","NPC creation request is invalid");
    try{const result=options.npcRepositoryAccessor().createCampaignNpc(LOCAL_OWNER,campaignId.data,body.data);
      if(result.campaignId!==campaignId.data||result.npc.personaId!==body.data.personaId
        ||JSON.stringify(result.npc.publicState)!==JSON.stringify(body.data.publicState)
        ||JSON.stringify(result.npc.privateState)!==JSON.stringify(body.data.privateState)
        ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)
        throw new Error("NPC creation binding is invalid");return reply.code(201).send(createCampaignNpcHttpResponseSchema.parse({npc:result.npc,
          receipt:{idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return failure(request,reply,error,"npc-create");}});

  app.post<{Params:{npcId:string};Querystring:Record<string,unknown>;Body:unknown}>("/npcs/:npcId/relationship-commands",{
    onRequest:async(req,rep)=>{rep.header("cache-control","no-store");if(!enabled()){await sendApiProblem(req,rep,404,"RPG_ROUTE_NOT_FOUND","RPG route not found");return;}
      if((req.raw.url??req.url).includes("?")||Object.keys(req.query).length){await sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","NPC relationship command does not accept query parameters");return;}
      if(!resourceIdSchema.safeParse(req.params.npcId).success){await missing(req,rep,true);return;}const type=req.headers["content-type"];
      if(typeof type!=="string"||!JSON_TYPE.test(type))await sendApiProblem(req,rep,415,"RPG_UNSUPPORTED_MEDIA_TYPE","NPC relationship command requires application/json");},
    errorHandler:(_error,req,rep)=>sendApiProblem(req,rep,400,"RPG_INVALID_REQUEST","NPC relationship request is invalid")},
  async(request,reply)=>{const npcId=resourceIdSchema.safeParse(request.params.npcId);if(!npcId.success)return missing(request,reply,true);
    const body=npcRelationshipCommandHttpRequestSchema.safeParse(request.body);if(!body.success)return sendApiProblem(request,reply,400,"RPG_INVALID_REQUEST","NPC relationship request is invalid");
    try{const result=options.npcRepositoryAccessor().changeNpcRelationship(LOCAL_OWNER,npcId.data,body.data);
      if(result.npcId!==npcId.data||result.relationship.npcId!==npcId.data||result.relationship.subjectActorId!==body.data.subjectActorId
        ||result.receipt.idempotencyKey!==body.data.idempotencyKey||result.receipt.revisionBefore!==body.data.expectedRevision||result.receipt.revisionAfter!==body.data.expectedRevision+1)
        throw new Error("NPC relationship binding is invalid");return reply.send(npcRelationshipCommandHttpResponseSchema.parse({relationship:result.relationship,
          receipt:{idempotencyKey:result.receipt.idempotencyKey,revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt}}));
    }catch(error){return failure(request,reply,error,"npc-relationship",true);}});
};
