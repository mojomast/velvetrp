import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { requestIdSchema } from "@velvet/contracts";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  addConsentEvent,
  addMemoryFacts,
  addMessage,
  deleteSummary,
  getHarnessSettings,
  getMessage,
  getProviderSettings,
  getSession,
  getSessionContextSource,
  getSummary,
  listApprovedMemories,
  listBranchChildren,
  listBranchMessages,
  listLoreEntries,
  listMessages,
  nextSwipeIndex,
  setActiveBranch,
  recordUsageEvent,
  createRepository,
  transitionSession,
  updateSessionSynthesizedSource,
  upsertSummary,
} from "./repo.js";
import { fallbackRoomSpeakers, generateReply, selectRoomSpeakers, streamReply, synthesizeSceneState } from "./llm.js";
import { selectLoreEntries } from "./lore.js";
import { buildSessionContextBasket, contextBasketText } from "./context.js";
import { buildEpisodeSummary, buildTurnMemories, shouldUpdateSummary } from "./memory.js";
import {
  checkAssistantOutput,
  checkUserMessage,
  isSafeWord,
  sanitizeUserContent,
} from "./policy.js";
import { getPromptPreset } from "./presets.js";
import { cleanCharacterReply } from "./prompt.js";
import { resolvePromptTemplate } from "./promptTemplates.js";
import type {
  Character,
  Message,
  PostMessageInput,
  RoomContinueInput,
  RoomTurnInput,
  Session,
  TokenUsage,
} from "./types.js";
import { roleplaySystemRoutes } from "./routes/roleplay/system.js";
import { roleplayCharacterRoutes } from "./routes/roleplay/characters.js";
import { roleplayLoreRoutes } from "./routes/roleplay/lore.js";
import { roleplayMemoryRoutes } from "./routes/roleplay/memories.js";
import { roleplayPromptTemplateRoutes } from "./routes/roleplay/promptTemplates.js";
import { roleplayHarnessRoutes } from "./routes/roleplay/harness.js";
import { roleplaySessionRoutes } from "./routes/roleplay/sessions.js";
import { roleplaySessionLifecycleRoutes } from "./routes/roleplay/sessionLifecycle.js";
import { roleplayProviderRoutes } from "./routes/roleplay/provider.js";
import { roleplayUsageRoutes } from "./routes/roleplay/usage.js";
import { rpgV1Routes } from "./routes/rpg/v1/features.js";
import type { CampaignListRepository } from "./routes/rpg/v1/features.js";
import { readRpgFeatureFlags } from "./features.js";
import { sendApiProblem } from "./http/problem.js";
import { systemRuntime } from "./runtime.js";
import type { RuntimeDependencies } from "./runtime.js";

const inFlightGenerations = new Set<string>();

interface ActiveGeneration {
  generationId: string;
  controller: AbortController;
}

const activeGenerations = new Map<string, ActiveGeneration>();

interface NormalizedCampaignResourceRoute {
  instance: string;
  hasQuery: boolean;
  queryDetail: string | null;
  mechanics?: boolean;
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
  if (/^\/api\/rpg\/v1\/campaigns\/[^/]+$/.test(instance)) {
    return {
      instance,
      hasQuery,
      queryDetail: method === "GET"
        ? "Campaign detail does not accept query parameters"
        : method === "PATCH"
          ? "Campaign rename does not accept query parameters"
          : null,
    };
  }
  return null;
}

function safeRouterMessage(errorCode: string): string {
  return errorCode === "FST_ERR_MAX_PARAM_LENGTH"
    ? "Request URL exceeds the routing limit"
    : "Request URL is invalid";
}

function tryAcquireGeneration(sessionId: string): (() => void) | null {
  if (inFlightGenerations.has(sessionId)) return null;
  inFlightGenerations.add(sessionId);
  return () => {
    inFlightGenerations.delete(sessionId);
  };
}

function abortActiveGeneration(sessionId: string): void {
  const active = activeGenerations.get(sessionId);
  if (active) active.controller.abort();
}

const SAFE_FALLBACK_REPLY =
  "I'm having trouble reaching the story engine right now, so I'm holding the scene right here. Your message is saved — try again in a moment and we'll continue, within the agreed boundaries.";
const BOUNDARY_REPLACEMENT_REPLY =
  "I’m keeping this within the agreed boundaries and the current scene state. Tell me what direction you want, within those limits.";
const SAFE_WORD_REPLY =
  "Safe word acknowledged. Stepping out of the scene and stopping here. Take your time.";

interface GenerationOutcome {
  text: string;
  presetId: string;
  loreTriggered: number;
  providerError: boolean;
  usage: TokenUsage | null;
}

async function runCharacterPipeline(input: {
  session: Session;
  character: Character;
  history: Message[];
  userContent: string;
  log: { error: (obj: object, msg: string) => void };
}): Promise<GenerationOutcome> {
  const { session, character, history, userContent, log } = input;
  const preset = getPromptPreset(session.presetId);
  const harness = await getHarnessSettings();
  const provider = await getProviderSettings();
  const memories = await listApprovedMemories(character.id, 8);
  const summary = await getSummary(session.id);
  const contextText = [...history.map((message) => message.content), userContent].join("\n");
  const participantIds = session.participants.map((participant) => participant.id);
  const lore = selectLoreEntries(await listLoreEntries(participantIds), participantIds, contextText, harness.loreChars);
  const sharedMemories = (await Promise.all(session.participants.map(async (participant) =>
    (await listApprovedMemories(participant.id, 3)).map((memory) => ({ characterName: participant.name, memory }))))).flat();
  const source = await getSessionContextSource(session.id);
  const sharedContext = contextBasketText(buildSessionContextBasket(session, history, sharedMemories, lore, source));
  let providerError = false;
  let replyText: string;
  let usage: TokenUsage | null = null;
  try {
    const generated = await generateReply(
      character,
      session,
      history,
      memories,
      summary,
      preset,
      lore,
      harness,
      provider,
      userContent,
      session.participants,
      sharedContext,
    );
    replyText = generated.text;
    usage = generated.usage;
  } catch (err) {
    providerError = true;
    log.error({ err }, "LLM generation failed; persisting safe fallback reply");
    replyText = SAFE_FALLBACK_REPLY;
  }
  const cleanedReplyText = cleanCharacterReply(replyText, session.participants);
  const outputPolicy = checkAssistantOutput(cleanedReplyText);
  const safeReplyText = outputPolicy.allowed ? cleanedReplyText : BOUNDARY_REPLACEMENT_REPLY;
  return { text: safeReplyText, presetId: preset.id, loreTriggered: lore.length, providerError, usage };
}

type StreamPipelineResult =
  | { kind: "completed"; outcome: GenerationOutcome }
  | { kind: "boundary"; outcome: GenerationOutcome; violations: string[] }
  | { kind: "aborted" };

async function streamCharacterPipeline(input: {
  session: Session;
  character: Character;
  history: Message[];
  userContent: string;
  controller: AbortController;
  onDelta: (delta: string) => void;
  log: { error: (obj: object, msg: string) => void };
}): Promise<StreamPipelineResult> {
  const { session, character, history, userContent, controller, onDelta, log } = input;
  const signal = controller.signal;
  const preset = getPromptPreset(session.presetId);
  const harness = await getHarnessSettings();
  const provider = await getProviderSettings();
  const memories = await listApprovedMemories(character.id, 8);
  const summary = await getSummary(session.id);
  const contextText = [...history.map((message) => message.content), userContent].join("\n");
  const participantIds = session.participants.map((participant) => participant.id);
  const lore = selectLoreEntries(await listLoreEntries(participantIds), participantIds, contextText, harness.loreChars);
  const sharedMemories = (await Promise.all(session.participants.map(async (participant) =>
    (await listApprovedMemories(participant.id, 3)).map((memory) => ({ characterName: participant.name, memory }))))).flat();
  const source = await getSessionContextSource(session.id);
  const sharedContext = contextBasketText(buildSessionContextBasket(session, history, sharedMemories, lore, source));
  let providerError = false;
  const boundaryOutcome = (violations: string[]): StreamPipelineResult => ({
    kind: "boundary",
    outcome: { text: BOUNDARY_REPLACEMENT_REPLY, presetId: preset.id, loreTriggered: lore.length, providerError, usage: null },
    violations,
  });
  let full = "";
  let usage: TokenUsage | null = null;
  let violations: string[] | null = null;
  try {
    const generated = await streamReply(
      { character, participants: session.participants, session, history, memories, summary, preset, lore, harness, provider, userContent, sharedContext },
      (delta) => {
        full += delta;
        if (violations) return;
        const incremental = checkAssistantOutput(full);
        if (!incremental.allowed) {
          violations = incremental.violations;
          log.error({ violations }, "streamed output violated policy; aborting provider and replacing reply");
          controller.abort();
          return;
        }
        onDelta(delta);
      },
      signal,
    );
    usage = generated.usage;
  } catch (err) {
    if (violations) return boundaryOutcome(violations);
    if (signal.aborted) return { kind: "aborted" };
    providerError = true;
    log.error({ err }, "LLM generation failed; persisting safe fallback reply");
    full = SAFE_FALLBACK_REPLY;
  }
  if (violations) return boundaryOutcome(violations);
  if (signal.aborted) return { kind: "aborted" };
  const outputPolicy = checkAssistantOutput(full);
  if (!outputPolicy.allowed) return boundaryOutcome(outputPolicy.violations);
  return {
    kind: "completed",
    outcome: { text: full, presetId: preset.id, loreTriggered: lore.length, providerError, usage },
  };
}

class SseWriter {
  private raw: FastifyReply["raw"];

  constructor(raw: FastifyReply["raw"]) {
    this.raw = raw;
  }

  send(event: string, data: unknown): void {
    if (this.raw.destroyed) return;
    this.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.raw.destroyed) return;
    this.raw.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.raw.destroyed) return;
    this.raw.end();
  }
}

function openSse(reply: FastifyReply): SseWriter {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return new SseWriter(reply.raw);
}

async function runSseGeneration(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  session: Session;
  character: Character;
  history: Message[];
  userContent: string;
  generationId: string;
  release: () => void;
  announce?: (sse: SseWriter) => void;
  persist: (outcome: GenerationOutcome) => Promise<{ replyMessage: Message; extra: Record<string, unknown> }>;
}): Promise<void> {
  const { request, reply, session, character, history, userContent, generationId, release, announce, persist } = input;
  const controller = new AbortController();
  let sse: SseWriter | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let finished = false;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    activeGenerations.delete(session.id);
    release();
  };

  try {
    activeGenerations.set(session.id, { generationId, controller });
    sse = openSse(reply);
    const heartbeatMs = Number(process.env.VELVET_SSE_HEARTBEAT_MS ?? 15_000);
    heartbeat = setInterval(() => sse?.comment("heartbeat"), heartbeatMs);
    reply.raw.on("close", () => {
      if (!finished) controller.abort();
    });

    announce?.(sse);
    sse.send("state", { session, state: session.state });
    let seq = 0;
    const result = await streamCharacterPipeline({
      session,
      character,
      history,
      userContent,
      controller,
      onDelta: (delta) => {
        sse?.send("delta", { seq, text: delta });
        seq += 1;
      },
      log: request.log,
    });
    if (result.kind === "aborted") {
      finished = true;
      sse.send("aborted", { generationId });
      sse.end();
      return;
    }
    const outcome = result.outcome;
    // Re-check abort signal and fresh session state before writing: a safe word
    // or stop may have closed the session while the provider was generating.
    // The boundary kind aborts the controller itself, so only external aborts
    // matter there; session closure is still authoritative for both kinds.
    const freshSession = await getSession(session.id);
    const externallyAborted = result.kind === "completed" && controller.signal.aborted;
    if (externallyAborted || !freshSession || freshSession.stoppedAt || freshSession.state === "closed") {
      finished = true;
      sse.send("aborted", { generationId });
      sse.end();
      return;
    }
    const { replyMessage, extra } = await persist(outcome);
    await maybeUpdateSummary(session.id);
    finished = true;
    if (result.kind === "boundary") {
      sse.send("boundary", {
        reply: replyMessage,
        generationId,
        violations: result.violations,
        providerError: outcome.providerError,
        preset: outcome.presetId,
        loreTriggered: outcome.loreTriggered,
        ...extra,
      });
    } else {
      sse.send("done", {
        reply: replyMessage,
        providerError: outcome.providerError,
        preset: outcome.presetId,
        loreTriggered: outcome.loreTriggered,
        ...extra,
      });
    }
    sse.end();
  } catch (err) {
    request.log.error({ err }, "streamed generation failed");
    finished = true;
    if (sse) {
      sse.send("error", { error: "streamed generation failed" });
      sse.end();
    } else if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  } finally {
    cleanup();
  }
}

async function maybeUpdateSummary(sessionId: string, force = false): Promise<void> {
  const activeBranch = await listMessages(sessionId);
  const harness = await getHarnessSettings();
  const session = await getSession(sessionId);
  if (session && activeBranch.length > 0) {
    try {
      const source = await getSessionContextSource(sessionId);
      const synthesized = await synthesizeSceneState({
        session,
        history: activeBranch,
        manualCanon: source.sourceOfTruth,
        previousState: source.synthesizedSource,
        provider: await getProviderSettings(),
        harness,
        preset: getPromptPreset(session.presetId),
      });
      if (synthesized) {
        await updateSessionSynthesizedSource(sessionId, synthesized.text);
        if (synthesized.usage) await recordUsageEvent(sessionId, "scene_synthesis", synthesized.usage);
      }
    } catch (error) {
      console.warn(`[velvet] scene synthesis skipped for session ${sessionId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (activeBranch.length > harness.recentTurns && (force || shouldUpdateSummary(activeBranch.length))) {
    const archivedHistory = activeBranch.slice(0, -harness.recentTurns);
    const names = Object.fromEntries((session?.participants ?? []).map((character) => [character.id, character.name]));
    await upsertSummary(sessionId, buildEpisodeSummary(archivedHistory, harness.summaryChars, names));
  } else if (force) {
    await deleteSummary(sessionId);
  }
}

function targetCharacter(session: Session, requestedId?: string): Character | null {
  const id = requestedId ?? session.primaryCharacterId;
  return session.participants.find((participant) => participant.id === id) ?? null;
}

function safeWords(session: Session): string[] {
  return session.participants.map((participant) => participant.safeWord);
}

export function buildApp(options: {
  runtime?: RuntimeDependencies;
  campaignRepositoryFactory?: () => CampaignListRepository;
  loggerStream?: Writable;
  diceCommandIds?: { nextId(): string };
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
      const normalizedRoute = normalizedCampaignResourceRoute(request.method, rawUrl)
        ?? (malformedWorkspaceShape ? {
          instance: rawInstance,
          hasQuery: rawUrl.includes("?"),
          noStore: request.method === "GET",
          queryDetail: request.method === "GET"
            ? "Campaign character workspace does not accept query parameters"
            : null,
        } : null);
      if (normalizedRoute
        && (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH")) {
        // Router failures happen before normal hooks and route encapsulation.
        // Normalize only the reviewed campaign resource shapes, and set the correlation
        // header that the ordinary onRequest hook has not had a chance to set.
        // Use the raw response because Fastify's pre-routing OPTIONS/TRACE
        // framework-error path does not consistently flush reply headers.
        reply.raw.setHeader("x-request-id", request.id);
        if (normalizedRoute.noStore === true) reply.raw.setHeader("cache-control", "no-store");
        const flags = readRpgFeatureFlags();
        if (!flags.campaign || (normalizedRoute.mechanics === true && !flags.mechanics)
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
        const isWorkspace = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/workspace$/.test(
          normalizedRoute.instance,
        );
        return sendApiProblem(request, reply, 404,
          isWorkspace ? "RPG_CAMPAIGN_CHARACTER_NOT_FOUND" : "RPG_CAMPAIGN_NOT_FOUND",
          isWorkspace ? "Campaign character not found" : "Campaign not found", {
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
          // Fastify's original message reflects the raw target. Keep the
          // legacy JSON/code/status shape without retaining path or query data.
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
    const isExactWorkspaceShape = /^\/api\/rpg\/v1\/campaigns\/[^/]+\/characters\/[^/]+\/workspace$/.test(pathOnly);
    if (hasOverlongSegment && !isExactWorkspaceShape
      && normalizedCampaignResourceRoute(request.method, rawUrl) === null) {
      const body = JSON.stringify({
        error: "Bad Request",
        code: "FST_ERR_MAX_PARAM_LENGTH",
        message: "Request URL exceeds the routing limit",
        statusCode: 414,
      });
      // Preserve the historical raw compatibility response: no structured
      // correlation header, concrete path, query, or Fastify error message.
      reply.hijack();
      reply.raw.removeHeader("x-request-id");
      reply.raw.writeHead(414, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      reply.raw.end(body);
      return;
    }
    // Raw assignment also preserves correlation for uncommon methods such as
    // TRACE that Fastify does not include in its typed route method set.
    reply.raw.setHeader("x-request-id", request.id);
  });

  // Match Fastify's legacy default 404 body while omitting query data from
  // its reflected route message. The scoped RPG handler below remains intact.
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const instance = rawUrl.split("?", 1)[0]!;
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
  void app.register(roleplaySessionLifecycleRoutes, { prefix: "/api", abortActiveGeneration });
  void app.register(roleplayProviderRoutes, { prefix: "/api" });
  void app.register(roleplayUsageRoutes, { prefix: "/api" });
  void app.register(rpgV1Routes, {
    prefix: "/api/rpg/v1",
    campaignRepositoryFactory: options.campaignRepositoryFactory ?? (() => createRepository()),
    diceCommandIds: options.diceCommandIds ?? { nextId: () => randomUUID() },
  });

app.post<{ Params: { id: string }; Body: PostMessageInput }>("/api/sessions/:id/messages", async (request, reply) => {
  const session = await getSession(request.params.id);
  if (!session) {
    return reply.code(404).send({ error: "session not found" });
  }
  const body = request.body;
  if (!body || typeof body.content !== "string" || body.content.trim() === "") {
    return reply.code(400).send({ error: "content is required" });
  }
  if (session.stoppedAt || session.state === "closed") {
    return reply.code(409).send({
      error: "session is stopped",
      stoppedAt: session.stoppedAt,
      stopReason: session.stopReason,
      session,
    });
  }

  const rawContent = body.content;

  const character = targetCharacter(session, body.speakerCharacterId);
  if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });

  if (isSafeWord(rawContent, safeWords(session))) {
    abortActiveGeneration(session.id);
    const userMessage = await addMessage(session.id, "user", rawContent);
    await addConsentEvent(session.id, "safe-word", false, "Safe word used; scene closed.");
    const stopped = await transitionSession(session.id, "closed", "safe-word");
    const replyMessage = await addMessage(
      session.id,
      "character",
      "Safe word acknowledged. Stepping out of the scene and stopping here. Take your time.",
      { speakerCharacterId: character.id },
    );
    return {
      userMessage,
      reply: replyMessage,
      session: stopped,
      state: stopped?.state ?? "closed",
      messages: await listMessages(session.id),
    };
  }

  const content = sanitizeUserContent(rawContent);
  const policy = checkUserMessage(content);
  if (!policy.allowed) {
    return reply.code(422).send({ error: "policy violation", violations: policy.violations });
  }

  const release = tryAcquireGeneration(session.id);
  if (!release) {
    return reply.code(409).send({ error: "generation already in flight for this session" });
  }
  try {
    let workingSession: Session = session;
    if (session.state === "setup") {
      await addConsentEvent(session.id, "scene-start", true, "First user message moved scene from setup to active.");
      workingSession = (await transitionSession(session.id, "active", "first-user-message")) ?? session;
    }

    const userMessage = await addMessage(session.id, "user", content);
    const history = await listMessages(session.id);
    await addMemoryFacts(character.id, buildTurnMemories(content, userMessage.id, history.slice(0, -1), character.id));
    const outcome = await runCharacterPipeline({
      session: workingSession,
      character,
      history: history.slice(0, -1),
      userContent: content,
      log: request.log,
    });
    const replyMessage = await addMessage(session.id, "character", outcome.text, { parentId: userMessage.id, speakerCharacterId: character.id, usage: outcome.usage });

    await maybeUpdateSummary(session.id);

    const finalSession = (await getSession(session.id)) ?? workingSession;
    return {
      userMessage,
      reply: replyMessage,
      preset: outcome.presetId,
      loreTriggered: outcome.loreTriggered,
      providerError: outcome.providerError,
      session: finalSession,
      state: finalSession.state,
      messages: await listMessages(session.id),
    };
  } finally {
    release();
  }
});

  app.post<{ Params: { id: string }; Body: RoomTurnInput }>("/api/sessions/:id/room-turn", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body;
    if (!body || typeof body.content !== "string" || body.content.trim() === "") {
      return reply.code(400).send({ error: "content is required" });
    }
    if (body.maxSpeakers !== undefined && (!Number.isInteger(body.maxSpeakers) || body.maxSpeakers < 1 || body.maxSpeakers > 6)) {
      return reply.code(400).send({ error: "maxSpeakers must be an integer from 1 to 6" });
    }
    if (session.stoppedAt || session.state === "closed") return reply.code(409).send({ error: "session is stopped", session });

    const rawContent = body.content;
    if (isSafeWord(rawContent, safeWords(session))) {
      abortActiveGeneration(session.id);
      const userMessage = await addMessage(session.id, "user", rawContent);
      await addConsentEvent(session.id, "safe-word", false, "Safe word used; scene closed.");
      const stopped = await transitionSession(session.id, "closed", "safe-word");
      const acknowledgement = await addMessage(session.id, "character", SAFE_WORD_REPLY, { speakerCharacterId: session.primaryCharacterId });
      return { userMessage, replies: [acknowledgement], selectedSpeakerIds: [session.primaryCharacterId], routing: "fallback", session: stopped, state: "closed", messages: await listMessages(session.id) };
    }

    const content = sanitizeUserContent(rawContent);
    const policy = checkUserMessage(content);
    if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    const release = tryAcquireGeneration(session.id);
    if (!release) return reply.code(409).send({ error: "generation already in flight for this session" });
    try {
      let workingSession = session;
      if (session.state === "setup") {
        await addConsentEvent(session.id, "scene-start", true, "First room message moved scene from setup to active.");
        workingSession = (await transitionSession(session.id, "active", "first-room-message")) ?? session;
      }
      const historyBefore = await listMessages(session.id);
      const maxSpeakers = Math.min(body.maxSpeakers ?? 3, session.participants.length);
      const provider = await getProviderSettings();
      const harness = await getHarnessSettings();
      let selection;
      try {
        selection = await selectRoomSpeakers({
          participants: session.participants,
          primaryCharacterId: session.primaryCharacterId,
          history: historyBefore,
          userContent: content,
          maxSpeakers,
          provider,
          harness,
          preset: getPromptPreset(session.presetId),
        });
      } catch (err) {
        request.log.error({ err }, "room routing failed; using deterministic fallback");
        selection = {
          speakerIds: fallbackRoomSpeakers(session.participants, session.primaryCharacterId, content, maxSpeakers),
          source: "fallback" as const,
          usage: null,
        };
      }
      if (selection.usage) await recordUsageEvent(session.id, "room_routing", selection.usage);

      const userMessage = await addMessage(session.id, "user", content);
      const roomSse = request.headers.accept?.includes("text/event-stream") ? openSse(reply) : null;
      roomSse?.send("user_message", { message: userMessage });
      roomSse?.send("state", { session: workingSession, state: workingSession.state });
      for (const speakerId of selection.speakerIds) {
        await addMemoryFacts(speakerId, buildTurnMemories(content, userMessage.id, historyBefore, speakerId));
      }
      const replies: Message[] = [];
      const outcomes: GenerationOutcome[] = [];
      let parentId = userMessage.id;
      for (const [speakerIndex, speakerId] of selection.speakerIds.entries()) {
        const character = session.participants.find((participant) => participant.id === speakerId)!;
        const selectedNames = selection.speakerIds.map((id) => session.participants.find((participant) => participant.id === id)?.name).filter(Boolean);
        const previousSpeaker = replies.length > 0
          ? session.participants.find((participant) => participant.id === replies.at(-1)?.speakerCharacterId)
          : null;
        const instruction = speakerIndex === 0
          ? resolvePromptTemplate("room.turn.first", harness.promptOverrides, {
              "user.content": content, "selected.names": selectedNames.join(", "), "target.name": character.name,
            })
          : resolvePromptTemplate("room.turn.followup", harness.promptOverrides, {
              "user.content": content,
              "previous.name": previousSpeaker?.name ?? "The previous character",
              "previous.reply": replies.at(-1)?.content ?? "",
              "target.name": character.name,
            });
        const turnHistory = replies.length === 0 ? historyBefore : [...historyBefore, userMessage, ...replies];
        const outcome = await runCharacterPipeline({ session: workingSession, character, history: turnHistory, userContent: instruction, log: request.log });
        outcomes.push(outcome);
        const message = await addMessage(session.id, "character", outcome.text, { parentId, speakerCharacterId: character.id, usage: outcome.usage });
        replies.push(message);
        roomSse?.send("room_reply", { reply: message, index: speakerIndex, total: selection.speakerIds.length });
        parentId = message.id;
      }
      await maybeUpdateSummary(session.id);
      const finalSession = (await getSession(session.id)) ?? workingSession;
      const result = {
        userMessage,
        replies,
        selectedSpeakerIds: selection.speakerIds,
        routing: selection.source,
        providerError: outcomes.some((outcome) => outcome.providerError),
        loreTriggered: outcomes.reduce((sum, outcome) => sum + outcome.loreTriggered, 0),
        session: finalSession,
        state: finalSession.state,
        messages: await listMessages(session.id),
      };
      if (roomSse) {
        roomSse.send("room_done", result);
        roomSse.end();
        return;
      }
      return result;
    } finally {
      release();
    }
  });

  app.post<{ Params: { id: string }; Body: RoomContinueInput | null }>("/api/sessions/:id/room-continue", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    if (session.stoppedAt || session.state === "closed") return reply.code(409).send({ error: "session is stopped", session });
    if (session.participants.length < 2) return reply.code(400).send({ error: "room continuation requires at least two participants" });
    const requestedMax = request.body?.maxSpeakers;
    if (requestedMax !== undefined && (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 6)) {
      return reply.code(400).send({ error: "maxSpeakers must be an integer from 1 to 6" });
    }
    const historyBefore = await listMessages(session.id);
    const previousMessage = historyBefore.at(-1);
    if (!previousMessage || previousMessage.role !== "character") {
      return reply.code(400).send({ error: "room continuation requires a preceding character reply" });
    }
    const previousCharacter = session.participants.find((participant) => participant.id === previousMessage.speakerCharacterId);
    if (!previousCharacter) return reply.code(400).send({ error: "preceding reply has no valid room speaker" });

    const release = tryAcquireGeneration(session.id);
    if (!release) return reply.code(409).send({ error: "generation already in flight for this session" });
    try {
      const maxSpeakers = Math.min(requestedMax ?? 2, session.participants.length);
      const provider = await getProviderSettings();
      const harness = await getHarnessSettings();
      const routingContent = resolvePromptTemplate("continuation.roomRouting", harness.promptOverrides, { "previous.name": previousCharacter.name });
      let selection;
      try {
        selection = await selectRoomSpeakers({
          participants: session.participants,
          primaryCharacterId: session.primaryCharacterId,
          history: historyBefore,
          userContent: routingContent,
          maxSpeakers,
          provider,
          harness,
          preset: getPromptPreset(session.presetId),
        });
      } catch (err) {
        request.log.error({ err }, "room continuation routing failed; using deterministic fallback");
        selection = {
          speakerIds: fallbackRoomSpeakers(session.participants, session.primaryCharacterId, routingContent, maxSpeakers),
          source: "fallback" as const,
          usage: null,
        };
      }
      if (selection.usage) await recordUsageEvent(session.id, "room_routing", selection.usage);
      const firstOther = selection.speakerIds.find((id) => id !== previousCharacter.id)
        ?? session.participants.find((participant) => participant.id !== previousCharacter.id)?.id;
      const selectedSpeakerIds = firstOther
        ? [firstOther, ...selection.speakerIds.filter((id) => id !== firstOther)].slice(0, maxSpeakers)
        : selection.speakerIds;

      const roomSse = request.headers.accept?.includes("text/event-stream") ? openSse(reply) : null;
      roomSse?.send("state", { session, state: session.state });
      const replies: Message[] = [];
      const outcomes: GenerationOutcome[] = [];
      let parentId = previousMessage.id;
      for (const speakerId of selectedSpeakerIds) {
        const character = session.participants.find((participant) => participant.id === speakerId)!;
        const precedingReply = replies.at(-1) ?? previousMessage;
        const precedingSpeaker = session.participants.find((participant) => participant.id === precedingReply.speakerCharacterId)!;
        const instruction = resolvePromptTemplate("continuation.roomTurn", harness.promptOverrides, {
          "previous.name": precedingSpeaker.name, "previous.reply": precedingReply.content, "target.name": character.name,
        });
        const outcome = await runCharacterPipeline({
          session,
          character,
          history: [...historyBefore, ...replies],
          userContent: instruction,
          log: request.log,
        });
        outcomes.push(outcome);
        const message = await addMessage(session.id, "character", outcome.text, {
          parentId,
          speakerCharacterId: character.id,
          usage: outcome.usage,
        });
        replies.push(message);
        roomSse?.send("room_reply", { reply: message, index: replies.length - 1, total: selectedSpeakerIds.length });
        parentId = message.id;
      }
      await maybeUpdateSummary(session.id);
      const finalSession = (await getSession(session.id)) ?? session;
      const result = {
        replies,
        selectedSpeakerIds,
        routing: selection.source,
        providerError: outcomes.some((outcome) => outcome.providerError),
        loreTriggered: outcomes.reduce((sum, outcome) => sum + outcome.loreTriggered, 0),
        session: finalSession,
        state: finalSession.state,
        messages: await listMessages(session.id),
      };
      if (roomSse) {
        roomSse.send("room_done", result);
        roomSse.end();
        return;
      }
      return result;
    } finally {
      release();
    }
  });

  app.post<{ Params: { id: string }; Body: { content?: string; generationId?: string; speakerCharacterId?: string } }>(
    "/api/sessions/:id/stream",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const body = request.body;
      if (!body || typeof body.content !== "string" || body.content.trim() === "") {
        return reply.code(400).send({ error: "content is required" });
      }
      if (session.stoppedAt || session.state === "closed") {
        return reply.code(409).send({
          error: "session is stopped",
          stoppedAt: session.stoppedAt,
          stopReason: session.stopReason,
          session,
        });
      }

      const rawContent = body.content;

      const character = targetCharacter(session, body.speakerCharacterId);
      if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });

      if (isSafeWord(rawContent, safeWords(session))) {
        abortActiveGeneration(session.id);
        const userMessage = await addMessage(session.id, "user", rawContent);
        await addConsentEvent(session.id, "safe-word", false, "Safe word used; scene closed.");
        const stopped = await transitionSession(session.id, "closed", "safe-word");
        const replyMessage = await addMessage(session.id, "character", SAFE_WORD_REPLY, { speakerCharacterId: character.id });
        const sse = openSse(reply);
        sse.send("user_message", { message: userMessage });
        sse.send("state", { session: stopped, state: stopped?.state ?? "closed" });
        sse.send("done", {
          reply: replyMessage,
          providerError: false,
          preset: session.presetId,
          loreTriggered: 0,
          session: stopped,
          state: stopped?.state ?? "closed",
          messages: await listMessages(session.id),
        });
        sse.end();
        return;
      }

      const content = sanitizeUserContent(rawContent);
      const policy = checkUserMessage(content);
      if (!policy.allowed) {
        const sse = openSse(reply);
        sse.send("error", { error: "policy violation", violations: policy.violations });
        sse.end();
        return;
      }

      const release = tryAcquireGeneration(session.id);
      if (!release) {
        return reply.code(409).send({ error: "generation already in flight for this session" });
      }

      let transferred = false;
      try {
        let workingSession: Session = session;
        if (session.state === "setup") {
          await addConsentEvent(session.id, "scene-start", true, "First user message moved scene from setup to active.");
          workingSession = (await transitionSession(session.id, "active", "first-user-message")) ?? session;
        }

        const userMessage = await addMessage(session.id, "user", content);
        const history = await listMessages(session.id);
        await addMemoryFacts(character.id, buildTurnMemories(content, userMessage.id, history.slice(0, -1), character.id));
        const generationId =
          typeof body.generationId === "string" && body.generationId.trim() !== "" ? body.generationId : randomUUID();

        transferred = true;
        await runSseGeneration({
          request,
          reply,
          session: workingSession,
          character,
          history: history.slice(0, -1),
          userContent: content,
          generationId,
          release,
          announce: (sse) => {
            sse.send("user_message", { message: userMessage, generationId });
          },
          persist: async (outcome) => {
            const replyMessage = await addMessage(session.id, "character", outcome.text, { parentId: userMessage.id, speakerCharacterId: character.id, usage: outcome.usage });
            const finalSession = (await getSession(session.id)) ?? workingSession;
            return {
              replyMessage,
              extra: {
                session: finalSession,
                state: finalSession.state,
                messages: await listMessages(session.id),
              },
            };
          },
        });
      } finally {
        if (!transferred) release();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { generationId?: string } | null }>(
    "/api/sessions/:id/generation/cancel",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const active = activeGenerations.get(session.id);
      const generationId = request.body?.generationId;
      if (!active || (typeof generationId === "string" && generationId !== active.generationId)) {
        return reply.code(404).send({ error: "no matching generation in flight" });
      }
      active.controller.abort();
      return { ok: true, aborted: active.generationId };
    },
  );

  app.post<{ Params: { id: string; mid: string }; Body: { speakerCharacterId?: string } | null }>("/api/sessions/:id/messages/:mid/swipe", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    const source = await getMessage(session.id, request.params.mid);
    if (!source) {
      return reply.code(404).send({ error: "message not found" });
    }
    if (source.role !== "character") {
      return reply.code(400).send({ error: "only character messages can be swiped" });
    }
    if (session.stoppedAt || session.state === "closed") {
      return reply.code(409).send({
        error: "session is stopped",
        stoppedAt: session.stoppedAt,
        stopReason: session.stopReason,
        session,
      });
    }
    if (!source.parentId) {
      return reply.code(400).send({ error: "message has no parent to regenerate from" });
    }
    const parent = await getMessage(session.id, source.parentId);
    if (!parent || parent.role !== "user") {
      return reply.code(400).send({ error: "swipe requires a user message parent" });
    }
    const inheritedSpeaker = source.speakerCharacterId ?? session.primaryCharacterId;
    const character = targetCharacter(session, request.body?.speakerCharacterId ?? inheritedSpeaker);
    if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });
    const release = tryAcquireGeneration(session.id);
    if (!release) {
      return reply.code(409).send({ error: "generation already in flight for this session" });
    }
    try {
      const history = parent.parentId ? await listBranchMessages(session.id, parent.parentId) : [];
      const outcome = await runCharacterPipeline({
        session,
        character,
        history,
        userContent: parent.content,
        log: request.log,
      });
      const swipeGroupId = source.swipeGroupId ?? source.id;
      const swipeIndex = await nextSwipeIndex(session.id, swipeGroupId);
      const replyMessage = await addMessage(session.id, "character", outcome.text, {
        parentId: parent.id,
        swipeGroupId,
        swipeIndex,
        speakerCharacterId: character.id,
        usage: outcome.usage,
      });
      await maybeUpdateSummary(session.id);
      return {
        reply: replyMessage,
        swipeIndex,
        swipeGroupId,
        siblings: await listBranchChildren(session.id, parent.id),
        preset: outcome.presetId,
        loreTriggered: outcome.loreTriggered,
        providerError: outcome.providerError,
        messages: await listMessages(session.id),
      };
    } finally {
      release();
    }
  });

  app.post<{ Params: { id: string; mid: string }; Body: { generationId?: string; speakerCharacterId?: string } | null }>(
    "/api/sessions/:id/messages/:mid/swipe/stream",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const source = await getMessage(session.id, request.params.mid);
      if (!source) {
        return reply.code(404).send({ error: "message not found" });
      }
      if (source.role !== "character") {
        return reply.code(400).send({ error: "only character messages can be swiped" });
      }
      if (session.stoppedAt || session.state === "closed") {
        return reply.code(409).send({
          error: "session is stopped",
          stoppedAt: session.stoppedAt,
          stopReason: session.stopReason,
          session,
        });
      }
      if (!source.parentId) {
        return reply.code(400).send({ error: "message has no parent to regenerate from" });
      }
      const parent = await getMessage(session.id, source.parentId);
      if (!parent || parent.role !== "user") {
        return reply.code(400).send({ error: "swipe requires a user message parent" });
      }
      const inheritedSpeaker = source.speakerCharacterId ?? session.primaryCharacterId;
      const character = targetCharacter(session, request.body?.speakerCharacterId ?? inheritedSpeaker);
      if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });
      const release = tryAcquireGeneration(session.id);
      if (!release) {
        return reply.code(409).send({ error: "generation already in flight for this session" });
      }
      let transferred = false;
      try {
        const history = parent.parentId ? await listBranchMessages(session.id, parent.parentId) : [];
        const swipeGroupId = source.swipeGroupId ?? source.id;
        const swipeIndex = await nextSwipeIndex(session.id, swipeGroupId);
        const generationId =
          typeof request.body?.generationId === "string" && request.body.generationId.trim() !== ""
            ? request.body.generationId
            : randomUUID();

        transferred = true;
        await runSseGeneration({
          request,
          reply,
          session,
          character,
          history,
          userContent: parent.content,
          generationId,
          release,
          persist: async (outcome) => {
            const replyMessage = await addMessage(session.id, "character", outcome.text, {
              parentId: parent.id,
              swipeGroupId,
              swipeIndex,
              speakerCharacterId: character.id,
              usage: outcome.usage,
            });
            return {
              replyMessage,
              extra: {
                swipeIndex,
                swipeGroupId,
                siblings: await listBranchChildren(session.id, parent.id),
                messages: await listMessages(session.id),
              },
            };
          },
        });
      } finally {
        if (!transferred) release();
      }
    },
  );

  app.post<{ Params: { id: string; mid: string } }>("/api/sessions/:id/messages/:mid/activate", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    const message = await getMessage(session.id, request.params.mid);
    if (!message) {
      return reply.code(404).send({ error: "message not found" });
    }
    await setActiveBranch(session.id, message.id);
    await maybeUpdateSummary(session.id, true);
    return { activeLeafId: message.id, messages: await listMessages(session.id) };
  });

  app.post<{ Params: { id: string }; Body: { messageId?: string; content?: string; speakerCharacterId?: string } }>(
    "/api/sessions/:id/branch",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const body = request.body;
      if (!body || typeof body.messageId !== "string") {
        return reply.code(400).send({ error: "messageId is required" });
      }
      if (typeof body.content !== "string" || body.content.trim() === "") {
        return reply.code(400).send({ error: "content is required" });
      }
      const anchor = await getMessage(session.id, body.messageId);
      if (!anchor) {
        return reply.code(404).send({ error: "message not found" });
      }
      if (session.stoppedAt || session.state === "closed") {
        return reply.code(409).send({
          error: "session is stopped",
          stoppedAt: session.stoppedAt,
          stopReason: session.stopReason,
          session,
        });
      }
      const character = targetCharacter(session, body.speakerCharacterId);
      if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });

      if (isSafeWord(body.content, safeWords(session))) {
        abortActiveGeneration(session.id);
        // Branch parenting mirrors the normal branch path: anchoring on a
        // character reply branches from that reply's user turn parent, so the
        // new user message must not be parented to another user message.
        const anchorUserTurn =
          anchor.role === "user" ? anchor : anchor.parentId ? await getMessage(session.id, anchor.parentId) : null;
        const safeParentId =
          anchor.role === "character" && anchorUserTurn?.role === "user" ? anchorUserTurn.parentId : anchor.parentId;
        const userMessage = await addMessage(session.id, "user", body.content, { parentId: safeParentId });
        await addConsentEvent(session.id, "safe-word", false, "Safe word used; scene closed.");
        const stopped = await transitionSession(session.id, "closed", "safe-word");
        const replyMessage = await addMessage(session.id, "character", SAFE_WORD_REPLY, {
          parentId: userMessage.id,
          speakerCharacterId: character.id,
        });
        return {
          userMessage,
          reply: replyMessage,
          session: stopped,
          state: stopped?.state ?? "closed",
          messages: await listMessages(session.id),
        };
      }

      const content = sanitizeUserContent(body.content);
      const policy = checkUserMessage(content);
      if (!policy.allowed) {
        return reply.code(422).send({ error: "policy violation", violations: policy.violations });
      }

      const release = tryAcquireGeneration(session.id);
      if (!release) {
        return reply.code(409).send({ error: "generation already in flight for this session" });
      }
      try {
        let workingSession: Session = session;
        if (session.state === "setup") {
          await addConsentEvent(session.id, "scene-start", true, "First user message moved scene from setup to active.");
          workingSession = (await transitionSession(session.id, "active", "first-user-message")) ?? session;
        }

        // A branch rewrites the user turn of the anchored exchange: anchoring on a
        // user message retries that message; anchoring on a character reply edits
        // the user message that produced it.
        const userTurn =
          anchor.role === "user" ? anchor : anchor.parentId ? await getMessage(session.id, anchor.parentId) : null;
        const branchParentId =
          anchor.role === "character" && userTurn?.role === "user" ? userTurn.parentId : anchor.parentId;
        const swipeGroupId = userTurn?.role === "user" ? (userTurn.swipeGroupId ?? userTurn.id) : null;
        const swipeIndex = swipeGroupId ? await nextSwipeIndex(session.id, swipeGroupId) : 0;
        const userMessage = await addMessage(session.id, "user", content, {
          parentId: branchParentId,
          ...(swipeGroupId ? { swipeGroupId, swipeIndex } : {}),
        });
        const history = branchParentId ? await listBranchMessages(session.id, branchParentId) : [];
        await addMemoryFacts(character.id, buildTurnMemories(content, userMessage.id, history, character.id));
        const outcome = await runCharacterPipeline({
          session: workingSession,
          character,
          history,
          userContent: content,
          log: request.log,
        });
        const replyMessage = await addMessage(session.id, "character", outcome.text, { parentId: userMessage.id, speakerCharacterId: character.id, usage: outcome.usage });

        await maybeUpdateSummary(session.id, true);

        const finalSession = (await getSession(session.id)) ?? workingSession;
        return {
          userMessage,
          reply: replyMessage,
          preset: outcome.presetId,
          loreTriggered: outcome.loreTriggered,
          providerError: outcome.providerError,
          session: finalSession,
          state: finalSession.state,
          messages: await listMessages(session.id),
        };
      } finally {
        release();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { speakerCharacterId?: string } | null }>(
    "/api/sessions/:id/continue",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      if (session.stoppedAt || session.state === "closed") return reply.code(409).send({ error: "session is stopped", session });
      const character = targetCharacter(session, request.body?.speakerCharacterId);
      if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });
      const release = tryAcquireGeneration(session.id);
      if (!release) return reply.code(409).send({ error: "generation already in flight for this session" });
      try {
        let workingSession = session;
        if (session.state === "setup") {
          await addConsentEvent(session.id, "scene-start", true, "Continue moved scene from setup to active.");
          workingSession = (await transitionSession(session.id, "active", "continue")) ?? session;
        }
        const history = await listMessages(session.id);
        const harness = await getHarnessSettings();
        const outcome = await runCharacterPipeline({
          session: workingSession,
          character,
          history,
          userContent: resolvePromptTemplate("continuation.single", harness.promptOverrides, { "target.name": character.name }),
          log: request.log,
        });
        const parentId = history.at(-1)?.id ?? null;
        const replyMessage = await addMessage(session.id, "character", outcome.text, {
          parentId, speakerCharacterId: character.id, usage: outcome.usage,
        });
        await maybeUpdateSummary(session.id);
        return {
          reply: replyMessage, session: (await getSession(session.id)) ?? workingSession,
          preset: outcome.presetId, loreTriggered: outcome.loreTriggered, providerError: outcome.providerError,
          messages: await listMessages(session.id),
        };
      } finally {
        release();
      }
    },
  );

  return app;
}
