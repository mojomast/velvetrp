import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { requestIdSchema } from "@velvet/contracts";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { readRpgFeatureFlags } from "./features.js";
import { sendApiProblem } from "./http/problem.js";
import { createRepository } from "./repo/index.js";
import { roleplayCharacterRoutes } from "./routes/roleplay/characters.js";
import { roleplayHarnessRoutes } from "./routes/roleplay/harness.js";
import { roleplayInteractionRoutes } from "./routes/roleplay/interactions.js";
import { roleplayLoreRoutes } from "./routes/roleplay/lore.js";
import { roleplayMemoryRoutes } from "./routes/roleplay/memories.js";
import { roleplayPromptTemplateRoutes } from "./routes/roleplay/promptTemplates.js";
import { roleplayProviderRoutes } from "./routes/roleplay/provider.js";
import { roleplaySessionLifecycleRoutes } from "./routes/roleplay/sessionLifecycle.js";
import { roleplaySessionRoutes } from "./routes/roleplay/sessions.js";
import { roleplaySystemRoutes } from "./routes/roleplay/system.js";
import { roleplayUsageRoutes } from "./routes/roleplay/usage.js";
import { rpgV1Routes } from "./routes/rpg/v1/features.js";
import type { CampaignListRepository } from "./routes/rpg/v1/features.js";
import { systemRuntime } from "./runtime.js";
import type { RuntimeDependencies } from "./runtime.js";
import type { AdventureAgentDependencies } from "./agent/adventureOrchestrator.js";
import type { GenerationDraftsHttpOptions } from "./routes/rpg/v1/generationDrafts.js";

interface NormalizedCampaignResourceRoute {
  instance: string;
  hasQuery: boolean;
  queryDetail: string | null;
  mechanics?: boolean;
  combat?: boolean;
  noStore?: boolean;
}

interface RequestLogInput {
  method: string;
  routeOptions?: { url?: unknown };
}

/**
 * Automatic request serialization can run before routing, when only the
 * concrete caller-controlled URL is available. Never retain that URL. A route
 * template is included only when Fastify has already attached one.
 */
export function serializeRequestForLog(request: RequestLogInput): { method: string; route?: string } {
  const route = request.routeOptions?.url;
  return typeof route === "string"
    ? { method: request.method, route }
    : { method: request.method };
}

function normalizedCampaignResourceRoute(method: string, rawUrl: string): NormalizedCampaignResourceRoute | null {
  const queryIndex = rawUrl.indexOf("?");
  const instance = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const hasQuery = queryIndex !== -1;

  if (instance === "/api/rpg/v1/adventure-turns/reconcile-initial") {
    return { instance, hasQuery, queryDetail: null, mechanics: true, noStore: true };
  }
  if (instance === "/api/rpg/v1/adventure-turns/stream") {
    return { instance, hasQuery, queryDetail: method === "POST" ? "Adventure turn streams do not accept query parameters" : null,
      mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/adventure-turns\/[^/]+(?:\/confirm)?$/.test(instance)) {
    const confirm = instance.endsWith("/confirm");
    return { instance: confirm ? "/api/rpg/v1/adventure-turns/:turnId/confirm" : "/api/rpg/v1/adventure-turns/:turnId",
      hasQuery, queryDetail: confirm ? method === "POST" ? "Adventure turn confirmation does not accept query parameters" : null
        : method === "GET" ? "Adventure turn reads do not accept query parameters" : null, mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/generation-drafts(?:\/[^/]+(?:\/apply)?)?$/.test(instance)) {
    const collection = instance === "/api/rpg/v1/generation-drafts", apply = instance.endsWith("/apply");
    return { instance: collection ? instance : apply ? "/api/rpg/v1/generation-drafts/:draftId/apply" : "/api/rpg/v1/generation-drafts/:draftId",
      hasQuery, queryDetail: collection ? method === "POST" ? "Generation draft creation does not accept query parameters" : null
        : apply ? method === "POST" ? "Generation draft apply does not accept query parameters" : null
          : method === "GET" ? "Generation draft reads do not accept query parameters" : null, mechanics: true, noStore: true };
  }

  if (/^\/api\/rpg\/v1\/actors\/[^/]+\/check-commands$/.test(instance)) {
    return {
      instance: "/api/rpg/v1/actors/:actorId/check-commands",
      hasQuery,
      queryDetail: method === "POST" ? "Actor checks do not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/actors\/[^/]+\/travel-commands$/.test(instance)) {
    return {instance:"/api/rpg/v1/actors/:actorId/travel-commands",hasQuery,
      queryDetail:method==="POST"?"Actor travel does not accept query parameters":null,mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/actors\/[^/]+\/(?:powers|power-commands)$/.test(instance)) {
    const command = instance.endsWith("/power-commands");
    return {
      instance: command
        ? "/api/rpg/v1/actors/:actorId/power-commands"
        : "/api/rpg/v1/actors/:actorId/powers",
      hasQuery,
      queryDetail: command
        ? method === "POST" ? "Actor power commands do not accept query parameters" : null
        : method === "GET" ? "Actor powers do not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/actors\/[^/]+\/(?:effects|effect-commands)$/.test(instance)) {
    const command = instance.endsWith("/effect-commands");
    return {
      instance: command
        ? "/api/rpg/v1/actors/:actorId/effect-commands"
        : "/api/rpg/v1/actors/:actorId/effects",
      hasQuery,
      queryDetail: command
        ? method === "POST" ? "Actor effect commands do not accept query parameters" : null
        : method === "GET" ? "Actor effects do not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/encounters\/[^/]+\/start-commands$/.test(instance)) {
    return {
      instance: "/api/rpg/v1/encounters/:encounterId/start-commands",
      hasQuery,
      queryDetail: method === "POST" ? "Encounter start does not accept query parameters" : null,
      mechanics: true,
      combat: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/npcs\/[^/]+\/relationship-commands$/.test(instance)) {
    return {instance:"/api/rpg/v1/npcs/:npcId/relationship-commands",hasQuery,
      queryDetail:method==="POST"?"NPC relationship command does not accept query parameters":null,mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/factions\/[^/]+\/reputation-commands$/.test(instance)) {
    return {instance:"/api/rpg/v1/factions/:factionId/reputation-commands",hasQuery,
      queryDetail:method==="POST"?"Faction reputation command does not accept query parameters":null,mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/quests\/[^/]+\/commands$/.test(instance)) {
    return { instance: "/api/rpg/v1/quests/:questId/commands", hasQuery,
      queryDetail: method === "POST" ? "Quest commands do not accept query parameters" : null,
      mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/storylines\/[^/]+\/commands$/.test(instance)) {
    return { instance: "/api/rpg/v1/storylines/:storylineId/commands", hasQuery,
      queryDetail: method === "POST" ? "Storyline commands do not accept query parameters" : null,
      mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/combats\/[^/]+\/command-results\/[^/]+$/.test(instance)) {
    return { instance: "/api/rpg/v1/campaigns/:campaignId/combats/:combatId/command-results/:idempotencyKey", hasQuery,
      queryDetail: method === "GET" ? "Combat command result does not accept query parameters" : null,
      mechanics: true, combat: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/combats\/[^/]+(?:\/(?:log|action-commands|end-commands))?$/.test(instance)) {
    const log=instance.endsWith("/log"),action=instance.endsWith("/action-commands"),end=instance.endsWith("/end-commands");
    return {
      instance:log?"/api/rpg/v1/combats/:combatId/log":action?"/api/rpg/v1/combats/:combatId/action-commands"
        :end?"/api/rpg/v1/combats/:combatId/end-commands":"/api/rpg/v1/combats/:combatId",
      hasQuery,
      queryDetail:method==="GET"?(log?"Combat log request is invalid":!action&&!end?"Combat state does not accept query parameters":null)
        :method==="POST"?(action?"Combat action does not accept query parameters":end?"Combat end does not accept query parameters":null):null,
      mechanics:true,
      combat:true,
      noStore:true,
    };
  }

  if (/^\/api\/rpg\/v1\/campaign-imports\/[^/]+\/apply$/.test(instance)) {
    return {
      instance: "/api/rpg/v1/campaign-imports/:importId/apply",
      hasQuery,
      queryDetail: method === "POST" ? "Campaign import apply does not accept query parameters" : null,
      noStore: true,
    };
  }

  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/creation-options$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign character creation options do not accept query parameters"
        : null,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/dice-rolls$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign dice history does not accept query parameters"
        : method === "POST" ? "Campaign dice roll does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/world$/.test(instance)) {
    return {instance:"/api/rpg/v1/campaigns/:campaignId/world",hasQuery,
      queryDetail:method==="GET"?"Campaign world does not accept query parameters":null,mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/npcs$/.test(instance)) {
    return {instance:"/api/rpg/v1/campaigns/:campaignId/npcs",hasQuery,
      queryDetail:method==="GET"?"Campaign NPCs do not accept query parameters":method==="POST"?"NPC creation does not accept query parameters":null,
      mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/factions$/.test(instance)) {
    return {instance:"/api/rpg/v1/campaigns/:campaignId/factions",hasQuery,
      queryDetail:method==="GET"?"Campaign factions do not accept query parameters":method==="POST"?"Faction creation does not accept query parameters":null,
      mechanics:true,noStore:true};
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/encounters$/.test(instance)) {
    return {
      instance: "/api/rpg/v1/campaigns/:campaignId/encounters",
      hasQuery,
      queryDetail: method === "GET"
        ? "Encounter list does not accept query parameters"
        : method === "POST" ? "Encounter creation does not accept query parameters" : null,
      mechanics: true,
      combat: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/rooms$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign rooms do not accept query parameters"
        : method === "PUT" ? "Campaign room attachment does not accept query parameters" : null,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/rooms\/[^/]+\/play-bootstrap$/.test(instance)) {
    return {
      instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/play-bootstrap",
      hasQuery,
      queryDetail: method === "GET" ? "Campaign play bootstrap does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/content(?:-packs\/[^/]+\/versions\/[^/]+)?$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "PUT" ? "Campaign content does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/rooms\/[^/]+$/.test(instance)) {
    return { instance, hasQuery, queryDetail: method === "DELETE" ? "Campaign room detachment does not accept query parameters" : null, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/memberships(?:\/[^/]+)?$/.test(instance)) {
    return { instance, hasQuery, queryDetail: method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE"
      ? "Campaign memberships do not accept query parameters" : null, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign character roster does not accept query parameters"
        : method === "POST"
          ? "Campaign character creation does not accept query parameters"
          : null,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/starter-setup$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "PUT" ? "Starter setup does not accept query parameters" : null,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/mechanics-starter-setup$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "PUT" ? "Mechanics starter setup does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/character-drafts(?:\/[^/]+(?:\/finalize)?)?$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST" || method === "PATCH"
        ? "Character draft does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/(?:xp-commands|progression(?:\/(?:preview|apply))?)$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST"
        ? "Character progression does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/sheet$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" ? "Campaign character sheet does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:resources|resource-commands)$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST" ? "Actor resources do not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:inventory|inventory-commands)$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST" ? "Actor inventory does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:wallet|economy-commands)$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST" ? "Actor economy does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/shops\/[^/]+$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" ? "Shop does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/rest-commands$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "POST" ? "Actor rest does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/administration$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "PATCH" || method === "DELETE"
        ? "Campaign administration does not accept query parameters" : null,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/(?:timelines|checkpoints|timeline-forks|recaps)$/.test(instance)
    || /^\/api\/rpg\/v1\/campaigns\/[^/]+\/commands\/[^/]+\/receipt$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET" || method === "POST" ? "Campaign history does not accept query parameters" : null,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/events$/.test(instance)) {
    return { instance, hasQuery, queryDetail: method === "GET" ? "Campaign history request is invalid" : null, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/story$/.test(instance)) {
    return { instance: "/api/rpg/v1/campaigns/:campaignId/story", hasQuery,
      queryDetail: method === "GET" ? "Campaign story does not accept query parameters" : null, mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/storylines$/.test(instance)) {
    return { instance: "/api/rpg/v1/campaigns/:campaignId/storylines", hasQuery,
      queryDetail: method === "GET" || method === "POST" ? "Storyline request does not accept query parameters" : null, mechanics: true, noStore: true };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/storylines(?:\/[^/]+(?:\/status)?)?$/.test(instance)
    || /^\/api\/rpg\/v1\/campaigns\/[^/]+\/quests(?:\/[^/]+(?:\/(?:clues(?:\/[^/]+\/discover)?|rewards(?:\/[^/]+\/grant)?|objectives|status))?)?$/.test(instance)) {
    const questList = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/quests$/.test(instance);
    return {
      instance,
      hasQuery,
      queryDetail: questList && method === "GET" ? "Campaign quests do not accept query parameters"
        : method === "GET" || method === "POST" || method === "PATCH" ? "Quest request does not accept query parameters" : null,
      mechanics: true,
      noStore: true,
    };
  }
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign detail does not accept query parameters"
        : method === "PATCH"
          ? "Campaign rename does not accept query parameters"
          : null,
      noStore: method === "GET",
    };
  }
  if (/^\/api\/rpg\/v1\/content-packs(?:\/validate|\/[^/]+\/versions\/[^/]+)?$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: instance === "/api/rpg/v1/content-packs" && method === "GET" ? null : "Content catalog request does not accept query parameters",
      mechanics: true,
      noStore: true,
    };
  }
  return null;
}

function safeRouterMessage(errorCode: string): string {
  return errorCode === "FST_ERR_MAX_PARAM_LENGTH"
    ? "Request URL exceeds the routing limit"
    : "Request URL is invalid";
}

export function buildApp(options: {
  runtime?: RuntimeDependencies;
  campaignRepositoryFactory?: () => CampaignListRepository;
  loggerStream?: Writable;
  diceCommandIds?: { nextId(): string };
  adventureAgentDependencies?: AdventureAgentDependencies;
  encounterGeneration?: GenerationDraftsHttpOptions["generateEncounter"];
} = {}) {
  const runtime = options.runtime ?? systemRuntime;
  const app = Fastify({
    logger: process.env.NODE_ENV === "test"
      ? false
      : {
          serializers: { req: serializeRequestForLog },
          redact: { paths: ["reqId"], remove: true },
          ...(options.loggerStream ? { stream: options.loggerStream } : {}),
        },
    // Exact nested RPG resources must normalize either overlong path ID in the
    // strict handler. The early hook below retains the public 128-character
    // router-cap behavior for every legacy, unknown, and lookalike shape.
    routerOptions: { maxParamLength: 10_000 },
    frameworkErrors: (error, request, reply) => {
      const rawUrl = request.raw.url ?? request.url;
      const rawInstance = rawUrl.split("?", 1)[0]!;
      const malformedWorkspaceShape = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/workspace$/.test(rawInstance);
      const malformedCharacterSheetShape = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/sheet$/.test(rawInstance);
      const normalizedRoute = normalizedCampaignResourceRoute(request.method, rawUrl)
        ?? (malformedWorkspaceShape || malformedCharacterSheetShape ? {
          instance: rawInstance,
          hasQuery: rawUrl.includes("?"),
          noStore: request.method === "GET",
          queryDetail: request.method === "GET"
            ? malformedWorkspaceShape
              ? "Campaign character workspace does not accept query parameters"
              : "Campaign character sheet does not accept query parameters"
            : null,
        } : null);
      if (normalizedRoute
        && (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH")) {
        // Router failures happen before normal hooks and route encapsulation.
        // Normalize only reviewed campaign resource shapes and set correlation
        // before the ordinary onRequest hook has had a chance to run.
        reply.raw.setHeader("x-request-id", request.id);
        if (normalizedRoute.noStore === true) reply.raw.setHeader("cache-control", "no-store");
        const flags = readRpgFeatureFlags();
        if (!flags.campaign || (normalizedRoute.mechanics === true && !flags.mechanics)
            || (normalizedRoute.combat === true && !flags.combat)
            || normalizedRoute.queryDetail === null) {
          return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
            instance: normalizedRoute.instance,
          });
        }
        if (normalizedRoute.hasQuery) {
          return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", normalizedRoute.queryDetail, {
            instance: normalizedRoute.instance,
          });
        }
        if (normalizedRoute.instance === "/api/rpg/v1/campaign-imports/:importId/apply") {
          return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
            "Campaign import apply request is invalid", { instance: normalizedRoute.instance });
        }
        const isCharacterResource = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/(?:workspace|sheet)$/.test(
          normalizedRoute.instance,
        );
        const isActorResource = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:resources|resource-commands)$/.test(
          normalizedRoute.instance,
        );
        const isActorInventory = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:inventory|inventory-commands)$/.test(
          normalizedRoute.instance,
        );
        const isActorRest = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/rest-commands$/.test(
          normalizedRoute.instance,
        );
        const isActorEconomy = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/actors\/[^/]+\/(?:wallet|economy-commands)$/.test(
          normalizedRoute.instance,
        );
        const isShop = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/shops\/[^/]+$/.test(normalizedRoute.instance);
        const isActorCheck = normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/check-commands";
        const isActorWorld = normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/travel-commands";
        const isActorPowers = normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/powers"
          || normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/power-commands";
        const isActorEffects = normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/effects"
          || normalizedRoute.instance === "/api/rpg/v1/actors/:actorId/effect-commands";
        const isEncounter = normalizedRoute.instance === "/api/rpg/v1/encounters/:encounterId/start-commands";
        const isNpc = normalizedRoute.instance === "/api/rpg/v1/npcs/:npcId/relationship-commands";
        const isFaction = normalizedRoute.instance === "/api/rpg/v1/factions/:factionId/reputation-commands";
        const isQuest = normalizedRoute.instance === "/api/rpg/v1/quests/:questId/commands";
        const isStoryline = normalizedRoute.instance === "/api/rpg/v1/storylines/:storylineId/commands";
        const isCampaignFactions = normalizedRoute.instance === "/api/rpg/v1/campaigns/:campaignId/factions";
        const isCombat = normalizedRoute.instance === "/api/rpg/v1/combats/:combatId"
          || normalizedRoute.instance === "/api/rpg/v1/combats/:combatId/log"
          || normalizedRoute.instance === "/api/rpg/v1/combats/:combatId/action-commands"
          || normalizedRoute.instance === "/api/rpg/v1/combats/:combatId/end-commands"
          || normalizedRoute.instance === "/api/rpg/v1/campaigns/:campaignId/combats/:combatId/command-results/:idempotencyKey";
        return sendApiProblem(request, reply, 404,
          isActorCheck ? "RPG_ACTOR_CHECK_NOT_FOUND" : isActorWorld ? "RPG_ACTOR_WORLD_NOT_FOUND" : isActorEffects ? "RPG_ACTOR_EFFECTS_NOT_FOUND" : isActorPowers ? "RPG_ACTOR_POWERS_NOT_FOUND" : isEncounter ? "RPG_ENCOUNTER_NOT_FOUND" : isNpc ? "RPG_NPC_NOT_FOUND" : isFaction ? "RPG_FACTION_NOT_FOUND" : isQuest ? "RPG_QUEST_NOT_FOUND" : isStoryline ? "RPG_STORYLINE_NOT_FOUND" : isCampaignFactions ? "RPG_CAMPAIGN_FACTIONS_NOT_FOUND" : isCombat ? "RPG_COMBAT_NOT_FOUND" : isCharacterResource ? "RPG_CAMPAIGN_CHARACTER_NOT_FOUND" : isActorResource ? "RPG_ACTOR_RESOURCE_NOT_FOUND" : isActorInventory ? "RPG_ACTOR_INVENTORY_NOT_FOUND" : isActorRest ? "RPG_ACTOR_REST_NOT_FOUND" : isActorEconomy ? "RPG_ACTOR_ECONOMY_NOT_FOUND" : isShop ? "RPG_SHOP_NOT_FOUND" : "RPG_CAMPAIGN_NOT_FOUND",
          isActorCheck ? "Actor check state not found" : isActorWorld ? "Actor world state not found" : isActorEffects ? "Actor effects not found" : isActorPowers ? "Actor powers not found" : isEncounter ? "Encounter not found" : isNpc ? "NPC not found" : isFaction ? "Faction not found" : isQuest ? "Quest not found" : isStoryline ? "Storyline not found" : isCampaignFactions ? "Campaign factions not found" : isCombat ? "Combat not found" : isCharacterResource ? "Campaign character not found" : isActorResource ? "Actor resources not found" : isActorInventory ? "Actor inventory not found" : isActorRest ? "Actor rest state not found" : isActorEconomy ? "Actor economy not found" : isShop ? "Shop not found" : "Campaign not found", {
            instance: normalizedRoute.instance,
          });
      }

      // Keep Fastify's pre-existing raw router response for legacy and unknown
      // paths rather than broadening the RPG problem contract globally.
      if (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH") {
        const status = error.code === "FST_ERR_MAX_PARAM_LENGTH" ? 414 : 400;
        const body = JSON.stringify({
          error: "Bad Request",
          code: error.code,
          message: safeRouterMessage(error.code),
          statusCode: status,
        });
        reply.raw.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        reply.raw.end(body);
        return reply;
      }
      return (reply as FastifyReply).send(error);
    },
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && requestIdSchema.safeParse(incoming).success
        ? incoming
        : runtime.ids.nextId();
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const pathOnly = rawUrl.split("?", 1)[0]!;
    const hasOverlongSegment = pathOnly.split("/").some((segment) => segment.length > 128);
    const isExactNestedCharacterResource = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/(?:workspace|sheet)$/.test(pathOnly);
    if (hasOverlongSegment && !isExactNestedCharacterResource
      && normalizedCampaignResourceRoute(request.method, rawUrl) === null) {
      const body = JSON.stringify({
        error: "Bad Request",
        code: "FST_ERR_MAX_PARAM_LENGTH",
        message: "Request URL exceeds the routing limit",
        statusCode: 414,
      });
      reply.hijack();
      reply.raw.removeHeader("x-request-id");
      reply.raw.writeHead(414, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      reply.raw.end(body);
      return;
    }
    reply.raw.setHeader("x-request-id", request.id);
  });

  // Match Fastify's legacy default 404 body while omitting query data from
  // its reflected route message. The scoped RPG handler remains intact.
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const instance = rawUrl.split("?", 1)[0]!;
    if (/^\/api\/rpg\/v1\/campaign-imports\/[^/]+\/apply$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: "/api/rpg/v1/campaign-imports/:importId/apply",
      });
    }
    if (instance === "/api/rpg/v1/adventure-turns/reconcile-initial") {
      reply.header("cache-control", "private, no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", { instance });
    }
    if (instance === "/api/rpg/v1/adventure-turns/stream" || /^\/api\/rpg\/v1\/adventure-turns\/[^/]+(?:\/confirm)?$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: instance === "/api/rpg/v1/adventure-turns/stream" ? instance
          : instance.endsWith("/confirm") ? "/api/rpg/v1/adventure-turns/:turnId/confirm" : "/api/rpg/v1/adventure-turns/:turnId",
      });
    }
    if (/^\/api\/rpg\/v1\/generation-drafts(?:\/[^/]+(?:\/apply)?)?$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: instance === "/api/rpg/v1/generation-drafts" ? instance
          : instance.endsWith("/apply") ? "/api/rpg/v1/generation-drafts/:draftId/apply" : "/api/rpg/v1/generation-drafts/:draftId",
      });
    }
    if (/^\/api\/rpg\/v1\/campaigns\/[^/]+\/rooms\/[^/]+\/play-bootstrap$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/play-bootstrap",
      });
    }
    if (/^\/api\/rpg\/v1\/actors\/[^/]+\/(?:check-commands|powers|power-commands|effects|effect-commands)$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: instance.endsWith("/effect-commands")
          ? "/api/rpg/v1/actors/:actorId/effect-commands"
          : instance.endsWith("/effects")
            ? "/api/rpg/v1/actors/:actorId/effects"
            : instance.endsWith("/power-commands")
              ? "/api/rpg/v1/actors/:actorId/power-commands"
              : instance.endsWith("/powers")
                ? "/api/rpg/v1/actors/:actorId/powers"
                : "/api/rpg/v1/actors/:actorId/check-commands",
      });
    }
    if (/^\/api\/rpg\/v1\/quests\/[^/]+\/commands$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: "/api/rpg/v1/quests/:questId/commands",
      });
    }
    if (/^\/api\/rpg\/v1\/storylines\/[^/]+\/commands$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: "/api/rpg/v1/storylines/:storylineId/commands",
      });
    }
    if (/^\/api\/rpg\/v1\/actors\/[^/]+\/travel-commands$/.test(instance)) {
      reply.header("cache-control","no-store");
      return sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found",{
        instance:"/api/rpg/v1/actors/:actorId/travel-commands"});
    }
    if (/^\/api\/rpg\/v1\/encounters\/[^/]+\/start-commands$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: "/api/rpg/v1/encounters/:encounterId/start-commands",
      });
    }
    if (/^\/api\/rpg\/v1\/npcs\/[^/]+\/relationship-commands$/.test(instance)) {
      reply.header("cache-control","no-store");return sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found",{
        instance:"/api/rpg/v1/npcs/:npcId/relationship-commands"});
    }
    if (/^\/api\/rpg\/v1\/factions\/[^/]+\/reputation-commands$/.test(instance)) {
      reply.header("cache-control","no-store");return sendApiProblem(request,reply,404,"RPG_ROUTE_NOT_FOUND","RPG route not found",{
        instance:"/api/rpg/v1/factions/:factionId/reputation-commands"});
    }
    if (/^\/api\/rpg\/v1\/combats\/[^/]+(?:\/(?:log|action-commands|end-commands))?$/.test(instance)) {
      reply.header("cache-control", "no-store");
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
        instance: instance.endsWith("/log") ? "/api/rpg/v1/combats/:combatId/log"
          :instance.endsWith("/action-commands")?"/api/rpg/v1/combats/:combatId/action-commands"
            :instance.endsWith("/end-commands")?"/api/rpg/v1/combats/:combatId/end-commands":"/api/rpg/v1/combats/:combatId",
      });
    }
    return reply.code(404).send({
      message: `Route ${request.method}:${instance} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  void app.register(roleplaySystemRoutes, { prefix: "/api" });
  void app.register(roleplayCharacterRoutes, { prefix: "/api" });
  void app.register(roleplayLoreRoutes, { prefix: "/api" });
  void app.register(roleplayMemoryRoutes, { prefix: "/api" });
  void app.register(roleplayPromptTemplateRoutes, { prefix: "/api" });
  void app.register(roleplayHarnessRoutes, { prefix: "/api" });
  void app.register(roleplaySessionRoutes, { prefix: "/api" });
  void app.register(roleplaySessionLifecycleRoutes, { prefix: "/api" });
  void app.register(roleplayInteractionRoutes, { prefix: "/api" });
  void app.register(roleplayProviderRoutes, { prefix: "/api" });
  void app.register(roleplayUsageRoutes, { prefix: "/api" });
  void app.register(rpgV1Routes, {
    prefix: "/api/rpg/v1",
    campaignRepositoryFactory: options.campaignRepositoryFactory ?? (() => createRepository()),
    diceCommandIds: options.diceCommandIds ?? { nextId: () => randomUUID() },
    ...(options.adventureAgentDependencies ? { adventureAgentDependencies: options.adventureAgentDependencies } : {}),
    ...(options.encounterGeneration ? { encounterGeneration: options.encounterGeneration } : {}),
  });

  return app;
}
