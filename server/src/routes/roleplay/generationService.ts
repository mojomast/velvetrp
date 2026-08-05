import type { FastifyReply, FastifyRequest } from "fastify";
import { buildSessionContextBasket, contextBasketText } from "../../context.js";
import { fallbackRoomSpeakers, generateReply, selectRoomSpeakers, streamReply, synthesizeSceneState } from "../../llm.js";
import { selectLoreEntries } from "../../lore.js";
import { buildEpisodeSummary, shouldUpdateSummary } from "../../memory.js";
import { checkAssistantOutput } from "../../policy.js";
import { getPromptPreset, type PromptPreset } from "../../presets.js";
import { cleanCharacterReply } from "../../prompt.js";
import {
  deleteSummary,
  getHarnessSettings,
  getProviderSettings,
  getSession,
  getSessionContextSource,
  getSummary,
  listApprovedMemories,
  listLoreEntries,
  listMessages,
  recordUsageEvent,
  updateSessionSynthesizedSource,
  upsertSummary,
} from "../../repo/index.js";
import type {
  Character,
  EpisodeSummary,
  HarnessSettings,
  LoreEntry,
  MemoryFact,
  Message,
  ProviderSettings,
  Session,
  TokenUsage,
} from "../../types.js";
import { generationRegistry } from "./generationRegistry.js";

export { fallbackRoomSpeakers, selectRoomSpeakers };

const SAFE_FALLBACK_REPLY =
  "I'm having trouble reaching the story engine right now, so I'm holding the scene right here. Your message is saved — try again in a moment and we'll continue, within the agreed boundaries.";
const BOUNDARY_REPLACEMENT_REPLY =
  "I’m keeping this within the agreed boundaries and the current scene state. Tell me what direction you want, within those limits.";

export interface GenerationOutcome {
  text: string;
  presetId: string;
  loreTriggered: number;
  providerError: boolean;
  usage: TokenUsage | null;
}

export interface PipelineContext {
  preset: PromptPreset;
  harness: HarnessSettings;
  provider: ProviderSettings;
  memories: MemoryFact[];
  summary: EpisodeSummary | null;
  lore: LoreEntry[];
  sharedContext: string;
}

export async function assemblePipelineContext(input: {
  session: Session;
  character: Character;
  history: Message[];
  userContent: string;
}): Promise<PipelineContext> {
  const { session, character, history, userContent } = input;
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
  return { preset, harness, provider, memories, summary, lore, sharedContext };
}

export async function runCharacterPipeline(input: {
  session: Session;
  character: Character;
  history: Message[];
  userContent: string;
  log: { error: (obj: object, msg: string) => void };
}): Promise<GenerationOutcome> {
  const { session, character, history, userContent, log } = input;
  const { preset, harness, provider, memories, summary, lore, sharedContext } = await assemblePipelineContext({
    session,
    character,
    history,
    userContent,
  });
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
  const { preset, harness, provider, memories, summary, lore, sharedContext } = await assemblePipelineContext({
    session,
    character,
    history,
    userContent,
  });
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

export class SseWriter {
  constructor(private readonly raw: FastifyReply["raw"]) {}

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

export function openSse(reply: FastifyReply): SseWriter {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return new SseWriter(reply.raw);
}

export async function runSseGeneration(input: {
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
    generationRegistry.clearActive(session.id);
    release();
  };

  try {
    generationRegistry.setActive(session.id, { generationId, controller });
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
    // A stop may have closed the session while the provider ran.
    const freshSession = await getSession(session.id);
    const externallyAborted = result.kind === "completed" && controller.signal.aborted;
    if (externallyAborted || !freshSession || freshSession.stoppedAt || freshSession.state === "closed") {
      finished = true;
      sse.send("aborted", { generationId });
      sse.end();
      return;
    }
    const { replyMessage, extra } = await persist(outcome);
    await maybeUpdateSummary(session.id, false, request.log);
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

export async function maybeUpdateSummary(
  sessionId: string,
  force = false,
  log: { warn: (obj: object, msg: string) => void } = { warn: () => {} },
): Promise<void> {
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
      log.warn({ sessionId, error }, "scene synthesis skipped");
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

export function targetCharacter(session: Session, requestedId?: string): Character | null {
  const id = requestedId ?? session.primaryCharacterId;
  return session.participants.find((participant) => participant.id === id) ?? null;
}
