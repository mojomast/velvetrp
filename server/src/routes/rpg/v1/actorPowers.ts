import { actorPowersResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { PowerRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";

export interface ActorPowersHttpOptions {
  powerRepositoryAccessor: () => Pick<PowerRepository, "getActorPowerSnapshot">;
}

function notFound(request:FastifyRequest,reply:Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request,reply,404,"RPG_ACTOR_POWERS_NOT_FOUND","Actor powers not found");
}

/** GET-only today; this module is the future actor-only power command boundary. */
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
        const allowed=new Set(["campaignId","actorId","known","prepared","slots","uses","legalNow","revision"]);
        if(typeof snapshot!=="object"||Object.keys(snapshot).some((key)=>!allowed.has(key)))
          throw new Error("actor power snapshot shape is invalid");
        if(snapshot.actorId!==actorId.data||!resourceIdSchema.safeParse(snapshot.campaignId).success)
          throw new Error("actor power snapshot binding is invalid");
        return reply.code(200).send(actorPowersResponseSchema.parse({
          known:snapshot.known,prepared:snapshot.prepared,slots:snapshot.slots,
          uses:snapshot.uses,legalNow:snapshot.legalNow,revision:snapshot.revision,
        }));
      }catch{
        request.log.error({operation:"actor-powers-read",method:request.method,route:request.routeOptions.url},"RPG actor powers read failed");
        return sendApiProblem(request,reply,500,"RPG_INTERNAL_ERROR","Actor powers could not be loaded");
      }
    },
  );
};
