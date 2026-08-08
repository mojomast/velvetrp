import { apiProblemSchema, campaignCharacterCreateRequestSchema, campaignCharacterCreateResponseSchema, campaignCharacterCreationOptionsResponseSchema, campaignCharacterListResponseSchema, campaignCharacterWorkspaceResponseSchema, campaignCreateRequestSchema, campaignCreateResponseSchema, campaignDetailResponseSchema, campaignDiceHistoryResponseSchema, campaignDiceRollRequestSchema, campaignDiceRollResponseSchema, campaignListResponseSchema, campaignMechanicsStarterSetupRequestSchema, campaignMechanicsStarterSetupResponseSchema, campaignRenameRequestSchema, campaignRenameResponseSchema, campaignRoomAttachRequestSchema, campaignRoomAttachResponseSchema, campaignRoomLinkingResponseSchema, campaignStarterSetupRequestSchema, MECHANICS_STARTER_ID, MECHANICS_STARTER_IDENTITY, ORIGINAL_STARTER_ID, ORIGINAL_STARTER_PRESENTATION, resourceIdSchema, roleplayFeatureFlagsSchema, rpgFeatureFlagsSchema } from "@velvet/contracts";
import type { ApiProblem, CampaignAccess as ContractCampaignAccess, CampaignCharacterCreateRequest, CampaignCharacterCreateResponse, CampaignCharacterCreationOptionsResponse, CampaignCharacterListResponse, CampaignCharacterWorkspaceResponse, CampaignCreateRequest, CampaignCreateResponse, CampaignDetail as ContractCampaignDetail, CampaignDetailResponse as ContractCampaignDetailResponse, CampaignDiceHistoryResponse, CampaignDiceRollRequest, CampaignDiceRollResponse, CampaignListResponse as ContractCampaignListResponse, CampaignRenameRequest, CampaignRenameResponse, CampaignRoomAttachRequest, CampaignRoomAttachResponse, CampaignRoomLinkingResponse, RoleplayFeatureFlags, RpgFeatureFlags } from "@velvet/contracts";
import {
  campaignAdministrationHttpArchiveRequestSchema,
  campaignAdministrationHttpArchiveResponseSchema,
  campaignAdministrationHttpGetResponseSchema,
  campaignAdministrationHttpMembershipCreateRequestSchema,
  campaignAdministrationHttpMembershipDeleteRequestSchema,
  campaignAdministrationHttpMembershipListResponseSchema,
  campaignAdministrationHttpMembershipMutationResponseSchema,
  campaignAdministrationHttpMembershipUpdateRequestSchema,
  campaignAdministrationHttpPatchRequestSchema,
  campaignAdministrationHttpPatchResponseSchema,
  campaignHistoryHttpCheckpointRequestSchema,
  campaignHistoryHttpCheckpointResponseSchema,
  campaignHistoryHttpCheckpointSchema,
  campaignHistoryHttpForkRequestSchema,
  campaignHistoryHttpForkResponseSchema,
  campaignHistoryHttpTimelinesResponseSchema,
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
} from "@velvet/contracts";
import type {
  CampaignAdministrationHttpArchiveRequest,
  CampaignAdministrationHttpArchiveResponse,
  CampaignAdministrationHttpMembershipCreateRequest,
  CampaignAdministrationHttpMembershipDeleteRequest,
  CampaignAdministrationHttpMembershipListResponse,
  CampaignAdministrationHttpMembershipMutationResponse,
  CampaignAdministrationHttpMembershipUpdateRequest,
  CampaignAdministrationHttpPatchRequest,
  CampaignAdministrationHttpPatchResponse,
  CampaignAdministrationHttpResponse,
  CampaignHistoryHttpCheckpoint,
  CampaignHistoryHttpCheckpointRequest,
  CampaignHistoryHttpCheckpointResponse,
  CampaignHistoryHttpForkRequest,
  CampaignHistoryHttpForkResponse,
  CampaignHistoryHttpTimelinesResponse,
  CampaignTransferHttpDryRunRequest,
  CampaignTransferHttpDryRunResponse,
} from "@velvet/contracts";
import {
  contentCatalogHttpCampaignContentGetResponseSchema,
  contentCatalogHttpCampaignContentPutRequestSchema,
  contentCatalogHttpCampaignContentPutResponseSchema,
  contentCatalogHttpCampaignPackDetailResponseSchema,
  contentCatalogHttpOwnerDetailResponseSchema,
  contentCatalogHttpPublicationRequestSchema,
  contentCatalogHttpPublicationResponseSchema,
  contentCatalogHttpPublicationsQuerySchema,
  contentCatalogHttpPublicationsResponseSchema,
  contentCatalogHttpValidationRequestSchema,
  contentCatalogHttpValidationResponseSchema,
  contentPackVersionSchema,
} from "@velvet/contracts";
import type {
  ContentCatalogHttpCampaignContentGetResponse,
  ContentCatalogHttpCampaignContentPutRequest,
  ContentCatalogHttpCampaignContentPutResponse,
  ContentCatalogHttpCampaignPackDetailResponse,
  ContentCatalogHttpOwnerDetailResponse,
  ContentCatalogHttpPublicationRequest,
  ContentCatalogHttpPublicationResponse,
  ContentCatalogHttpPublicationsQuery,
  ContentCatalogHttpPublicationsResponse,
  ContentCatalogHttpValidationRequest,
  ContentCatalogHttpValidationResponse,
} from "@velvet/contracts";

export type FeatureFlags = RoleplayFeatureFlags;
export type CampaignAccess = ContractCampaignAccess;
export type CampaignListResponse = ContractCampaignListResponse;
export type CampaignDetail = ContractCampaignDetail;
export type CampaignDetailResponse = ContractCampaignDetailResponse;
export type RpgFeatures = RpgFeatureFlags;

export interface CharacterSpec {
  name: string;
  age: number;
  archetype: string;
  boundaries: string;
  fictionalConfirmed: boolean;
}

export interface Character extends CharacterSpec {
  id: string;
  isRealPerson: boolean;
  createdAt: string;
}

export type SceneState = "setup" | "active" | "paused" | "cooldown" | "closed";

export interface Session {
  id: string;
  characterId: string;
  primaryCharacterId: string;
  participants: Character[];
  title: string;
  state: SceneState;
  presetId: string;
  activeLeafId: string | null;
  createdAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
}

export interface SessionContextBasket {
  sessionId: string;
  state: SceneState;
  sourceOfTruth: string;
  editableSource: string;
  sourceUpdatedAt: string | null;
  synthesizedSource: string;
  synthesizedUpdatedAt: string | null;
  participants: Array<{ id: string; name: string; archetype: string }>;
  recentEvents: string[];
  rememberedFacts: string[];
  activeLore: string[];
  openThreads: string[];
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "character" | "system";
  speakerCharacterId: string | null;
  content: string;
  createdAt: string;
  parentId?: string | null;
  swipeGroupId?: string | null;
  swipeIndex?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    source: "provider" | "estimated";
    model: string;
  } | null;
}

export type MemoryKind = "fact" | "preference" | "event";

export interface MemoryFact {
  id: string;
  characterId: string;
  kind: MemoryKind;
  content: string;
  sourceTurnId: string;
  createdAt: string;
  userApproved: boolean;
  forgottenAt: string | null;
}

export interface LoreEntry {
  id: string;
  characterId: string | null;
  characterIds: string[];
  keys: string[];
  content: string;
  enabled: boolean;
  insertionOrder: number;
  createdAt: string;
}

export interface LoreInput {
  characterIds: string[];
  keys: string[];
  content: string;
  enabled: boolean;
  insertionOrder: number;
}

export class ApiError extends Error {
  status: number;
  violations: string[];
  sessionStopped: boolean;
  problem: ApiProblem | null;
  code: string | null;
  requestId: string | null;

  constructor(
    status: number,
    message: string,
    violations: string[] = [],
    sessionStopped = false,
    problem: ApiProblem | null = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.violations = violations;
    this.sessionStopped = sessionStopped;
    this.problem = problem;
    this.code = problem?.code ?? null;
    this.requestId = problem?.requestId ?? requestId;
  }
}

/** A request was rejected by the local wire contract before network I/O. */
export class ApiInputError extends Error {
  constructor(message = "API request input is invalid") {
    super(message);
    this.name = "ApiInputError";
  }
}

function parseApiInput<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new ApiInputError(); }
}

export async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  let violations: string[] = [];
  let sessionStopped = false;
  let problem: ApiProblem | null = null;
  try {
    const body: unknown = await res.json();
    const parsedProblem = apiProblemSchema.safeParse(body);
    if (parsedProblem.success) {
      problem = parsedProblem.data;
      message = problem.detail;
      violations = problem.violations ?? [];
      sessionStopped = problem.code === "SESSION_STOPPED";
    }
    if (
      !problem &&
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      message = (body as { error: string }).error;
    }
    if (
      !problem &&
      typeof body === "object" &&
      body !== null &&
      ("stopReason" in body || "stoppedAt" in body)
    ) {
      sessionStopped = true;
    }
    if (
      !problem &&
      typeof body === "object" &&
      body !== null &&
      "violations" in body &&
      Array.isArray((body as { violations: unknown }).violations)
    ) {
      violations = (body as { violations: unknown[] }).violations.filter(
        (v): v is string => typeof v === "string",
      );
      if (violations.length > 0) {
        message = `${message}: ${violations.join("; ")}`;
      }
    }
    if (
      !problem &&
      typeof body === "object" &&
      body !== null &&
      "reason" in body &&
      typeof (body as { reason: unknown }).reason === "string"
    ) {
      message = `${message}: ${(body as { reason: string }).reason}`;
    }
  } catch {
    // keep default message
  }
  return new ApiError(res.status, message, violations, sessionStopped, problem, res.headers.get("x-request-id"));
}

async function requestResponse<T>(path: string, init?: RequestInit): Promise<{ body: T; status: number }> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  return { body: (await res.json()) as T, status: res.status };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestResponse<T>(path, init)).body;
}

export function createCharacter(spec: CharacterSpec): Promise<Character> {
  return request<Character>("/characters", {
    method: "POST",
    body: JSON.stringify(spec),
  });
}

export function listCharacters(): Promise<{ characters: Character[] }> {
  return request<{ characters: Character[] }>("/characters");
}

export function updateCharacter(id: string, spec: CharacterSpec): Promise<Character> {
  return request<Character>(`/characters/${id}`, { method: "PATCH", body: JSON.stringify(spec) });
}

export function deleteCharacter(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/characters/${id}`, { method: "DELETE" });
}

export function exportCharacter(id: string): Promise<unknown> {
  return request<unknown>(`/characters/${id}/export`);
}

export function importCharacter(data: unknown): Promise<Character> {
  return request<Character>("/characters/import", { method: "POST", body: JSON.stringify(data) });
}

export interface StartSessionInput {
  characterIds: string[];
  primaryCharacterId: string;
  title?: string;
  presetId?: string;
}

export function startSession(input: string | StartSessionInput): Promise<Session> {
  const body = typeof input === "string" ? { characterId: input } : input;
  return request<Session>("/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function openSoloSession(characterId: string): Promise<{ session: Session; messages: ChatMessage[]; created: boolean }> {
  return request<{ session: Session; messages: ChatMessage[]; created: boolean }>("/sessions/solo", {
    method: "POST",
    body: JSON.stringify({ characterId }),
  });
}

export function listSessions(characterId?: string): Promise<{ sessions: Session[] }> {
  return request<{ sessions: Session[] }>(`/sessions${characterId ? `?characterId=${encodeURIComponent(characterId)}` : ""}`);
}

/** Encode one opaque legacy identifier exactly once for use as a URL segment. */
export function encodeOpaquePathSegment(id: string): string {
  return encodeURIComponent(id);
}

export function getSession(sessionId: string): Promise<{ session: Session; messages: ChatMessage[] }> {
  return request<{ session: Session; messages: ChatMessage[] }>(`/sessions/${encodeOpaquePathSegment(sessionId)}`);
}

export function getSessionContext(sessionId: string): Promise<{ context: SessionContextBasket }> {
  return request<{ context: SessionContextBasket }>(`/sessions/${encodeOpaquePathSegment(sessionId)}/context`);
}

export function updateSessionContext(sessionId: string, sourceOfTruth: string): Promise<{ source: { sourceOfTruth: string; updatedAt: string } }> {
  return request(`/sessions/${encodeOpaquePathSegment(sessionId)}/context`, { method: "PUT", body: JSON.stringify({ sourceOfTruth }) });
}

export function deleteSession(sessionId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/sessions/${encodeOpaquePathSegment(sessionId)}`, { method: "DELETE" });
}

export interface TurnResult {
  reply: ChatMessage;
  messages?: ChatMessage[];
  session?: Session;
  state?: Session["state"];
  providerError?: boolean;
}

export interface RoomTurnResult {
  userMessage: ChatMessage;
  replies: ChatMessage[];
  selectedSpeakerIds: string[];
  routing: "model" | "fallback";
  messages: ChatMessage[];
  session?: Session;
  state?: Session["state"];
  providerError?: boolean;
  loreTriggered?: number;
}

export interface RoomContinuationResult {
  replies: ChatMessage[];
  selectedSpeakerIds: string[];
  routing: "model" | "fallback";
  messages: ChatMessage[];
  session?: Session;
  state?: Session["state"];
  providerError?: boolean;
  loreTriggered?: number;
}

export function sendMessage(sessionId: string, content: string, speakerCharacterId?: string): Promise<TurnResult> {
  return request<TurnResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, speakerCharacterId }),
  });
}

export function sendRoomMessage(sessionId: string, content: string, maxSpeakers = 3): Promise<RoomTurnResult> {
  return request<RoomTurnResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/room-turn`, {
    method: "POST",
    body: JSON.stringify({ content, maxSpeakers }),
  });
}

export function continueRoom(sessionId: string, maxSpeakers = 2): Promise<RoomContinuationResult> {
  return request<RoomContinuationResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/room-continue`, {
    method: "POST",
    body: JSON.stringify({ maxSpeakers }),
  });
}

export interface RoomStreamHandlers {
  onUserMessage?: (message: ChatMessage) => void;
  onState?: (session: Session | undefined, state: string) => void;
  onReply: (reply: ChatMessage, index: number, total: number) => void;
  onDone: (result: RoomTurnResult | RoomContinuationResult) => void;
  onError?: (error: string) => void;
}

async function streamRoom(path: string, body: Record<string, unknown>, handlers: RoomStreamHandlers): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ApiError(0, "room stream response had no body");
  const push = createSseParser((event, data) => {
    const payload = (data ?? {}) as Record<string, unknown>;
    if (event === "user_message") handlers.onUserMessage?.(payload.message as ChatMessage);
    else if (event === "state") handlers.onState?.(payload.session as Session | undefined, String(payload.state ?? ""));
    else if (event === "room_reply") handlers.onReply(payload.reply as ChatMessage, Number(payload.index), Number(payload.total));
    else if (event === "room_done") handlers.onDone(payload as unknown as RoomTurnResult | RoomContinuationResult);
    else if (event === "error") handlers.onError?.(String(payload.error ?? "room stream failed"));
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function streamRoomMessage(sessionId: string, content: string, handlers: RoomStreamHandlers, maxSpeakers = 3): Promise<void> {
  return streamRoom(`/sessions/${encodeOpaquePathSegment(sessionId)}/room-turn`, { content, maxSpeakers }, handlers);
}

export function streamRoomContinuation(sessionId: string, handlers: RoomStreamHandlers, maxSpeakers = 2): Promise<void> {
  return streamRoom(`/sessions/${encodeOpaquePathSegment(sessionId)}/room-continue`, { maxSpeakers }, handlers);
}

export function stopSession(sessionId: string): Promise<Session> {
  return request<Session>(`/sessions/${encodeOpaquePathSegment(sessionId)}/stop`, {
    method: "POST",
  });
}

export function getMessages(sessionId: string): Promise<{ messages: ChatMessage[] }> {
  return request<{ messages: ChatMessage[] }>(`/sessions/${encodeOpaquePathSegment(sessionId)}/messages`);
}

export interface SiblingsResponse {
  siblings: ChatMessage[];
  activeMessageId: string | null;
  activeLeafId: string | null;
}

export function getSiblings(sessionId: string, messageId: string): Promise<SiblingsResponse> {
  return request<SiblingsResponse>(`/sessions/${encodeOpaquePathSegment(sessionId)}/messages/${encodeOpaquePathSegment(messageId)}/siblings`);
}

export function activateMessage(
  sessionId: string,
  messageId: string,
): Promise<{ activeLeafId: string; messages: ChatMessage[] }> {
  return request<{ activeLeafId: string; messages: ChatMessage[] }>(
    `/sessions/${encodeOpaquePathSegment(sessionId)}/messages/${encodeOpaquePathSegment(messageId)}/activate`,
    { method: "POST" },
  );
}

export interface SwipeResult {
  reply: ChatMessage;
  swipeIndex: number;
  swipeGroupId: string;
  siblings: ChatMessage[];
  providerError?: boolean;
  messages?: ChatMessage[];
}

export function swipeMessage(sessionId: string, messageId: string, speakerCharacterId?: string): Promise<SwipeResult> {
  return request<SwipeResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/messages/${encodeOpaquePathSegment(messageId)}/swipe`, {
    method: "POST", body: JSON.stringify({ speakerCharacterId }),
  });
}

export function branchMessage(sessionId: string, messageId: string, content: string, speakerCharacterId?: string): Promise<TurnResult> {
  return request<TurnResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/branch`, {
    method: "POST",
    body: JSON.stringify({ messageId, content, speakerCharacterId }),
  });
}

export function continueSession(sessionId: string, speakerCharacterId: string): Promise<TurnResult> {
  return request<TurnResult>(`/sessions/${encodeOpaquePathSegment(sessionId)}/continue`, {
    method: "POST", body: JSON.stringify({ speakerCharacterId }),
  });
}

export function cancelGeneration(sessionId: string, generationId: string): Promise<{ ok: boolean; aborted: string }> {
  return request<{ ok: boolean; aborted: string }>(`/sessions/${encodeOpaquePathSegment(sessionId)}/generation/cancel`, {
    method: "POST",
    body: JSON.stringify({ generationId }),
  });
}

export interface StreamDonePayload {
  reply: ChatMessage;
  providerError: boolean;
  preset: string;
  loreTriggered: number;
  session?: Session;
  state?: Session["state"];
  messages?: ChatMessage[];
  swipeIndex?: number;
  swipeGroupId?: string;
  siblings?: ChatMessage[];
}

export interface StreamBoundaryPayload extends StreamDonePayload {
  generationId?: string;
  violations?: string[];
}

export interface StreamHandlers {
  onUserMessage?: (message: ChatMessage, generationId: string) => void;
  onDelta?: (seq: number, text: string) => void;
  onState?: (session: Session | undefined, state: string) => void;
  onDone?: (payload: StreamDonePayload) => void;
  onBoundary?: (payload: StreamBoundaryPayload) => void;
  onError?: (error: string, violations: string[]) => void;
  onAborted?: (generationId: string) => void;
}

export interface StreamHandle {
  generationId: string;
  done: Promise<void>;
  cancel: () => Promise<void>;
}

export function createSseParser(onEvent: (event: string, data: unknown) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      if (dataLines.length === 0) continue;
      let data: unknown = null;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      onEvent(event, data);
    }
  };
}

function dispatchStreamEvent(handlers: StreamHandlers, event: string, data: unknown): void {
  const payload = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "user_message":
      handlers.onUserMessage?.(payload.message as ChatMessage, String(payload.generationId ?? ""));
      break;
    case "delta":
      handlers.onDelta?.(Number(payload.seq ?? 0), String(payload.text ?? ""));
      break;
    case "state":
      handlers.onState?.(payload.session as Session | undefined, String(payload.state ?? ""));
      break;
    case "done":
      handlers.onDone?.(payload as unknown as StreamDonePayload);
      break;
    case "boundary":
      if (handlers.onBoundary) handlers.onBoundary(payload as unknown as StreamBoundaryPayload);
      else handlers.onDone?.(payload as unknown as StreamDonePayload);
      break;
    case "error":
      handlers.onError?.(
        String(payload.error ?? "stream error"),
        Array.isArray(payload.violations) ? (payload.violations as string[]) : [],
      );
      break;
    case "aborted":
      handlers.onAborted?.(String(payload.generationId ?? ""));
      break;
    default:
      break;
  }
}

function streamSse(
  path: string,
  body: Record<string, unknown>,
  handlers: StreamHandlers,
  sessionId: string,
): StreamHandle {
  const controller = new AbortController();
  const generationId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const done = (async () => {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, generationId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw await errorFromResponse(res);
    }
    if (!res.body) {
      throw new ApiError(0, "stream response had no body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const push = createSseParser((event, data) => dispatchStreamEvent(handlers, event, data));
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  })();

  return {
    generationId,
    done,
    cancel: async () => {
      try {
        // Keep the raw opaque ID alongside the encoded stream path so cancel
        // cannot accidentally encode an already encoded path capture.
        await cancelGeneration(sessionId, generationId);
      } catch {
        // generation may already be finished
      }
      controller.abort();
    },
  };
}

export function streamMessage(sessionId: string, content: string, speakerCharacterId: string | undefined, handlers: StreamHandlers): StreamHandle {
  return streamSse(`/sessions/${encodeOpaquePathSegment(sessionId)}/stream`, { content, speakerCharacterId }, handlers, sessionId);
}

export function streamSwipe(sessionId: string, messageId: string, speakerCharacterId: string | undefined, handlers: StreamHandlers): StreamHandle {
  return streamSse(`/sessions/${encodeOpaquePathSegment(sessionId)}/messages/${encodeOpaquePathSegment(messageId)}/swipe/stream`, { speakerCharacterId }, handlers, sessionId);
}

export function listMemories(characterId: string): Promise<{ memories: MemoryFact[] }> {
  return request<{ memories: MemoryFact[] }>(`/characters/${characterId}/memories`);
}

export function createMemory(characterId: string, input: { content: string; kind: MemoryKind; userApproved: boolean }): Promise<MemoryFact> {
  return request<MemoryFact>(`/characters/${characterId}/memories`, { method: "POST", body: JSON.stringify(input) });
}

export function updateMemory(id: string, patch: Partial<Pick<MemoryFact, "content" | "kind" | "userApproved">>): Promise<MemoryFact> {
  return request<MemoryFact>(`/memories/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function forgetMemory(id: string): Promise<{ ok: true; forgottenAt: string }> {
  return request<{ ok: true; forgottenAt: string }>(`/memories/${id}`, { method: "DELETE" });
}

export function restoreMemory(id: string): Promise<MemoryFact> {
  return request<MemoryFact>(`/memories/${id}/restore`, { method: "POST" });
}

export function listLore(characterId?: string): Promise<{ lore: LoreEntry[] }> {
  return request<{ lore: LoreEntry[] }>(`/lore${characterId ? `?characterId=${encodeURIComponent(characterId)}` : ""}`);
}

export function createLore(input: LoreInput): Promise<LoreEntry> {
  return request<LoreEntry>("/lore", { method: "POST", body: JSON.stringify(input) });
}

export function updateLore(id: string, patch: Partial<LoreInput>): Promise<LoreEntry> {
  return request<LoreEntry>(`/lore/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteLore(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/lore/${id}`, { method: "DELETE" });
}

export async function getFeatures(): Promise<FeatureFlags> {
  return roleplayFeatureFlagsSchema.parse(await request<unknown>("/features"));
}

export async function getRpgFeatures(): Promise<RpgFeatures> {
  return rpgFeatureFlagsSchema.parse(await request<unknown>("/rpg/v1/features"));
}

export async function listCampaigns(): Promise<CampaignListResponse> {
  return campaignListResponseSchema.parse(await request<unknown>("/rpg/v1/campaigns"));
}

export async function getCampaignDetail(campaignId: string): Promise<CampaignDetailResponse> {
  // Validate before interpolation; IDs are opaque and are never normalized or trimmed.
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const response = campaignDetailResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}`,
    { cache: "no-store" },
  ));
  if (response.campaign.id !== validCampaignId) throw new Error("Campaign detail response did not match the request");
  return response;
}

/** Reads the bounded safe room projection. Opaque session IDs must not be rendered. */
export async function listCampaignRooms(campaignId: string): Promise<CampaignRoomLinkingResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  return campaignRoomLinkingResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/rooms`,
    { cache: "no-store" },
  ));
}

/** Issues one PUT with the exact opaque ID. This function intentionally never retries. */
export async function attachCampaignRoom(
  campaignId: string,
  input: CampaignRoomAttachRequest,
): Promise<CampaignRoomAttachResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const exactInput = campaignRoomAttachRequestSchema.parse(input);
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/rooms`,
    { method: "PUT", body: JSON.stringify(exactInput) },
  );
  if (success.status !== 200) throw new Error("Campaign room attachment response did not use the committed status");
  const response = campaignRoomAttachResponseSchema.parse(success.body);
  if (response.attachment.sessionId !== exactInput.sessionId) {
    throw new Error("Campaign room attachment response did not match the request");
  }
  return response;
}

/** Reads the strict ID-free latest campaign dice projection without caching. */
export async function getCampaignDiceHistory(campaignId: string): Promise<CampaignDiceHistoryResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  return campaignDiceHistoryResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/dice-rolls`,
    { cache: "no-store" },
  ));
}

/** Issues one non-idempotent roll POST; callers reconcile every outcome by GET. */
export async function rollCampaignDice(
  campaignId: string,
  input: CampaignDiceRollRequest,
): Promise<CampaignDiceRollResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const normalized = campaignDiceRollRequestSchema.parse(input);
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/dice-rolls`,
    { method: "POST", body: JSON.stringify(normalized) },
  );
  // Only the documented status plus a strict, request-bound body is a receipt-
  // derived success. Any other 2xx is malformed and remains commit-ambiguous.
  if (success.status !== 201) throw new Error("Campaign dice response did not use the committed status");
  const response = campaignDiceRollResponseSchema.parse(success.body);
  if (response.roll.character.position !== normalized.character.position
      || response.roll.character.name !== normalized.character.name
      || response.roll.result.expression !== normalized.expression) {
    throw new Error("Campaign dice response did not match the request");
  }
  return response;
}

/** Reads the strict public roster projection. Callers must not render its opaque IDs. */
export async function listCampaignCharacters(campaignId: string): Promise<CampaignCharacterListResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  return campaignCharacterListResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters`,
  ));
}

/** Reads the strict ID-free display workspace for one roster entry. */
export async function getCampaignCharacterWorkspace(
  campaignId: string,
  campaignCharacterId: string,
): Promise<CampaignCharacterWorkspaceResponse> {
  // IDs stay opaque: validate without trimming, then encode both path segments.
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const validCampaignCharacterId = resourceIdSchema.parse(campaignCharacterId);
  return campaignCharacterWorkspaceResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters/${encodeURIComponent(validCampaignCharacterId)}/workspace`,
    { cache: "no-store" },
  ));
}

/** Reads only the strict, path-bound fixed-starter creation projection. */
export async function getCampaignCharacterCreationOptions(campaignId: string): Promise<CampaignCharacterCreationOptionsResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const response = campaignCharacterCreationOptionsResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters/creation-options`,
  ));
  if (response.campaignId !== validCampaignId) throw new Error("Campaign character creation options did not match the request");
  return response;
}

/**
 * Issues one non-idempotent POST. This wrapper intentionally contains no retry;
 * callers must reconcile every issued outcome with fresh authoritative GETs.
 */
export async function createOriginalStarterCampaignCharacter(
  campaignId: string,
  input: CampaignCharacterCreateRequest,
): Promise<CampaignCharacterCreateResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const normalized = campaignCharacterCreateRequestSchema.parse(input);
  const response = campaignCharacterCreateResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters`,
    { method: "POST", body: JSON.stringify(normalized) },
  ));
  if (response.character.characterId !== normalized.characterId) {
    throw new Error("Campaign character creation response did not match the request");
  }
  return response;
}

export async function createCampaign(input: CampaignCreateRequest): Promise<CampaignCreateResponse> {
  const normalized = campaignCreateRequestSchema.parse(input);
  return campaignCreateResponseSchema.parse(await request<unknown>("/rpg/v1/campaigns", {
    method: "POST",
    body: JSON.stringify(normalized),
  }));
}

export async function renameCampaign(campaignId: string, input: CampaignRenameRequest): Promise<CampaignRenameResponse> {
  // Validate and normalize before interpolation or network I/O. In addition to
  // the strict wire schema, bind the minimal response to this exact operation.
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const normalized = campaignRenameRequestSchema.parse(input);
  const response = campaignRenameResponseSchema.parse(await request<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}`, {
    method: "PATCH",
    body: JSON.stringify(normalized),
  }));
  if (
    response.campaign.id !== validCampaignId
    || response.campaign.name !== normalized.name
    || response.campaign.updatedAt <= normalized.expectedUpdatedAt
  ) {
    throw new Error("Campaign rename response did not match the request");
  }
  return response;
}

export async function setupOriginalStarter(campaignId: string): Promise<CampaignDetailResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  // This function intentionally accepts no caller-selected starter or content.
  const body = campaignStarterSetupRequestSchema.parse({ starterId: ORIGINAL_STARTER_ID });
  const response = campaignDetailResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/starter-setup`,
    { method: "PUT", body: JSON.stringify(body) },
  ));
  const content = response.campaign.content;
  if (
    response.campaign.id !== validCampaignId
    || response.campaign.actorRole !== "owner"
    || content.status !== "configured"
    || content.rulesProfileId !== ORIGINAL_STARTER_PRESENTATION.rulesProfile.id
    || content.contentPacks.length !== 1
    || content.contentPacks[0]?.packId !== ORIGINAL_STARTER_PRESENTATION.pack.id
    || content.contentPacks[0]?.packVersion !== ORIGINAL_STARTER_PRESENTATION.pack.version
  ) {
    throw new Error("Campaign starter setup response did not match the request");
  }
  return response;
}

/** Issues exactly one fixed mechanics setup PUT and never retries it. */
export async function setupMechanicsStarter(campaignId: string): Promise<CampaignDetailResponse> {
  const validCampaignId = resourceIdSchema.parse(campaignId);
  const body = campaignMechanicsStarterSetupRequestSchema.parse({ starterId: MECHANICS_STARTER_ID });
  const result = await fetch(
    `/api/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/mechanics-starter-setup`,
    { method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!result.ok) throw await errorFromResponse(result);
  // Check the operation status before attempting to parse any success body.
  if (result.status !== 200) throw new Error("Campaign mechanics starter setup response did not use the committed status");
  const response = campaignMechanicsStarterSetupResponseSchema.parse(await result.json() as unknown);
  const content = response.campaign.content;
  if (response.campaign.id !== validCampaignId
    || response.campaign.actorRole !== "owner"
    || content.status !== "configured"
    || content.rulesProfileId !== MECHANICS_STARTER_IDENTITY.rulesProfileId
    || content.contentPacks.length !== 1
    || content.contentPacks[0]?.packId !== MECHANICS_STARTER_IDENTITY.packId
    || content.contentPacks[0]?.packVersion !== MECHANICS_STARTER_IDENTITY.packVersion) {
    throw new Error("Campaign mechanics starter setup response did not match the request");
  }
  return response;
}

function campaignAdministrationPath(campaignId: string): { id: string; path: string } {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  return { id, path: `/rpg/v1/campaigns/${encodeURIComponent(id)}/administration` };
}

function assertAdministrationReceipt(
  receipt: CampaignAdministrationHttpPatchResponse["receipt"],
  campaignId: string,
  type: CampaignAdministrationHttpPatchResponse["receipt"]["type"],
  expectedRevision: number,
): void {
  const [event] = receipt.events;
  if (receipt.campaignId !== campaignId || receipt.type !== type
    || receipt.revisionBefore !== expectedRevision || receipt.revisionAfter !== expectedRevision + 1
    || event.campaignId !== campaignId || event.commandId !== receipt.commandId || event.type !== type
    || event.revision !== receipt.revisionAfter || event.occurredAt !== receipt.occurredAt) {
    throw new Error("Campaign administration receipt did not match the request");
  }
}

/** Reads the strict role-specific administration projection without caching. */
export async function getCampaignAdministration(campaignId: string): Promise<CampaignAdministrationHttpResponse> {
  const { id, path } = campaignAdministrationPath(campaignId);
  const response = campaignAdministrationHttpGetResponseSchema.parse(await request<unknown>(path, { cache: "no-store" }));
  if (response.campaign.id !== id) throw new Error("Campaign administration response did not match the request");
  return response;
}

/** Issues one revision-bound PATCH. Callers must never automatically retry it. */
export async function updateCampaignAdministration(
  campaignId: string,
  input: CampaignAdministrationHttpPatchRequest,
): Promise<CampaignAdministrationHttpPatchResponse> {
  const { id, path } = campaignAdministrationPath(campaignId);
  const body = parseApiInput(() => campaignAdministrationHttpPatchRequestSchema.parse(input));
  const success = await requestResponse<unknown>(path, { method: "PATCH", body: JSON.stringify(body) });
  if (success.status !== 200) throw new Error("Campaign administration response did not use the committed status");
  const response = campaignAdministrationHttpPatchResponseSchema.parse(success.body);
  assertAdministrationReceipt(response.receipt, id, "administration_updated", body.expectedRevision);
  if (response.campaign.id !== id || response.receipt.revisionAfter !== response.campaign.revision) {
    throw new Error("Campaign administration receipt did not match the request");
  }
  return response;
}

/** Archives through one confirmed DELETE and requires an exact receipt. */
export async function archiveCampaignAdministration(
  campaignId: string,
  input: CampaignAdministrationHttpArchiveRequest,
): Promise<CampaignAdministrationHttpArchiveResponse> {
  const { id, path } = campaignAdministrationPath(campaignId);
  const body = parseApiInput(() => campaignAdministrationHttpArchiveRequestSchema.parse(input));
  const success = await requestResponse<unknown>(path, { method: "DELETE", body: JSON.stringify(body) });
  if (success.status !== 200) throw new Error("Campaign archive response did not use the committed status");
  const response = campaignAdministrationHttpArchiveResponseSchema.parse(success.body);
  assertAdministrationReceipt(response.receipt, id, "administration_updated", body.expectedRevision);
  if (response.campaign.id !== id || response.campaign.status !== "archived"
    || response.receipt.revisionAfter !== response.campaign.revision) {
    throw new Error("Campaign archive receipt did not match the request");
  }
  return response;
}

function membershipPath(campaignId: string, principalId?: string): { campaignId: string; path: string } {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const suffix = principalId === undefined ? "" : `/${encodeURIComponent(parseApiInput(() => resourceIdSchema.parse(principalId)))}`;
  return { campaignId: validCampaignId, path: `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/memberships${suffix}` };
}

export async function listCampaignMemberships(campaignId: string): Promise<CampaignAdministrationHttpMembershipListResponse> {
  const { path } = membershipPath(campaignId);
  return campaignAdministrationHttpMembershipListResponseSchema.parse(await request<unknown>(path, { cache: "no-store" }));
}

async function membershipMutation(
  campaignId: string,
  principalId: string,
  path: string,
  init: RequestInit,
  expectedRevision: number,
  operation: "membership_added" | "membership_role_changed" | "membership_removed",
  expectedRole?: CampaignAdministrationHttpMembershipMutationResponse["membership"]["role"],
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const success = await requestResponse<unknown>(path, init);
  if (success.status !== 200) throw new Error("Campaign membership response did not use the committed status");
  const response = campaignAdministrationHttpMembershipMutationResponseSchema.parse(success.body);
  assertAdministrationReceipt(response.receipt, campaignId, operation, expectedRevision);
  const [event] = response.receipt.events;
  if (response.membership.principalId !== principalId
    || event.data.principalId !== principalId
    || (expectedRole !== undefined && (response.membership.role !== expectedRole || event.data.role !== expectedRole))) {
    throw new Error("Campaign membership receipt did not match the request");
  }
  return response;
}

export async function addCampaignAdministrationMembership(
  campaignId: string,
  input: CampaignAdministrationHttpMembershipCreateRequest,
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const body = parseApiInput(() => campaignAdministrationHttpMembershipCreateRequestSchema.parse(input));
  const target = membershipPath(campaignId);
  return membershipMutation(target.campaignId, body.principalId, target.path,
    { method: "POST", body: JSON.stringify(body) }, body.expectedRevision, "membership_added", body.role);
}

export async function updateCampaignAdministrationMembership(
  campaignId: string,
  principalId: string,
  input: CampaignAdministrationHttpMembershipUpdateRequest,
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const body = parseApiInput(() => campaignAdministrationHttpMembershipUpdateRequestSchema.parse(input));
  const target = membershipPath(campaignId, principalId);
  return membershipMutation(target.campaignId, parseApiInput(() => resourceIdSchema.parse(principalId)), target.path,
    { method: "PATCH", body: JSON.stringify(body) }, body.expectedRevision, "membership_role_changed", body.role);
}

export async function removeCampaignAdministrationMembership(
  campaignId: string,
  principalId: string,
  input: CampaignAdministrationHttpMembershipDeleteRequest,
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const body = parseApiInput(() => campaignAdministrationHttpMembershipDeleteRequestSchema.parse(input));
  const target = membershipPath(campaignId, principalId);
  return membershipMutation(target.campaignId, parseApiInput(() => resourceIdSchema.parse(principalId)), target.path,
    { method: "DELETE", body: JSON.stringify(body) }, body.expectedRevision, "membership_removed");
}

export async function listCampaignTimelines(campaignId: string): Promise<CampaignHistoryHttpTimelinesResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const response = campaignHistoryHttpTimelinesResponseSchema.parse(await request<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(id)}/timelines`, { cache: "no-store" }));
  if (!response.timelines.some((timeline) => timeline.id === response.activeTimelineId && timeline.active)) {
    throw new Error("Campaign timeline response did not identify its active timeline");
  }
  return response;
}

export async function listCampaignCheckpoints(campaignId: string): Promise<{ checkpoints: CampaignHistoryHttpCheckpoint[] }> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = await request<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/checkpoints`, { cache: "no-store" });
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).length !== 1 || !("checkpoints" in body)) {
    throw new Error("Campaign checkpoint response was malformed");
  }
  return { checkpoints: campaignHistoryHttpCheckpointSchema.array().max(1000).parse((body as { checkpoints: unknown }).checkpoints) };
}

export async function createCampaignCheckpoint(
  campaignId: string,
  input: CampaignHistoryHttpCheckpointRequest,
): Promise<CampaignHistoryHttpCheckpointResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = parseApiInput(() => campaignHistoryHttpCheckpointRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/checkpoints`,
    { method: "POST", body: JSON.stringify(body) });
  if (success.status !== 201) throw new Error("Campaign checkpoint response did not use the committed status");
  const response = campaignHistoryHttpCheckpointResponseSchema.parse(success.body);
  const [event] = response.receipt.events;
  const eventKeys = Object.keys(event.data).sort().join(",");
  if (response.checkpoint.timelineId !== body.timelineId || response.checkpoint.timelineRevision !== body.timelineRevision
    || response.checkpoint.label !== body.label || response.checkpoint.createdAt !== response.receipt.occurredAt
    || response.receipt.revisionBefore !== body.expectedRevision || response.receipt.type !== "checkpoint_created"
    || event.type !== "checkpoint_created" || event.occurredAt !== response.receipt.occurredAt
    || eventKeys !== "label,timelineId,timelineRevision"
    || event.data.timelineId !== body.timelineId || event.data.timelineRevision !== body.timelineRevision
    || event.data.label !== body.label) throw new Error("Campaign checkpoint receipt did not match the request");
  return response;
}

export async function forkCampaignTimeline(
  campaignId: string,
  input: CampaignHistoryHttpForkRequest,
  checkpoint: Pick<CampaignHistoryHttpCheckpoint, "id" | "timelineId" | "timelineRevision">,
): Promise<CampaignHistoryHttpForkResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = parseApiInput(() => campaignHistoryHttpForkRequestSchema.parse(input));
  if (checkpoint.id !== body.checkpointId) throw new ApiInputError("Fork checkpoint identity is invalid");
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/timeline-forks`,
    { method: "POST", body: JSON.stringify(body) });
  if (success.status !== 201) throw new Error("Campaign timeline fork response did not use the committed status");
  const response = campaignHistoryHttpForkResponseSchema.parse(success.body);
  const [event] = response.receipt.events;
  if (!response.timeline.active || response.timeline.parentTimelineId !== checkpoint.timelineId
    || response.timeline.forkedFromRevision !== checkpoint.timelineRevision
    || response.timeline.revision !== checkpoint.timelineRevision || response.timeline.createdAt !== response.receipt.occurredAt
    || response.receipt.revisionBefore !== body.expectedRevision || response.receipt.type !== "timeline_forked"
    || event.type !== "timeline_forked" || event.occurredAt !== response.receipt.occurredAt
    || Object.keys(event.data).join(",") !== "checkpointId" || event.data.checkpointId !== body.checkpointId) {
    throw new Error("Campaign timeline fork receipt did not match the request");
  }
  return response;
}

/** Runs validation only. This stores a report but does not alter campaign state. */
export async function dryRunCampaignImport(input: CampaignTransferHttpDryRunRequest): Promise<CampaignTransferHttpDryRunResponse> {
  const body = parseApiInput(() => campaignTransferHttpDryRunRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/campaign-imports", { method: "POST", body: JSON.stringify(body) });
  if (success.status !== 200) throw new Error("Campaign import report response did not use the documented status");
  return campaignTransferHttpDryRunResponseSchema.parse(success.body);
}

function contentPackPath(packId: string, packVersion: string): { packId: string; packVersion: string; path: string } {
  const validPackId = parseApiInput(() => resourceIdSchema.parse(packId));
  const validPackVersion = parseApiInput(() => contentPackVersionSchema.parse(packVersion));
  return { packId: validPackId, packVersion: validPackVersion,
    path: `/rpg/v1/content-packs/${encodeURIComponent(validPackId)}/versions/${encodeURIComponent(validPackVersion)}` };
}

function requireStatus(success: { status: number }, status: number, operation: string): void {
  if (success.status !== status) throw new Error(`${operation} response did not use the documented status`);
}

/** Reads one strict page of sealed publications without caching. */
export async function listContentPackPublications(query: ContentCatalogHttpPublicationsQuery = {}): Promise<ContentCatalogHttpPublicationsResponse> {
  const input = parseApiInput(() => contentCatalogHttpPublicationsQuerySchema.parse(query));
  const params = new URLSearchParams();
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const success = await requestResponse<unknown>(`/rpg/v1/content-packs${params.size ? `?${params}` : ""}`, { cache: "no-store" });
  requireStatus(success, 200, "Content pack publication list");
  const response = contentCatalogHttpPublicationsResponseSchema.parse(success.body);
  if (input.limit !== undefined && response.publications.length > input.limit) throw new Error("Content pack publication page exceeded the requested limit");
  return response;
}

/** Follows opaque cursors to a safely bounded complete publication snapshot. */
export async function listAllContentPackPublications(): Promise<ContentCatalogHttpPublicationsResponse> {
  const publications: ContentCatalogHttpPublicationsResponse["publications"] = [];
  const exactKeys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = await listContentPackPublications({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const publication of response.publications) {
      const key = `${publication.packId}\0${publication.packVersion}`;
      if (!exactKeys.has(key)) { exactKeys.add(key); publications.push(publication); }
    }
    if (response.nextCursor === null) return { publications, nextCursor: null };
    if (cursors.has(response.nextCursor)) throw new Error("Content pack publication pagination repeated a cursor");
    cursors.add(response.nextCursor); cursor = response.nextCursor;
  }
  throw new Error("Content pack publication pagination exceeded the safe page limit");
}

/** Reads the owner-only complete projection for one exact sealed version. */
export async function getContentPackPublication(packId: string, packVersion: string): Promise<ContentCatalogHttpOwnerDetailResponse> {
  const target = contentPackPath(packId, packVersion);
  const success = await requestResponse<unknown>(target.path, { cache: "no-store" });
  requireStatus(success, 200, "Content pack detail");
  const response = contentCatalogHttpOwnerDetailResponseSchema.parse(success.body);
  if (response.catalog.publication.packId !== target.packId || response.catalog.publication.packVersion !== target.packVersion) {
    throw new Error("Content pack detail response did not match the request");
  }
  return response;
}

/** Validates only the supplied in-memory draft; this method never publishes. */
export async function validateContentPackDraft(input: ContentCatalogHttpValidationRequest): Promise<ContentCatalogHttpValidationResponse> {
  const body = parseApiInput(() => contentCatalogHttpValidationRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/content-packs/validate", { method: "POST", body: JSON.stringify(body) });
  requireStatus(success, 200, "Content pack validation");
  return contentCatalogHttpValidationResponseSchema.parse(success.body);
}

/** Issues one immutable publication POST. Callers must never automatically retry it. */
function canonicalWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalWireValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalWireValue(entry)]));
  return value;
}

function canonicalDefinitionSet(definitions: ContentCatalogHttpPublicationRequest["definitions"]): string {
  return JSON.stringify([...definitions].sort((left, right) => left.reference.kind.localeCompare(right.reference.kind)
    || left.reference.definitionId.localeCompare(right.reference.definitionId)).map(canonicalWireValue));
}

export async function publishContentPack(input: ContentCatalogHttpPublicationRequest): Promise<ContentCatalogHttpPublicationResponse> {
  const body = parseApiInput(() => contentCatalogHttpPublicationRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/content-packs", { method: "POST", body: JSON.stringify(body) });
  requireStatus(success, 201, "Content pack publication");
  const response = contentCatalogHttpPublicationResponseSchema.parse(success.body);
  const publication = response.catalog.publication;
  if (publication.packId !== body.manifest.packId || publication.packVersion !== body.manifest.packVersion
    || publication.name !== body.manifest.name || publication.description !== body.manifest.description
    || publication.digest !== body.manifest.digest
    || JSON.stringify(publication.tags) !== JSON.stringify(body.manifest.tags)
    || JSON.stringify(publication.compatibility) !== JSON.stringify(body.manifest.compatibility)
    || JSON.stringify(response.catalog.provenance) !== JSON.stringify(body.manifest.provenance)
    || canonicalDefinitionSet(response.catalog.definitions) !== canonicalDefinitionSet(body.definitions)) {
    throw new Error("Content pack publication response did not match the request");
  }
  return response;
}

function campaignContentPath(campaignId: string): { campaignId: string; path: string } {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  return { campaignId: validCampaignId, path: `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/content` };
}

/** Reads the exact authoritative campaign pin set without caching. */
export async function getCampaignContent(campaignId: string): Promise<ContentCatalogHttpCampaignContentGetResponse> {
  const target = campaignContentPath(campaignId);
  const success = await requestResponse<unknown>(target.path, { cache: "no-store" });
  requireStatus(success, 200, "Campaign content");
  return contentCatalogHttpCampaignContentGetResponseSchema.parse(success.body);
}

/** Issues one revision-bound exact-pin PUT and never retries it. */
export async function configureCampaignContent(campaignId: string, input: ContentCatalogHttpCampaignContentPutRequest): Promise<ContentCatalogHttpCampaignContentPutResponse> {
  const target = campaignContentPath(campaignId);
  const body = parseApiInput(() => contentCatalogHttpCampaignContentPutRequestSchema.parse(input));
  const success = await requestResponse<unknown>(target.path, { method: "PUT", body: JSON.stringify(body) });
  requireStatus(success, 200, "Campaign content configuration");
  const response = contentCatalogHttpCampaignContentPutResponseSchema.parse(success.body);
  const expectedPins = JSON.stringify(body.contentPacks);
  if (response.content.rulesProfileId !== body.rulesProfileId || JSON.stringify(response.content.contentPacks.map(({ packId, packVersion }) => ({ packId, packVersion }))) !== expectedPins
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1 || response.receipt.content.rulesProfileId !== body.rulesProfileId
    || JSON.stringify(response.receipt.content) !== JSON.stringify(response.content)) {
    throw new Error("Campaign content configuration response did not match the request");
  }
  return response;
}

/** Reads one role-filtered campaign pack projection at an exact version. */
export async function getCampaignContentPack(campaignId: string, packId: string, packVersion: string): Promise<ContentCatalogHttpCampaignPackDetailResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const target = contentPackPath(packId, packVersion);
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/content-packs/${encodeURIComponent(target.packId)}/versions/${encodeURIComponent(target.packVersion)}`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign content pack detail");
  const response = contentCatalogHttpCampaignPackDetailResponseSchema.parse(success.body);
  if (response.catalog.publication.packId !== target.packId || response.catalog.publication.packVersion !== target.packVersion) {
    throw new Error("Campaign content pack detail response did not match the request");
  }
  return response;
}

export interface HarnessSettings {
  id: "harness";
  systemPrompt: string;
  personaPreamble: string;
  styleGuide: string;
  postHistoryInstructions: string;
  recentTurns: number;
  memoryChars: number;
  summaryChars: number;
  loreChars: number;
  temperature: number | null;
  promptOverrides: Record<string, string>;
  updatedAt: string;
}

export function getHarness(): Promise<HarnessSettings> {
  return request<HarnessSettings>("/harness");
}

export function updateHarness(patch: Partial<Omit<HarnessSettings, "id" | "updatedAt">>): Promise<HarnessSettings> {
  return request<HarnessSettings>("/harness", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface PromptTemplateDefinition {
  id: string;
  label: string;
  description: string;
  defaultTemplate: string;
  template: string;
  placeholders: string[];
  overridden: boolean;
}

export function listPromptTemplates(): Promise<{ templates: PromptTemplateDefinition[] }> {
  return request<{ templates: PromptTemplateDefinition[] }>("/prompt-templates");
}

export function updatePromptTemplate(id: string, template: string | null): Promise<{ templates: PromptTemplateDefinition[] }> {
  return request<{ templates: PromptTemplateDefinition[] }>(`/prompt-templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ template }),
  });
}

export type ProviderType = "openai-compatible" | "ollama" | "llamacpp" | "koboldcpp";

export interface SamplerSettings {
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repetitionPenalty: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  seed: number | null;
  reasoningEffort: "none" | "high" | "xhigh" | null;
  stopStrings: string[];
  startReplyWith: string;
}

export interface ProviderSettings {
  id: "provider";
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  streaming: boolean;
  httpReferer: string;
  appTitle: string;
  requireParameters: boolean;
  allowFallbacks: boolean;
  routingSort: "default" | "price" | "throughput" | "latency";
  dataCollection: "default" | "allow" | "deny";
  zdr: boolean;
  requestTimeoutSeconds: number;
  pricing: { promptPerMillion: number | null; completionPerMillion: number | null };
  samplers: SamplerSettings;
  updatedAt: string;
}

export function getProvider(): Promise<ProviderSettings> {
  return request<ProviderSettings>("/provider");
}

export interface UsageBreakdown {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface UsageSummary extends UsageBreakdown {
  providerMeasuredTokens: number;
  estimatedTokens: number;
  pricing: ProviderSettings["pricing"];
  byKind: Array<UsageBreakdown & { kind: string }>;
  byModel: Array<UsageBreakdown & { model: string }>;
  bySession: Array<UsageBreakdown & { sessionId: string; title: string }>;
}

export function getUsage(): Promise<{ usage: UsageSummary }> {
  return request<{ usage: UsageSummary }>("/usage");
}

export function updateProvider(patch: {
  providerType?: ProviderType;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  streaming?: boolean;
  httpReferer?: string;
  appTitle?: string;
  requireParameters?: boolean;
  allowFallbacks?: boolean;
  routingSort?: ProviderSettings["routingSort"];
  dataCollection?: ProviderSettings["dataCollection"];
  zdr?: boolean;
  requestTimeoutSeconds?: number;
  pricing?: Partial<ProviderSettings["pricing"]>;
  samplers?: Partial<SamplerSettings>;
}): Promise<ProviderSettings> {
  return request<ProviderSettings>("/provider", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}
