import { quickAdventureCreateRequestSchema, quickAdventureCreateResponseSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { Repository } from "../../../repo/index.js";
import { QuickAdventureError, createQuickAdventure } from "../../../quickstart/quickAdventure.js";
import { runQuickAdventureInWorker } from "../../../quickstart/quickAdventureWorkerClient.js";

/**
 * Quick adventure command.
 *
 * `POST /api/rpg/v1/quick-adventures` builds the bundled, provider-free
 * Sintermark starter world into the owner's database as a brand-new campaign
 * and returns the active play room. The fixed trusted-local principal is the
 * only caller identity, consistent with the other RPG routes.
 *
 * Replay is in-process only: successful responses are remembered by
 * idempotency key for the lifetime of this server process. A restart forgets
 * every key, so re-sending a key after a restart builds a new campaign.
 */

const PRINCIPAL = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const REPLAY_LIMIT = 256;

type CachedSuccess = ReturnType<typeof quickAdventureCreateResponseSchema.parse>;

/**
 * The composed repository exposes its SQLite directory so the build can run in
 * a worker against the same file. Fake/mock repositories in tests do not, and
 * keep using the in-process build.
 */
function databaseDirectoryOf(repository: Repository): string | null {
  const candidate = (repository as { databaseDirectory?: unknown }).databaseDirectory;
  return typeof candidate === "function" ? (candidate as () => string).call(repository) : null;
}

export const quickAdventureHttpRoutes: FastifyPluginAsync<{ repositoryAccessor: () => Repository }> = async (
  app,
  options,
) => {
  const completed = new Map<string, CachedSuccess>();
  const inFlight = new Map<string, Promise<CachedSuccess>>();

  const remember = (key: string, response: CachedSuccess): void => {
    completed.set(key, response);
    if (completed.size > REPLAY_LIMIT) {
      const oldest = completed.keys().next().value;
      if (oldest !== undefined) completed.delete(oldest);
    }
  };

  const failure = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof QuickAdventureError) {
      request.log.error({ operation: "quick-adventure", err: error.cause }, "quick adventure build failed");
      return sendApiProblem(request, reply, 500, "RPG_QUICK_ADVENTURE_FAILED", error.message);
    }
    throw error;
  };

  const gate = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics || !flags.combat) {
      sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if ((request.raw.url ?? request.url).includes("?")) {
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quick adventures do not accept query parameters");
      return false;
    }
    if (request.method === "POST" && !JSON_MEDIA_TYPE.test(request.headers["content-type"] ?? "")) {
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quick adventures require application/json");
      return false;
    }
    return true;
  };

  app.post(
    "/quick-adventures",
    {
      onRequest: async (request, reply) => {
        await gate(request, reply);
      },
    },
    async (request, reply) => {
      const parsed = quickAdventureCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quick adventure request is invalid");
      }
      const key = parsed.data.idempotencyKey;

      const cached = completed.get(key);
      if (cached) {
        return reply.code(200).send(quickAdventureCreateResponseSchema.parse({ ...cached, replayed: true }));
      }

      const running = inFlight.get(key);
      if (running) {
        try {
          const response = await running;
          return reply.code(200).send(quickAdventureCreateResponseSchema.parse({ ...response, replayed: true }));
        } catch (error) {
          return failure(request, reply, error);
        }
      }

      if (inFlight.size > 0) {
        return sendApiProblem(
          request,
          reply,
          409,
          "RPG_QUICK_ADVENTURE_IN_PROGRESS",
          "Another quick adventure build is already in progress",
        );
      }

      const build = (async (): Promise<CachedSuccess> => {
        const repository = options.repositoryAccessor();
        const databaseDir = databaseDirectoryOf(repository);
        const adventure = parsed.data.adventureId ? { adventureId: parsed.data.adventureId } : {};
        const result =
          databaseDir !== null
            ? await runQuickAdventureInWorker({ databaseDir, ownerId: PRINCIPAL, ...adventure })
            : await createQuickAdventure({ repository, ownerId: PRINCIPAL, ...adventure });
        return quickAdventureCreateResponseSchema.parse({
          campaignId: result.campaignId,
          campaignName: result.campaignName,
          sessionId: result.sessionId,
          actorId: result.actorId,
          replayed: false,
        });
      })();
      inFlight.set(key, build);

      try {
        const response = await build;
        remember(key, response);
        return reply.code(201).send(quickAdventureCreateResponseSchema.parse({ ...response, replayed: false }));
      } catch (error) {
        return failure(request, reply, error);
      } finally {
        if (inFlight.get(key) === build) inFlight.delete(key);
      }
    },
  );
};
