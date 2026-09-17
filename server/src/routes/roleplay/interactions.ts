import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { buildTurnMemories } from "../../memory.js";
import { checkUserMessage, sanitizeUserContent } from "../../policy.js";
import { getPromptPreset } from "../../presets.js";
import { resolvePromptTemplate } from "../../promptTemplates.js";
import {
  addConsentEvent,
  addMemoryFacts,
  addMessage,
  getHarnessSettings,
  getMessage,
  getProviderSettings,
  getSession,
  getSystemOneSettings,
  recordSystemOneDecision,
  listBranchChildren,
  listBranchMessages,
  listMessages,
  nextSwipeIndex,
  recordUsageEvent,
  setActiveBranch,
  transitionSession,
} from "../../repo/index.js";
import type { Message, PostMessageInput, RoomContinueInput, RoomTurnInput, Session, SystemOneSettings } from "../../types.js";
import type { RoomRoutingSystemOne, SystemOneRoomRoutingDecision } from "../../llm.js";
import { canUseSystemOne } from "../../provider/providerTransport.js";
import { callSystemOne, type SystemOneCaller } from "../../provider/systemOneCompletion.js";
import { buildRouterQuestions, composeRouterDecision, type RouterHandler, type RouterRequestProjection } from "../../agent/systemOneRouter.js";
import { SYSTEM_ONE_CONFIDENCE_POLICY_VERSION } from "../../agent/systemOnePolicy.js";
import { readRpgFeatureFlags } from "../../features.js";
import {
  fallbackRoomSpeakers,
  maybeUpdateSummary,
  openSse,
  runCharacterPipeline,
  runSseGeneration,
  selectRoomSpeakers,
  targetCharacter,
} from "./generationService.js";
import { generationRegistry } from "./generationRegistry.js";

/** Resolves the optional room-routing System One lane from the flag, setting, and key. */
async function resolveRoomRoutingSystemOne(): Promise<RoomRoutingSystemOne | undefined> {
  if (!readRpgFeatureFlags().systemOne) return undefined;
  const settings = await getSystemOneSettings();
  if (!settings.enabled || !canUseSystemOne(settings)) return undefined;
  return { settings, caller: callSystemOne };
}

function usageKind(selection: { kind?: "llm" | "system-one" }): string {
  return selection.kind === "system-one" ? "room_routing_system_one" : "room_routing";
}

/** Records one System One routing decision immutably; never allowed to fail a room turn. */
function recordRoomRoutingDecision(sessionId: string, decision: SystemOneRoomRoutingDecision): void {
  try {
    recordSystemOneDecision({
      decisionId: randomUUID(),
      lane: decision.lane,
      sessionId,
      provider: decision.provider,
      model: decision.model,
      confidencePolicyVersion: decision.confidencePolicyVersion,
      state: decision.state,
      questions: decision.questions,
      answers: decision.answers,
      selection: decision.selection,
      confidenceBand: decision.confidenceBand,
      fallbackUsed: decision.fallbackUsed,
      shadow: decision.shadow,
      usage: decision.usage,
      latencyMs: decision.latencyMs,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Advisory only: a decision-record failure must not affect routing or the turn.
  }
}

/**
 * Records a record-only cost-router shadow decision. It builds the L7 router battery,
 * asks the injected caller, composes against the current handler, and persists an
 * immutable `cost-router` row. It is advisory: it never throws, never selects a
 * handler, and never influences routing, generation, fallbacks, or the response.
 */
export async function recordRouterShadowDecision(
  sessionId: string,
  request: RouterRequestProjection,
  lane: { settings: SystemOneSettings; caller: SystemOneCaller },
  currentHandler: RouterHandler,
): Promise<void> {
  try {
    const questions = buildRouterQuestions(request);
    const state = { ...request };
    const startedAt = performance.now();
    const result = await lane.caller({ settings: lane.settings, state, questions });
    const decision = composeRouterDecision(
      request,
      result.answers,
      lane.settings.confidencePolicy["cost-router"],
      currentHandler,
    );
    recordSystemOneDecision({
      decisionId: randomUUID(),
      lane: "cost-router",
      sessionId,
      provider: "typesafe",
      model: result.model.responseModel ?? lane.settings.model,
      confidencePolicyVersion: SYSTEM_ONE_CONFIDENCE_POLICY_VERSION,
      state,
      questions,
      answers: result.answers,
      selection: {
        band: decision.band,
        handler: decision.handler,
        complexity: decision.complexity,
        deterministicSufficient: decision.deterministicSufficient,
        topSignal: decision.topSignal,
        reason: decision.reason,
      },
      confidenceBand: decision.band,
      fallbackUsed: true,
      shadow: true,
      usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Advisory shadow recording: never affects routing, generation, or the response.
  }
}

export const roleplayInteractionRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string }; Body: PostMessageInput }>("/sessions/:id/messages", async (request, reply) => {
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

    const { content, wasTruncated } = sanitizeUserContent(rawContent);
    if (wasTruncated) request.log.warn({ sessionId: session.id, contentLength: content.length }, "user content truncated to policy limit");
    const policy = checkUserMessage(content);
    if (!policy.allowed) {
      return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    }

    const release = generationRegistry.tryAcquire(session.id);
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
      const replyMessage = await addMessage(session.id, "character", outcome.text, {
        parentId: userMessage.id,
        speakerCharacterId: character.id,
        usage: outcome.usage,
      });

      await maybeUpdateSummary(session.id, false, request.log);
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

  app.post<{ Params: { id: string }; Body: RoomTurnInput }>("/sessions/:id/room-turn", async (request, reply) => {
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
    const { content, wasTruncated } = sanitizeUserContent(rawContent);
    if (wasTruncated) request.log.warn({ sessionId: session.id, contentLength: content.length }, "user content truncated to policy limit");
    const policy = checkUserMessage(content);
    if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    const release = generationRegistry.tryAcquire(session.id);
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
      let routingSystemOne: RoomRoutingSystemOne | undefined;
      let selection;
      try {
        routingSystemOne = await resolveRoomRoutingSystemOne();
        selection = await selectRoomSpeakers({
          participants: session.participants,
          primaryCharacterId: session.primaryCharacterId,
          history: historyBefore,
          userContent: content,
          maxSpeakers,
          provider,
          harness,
          preset: getPromptPreset(session.presetId),
          systemOne: routingSystemOne,
        });
      } catch {
        request.log.error({ operation: "room-routing" }, "room routing failed; using deterministic fallback");
        selection = {
          speakerIds: fallbackRoomSpeakers(session.participants, session.primaryCharacterId, content, maxSpeakers),
          source: "fallback" as const,
          usage: null,
        };
      }
      if (selection.usage) await recordUsageEvent(session.id, usageKind(selection), selection.usage);
      if (selection.systemOneDecision) recordRoomRoutingDecision(session.id, selection.systemOneDecision);
      if (routingSystemOne?.settings.shadow) {
        try {
          await recordRouterShadowDecision(
            session.id,
            { summary: content, hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false },
            routingSystemOne,
            "frontier-generation",
          );
        } catch {
          // Advisory shadow routing: never affects routing, generation, fallbacks, or the response.
        }
      }

      const userMessage = await addMessage(session.id, "user", content);
      const roomSse = request.headers.accept?.includes("text/event-stream") ? openSse(reply) : null;
      roomSse?.send("user_message", { message: userMessage });
      roomSse?.send("state", { session: workingSession, state: workingSession.state });
      for (const speakerId of selection.speakerIds) {
        await addMemoryFacts(speakerId, buildTurnMemories(content, userMessage.id, historyBefore, speakerId));
      }
      const replies: Message[] = [];
      const outcomes = [];
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
      await maybeUpdateSummary(session.id, false, request.log);
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

  app.post<{ Params: { id: string }; Body: RoomContinueInput | null }>("/sessions/:id/room-continue", async (request, reply) => {
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

    const release = generationRegistry.tryAcquire(session.id);
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
          systemOne: await resolveRoomRoutingSystemOne(),
        });
      } catch {
        request.log.error({ operation: "room-continuation-routing" }, "room continuation routing failed; using deterministic fallback");
        selection = {
          speakerIds: fallbackRoomSpeakers(session.participants, session.primaryCharacterId, routingContent, maxSpeakers),
          source: "fallback" as const,
          usage: null,
        };
      }
      if (selection.usage) await recordUsageEvent(session.id, usageKind(selection), selection.usage);
      if (selection.systemOneDecision) recordRoomRoutingDecision(session.id, selection.systemOneDecision);
      const firstOther = selection.speakerIds.find((id) => id !== previousCharacter.id)
        ?? session.participants.find((participant) => participant.id !== previousCharacter.id)?.id;
      const selectedSpeakerIds = firstOther
        ? [firstOther, ...selection.speakerIds.filter((id) => id !== firstOther)].slice(0, maxSpeakers)
        : selection.speakerIds;

      const roomSse = request.headers.accept?.includes("text/event-stream") ? openSse(reply) : null;
      roomSse?.send("state", { session, state: session.state });
      const replies: Message[] = [];
      const outcomes = [];
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
      await maybeUpdateSummary(session.id, false, request.log);
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
    "/sessions/:id/stream",
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

      const { content, wasTruncated } = sanitizeUserContent(rawContent);
      if (wasTruncated) request.log.warn({ sessionId: session.id, contentLength: content.length }, "user content truncated to policy limit");
      const policy = checkUserMessage(content);
      if (!policy.allowed) {
        const sse = openSse(reply);
        sse.send("error", { error: "policy violation", violations: policy.violations });
        sse.end();
        return;
      }

      const release = generationRegistry.tryAcquire(session.id);
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
    "/sessions/:id/generation/cancel",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const active = generationRegistry.getActive(session.id);
      const generationId = request.body?.generationId;
      if (!active || (typeof generationId === "string" && generationId !== active.generationId)) {
        return reply.code(404).send({ error: "no matching generation in flight" });
      }
      active.controller.abort();
      return { ok: true, aborted: active.generationId };
    },
  );

  app.post<{ Params: { id: string; mid: string }; Body: { speakerCharacterId?: string } | null }>("/sessions/:id/messages/:mid/swipe", async (request, reply) => {
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
    const release = generationRegistry.tryAcquire(session.id);
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
      await maybeUpdateSummary(session.id, false, request.log);
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
    "/sessions/:id/messages/:mid/swipe/stream",
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
      const release = generationRegistry.tryAcquire(session.id);
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

  app.post<{ Params: { id: string; mid: string } }>("/sessions/:id/messages/:mid/activate", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    const message = await getMessage(session.id, request.params.mid);
    if (!message) {
      return reply.code(404).send({ error: "message not found" });
    }
    await setActiveBranch(session.id, message.id);
    await maybeUpdateSummary(session.id, true, request.log);
    return { activeLeafId: message.id, messages: await listMessages(session.id) };
  });

  app.post<{ Params: { id: string }; Body: { messageId?: string; content?: string; speakerCharacterId?: string } }>(
    "/sessions/:id/branch",
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

      const { content, wasTruncated } = sanitizeUserContent(body.content);
      if (wasTruncated) request.log.warn({ sessionId: session.id, contentLength: content.length }, "user content truncated to policy limit");
      const policy = checkUserMessage(content);
      if (!policy.allowed) {
        return reply.code(422).send({ error: "policy violation", violations: policy.violations });
      }

      const release = generationRegistry.tryAcquire(session.id);
      if (!release) {
        return reply.code(409).send({ error: "generation already in flight for this session" });
      }
      try {
        let workingSession: Session = session;
        if (session.state === "setup") {
          await addConsentEvent(session.id, "scene-start", true, "First user message moved scene from setup to active.");
          workingSession = (await transitionSession(session.id, "active", "first-user-message")) ?? session;
        }

        // A branch rewrites the user turn of the anchored exchange.
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

        await maybeUpdateSummary(session.id, true, request.log);
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
    "/sessions/:id/continue",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      if (session.stoppedAt || session.state === "closed") return reply.code(409).send({ error: "session is stopped", session });
      const character = targetCharacter(session, request.body?.speakerCharacterId);
      if (!character) return reply.code(400).send({ error: "speakerCharacterId must be a session participant" });
      const release = generationRegistry.tryAcquire(session.id);
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
        await maybeUpdateSummary(session.id, false, request.log);
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
};
