import type { OrchestratedMessage } from "./prompt.js";
import type { CampaignAgentContextBasket } from "./context.js";
import { resolvePromptTemplate } from "./promptTemplates.js";
import type { PromptPreset } from "./presets.js";
import { buildOrchestratedMessages } from "./prompt.js";
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
} from "./types.js";
import { buildProviderHeaders, canUseProvider, canUseSystemOne } from "./provider/providerTransport.js";
import type { SystemOneCaller } from "./provider/systemOneCompletion.js";
import { buildRoomRoutingQuestions, composeRoomRoutingSelection } from "./agent/systemOneRoomRouting.js";
import { calibrateTopSignal } from "./agent/systemOneCalibration.js";
import { SYSTEM_ONE_CONFIDENCE_POLICY_VERSION, type SystemOneBand } from "./agent/systemOnePolicy.js";
import { isLanePromoted } from "./agent/systemOnePromotion.js";
import { estimateTurnTokens } from "./agent/turnBudget.js";
import { systemOneLaneBudgets } from "./agent/systemOneBudget.js";
import { systemOneLaneMode } from "./defaults.js";
import type { SystemOneConfidenceThresholds, SystemOneSettings } from "./types.js";
export { isLoopbackHost, validateProviderBaseUrl } from "./provider/providerTransport.js";

function stubReply(userContent: string, memoryCount: number, loreCount: number): string {
  const trimmed = userContent.trim().replace(/\s+/g, " ").slice(0, 80);
  const memoryNote = memoryCount > 0 ? ` I also remember ${memoryCount} approved detail${memoryCount === 1 ? "" : "s"}.` : "";
  const loreNote = loreCount > 0 ? ` ${loreCount} lore note${loreCount === 1 ? "" : "s"} is active.` : "";
  return `[local stub — provider not fully configured] (staying in character) I hear you: "${trimmed}".${memoryNote}${loreNote} Let's continue, keeping everything consensual and between adults.`;
}

export interface GenerationArgs {
  character: Character;
  participants?: Character[];
  session: Session;
  history: Message[];
  memories: MemoryFact[];
  summary: EpisodeSummary | null;
  preset: PromptPreset;
  lore: LoreEntry[];
  harness: HarnessSettings;
  provider: ProviderSettings;
  userContent: string;
  sharedContext?: string;
  /** Optional pre-authorized campaign context passed through without repository access. */
  campaignContext?: CampaignAgentContextBasket;
}

type PreparedGeneration =
  | { kind: "stub"; text: string }
  | { kind: "request"; url: string; headers: Record<string, string>; messages: OrchestratedMessage[] };

function prepareGeneration(args: GenerationArgs): PreparedGeneration {
  const { character, participants, session, history, memories, summary, preset, lore, harness, provider, userContent, sharedContext, campaignContext } = args;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  const messages = buildOrchestratedMessages({
    character,
    ...(participants ? { participants } : {}),
    targetCharacter: character,
    session,
    history,
    memories,
    summary,
    preset,
    lore,
    harness,
    userContent,
    ...(sharedContext ? { sharedContext } : {}),
    ...(campaignContext ? { campaignContext } : {}),
  });

  if (provider.samplers.startReplyWith.trim()) {
    messages.splice(messages.length - 1, 0, {
      role: "system",
      content: resolvePromptTemplate("provider.startReply", harness.promptOverrides, { "reply.start": provider.samplers.startReplyWith.trim() }),
    });
  }

  if (!canUseProvider(provider)) {
    return { kind: "stub", text: stubReply(userContent, memories.length, lore.length) };
  }

  return { kind: "request", url: `${baseUrl}/chat/completions`, headers: buildProviderHeaders(baseUrl, provider), messages };
}

export interface RoomSpeakerSelection {
  speakerIds: string[];
  source: "model" | "fallback";
  usage: TokenUsage | null;
  /** Internal usage discriminator; never serialized to HTTP. */
  kind?: "llm" | "system-one";
  /** Set when a System One decision was made (shadow or active) so the route can record it. */
  systemOneDecision?: SystemOneRoomRoutingDecision;
}

/** An audit payload for one System One room-routing dispatch, recorded immutably by the route. */
export interface SystemOneRoomRoutingDecision {
  lane: "speaker-routing";
  provider: string;
  model: string;
  confidencePolicyVersion: string;
  state: unknown;
  questions: unknown;
  answers: unknown;
  selection: unknown;
  confidenceBand: SystemOneBand;
  fallbackUsed: boolean;
  shadow: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
}

/** Optional System One lane for room routing; absent when the flag, setting, or key is off. */
export interface RoomRoutingSystemOne {
  settings: SystemOneSettings;
  caller: SystemOneCaller;
  /** Defaults to `settings.confidencePolicy["speaker-routing"]`. */
  thresholds?: SystemOneConfidenceThresholds;
}

type SystemOneRoomRoutingOutcome =
  | { kind: "selection"; selection: RoomSpeakerSelection }
  | { kind: "shadow"; decision: SystemOneRoomRoutingDecision }
  | null;

/**
 * Attempts the System One routing lane. Returns `null` — never throws — when the
 * lane is unavailable, over budget, low-confidence, or fails, so the caller always
 * retains the LLM and deterministic paths. In shadow mode it records the decision
 * but reports `kind: "shadow"` so behavior is unchanged.
 */
async function trySystemOneRoomRouting(input: {
  systemOne: RoomRoutingSystemOne | undefined;
  participants: Character[];
  history: Message[];
  userContent: string;
  maxSpeakers: number;
}): Promise<SystemOneRoomRoutingOutcome> {
  const { systemOne, participants, history, userContent, maxSpeakers } = input;
  if (!systemOne || !systemOne.settings.enabled || !canUseSystemOne(systemOne.settings)) return null;
  if (systemOneLaneMode(systemOne.settings, "speaker-routing") === "off") return null;
  const projection = participants.map((participant) => ({ id: participant.id, name: participant.name, archetype: participant.archetype }));
  const thresholds = systemOne.thresholds ?? systemOne.settings.confidencePolicy["speaker-routing"];
  const names = new Map(participants.map((participant) => [participant.id, participant.name]));
  const recent = history.slice(-8).map((message) => {
    const speaker = message.role === "character" ? names.get(message.speakerCharacterId ?? "") ?? "Character" : "User";
    return `${speaker}: ${message.content.slice(0, 300)}`;
  }).join("\n");
  const questions = buildRoomRoutingQuestions(projection, userContent, recent);
  const state = {
    user_message: userContent,
    recent_history: recent,
    max_speakers: maxSpeakers,
    participants: projection,
  };
  const reservation = systemOneLaneBudgets.reserve("speaker-routing", systemOne.settings.budget, {
    estimatedInputTokens: estimateTurnTokens(JSON.stringify({ state, questions })),
    maxOutputTokens: 0,
    pricing: {
      inputPerMillionUsd: systemOne.settings.pricing.promptPerMillion ?? 0,
      outputPerMillionUsd: systemOne.settings.pricing.completionPerMillion ?? 0,
    },
    nowMs: Date.now(),
  });
  if (!reservation.allowed) return null;
  const startedAt = performance.now();
  try {
    const result = await systemOne.caller({ settings: systemOne.settings, state, questions });
    const usage = result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : null;
    systemOneLaneBudgets.settle("speaker-routing", usage ?? { inputTokens: 0, outputTokens: 0 }, reservation.reservationId);
    const composed = composeRoomRoutingSelection(projection, result.answers, thresholds, maxSpeakers);
    // A lane changes behavior only when it is `active` and has a recorded, passing promotion.
    // Otherwise it still records the would-be decision.
    const active = systemOneLaneMode(systemOne.settings, "speaker-routing") === "active" && isLanePromoted("speaker-routing");
    const decision: SystemOneRoomRoutingDecision = {
      lane: "speaker-routing",
      provider: "typesafe",
      model: result.model.responseModel ?? systemOne.settings.model,
      confidencePolicyVersion: SYSTEM_ONE_CONFIDENCE_POLICY_VERSION,
      state,
      questions,
      answers: result.answers,
      selection: { method: composed.method, speakerIds: composed.speakerIds, topSignal: calibrateTopSignal(composed.topSignal, systemOne.settings.confidenceCalibration["speaker-routing"]) },
      confidenceBand: composed.band,
      fallbackUsed: !active || composed.band !== "act",
      shadow: !active,
      usage,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
    if (!active) return { kind: "shadow", decision };
    if (composed.band !== "act" || composed.speakerIds.length === 0) return { kind: "shadow", decision };
    return {
      kind: "selection",
      selection: {
        speakerIds: ensureGroupSpeakers(composed.speakerIds, participants, userContent, maxSpeakers),
        source: "model",
        kind: "system-one",
        systemOneDecision: decision,
        usage: usage
          ? {
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens,
              source: "provider",
              model: result.model.responseModel ?? systemOne.settings.model,
            }
          : null,
      },
    };
  } catch {
    systemOneLaneBudgets.release("speaker-routing", reservation.reservationId);
    return null;
  }
}

export async function synthesizeSceneState(input: {
  session: Session;
  history: Message[];
  manualCanon: string;
  previousState: string;
  provider: ProviderSettings;
  harness: HarnessSettings;
  preset: PromptPreset;
}): Promise<{ text: string; usage: TokenUsage | null } | null> {
  const { session, history, manualCanon, previousState, provider, harness, preset } = input;
  if (!canUseProvider(provider) || history.length === 0) return null;
  const names = new Map(session.participants.map((participant) => [participant.id, participant.name]));
  const recent = history.slice(-10).map((message) => {
    const speaker = message.role === "user" ? "User" : names.get(message.speakerCharacterId ?? "") ?? "Character";
    return `${speaker}: ${message.content.replace(/\s+/g, " ").trim().slice(0, 1200)}`;
  }).join("\n");
  const messages: OrchestratedMessage[] = [
    { role: "system", content: resolvePromptTemplate("scene.synthesizer.system", harness.promptOverrides, {}) },
    { role: "user", content: resolvePromptTemplate("scene.synthesizer.user", harness.promptOverrides, {
      "scene.manual": manualCanon.trim() || "none set",
      "scene.previous": previousState.trim() || "none yet",
      "scene.recent": recent,
    }) },
  ];
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const body = buildRequestBody(provider, { ...harness, temperature: 0.1 }, preset, messages, false);
  body.max_tokens = Math.min(provider.samplers.maxTokens ?? 700, 700);
  delete body.stop;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildProviderHeaders(baseUrl, provider),
    signal: AbortSignal.timeout(provider.requestTimeoutSeconds * 1000),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`scene synthesis failed: ${response.status}`);
  const payload = await response.json() as { model?: string; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }; choices?: Array<{ message?: { content?: unknown } }> };
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("scene synthesis returned no text");
  const cleaned = raw.replace(/^```(?:markdown|text)?\s*/i, "").replace(/\s*```$/, "").trim().slice(0, 8000);
  return cleaned ? { text: cleaned, usage: normalizeUsage(payload as StreamChunk, provider.model) } : null;
}

function requestedGroupSize(content: string, maxSpeakers: number): number {
  if (/\b(?:everyone|everybody|all of you|you all|the whole (?:room|group)|your characters)\b/i.test(content)) return maxSpeakers;
  if (/\b(?:you two|u 2|both|guys|gang|room)\b/i.test(content)) return Math.min(2, maxSpeakers);
  return 0;
}

export function ensureGroupSpeakers(speakerIds: string[], participants: Character[], content: string, maxSpeakers: number): string[] {
  const result = [...speakerIds];
  const minimum = requestedGroupSize(content, maxSpeakers);
  if (minimum > 0) {
    for (const participant of participants) {
      if (!result.includes(participant.id)) result.push(participant.id);
      if (result.length >= minimum) break;
    }
  }
  return result.slice(0, maxSpeakers);
}

export function fallbackRoomSpeakers(participants: Character[], primaryCharacterId: string, content: string, maxSpeakers: number): string[] {
  const lower = content.toLocaleLowerCase();
  const mentioned = participants.filter((participant) => lower.includes(participant.name.toLocaleLowerCase()));
  const selected = (mentioned.length > 0 ? mentioned : participants.filter((participant) => participant.id === primaryCharacterId))
    .slice(0, maxSpeakers)
    .map((participant) => participant.id);
  return ensureGroupSpeakers(selected, participants, content, maxSpeakers);
}

export async function selectRoomSpeakers(input: {
  participants: Character[];
  primaryCharacterId: string;
  history: Message[];
  userContent: string;
  maxSpeakers: number;
  provider: ProviderSettings;
  harness: HarnessSettings;
  preset: PromptPreset;
  /** Optional toggleable System One routing lane; absent leaves routing unchanged. */
  systemOne?: RoomRoutingSystemOne | undefined;
}): Promise<RoomSpeakerSelection> {
  const { participants, primaryCharacterId, history, userContent, maxSpeakers, provider, harness, preset } = input;
  const fallback = fallbackRoomSpeakers(participants, primaryCharacterId, userContent, maxSpeakers);
  const withDecision = (selection: RoomSpeakerSelection, decision: SystemOneRoomRoutingDecision | undefined): RoomSpeakerSelection =>
    decision ? { ...selection, systemOneDecision: decision } : selection;
  const fallbackSelection: RoomSpeakerSelection = { speakerIds: fallback, source: "fallback", usage: null };
  if (participants.length === 1) return fallbackSelection;
  const outcome = await trySystemOneRoomRouting({ systemOne: input.systemOne, participants, history, userContent, maxSpeakers });
  if (outcome?.kind === "selection") return outcome.selection;
  const shadowDecision = outcome?.kind === "shadow" ? outcome.decision : undefined;
  if (!canUseProvider(provider)) return withDecision(fallbackSelection, shadowDecision);

  const participantByToken = new Map<string, string>();
  for (const participant of participants) {
    participantByToken.set(participant.id.toLocaleLowerCase(), participant.id);
    participantByToken.set(participant.name.toLocaleLowerCase(), participant.id);
  }
  const names = new Map(participants.map((participant) => [participant.id, participant.name]));
  const recent = history.slice(-8).map((message) => {
    const speaker = message.role === "character" ? names.get(message.speakerCharacterId ?? "") ?? "Character" : "User";
    return `${speaker}: ${message.content.slice(0, 300)}`;
  }).join("\n");
  const messages: OrchestratedMessage[] = [
    {
      role: "system",
      content: resolvePromptTemplate("room.router.system", harness.promptOverrides, {
        "room.maxSpeakers": maxSpeakers,
        "participants.routing": participants.map((participant) => `- ${participant.id}: ${participant.name} — ${participant.archetype}`).join("\n"),
      }),
    },
    { role: "user", content: resolvePromptTemplate("room.router.user", harness.promptOverrides, {
      "history.recent": recent ? `Recent room history:\n${recent}` : "",
      "user.content": userContent,
    }) },
  ];
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const requestBody = {
    ...buildRequestBody(provider, harness, preset, messages, false),
    stream: false,
    temperature: 0,
    // 96 tokens was too small for reasoning-style models, which returned no JSON array
    // and forced a deterministic fallback; 512 leaves headroom while staying bounded.
    max_tokens: Math.min(provider.samplers.maxTokens ?? 512, 512),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildProviderHeaders(baseUrl, provider),
    signal: AbortSignal.timeout(provider.requestTimeoutSeconds * 1000),
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(`room routing request failed: ${response.status}`);
  const payload = await response.json() as { model?: string; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }; choices?: Array<{ message?: { content?: unknown } }> };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("room routing response had no text");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("room routing response was not a JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("room routing response was not an array");
  const speakerIds = ensureGroupSpeakers([...new Set(parsed.flatMap((value) => {
    if (typeof value !== "string") return [];
    const id = participantByToken.get(value.trim().toLocaleLowerCase());
    return id ? [id] : [];
  }))], participants, userContent, maxSpeakers);
  if (speakerIds.length === 0) throw new Error("room routing selected no valid participants");
  return withDecision({ speakerIds, source: "model", kind: "llm", usage: normalizeUsage(payload as StreamChunk, provider.model) }, shadowDecision);
}

export function buildRequestBody(
  provider: ProviderSettings,
  harness: HarnessSettings,
  preset: PromptPreset,
  messages: OrchestratedMessage[],
  stream: boolean,
): Record<string, unknown> {
  const model = provider.model.trim() || "gpt-4o-mini";
  const temperature = harness.temperature ?? preset.temperature;
  let openRouter = false;
  try {
    openRouter = /(?:^|\.)openrouter\.ai$/i.test(new URL(provider.baseUrl).hostname);
  } catch {
    openRouter = false;
  }
  const routing = openRouter
    ? {
        provider: {
          allow_fallbacks: provider.allowFallbacks,
          require_parameters: provider.requireParameters,
          ...(provider.routingSort !== "default" ? { sort: provider.routingSort } : {}),
          ...(provider.dataCollection !== "default" ? { data_collection: provider.dataCollection } : {}),
          ...(provider.zdr ? { zdr: true } : {}),
        },
      }
    : {};
  return {
    model,
    messages,
    stream,
    ...(temperature !== null ? { temperature } : {}),
    ...(provider.samplers.maxTokens !== null ? { max_tokens: provider.samplers.maxTokens } : {}),
    ...(provider.samplers.topP !== null ? { top_p: provider.samplers.topP } : {}),
    ...(provider.samplers.topK !== null ? { top_k: provider.samplers.topK } : {}),
    ...(provider.samplers.minP !== null ? { min_p: provider.samplers.minP } : {}),
    ...(provider.samplers.repetitionPenalty !== null ? { repetition_penalty: provider.samplers.repetitionPenalty } : {}),
    ...(provider.samplers.frequencyPenalty !== null ? { frequency_penalty: provider.samplers.frequencyPenalty } : {}),
    ...(provider.samplers.presencePenalty !== null ? { presence_penalty: provider.samplers.presencePenalty } : {}),
    ...(provider.samplers.seed !== null ? { seed: provider.samplers.seed } : {}),
    ...(provider.samplers.reasoningEffort === "none"
      ? { reasoning: { enabled: false } }
      : provider.samplers.reasoningEffort
        ? { reasoning: { effort: provider.samplers.reasoningEffort, exclude: true } }
        : {}),
    ...(provider.samplers.stopStrings.length > 0 ? { stop: provider.samplers.stopStrings } : {}),
    ...routing,
  };
}

interface StreamChunk {
  model?: string;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
  error?: { message?: unknown };
  choices?: Array<{
    delta?: { content?: string | null };
  }>;
}

export interface GenerationResult {
  text: string;
  usage: TokenUsage | null;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeUsage(chunk: StreamChunk, fallbackModel: string): TokenUsage | null {
  const usage = chunk.usage;
  if (!usage || !validTokenCount(usage.prompt_tokens) || !validTokenCount(usage.completion_tokens)) return null;
  const derived = usage.prompt_tokens + usage.completion_tokens;
  const total = validTokenCount(usage.total_tokens) && usage.total_tokens >= derived ? usage.total_tokens : derived;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: total,
    source: "provider",
    model: typeof chunk.model === "string" && chunk.model.trim() ? chunk.model : fallbackModel,
  };
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) char.codePointAt(0)! < 128 ? ascii++ : nonAscii++;
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

function estimateUsage(messages: OrchestratedMessage[], text: string, model: string): TokenUsage {
  const promptTokens = 3 + messages.reduce((sum, message) => sum + 4 + estimateTokens(message.role) + estimateTokens(message.content), 0);
  const completionTokens = estimateTokens(text);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, source: "estimated", model };
}

export async function streamReply(args: GenerationArgs, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<GenerationResult> {
  const prepared = prepareGeneration(args);
  if (prepared.kind === "stub") {
    onDelta(prepared.text);
    return { text: prepared.text, usage: null };
  }

  const body = buildRequestBody(args.provider, args.harness, args.preset, prepared.messages, true);
  const signals = [AbortSignal.timeout(args.provider.requestTimeoutSeconds * 1000)];
  if (signal) signals.push(signal);

  const res = await fetch(prepared.url, {
    method: "POST",
    headers: prepared.headers,
    signal: AbortSignal.any(signals),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error("LLM response contained no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let usage: TokenUsage | null = null;
  let finished = false;
  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      finished = true;
      return;
    }
    if (data === "") return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return;
    }
    if (chunk.error) throw new Error(`LLM stream error: ${String(chunk.error.message ?? "unknown provider error")}`);
    usage = normalizeUsage(chunk, args.provider.model.trim()) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta !== "") {
      full += delta;
      onDelta(delta);
    }
  };
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          processLine(line);
          if (finished) break;
        }
      }
      buffer += decoder.decode();
      if (!finished && buffer) processLine(buffer);
    } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: full,
    usage: usage ?? estimateUsage(prepared.messages, full, args.provider.model.trim()),
  };
}

export async function generateReply(
  character: Character,
  session: Session,
  history: Message[],
  memories: MemoryFact[],
  summary: EpisodeSummary | null,
  preset: PromptPreset,
  lore: LoreEntry[],
  harness: HarnessSettings,
  provider: ProviderSettings,
  userContent: string,
  participants?: Character[],
  sharedContext?: string,
  campaignContext?: CampaignAgentContextBasket,
): Promise<GenerationResult> {
  return streamReply(
    { character, ...(participants ? { participants } : {}), session, history, memories, summary, preset, lore, harness, provider, userContent, ...(sharedContext ? { sharedContext } : {}), ...(campaignContext ? { campaignContext } : {}) },
    () => undefined,
  );
}
