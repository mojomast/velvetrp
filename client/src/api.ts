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
  campaignAdministrationHttpRoomDetachRequestSchema,
  campaignAdministrationHttpRoomDetachResponseSchema,
  campaignAdministrationHttpPatchRequestSchema,
  campaignAdministrationHttpPatchResponseSchema,
  campaignHistoryHttpCheckpointRequestSchema,
  campaignHistoryHttpCheckpointResponseSchema,
  campaignHistoryHttpCheckpointSchema,
  campaignHistoryHttpEventsQuerySchema,
  campaignHistoryHttpEventsResponseSchema,
  campaignHistoryHttpForkRequestSchema,
  campaignHistoryHttpForkResponseSchema,
  campaignHistoryHttpRecapRequestSchema,
  campaignHistoryHttpRecapResponseSchema,
  campaignHistoryHttpRecapSchema,
  campaignHistoryHttpPublicReceiptResponseSchema,
  campaignHistoryHttpTimelinesResponseSchema,
  campaignTransferHttpApplyRequestSchema,
  campaignTransferHttpApplyResponseSchema,
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
  campaignTransferHttpExportDocumentSchema,
} from "@velvet/contracts";
import { campaignContentApplyRequestSchema, campaignContentApplyResponseSchema, campaignContentDraftViewSchema, campaignContentGenerationRequestSchema } from "@velvet/contracts";
import type { CampaignContentGenerationRequest } from "@velvet/contracts";
import type {
  CampaignAdministrationHttpArchiveRequest,
  CampaignAdministrationHttpArchiveResponse,
  CampaignAdministrationHttpMembershipCreateRequest,
  CampaignAdministrationHttpMembershipDeleteRequest,
  CampaignAdministrationHttpMembershipListResponse,
  CampaignAdministrationHttpMembershipMutationResponse,
  CampaignAdministrationHttpMembershipUpdateRequest,
  CampaignAdministrationHttpRoomDetachRequest,
  CampaignAdministrationHttpRoomDetachResponse,
  CampaignAdministrationHttpPatchRequest,
  CampaignAdministrationHttpPatchResponse,
  CampaignAdministrationHttpResponse,
  CampaignHistoryHttpCheckpoint,
  CampaignHistoryHttpCheckpointRequest,
  CampaignHistoryHttpCheckpointResponse,
  CampaignHistoryHttpEventsQuery,
  CampaignHistoryHttpEventsResponse,
  CampaignHistoryHttpForkRequest,
  CampaignHistoryHttpForkResponse,
  CampaignHistoryHttpRecap,
  CampaignHistoryHttpRecapRequest,
  CampaignHistoryHttpRecapResponse,
  CampaignHistoryHttpPublicReceiptResponse,
  CampaignHistoryHttpTimelinesResponse,
  CampaignTransferHttpApplyRequest,
  CampaignTransferHttpApplyResponse,
  CampaignTransferHttpDryRunRequest,
  CampaignTransferHttpDryRunResponse,
  CampaignTransferHttpExportDocument,
} from "@velvet/contracts";
import {
  npcCastHttpSchema,
  npcPresenceMutationHttpRequestSchema,
  npcPresenceMutationHttpResponseSchema,
} from "@velvet/contracts";
import type {
  NpcCastHttp,
  NpcPresenceMutationHttpRequest,
  NpcPresenceMutationHttpResponse,
} from "@velvet/contracts";
import {
  companionAdministrationHttpCommandResponseSchema,
  companionAdministrationHttpCommandSchema,
  companionAdministrationHttpGetResponseSchema,
} from "@velvet/contracts";
import type {
  CompanionAdministrationHttpCommand,
  CompanionAdministrationHttpCommandResponse,
  CompanionAdministrationHttpGetResponse,
} from "@velvet/contracts";
import {
  generationDraftApplyRequestSchema,
  generationDraftApplyResponseSchema,
  generationDraftCreateRequestSchema,
  generationDraftCreateResponseSchema,
  generationDraftGetResponseSchema,
} from "@velvet/contracts";
import type {
  GenerationDraftApplyRequest,
  GenerationDraftApplyResponse,
  GenerationDraftCreateRequest,
  GenerationDraftGetResponse,
} from "@velvet/contracts";
import {
  adventureTurnConfirmRequestSchema,
  adventureTurnConfirmResponseSchema,
  adventureTurnGetResponseSchema,
  adventureTurnInitialReconcileRequestSchema,
  adventureTurnInitialReconcileResponseSchema,
  adventureTurnInitialStreamRequestSchema,
  adventureTurnNarrationVariantStreamRequestSchema,
  adventureTurnResumeStreamRequestSchema,
  adventureTurnStreamEventSchema,
  campaignPlayBootstrapSchema,
  campaignPlaySessionIdSchema,
} from "@velvet/contracts";
import type {
  AdventureTurnConfirmRequest,
  AdventureTurnGetResponse,
  AdventureTurnInitialReconcileRequest,
  AdventureTurnStreamEvent,
  CampaignPlayBootstrap,
} from "@velvet/contracts";
import {
  actorCheckCommandRequestSchema, actorCheckCommandResponseSchema,
  actorTravelCommandRequestSchema, actorTravelCommandResponseSchema, gmCampaignQuestsHttpResponseSchema, gmCampaignStoryHttpResponseSchema,
  campaignWorldHttpResponseSchema, createCampaignFactionHttpRequestSchema, createCampaignFactionHttpResponseSchema,
  createCampaignNpcHttpRequestSchema, createCampaignNpcHttpResponseSchema, createCampaignQuestHttpRequestSchema,
  createCampaignQuestHttpResponseSchema, createCampaignStorylineHttpRequestSchema,
  createCampaignStorylineHttpResponseSchema, factionReputationCommandHttpRequestSchema,
  factionReputationCommandHttpResponseSchema, npcRelationshipCommandHttpRequestSchema,
  npcRelationshipCommandHttpResponseSchema, playerCampaignQuestsHttpResponseSchema,
  playerCampaignStoryHttpResponseSchema, gmCampaignNpcsHttpResponseSchema, playerCampaignNpcsHttpResponseSchema,
  gmCampaignFactionsHttpResponseSchema, playerCampaignFactionsHttpResponseSchema, questCommandHttpRequestSchema, questCommandHttpResponseSchema,
  storylineCommandHttpRequestSchema, storylineCommandHttpResponseSchema,
} from "@velvet/contracts";
import type {
  ActorCheckCommandRequest, ActorCheckCommandResponse, ActorTravelCommandRequest, ActorTravelCommandResponse,
  CampaignQuestsHttpResponse, CampaignStoryHttpResponse,
  CampaignWorldHttpResponse, CreateCampaignFactionHttpRequest, CreateCampaignNpcHttpRequest,
  CreateCampaignQuestHttpRequest, CreateCampaignStorylineHttpRequest, FactionReputationCommandHttpRequest,
  NpcRelationshipCommandHttpRequest, QuestCommandHttpRequest, StorylineCommandHttpRequest,
  GmCampaignNpcsHttpResponse, PlayerCampaignNpcsHttpResponse, GmCampaignFactionsHttpResponse, PlayerCampaignFactionsHttpResponse,
} from "@velvet/contracts";

export type CampaignNpcsHttpResponse = GmCampaignNpcsHttpResponse | PlayerCampaignNpcsHttpResponse;
export type CampaignFactionsHttpResponse = GmCampaignFactionsHttpResponse | PlayerCampaignFactionsHttpResponse;
export type GmCampaignQuestsHttpResponse = ReturnType<typeof gmCampaignQuestsHttpResponseSchema.parse>;
export type PlayerCampaignQuestsHttpResponse = ReturnType<typeof playerCampaignQuestsHttpResponseSchema.parse>;
export type GmCampaignStoryHttpResponse = ReturnType<typeof gmCampaignStoryHttpResponseSchema.parse>;
export type PlayerCampaignStoryHttpResponse = ReturnType<typeof playerCampaignStoryHttpResponseSchema.parse>;
import {
  actorEffectCommandRequestSchema,
  actorEffectCommandResponseSchema,
  actorEffectsResponseSchema,
  actorPowerCommandRequestSchema,
  actorPowerCommandResponseSchema,
  actorPowersResponseSchema,
  actorResourcesHttpChangeCommandRequestSchema,
  actorResourcesHttpChangeCommandResponseSchema,
  actorResourcesHttpGetResponseSchema,
  economyHttpCommandRequestSchema,
  economyHttpCommandResponseSchema,
  economyHttpShopGetResponseSchema,
  economyHttpWalletGetResponseSchema,
  inventoryHttpCommandRequestSchema,
  inventoryHttpCommandResponseSchema,
  inventoryHttpGetResponseSchema,
  restHttpRequestSchema,
  restHttpResponseSchema,
} from "@velvet/contracts";
import type {
  ActorEffectCommandRequest,
  ActorEffectCommandResponse,
  ActorEffectsResponse,
  ActorPowerCommandRequest,
  ActorPowerCommandResponse,
  ActorPowersResponse,
  ActorResourcesHttpChangeCommandRequest,
  ActorResourcesHttpChangeCommandResponse,
  ActorResourcesHttpGetResponse,
  EconomyHttpCommandRequest,
  EconomyHttpCommandResponse,
  EconomyHttpShopGetResponse,
  EconomyHttpWalletGetResponse,
  InventoryHttpCommandRequest,
  InventoryHttpCommandResponse,
  InventoryHttpGetResponse,
  RestHttpRequest,
  RestHttpResponse,
} from "@velvet/contracts";
import {
  combatActionCommandRequestSchema,
  combatActionCommandResponseSchema,
  combatCommandResultResponseSchema,
  combatEndCommandRequestSchema,
  combatEndCommandResponseSchema,
  combatLogQuerySchema,
  combatLogResponseSchema,
  combatReadResponseSchema,
  encounterCreateRequestSchema,
  encounterCreateResponseSchema,
  encounterListResponseSchema,
  encounterStartCommandRequestSchema,
  encounterStartCommandResponseSchema,
  useConsumableCommandRequestSchema,
  useConsumableCommandResultSchema,
  useConsumableLegalActionSchema,
  canonicalUseConsumableRequestFrame,
} from "@velvet/contracts";
import type {
  CombatActionCommandRequest,
  CombatActionCommandResponse,
  CombatCommandResultResponse,
  CombatEndCommandRequest,
  CombatEndCommandResponse,
  CombatLogQuery,
  CombatLogResponse,
  CombatReadResponse,
  EncounterCreateRequest,
  EncounterPublic,
  EncounterStartCommandRequest,
  UseConsumableCommandRequest,
  UseConsumableCommandResult,
  UseConsumableLegalAction,
} from "@velvet/contracts";
import {
  characterDraftHttpFinalizationResultSchema,
  characterDraftHttpMutationResultSchema,
  characterDraftHttpViewSchema,
  characterProgressionHttpApplyRequestSchema,
  characterProgressionHttpApplyResponseSchema,
  characterProgressionHttpGrantXpRequestSchema,
  characterProgressionHttpGrantXpResponseSchema,
  characterProgressionHttpPreviewRequestSchema,
  characterProgressionHttpPreviewResponseSchema,
  characterProgressionHttpStateResponseSchema,
  characterSheetHttpResponseSchema,
  createCharacterDraftHttpInputSchema,
  finalizeCharacterDraftHttpInputSchema,
  updateCharacterDraftHttpInputSchema,
} from "@velvet/contracts";
import type {
  CharacterDraftHttpFinalizationResult,
  CharacterDraftHttpView,
  CharacterDraftMutationReceipt,
  CharacterProgressionHttpApplyRequest,
  CharacterProgressionHttpApplyResponse,
  CharacterProgressionHttpGrantXpRequest,
  CharacterProgressionHttpGrantXpResponse,
  CharacterProgressionHttpPreview,
  CharacterProgressionHttpPreviewRequest,
  CharacterProgressionHttpState,
  CharacterSheetHttpResponse,
  CreateCharacterDraftHttpInput,
  UpdateCharacterDraftHttpInput,
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

async function requestResponse<T>(
  path: string,
  init?: RequestInit,
  expected?: { status: number; message: string },
): Promise<{ body: T; status: number; headers: Headers }> {
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
  // Mutations may require status confirmation before touching an untrusted
  // success body. This still uses the shared fetch/error/header boundary.
  if (expected !== undefined && res.status !== expected.status) throw new Error(expected.message);

  return { body: (await res.json()) as T, status: res.status, headers: res.headers };
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
  const success = await requestResponse<unknown>("/rpg/v1/features", { cache: "no-store" });
  requireStatus(success, 200, "RPG feature read");
  return rpgFeatureFlagsSchema.parse(success.body);
}

/** Delivery-only handle for a durable adventure-turn SSE response. */
export interface AdventureTurnClientStreamHandle {
  turnId: Promise<string>;
  done: Promise<void>;
  cancelDelivery: () => void;
}

/** Closed initial or server-token continuation input accepted by the client stream method. */
export type AdventureTurnClientStreamRequest =
  | { kind: "initial"; campaignId: string; sessionId: string; actorId: string; declaration: string; expectedRevision: number; idempotencyKey: string }
  | { kind: "resume"; resumeToken: string; expected: AdventureTurnClientBinding }
  | { kind: "narration-retry" | "narration-swipe"; campaignId: string; sessionId: string; actorId: string;
    priorTurnId: string; expectedRevision: number; idempotencyKey: string };

/** Exact active play identity required for every durable turn response. */
export interface AdventureTurnClientBinding {
  campaignId: string;
  sessionId: string;
  actorId: string;
  turnId?: string;
  priorTurnId?: string | null;
}

/** Incremental strict parser used only for the M2.11 adventure-turn vocabulary. */
export interface AdventureTurnSseParser {
  push: (chunk: string) => void;
  finish: () => void;
}

/**
 * Parses CRLF or LF SSE framing across arbitrary chunks, validates every event,
 * and requires one final terminal envelope without silently dropping data.
 */
export function createAdventureTurnSseParser(onEvent: (event: AdventureTurnStreamEvent) => void,
  streamKind: "initial" | "resume" | "variant" = "resume"): AdventureTurnSseParser {
  let buffer = ""; let terminal = false; let lastSequence = -1; let count = 0; let confirmationRequired = false;
  let mechanicsSeen = false; let narrationSeen = false;
  const consume = (final: boolean) => {
    let separator = buffer.match(/\r\n\r\n|\n\n|\r\r/);
    while (separator?.index !== undefined || (final && buffer.length > 0)) {
      const boundary = separator?.index ?? -1; const separatorLength = separator?.[0].length ?? 0;
      const block = boundary >= 0 ? buffer.slice(0, boundary) : buffer;
      buffer = boundary >= 0 ? buffer.slice(boundary + separatorLength) : "";
      separator = buffer.match(/\r\n\r\n|\n\n|\r\r/);
      const lines = block.split(/\r\n|\r|\n/);
      if (block.length === 0 || lines.every((line) => line.startsWith(":"))) continue;
      let eventName: string | null = null; const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.length > 0 && !line.startsWith("id:") && !line.startsWith("retry:")) throw new Error("Adventure turn stream contained malformed SSE fields");
      }
      if (!eventName || data.length === 0) throw new Error("Adventure turn stream event framing was incomplete");
      let raw: unknown; try { raw = JSON.parse(data.join("\n")); } catch { throw new Error("Adventure turn stream contained malformed JSON"); }
      const event = adventureTurnStreamEventSchema.parse(raw);
      if (event.type !== eventName) throw new Error("Adventure turn stream event name did not match its envelope");
      if (event.sequence !== lastSequence + 1) throw new Error("Adventure turn stream sequence was not contiguous");
      if (terminal) throw new Error("Adventure turn stream emitted data after its terminal event");
      if (count === 0) {
        if ((streamKind === "initial" || streamKind === "variant") && (event.type !== "turn_started" || event.sequence !== 0)) {
          throw new Error("Adventure turn creation stream did not start with turn_started sequence zero");
        }
        if (streamKind === "resume" && event.type !== "agent_status") throw new Error("Adventure turn resume stream had an illegal first event");
      }
      if (event.type === "turn_started" && (count !== 0 || streamKind === "resume")) throw new Error("Adventure turn stream emitted turn_started illegally");
      if (event.type === "tool_proposed" && (streamKind !== "initial" || confirmationRequired || mechanicsSeen || narrationSeen)) {
        throw new Error("Adventure turn stream proposed a tool out of order");
      }
      if (confirmationRequired && event.type !== "terminal") throw new Error("Adventure turn confirmation boundary was not immediately terminal");
      if (event.type === "confirmation_required") {
        if (streamKind === "variant" || mechanicsSeen || narrationSeen) throw new Error("Adventure turn confirmation boundary was illegal");
        confirmationRequired = true;
      }
      if (event.type === "mechanics_committed") {
        if (mechanicsSeen || narrationSeen) throw new Error("Adventure turn mechanics were emitted out of order"); mechanicsSeen = true;
      }
      if (event.type === "narration_delta") narrationSeen = true;
      if (event.type === "terminal") {
        if (event.payload.receipts.length > 0 && !mechanicsSeen) throw new Error("Adventure turn narration omitted its mechanics event");
        if (confirmationRequired && (event.payload.outcome !== "aborted" || event.payload.turn.state !== "awaiting-confirmation")) {
          throw new Error("Adventure turn confirmation terminal was illegal");
        }
        if (!confirmationRequired && event.payload.turn.state === "awaiting-confirmation") throw new Error("Adventure turn terminal omitted its confirmation boundary");
      }
      lastSequence = event.sequence; count += 1; if (event.type === "terminal") terminal = true; onEvent(event);
    }
    if (final && !terminal) throw new Error("Adventure turn stream ended without exactly one terminal event");
  };
  return { push: (chunk) => { buffer += chunk; consume(false); }, finish: () => consume(true) };
}

/** Reads one exact campaign-and-room play bootstrap without caching. */
export async function getCampaignPlayBootstrap(campaignId: string, sessionId: string): Promise<CampaignPlayBootstrap> {
  const campaign = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const room = parseApiInput(() => campaignPlaySessionIdSchema.parse(sessionId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(campaign)}/rooms/${encodeURIComponent(room)}/play-bootstrap`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign play bootstrap"); const response = campaignPlayBootstrapSchema.parse(success.body);
  if (response.campaignId !== campaign || response.sessionId !== room) throw new Error("Campaign play bootstrap did not match the request");
  return response;
}

/** Opens one initial or token-resume delivery stream; cancellation affects delivery only. */
export function streamAdventureTurn(requestInput: AdventureTurnClientStreamRequest, onEvent: (event: AdventureTurnStreamEvent) => void): AdventureTurnClientStreamHandle {
  const request = requestInput.kind === "initial"
    ? parseApiInput(() => adventureTurnInitialStreamRequestSchema.parse({ campaignId: requestInput.campaignId, sessionId: requestInput.sessionId,
      actorId: requestInput.actorId, declaration: requestInput.declaration, expectedRevision: requestInput.expectedRevision, idempotencyKey: requestInput.idempotencyKey }))
    : requestInput.kind === "resume"
      ? parseApiInput(() => adventureTurnResumeStreamRequestSchema.parse({ resumeToken: requestInput.resumeToken }))
      : parseApiInput(() => adventureTurnNarrationVariantStreamRequestSchema.parse({ variant: requestInput.kind,
        campaignId: requestInput.campaignId, sessionId: requestInput.sessionId, actorId: requestInput.actorId,
        priorTurnId: requestInput.priorTurnId, expectedRevision: requestInput.expectedRevision, idempotencyKey: requestInput.idempotencyKey }));
  const controller = new AbortController(); let resolveTurn!: (turnId: string) => void; let rejectTurn!: (error: unknown) => void;
  const turnId = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // Consumers commonly await `done` first; mark the correlated identity
  // rejection handled while preserving rejection semantics for explicit awaits.
  void turnId.catch(() => undefined);
  const done = (async () => {
    try {
      const response = await fetch("/api/rpg/v1/adventure-turns/stream", { method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(request) });
      if (!response.ok) throw await errorFromResponse(response);
      const contentType = response.headers.get("content-type") ?? "";
      const cache = (response.headers.get("cache-control") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (response.status !== 200 || !/^text\/event-stream(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i.test(contentType)
        || cache.length !== 3 || new Set(cache).size !== 3 || !["private", "no-store", "no-transform"].every((directive) => cache.includes(directive))) {
        throw new Error("Adventure turn stream response headers were invalid");
      }
      const headerTurnId = resourceIdSchema.parse(response.headers.get("x-adventure-turn-id"));
      if (!response.body) throw new Error("Adventure turn stream response had no body");
      const expected: AdventureTurnClientBinding = requestInput.kind === "resume" ? requestInput.expected
        : { campaignId: requestInput.campaignId, sessionId: requestInput.sessionId, actorId: requestInput.actorId,
          ...(requestInput.kind === "initial" ? { priorTurnId: null } : { priorTurnId: requestInput.priorTurnId }) };
      if (expected.turnId && expected.turnId !== headerTurnId) throw new Error("Adventure turn stream header did not match the expected turn");
      resolveTurn(headerTurnId);
      const parser = createAdventureTurnSseParser((event) => {
        if ((event.type === "turn_started" || event.type === "terminal") && event.payload.turn.turnId !== headerTurnId) throw new Error("Adventure turn stream was bound to another turn");
        if (event.type === "turn_started" || event.type === "terminal") {
          const turn = event.payload.turn;
          if (turn.campaignId !== expected.campaignId || turn.sessionId !== expected.sessionId || turn.actorId !== expected.actorId
            || (expected.priorTurnId !== undefined && turn.priorTurnId !== expected.priorTurnId)) throw new Error("Adventure turn stream did not match active play identity");
          if (requestInput.kind === "initial" && (turn.declaration !== requestInput.declaration || turn.mode !== "original" || turn.priorTurnId !== null)) {
            throw new Error("Adventure turn stream did not match the initial request");
          }
          if (requestInput.kind !== "initial" && requestInput.kind !== "resume" && turn.mode !== requestInput.kind) {
            throw new Error("Adventure turn stream did not match the narration variant");
          }
        }
        onEvent(event);
      }, requestInput.kind === "initial" ? "initial" : requestInput.kind === "resume" ? "resume" : "variant");
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      try { while (true) { const next = await reader.read(); if (next.done) break; parser.push(decoder.decode(next.value, { stream: true })); }
        parser.push(decoder.decode()); parser.finish(); } finally { void reader.cancel().catch(() => undefined); }
    } catch (error) { rejectTurn(error); throw error; }
  })();
  return { turnId, done, cancelDelivery: () => controller.abort() };
}

/** Reconciles one strict path-bound durable adventure turn. */
export async function getAdventureTurn(turnId: string, expected: AdventureTurnClientBinding): Promise<AdventureTurnGetResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(turnId));
  const success = await requestResponse<unknown>(`/rpg/v1/adventure-turns/${encodeURIComponent(id)}`, { cache: "no-store" }); requireStatus(success, 200, "Adventure turn read");
  const response = adventureTurnGetResponseSchema.parse(success.body); assertAdventureTurnBinding(response.turn, { ...expected, turnId: id }); return response;
}

function assertAdventureTurnBinding(turn: AdventureTurnGetResponse["turn"], expected: AdventureTurnClientBinding): void {
  if ((expected.turnId !== undefined && turn.turnId !== expected.turnId) || turn.campaignId !== expected.campaignId
    || turn.sessionId !== expected.sessionId || turn.actorId !== expected.actorId
    || (expected.priorTurnId !== undefined && turn.priorTurnId !== expected.priorTurnId)) {
    throw new Error("Adventure turn response did not match active play identity");
  }
}

/** Performs one read-only exact initial-key lookup; a null result remains commit-ambiguous. */
export async function reconcileInitialAdventureTurn(input: AdventureTurnInitialReconcileRequest): Promise<AdventureTurnGetResponse | null> {
  const locator = parseApiInput(() => adventureTurnInitialReconcileRequestSchema.parse(input));
  const query = new URLSearchParams(locator);
  const success = await requestResponse<unknown>(`/rpg/v1/adventure-turns/reconcile-initial?${query.toString()}`, { cache: "no-store" });
  requireStatus(success, 200, "Initial adventure turn reconciliation");
  const response = adventureTurnInitialReconcileResponseSchema.parse(success.body);
  if (response.result) assertAdventureTurnBinding(response.result.turn, locator);
  return response.result;
}

/** Sends one exact confirmation batch without retry and requires turn/revision/token binding. */
export async function confirmAdventureTurn(turnId: string, input: AdventureTurnConfirmRequest,
  expected: AdventureTurnClientBinding): Promise<ReturnType<typeof adventureTurnConfirmResponseSchema.parse>> {
  const id = parseApiInput(() => resourceIdSchema.parse(turnId)); const body = parseApiInput(() => adventureTurnConfirmRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/adventure-turns/${encodeURIComponent(id)}/confirm`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Adventure turn confirmation"); const response = adventureTurnConfirmResponseSchema.parse(success.body);
  assertAdventureTurnBinding(response.turn, { ...expected, turnId: id });
  if (response.turn.revision < body.expectedRevision + 1) throw new Error("Adventure turn confirmation response did not match the request");
  return response;
}

export async function listCampaigns(): Promise<CampaignListResponse> {
  const success = await requestResponse<unknown>("/rpg/v1/campaigns", { cache: "no-store" });
  requireStatus(success, 200, "Campaign list");
  return campaignListResponseSchema.parse(success.body);
}

export async function getCampaignDetail(campaignId: string): Promise<CampaignDetailResponse> {
  // Validate before interpolation; IDs are opaque and are never normalized or trimmed.
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign detail");
  const response = campaignDetailResponseSchema.parse(success.body);
  if (response.campaign.id !== validCampaignId) throw new Error("Campaign detail response did not match the request");
  return response;
}

/** Reads the bounded safe room projection. Opaque session IDs must not be rendered. */
export async function listCampaignRooms(campaignId: string): Promise<CampaignRoomLinkingResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/rooms`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign room list");
  return campaignRoomLinkingResponseSchema.parse(success.body);
}

/** Issues one PUT with the exact opaque ID. This function intentionally never retries. */
export async function attachCampaignRoom(
  campaignId: string,
  input: CampaignRoomAttachRequest,
): Promise<CampaignRoomAttachResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const exactInput = parseApiInput(() => campaignRoomAttachRequestSchema.parse(input));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/rooms`,
    { method: "PUT", cache: "no-store", body: JSON.stringify(exactInput) },
  );
  if (success.status !== 200) throw new Error("Campaign room attachment response did not use the committed status");
  const response = campaignRoomAttachResponseSchema.parse(success.body);
  if (response.attachment.sessionId !== exactInput.sessionId) {
    throw new Error("Campaign room attachment response did not match the request");
  }
  return response;
}

/** Detaches one exact opaque room path and accepts only its audited administration receipt. */
export async function detachCampaignRoom(
  campaignId: string,
  sessionId: string,
  input: CampaignAdministrationHttpRoomDetachRequest,
): Promise<CampaignAdministrationHttpRoomDetachResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  // Session IDs belong to the legacy room namespace. Validate without trimming
  // or resource-ID normalization, then encode this raw value exactly once.
  const validSessionId = parseApiInput(() => campaignRoomAttachRequestSchema.parse({ sessionId }).sessionId);
  const body = parseApiInput(() => campaignAdministrationHttpRoomDetachRequestSchema.parse(input));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/rooms/${encodeURIComponent(validSessionId)}`,
    { method: "DELETE", cache: "no-store", body: JSON.stringify(body) },
  );
  requireStatus(success, 200, "Campaign room detachment");
  const response = campaignAdministrationHttpRoomDetachResponseSchema.parse(success.body);
  const [event] = response.receipt.events;
  if (response.attachment.sessionId !== validSessionId
    || response.receipt.campaignId !== validCampaignId
    || response.receipt.type !== "room_detached"
    || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1
    || event.campaignId !== validCampaignId
    || event.commandId !== response.receipt.commandId
    || event.type !== "room_detached"
    || event.revision !== response.receipt.revisionAfter
    || event.occurredAt !== response.receipt.occurredAt
    || Object.keys(event.data).join(",") !== "sessionId"
    || event.data.sessionId !== validSessionId) {
    throw new Error("Campaign room detachment receipt did not match the request");
  }
  return response;
}

/** Reads the strict ID-free latest campaign dice projection without caching. */
export async function getCampaignDiceHistory(campaignId: string): Promise<CampaignDiceHistoryResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/dice-rolls`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign dice history");
  return campaignDiceHistoryResponseSchema.parse(success.body);
}

/** Issues one non-idempotent roll POST; callers reconcile every outcome by GET. */
export async function rollCampaignDice(
  campaignId: string,
  input: CampaignDiceRollRequest,
): Promise<CampaignDiceRollResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const normalized = parseApiInput(() => campaignDiceRollRequestSchema.parse(input));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/dice-rolls`,
    { method: "POST", cache: "no-store", body: JSON.stringify(normalized) },
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
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign character list");
  return campaignCharacterListResponseSchema.parse(success.body);
}

/** Reads the strict ID-free display workspace for one roster entry. */
export async function getCampaignCharacterWorkspace(
  campaignId: string,
  campaignCharacterId: string,
): Promise<CampaignCharacterWorkspaceResponse> {
  // IDs stay opaque: validate without trimming, then encode both path segments.
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const validCampaignCharacterId = parseApiInput(() => resourceIdSchema.parse(campaignCharacterId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters/${encodeURIComponent(validCampaignCharacterId)}/workspace`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign character workspace");
  return campaignCharacterWorkspaceResponseSchema.parse(success.body);
}

type CharacterDraftHttpMutation = { draft: CharacterDraftHttpView; receipt: Omit<CharacterDraftMutationReceipt, "commandId" | "draft"> };

function characterDraftPath(campaignId: string, draftId?: string): { campaignId: string; draftId?: string; path: string } {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const validDraftId = draftId === undefined ? undefined : parseApiInput(() => resourceIdSchema.parse(draftId));
  return { campaignId: validCampaignId, draftId: validDraftId,
    path: `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/character-drafts${validDraftId ? `/${encodeURIComponent(validDraftId)}` : ""}` };
}

/** Creates one revision-zero draft. The idempotency key is owned by this exact caller intent. */
export async function createCharacterDraft(campaignId: string, input: CreateCharacterDraftHttpInput): Promise<CharacterDraftHttpMutation> {
  const target = characterDraftPath(campaignId);
  const body = parseApiInput(() => createCharacterDraftHttpInputSchema.parse(input));
  const success = await requestResponse<unknown>(target.path, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 201, "Character draft creation");
  const response = characterDraftHttpMutationResultSchema.parse(success.body);
  if (response.draft.campaignId !== target.campaignId || response.draft.personaId !== body.personaId
    || response.draft.revision !== 0 || response.receipt.draftId !== response.draft.id
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.type !== "create"
    || response.receipt.revisionBefore !== 0 || response.receipt.revisionAfter !== 0) {
    throw new Error("Character draft creation response did not match the request");
  }
  return response;
}

export async function getCharacterDraft(campaignId: string, draftId: string): Promise<CharacterDraftHttpView> {
  const target = characterDraftPath(campaignId, draftId);
  const success = await requestResponse<unknown>(target.path, { cache: "no-store" });
  requireStatus(success, 200, "Character draft read");
  const response = characterDraftHttpViewSchema.parse(success.body);
  if (response.campaignId !== target.campaignId || response.id !== target.draftId) throw new Error("Character draft response did not match the request");
  return response;
}

/** Autosaves one selection intent exactly once; this wrapper never retries a PATCH. */
export async function updateCharacterDraft(campaignId: string, draftId: string, input: UpdateCharacterDraftHttpInput): Promise<CharacterDraftHttpMutation> {
  const target = characterDraftPath(campaignId, draftId);
  const body = parseApiInput(() => updateCharacterDraftHttpInputSchema.parse(input));
  const success = await requestResponse<unknown>(target.path, { method: "PATCH", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Character draft update");
  const response = characterDraftHttpMutationResultSchema.parse(success.body);
  if (response.draft.campaignId !== target.campaignId || response.draft.id !== target.draftId
    || response.draft.revision !== body.expectedRevision + 1 || response.receipt.draftId !== target.draftId
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.type !== "update"
    || response.receipt.revisionBefore !== body.expectedRevision || response.receipt.revisionAfter !== response.draft.revision) {
    throw new Error("Character draft update response did not match the request");
  }
  return response;
}

/** Finalizes once and accepts only the strict public M2.6 receipt projection. */
export async function finalizeCharacterDraft(campaignId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }): Promise<CharacterDraftHttpFinalizationResult> {
  const target = characterDraftPath(campaignId, draftId);
  const body = parseApiInput(() => finalizeCharacterDraftHttpInputSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/finalize`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 201, "Character draft finalization");
  const response = characterDraftHttpFinalizationResultSchema.parse(success.body);
  if (response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1) {
    throw new Error("Character draft finalization response did not match the request");
  }
  return response;
}

function campaignCharacterPath(campaignId: string, campaignCharacterId: string): { campaignId: string; characterId: string; path: string } {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const validCharacterId = parseApiInput(() => resourceIdSchema.parse(campaignCharacterId));
  return { campaignId: validCampaignId, characterId: validCharacterId,
    path: `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters/${encodeURIComponent(validCharacterId)}` };
}

export async function getCharacterSheet(campaignId: string, campaignCharacterId: string): Promise<CharacterSheetHttpResponse> {
  const target = campaignCharacterPath(campaignId, campaignCharacterId);
  const success = await requestResponse<unknown>(`${target.path}/sheet`, { cache: "no-store" });
  requireStatus(success, 200, "Character sheet read");
  return characterSheetHttpResponseSchema.parse(success.body);
}

function actorLanePath(campaignId: string, actorId: string): { campaignId: string; actorId: string; path: string } {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  return { campaignId: validCampaignId, actorId: validActorId,
    path: `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/actors/${encodeURIComponent(validActorId)}` };
}

export async function getActorResources(campaignId: string, actorId: string): Promise<ActorResourcesHttpGetResponse> {
  const target = actorLanePath(campaignId, actorId);
  const success = await requestResponse<unknown>(`${target.path}/resources`, { cache: "no-store" });
  requireStatus(success, 200, "Actor resources read");
  return actorResourcesHttpGetResponseSchema.parse(success.body);
}

/** Issues one exact signed adjustment. This function deliberately never retries. */
export async function changeActorResource(campaignId: string, actorId: string, input: ActorResourcesHttpChangeCommandRequest): Promise<ActorResourcesHttpChangeCommandResponse> {
  const target = actorLanePath(campaignId, actorId);
  const body = parseApiInput(() => actorResourcesHttpChangeCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/resource-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor resource command");
  const response = actorResourcesHttpChangeCommandResponseSchema.parse(success.body);
  if (response.receipt.kind !== body.kind || response.receipt.resourceName !== body.resourceName || response.receipt.amount !== body.amount
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.revisionBefore !== body.expectedRevision) {
    throw new Error("Actor resource receipt did not match the request");
  }
  return response;
}

export async function getActorInventory(campaignId: string, actorId: string): Promise<InventoryHttpGetResponse> {
  const target = actorLanePath(campaignId, actorId);
  const success = await requestResponse<unknown>(`${target.path}/inventory`, { cache: "no-store" });
  requireStatus(success, 200, "Actor inventory read");
  return inventoryHttpGetResponseSchema.parse(success.body);
}

function inventoryReceiptMatches(command: InventoryHttpCommandRequest, receipt: InventoryHttpCommandResponse["receipt"]): boolean {
  if (command.kind !== receipt.kind) return false;
  if (command.kind === "equip" && receipt.kind === "equip") return command.slot === receipt.slot && command.entryId === receipt.entryId;
  if (command.kind === "unequip" && receipt.kind === "unequip") return command.slot === receipt.slot;
  if (command.kind === "consume" && receipt.kind === "consume") return command.entryId === receipt.entryId && command.quantity === receipt.quantity && JSON.stringify(command.item) === JSON.stringify(receipt.item);
  if (command.kind === "drop" && receipt.kind === "drop") return command.entryId === receipt.entryId && command.quantity === receipt.quantity && JSON.stringify(command.item) === JSON.stringify(receipt.item);
  return command.kind === "gift" && receipt.kind === "gift" && command.recipientActorId === receipt.recipientActorId
    && command.entryId === receipt.entryId && command.quantity === receipt.quantity && JSON.stringify(command.item) === JSON.stringify(receipt.item);
}

/** Submits one legal M2.7 inventory discriminant and requires its exact receipt. */
export async function commandActorInventory(campaignId: string, actorId: string, input: InventoryHttpCommandRequest): Promise<InventoryHttpCommandResponse> {
  const target = actorLanePath(campaignId, actorId);
  const body = parseApiInput(() => inventoryHttpCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/inventory-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor inventory command");
  const response = inventoryHttpCommandResponseSchema.parse(success.body);
  if (!inventoryReceiptMatches(body, response.receipt) || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision || response.inventory.revision !== response.receipt.revisionAfter) {
    throw new Error("Actor inventory receipt did not match the request");
  }
  return response;
}

export async function getActorWallet(campaignId: string, actorId: string): Promise<EconomyHttpWalletGetResponse> {
  const target = actorLanePath(campaignId, actorId);
  const success = await requestResponse<unknown>(`${target.path}/wallet`, { cache: "no-store" });
  requireStatus(success, 200, "Actor wallet read");
  return economyHttpWalletGetResponseSchema.parse(success.body);
}

export async function getCampaignShop(campaignId: string, shopId: string): Promise<EconomyHttpShopGetResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const validShopId = parseApiInput(() => resourceIdSchema.parse(shopId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/shops/${encodeURIComponent(validShopId)}`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign shop read");
  return economyHttpShopGetResponseSchema.parse(success.body);
}

/** Submits one canonical economy command and binds its discriminated result. */
export async function commandActorEconomy(campaignId: string, actorId: string, input: EconomyHttpCommandRequest): Promise<EconomyHttpCommandResponse> {
  const target = actorLanePath(campaignId, actorId);
  const body = parseApiInput(() => economyHttpCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/economy-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor economy command");
  const response = economyHttpCommandResponseSchema.parse(success.body);
  const resultMatches = body.type === "request_purchase_quote" && response.type === body.type
    ? response.quote.quantity === body.quantity && JSON.stringify(response.quote.item) === JSON.stringify(body.item)
    : body.type === "purchase_from_shop" && response.type === body.type
      ? response.purchase.quoteId === body.quoteId
      : body.type === "propose_bilateral_trade" && response.type === body.type && response.trade.tradeId === body.tradeId;
  if (!resultMatches || response.receipt.type !== body.type || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision) throw new Error("Actor economy receipt did not match the request");
  return response;
}

/** Rest recovery is wholly server-owned and accepted only with a bound receipt/state revision. */
export async function commandActorRest(campaignId: string, actorId: string, input: RestHttpRequest): Promise<RestHttpResponse> {
  const target = actorLanePath(campaignId, actorId);
  const body = parseApiInput(() => restHttpRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/rest-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor rest command");
  const response = restHttpResponseSchema.parse(success.body);
  const expectedKind = body.type === "take_short_rest" ? "short" : "long";
  const returnedResources = new Map(response.actorState.resources.map((resource) => [resource.resourceId, resource]));
  if (response.receipt.kind !== expectedKind || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision || response.actorState.revision !== response.receipt.revisionAfter
    || response.receipt.recovery.resources.some((delta) => returnedResources.get(delta.resourceId)?.current !== delta.after)) {
    throw new Error("Actor rest receipt did not match the request");
  }
  return response;
}

export async function getActorEffects(actorId: string): Promise<ActorEffectsResponse> {
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  const success = await requestResponse<unknown>(`/rpg/v1/actors/${encodeURIComponent(validActorId)}/effects`, { cache: "no-store" });
  requireStatus(success, 200, "Actor effects read");
  return actorEffectsResponseSchema.parse(success.body);
}

/** Resolves one server-owned check and binds its discriminant, target, and receipt. */
export async function commandActorCheck(actorId: string, input: ActorCheckCommandRequest): Promise<ActorCheckCommandResponse> {
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  const body = parseApiInput(() => actorCheckCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/actors/${encodeURIComponent(validActorId)}/check-commands`, {
    method: "POST", cache: "no-store", body: JSON.stringify(body),
  });
  requireStatus(success, 200, "Actor check command");
  const response = actorCheckCommandResponseSchema.parse(success.body);
  const targetMatches = body.kind === "opposed"
    ? response.check.target.kind === "opposed_total" && response.check.target.actorId === body.targetActorId
    : response.check.target.kind === "difficulty_class";
  if (!targetMatches
    || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1) {
    throw new Error("Actor check response did not match the request");
  }
  return response;
}

export async function getActorPowers(actorId: string): Promise<ActorPowersResponse> {
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  const success = await requestResponse<unknown>(`/rpg/v1/actors/${encodeURIComponent(validActorId)}/powers`, { cache: "no-store" });
  requireStatus(success, 200, "Actor powers read");
  return actorPowersResponseSchema.parse(success.body);
}

/** Issues one revision-bound power intent. This wrapper never retries a write. */
export async function commandActorPower(actorId: string, input: ActorPowerCommandRequest): Promise<ActorPowerCommandResponse> {
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  const body = parseApiInput(() => actorPowerCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/actors/${encodeURIComponent(validActorId)}/power-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor power command");
  const response = actorPowerCommandResponseSchema.parse(success.body);
  const targetsMatch = JSON.stringify(response.resolution.targetIds) === JSON.stringify(body.targetIds)
    || (body.targetIds.length === 0 && response.resolution.targetIds.length === 1 && response.resolution.targetIds[0] === validActorId);
  if (response.actorStates[0]?.actorId !== validActorId
    || JSON.stringify(response.resolution.powerRef) !== JSON.stringify(body.powerRef)
    || !targetsMatch
    || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1) {
    throw new Error("Actor power response did not match the request");
  }
  return response;
}

/** Issues one exact effect mutation and binds its receipt; no automatic retry. */
export async function commandActorEffect(actorId: string, input: ActorEffectCommandRequest): Promise<ActorEffectCommandResponse> {
  const validActorId = parseApiInput(() => resourceIdSchema.parse(actorId));
  const body = parseApiInput(() => actorEffectCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/actors/${encodeURIComponent(validActorId)}/effect-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor effect command");
  const response = actorEffectCommandResponseSchema.parse(success.body);
  if (response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1
    || (body.kind === "remove" && response.effects.some((effect) => effect.effectId === body.effectId))) {
    throw new Error("Actor effect response did not match the request");
  }
  return response;
}

function combatPath(combatId: string): { id: string; path: string } {
  const id = parseApiInput(() => resourceIdSchema.parse(combatId));
  return { id, path: `/rpg/v1/combats/${encodeURIComponent(id)}` };
}

export async function listCampaignEncounters(campaignId: string): Promise<{ encounters: EncounterPublic[] }> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/encounters`, { cache: "no-store" });
  requireStatus(success, 200, "Encounter list");
  return encounterListResponseSchema.parse(success.body);
}

/** Creates one encounter intent and requires its route-bound preparing projection. */
export async function createCampaignEncounter(campaignId: string, input: EncounterCreateRequest): Promise<EncounterPublic> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = parseApiInput(() => encounterCreateRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/encounters`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 201, "Encounter creation");
  const { encounter } = encounterCreateResponseSchema.parse(success.body);
  const requestedCombatants = body.combatants.map((entry) => entry.kind === "actor"
    ? { kind: entry.kind, actorId: entry.actorId, team: entry.team }
    : { kind: entry.kind, template: entry.template, team: entry.team });
  const returnedCombatants = encounter.combatants.map((entry) => entry.kind === "actor"
    ? { kind: entry.kind, actorId: entry.actorId, team: entry.team }
    : { kind: entry.kind, template: entry.template, team: entry.team });
  if (encounter.sessionId !== body.sessionId || encounter.name !== body.name || encounter.status !== "preparing"
    || encounter.combatId !== null || encounter.revision !== 1
    || JSON.stringify(returnedCombatants) !== JSON.stringify(requestedCombatants)) {
    throw new Error("Encounter creation response did not match the request");
  }
  return encounter;
}

/** Requests one typed encounter draft. Writes are never retried automatically. */
export async function createEncounterGenerationDraft(input: GenerationDraftCreateRequest): Promise<GenerationDraftGetResponse> {
  const body = parseApiInput(() => generationDraftCreateRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/generation-drafts", { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 201, "Encounter generation");
  const response = generationDraftCreateResponseSchema.parse(success.body);
  if (response.draft.campaignId !== body.campaignId || response.draft.kind !== "encounter") throw new Error("Encounter generation response did not match the request");
  return response;
}

/** Reads only the role-safe typed encounter draft projection. */
export async function getEncounterGenerationDraft(draftId: string): Promise<GenerationDraftGetResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(draftId));
  const success = await requestResponse<unknown>(`/rpg/v1/generation-drafts/${encodeURIComponent(id)}`, { cache: "no-store" });
  requireStatus(success, 200, "Encounter generation draft");
  return generationDraftGetResponseSchema.parse(success.body);
}

/** Confirms and applies one reviewed encounter draft through the authoritative encounter command service. */
export async function applyEncounterGenerationDraft(draftId: string, input: GenerationDraftApplyRequest): Promise<GenerationDraftApplyResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(draftId));
  const body = parseApiInput(() => generationDraftApplyRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/generation-drafts/${encodeURIComponent(id)}/apply`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Encounter generation apply");
  const response = generationDraftApplyResponseSchema.parse(success.body);
  if (response.draft.draftId !== id || response.application.encounterId !== response.receipts[0].encounterId) throw new Error("Encounter generation apply response did not match the request");
  return response;
}

/** Requests a bounded campaign-content draft; provider internals never enter this projection. */
export async function createCampaignContentDraft(input: CampaignContentGenerationRequest) {
  const body = parseApiInput(() => campaignContentGenerationRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/campaign-content-drafts", { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 201, "Campaign content generation");
  return campaignContentDraftViewSchema.parse(success.body);
}
export async function getCampaignContentDraft(draftId: string) {
  const id = parseApiInput(() => resourceIdSchema.parse(draftId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaign-content-drafts/${encodeURIComponent(id)}`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign content draft");
  return campaignContentDraftViewSchema.parse(success.body);
}
export async function applyCampaignContentDraft(draftId: string, input: { expectedRevision: number; idempotencyKey: string }) {
  const id = parseApiInput(() => resourceIdSchema.parse(draftId)), body = parseApiInput(() => campaignContentApplyRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaign-content-drafts/${encodeURIComponent(id)}/apply`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Campaign content apply");
  return campaignContentApplyResponseSchema.parse(success.body);
}

export async function startEncounter(encounterId: string, input: EncounterStartCommandRequest) {
  const id = parseApiInput(() => resourceIdSchema.parse(encounterId));
  const body = parseApiInput(() => encounterStartCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/encounters/${encodeURIComponent(id)}/start-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Encounter start");
  const response = encounterStartCommandResponseSchema.parse(success.body);
  if (response.combat.combatId !== id || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision || response.receipt.revisionAfter !== body.expectedRevision + 1
    || response.combat.revision !== response.receipt.revisionAfter) throw new Error("Encounter start response did not match the request");
  return response;
}

export async function getCombatState(combatId: string): Promise<CombatReadResponse> {
  const target = combatPath(combatId);
  const success = await requestResponse<unknown>(target.path, { cache: "no-store" });
  requireStatus(success, 200, "Combat state read");
  return combatReadResponseSchema.parse(success.body);
}

export async function getCombatConsumableActions(combatId:string):Promise<UseConsumableLegalAction[]>{
  const target=combatPath(combatId);
  const success=await requestResponse<unknown>(`${target.path}/consumable-actions`,{cache:"no-store"});
  requireStatus(success,200,"Combat consumable actions");
  const actions=useConsumableLegalActionSchema.array().parse(success.body);
  return actions;
}

export async function commandCombatConsumable(combatId:string,input:UseConsumableCommandRequest):Promise<UseConsumableCommandResult>{
  const target=combatPath(combatId),body=parseApiInput(()=>useConsumableCommandRequestSchema.parse(input));
  const success=await requestResponse<unknown>(`${target.path}/consumable-actions/commands`,{method:"POST",cache:"no-store",body:JSON.stringify(body)});
  requireStatus(success,200,"Combat consumable command");
  const response=useConsumableCommandResultSchema.parse(success.body);
  await verifyConsumableResult(body,response);
  return response;
}

/** Reads an immutable consumable result and cannot execute or replay the command. */
export async function getCombatConsumableResult(combatId:string,expectedRequest:UseConsumableCommandRequest):Promise<UseConsumableCommandResult>{
  const target=combatPath(combatId),expected=parseApiInput(()=>useConsumableCommandRequestSchema.parse(expectedRequest)),key=expected.idempotencyKey;
  const success=await requestResponse<unknown>(`${target.path}/consumable-actions/results/${encodeURIComponent(key)}`,{cache:"no-store"});
  requireStatus(success,200,"Combat consumable result");
  const response=useConsumableCommandResultSchema.parse(success.body);
  await verifyConsumableResult(expected,response);
  return response;
}

async function verifyConsumableResult(expected:UseConsumableCommandRequest,result:UseConsumableCommandResult):Promise<void>{
  const frame=new TextEncoder().encode(canonicalUseConsumableRequestFrame(expected));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",frame)),(byte)=>byte.toString(16).padStart(2,"0")).join("");
  if(JSON.stringify(result.requestBinding.requestEvidence)!==JSON.stringify(expected)
    ||result.requestBinding.idempotencyKey!==expected.idempotencyKey||result.receipt.idempotencyKey!==expected.idempotencyKey
    ||result.requestBinding.canonicalRequestDigest!==digest)throw new Error("Combat consumable result did not match the exact request");
}

export async function getCombatLog(combatId: string, query: CombatLogQuery): Promise<CombatLogResponse> {
  const target = combatPath(combatId);
  const input = parseApiInput(() => combatLogQuerySchema.parse(query));
  const params = new URLSearchParams({ afterSequence: String(input.afterSequence), limit: String(input.limit) });
  const success = await requestResponse<unknown>(`${target.path}/log?${params}`, { cache: "no-store" });
  requireStatus(success, 200, "Combat log read");
  const response = combatLogResponseSchema.parse(success.body);
  if (response.entries.length > input.limit || response.entries.some((entry) => entry.sequence <= input.afterSequence)) {
    throw new Error("Combat log response did not match the requested page");
  }
  return response;
}

/** Reads an immutable prior command result. This method cannot execute or replay a command. */
export async function getCombatCommandResult(campaignId: string, combatId: string, idempotencyKey: string): Promise<CombatCommandResultResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const target = combatPath(combatId);
  const key = parseApiInput(() => actorPowerCommandRequestSchema.shape.idempotencyKey.parse(idempotencyKey));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/combats/${encodeURIComponent(target.id)}/command-results/${encodeURIComponent(key)}`, { cache: "no-store" });
  requireStatus(success, 200, "Combat command result");
  const response = combatCommandResultResponseSchema.parse(success.body);
  const bound = response.operation === "action" ? response.result.combat.combatId === target.id && response.result.receipt.idempotencyKey === key
    : response.result.encounter.encounterId === target.id && response.result.receipt.idempotencyKey === key;
  if (!bound) throw new Error("Combat command result did not match the request");
  return response;
}

/** Resolves one server-issued legal action ID exactly once. */
export async function resolveCombatAction(combatId: string, input: CombatActionCommandRequest): Promise<CombatActionCommandResponse> {
  const target = combatPath(combatId);
  const body = parseApiInput(() => combatActionCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/action-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Combat action");
  const response = combatActionCommandResponseSchema.parse(success.body);
  if (response.combat.combatId !== target.id || response.resolution.legalActionId !== body.legalActionId
    || JSON.stringify(response.resolution.targetIds) !== JSON.stringify(body.targetIds)
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1 || response.combat.revision !== response.receipt.revisionAfter) {
    throw new Error("Combat action response did not match the request");
  }
  return response;
}

export async function endCombat(combatId: string, input: CombatEndCommandRequest): Promise<CombatEndCommandResponse> {
  const target = combatPath(combatId);
  const body = parseApiInput(() => combatEndCommandRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/end-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Combat end");
  const response = combatEndCommandResponseSchema.parse(success.body);
  if (response.encounter.encounterId !== target.id || response.encounter.combatId !== target.id
    || response.receipt.idempotencyKey !== body.idempotencyKey || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1 || response.encounter.revision !== response.receipt.revisionAfter) {
    throw new Error("Combat end response did not match the request");
  }
  return response;
}

export async function getCharacterProgression(campaignId: string, campaignCharacterId: string): Promise<CharacterProgressionHttpState> {
  const target = campaignCharacterPath(campaignId, campaignCharacterId);
  const success = await requestResponse<unknown>(`${target.path}/progression`, { cache: "no-store" });
  requireStatus(success, 200, "Character progression read");
  const { progression } = characterProgressionHttpStateResponseSchema.parse(success.body);
  if (progression.campaignId !== target.campaignId || progression.campaignCharacterId !== target.characterId) throw new Error("Character progression response did not match the request");
  return progression;
}

export async function previewCharacterProgression(campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpPreviewRequest): Promise<CharacterProgressionHttpPreview> {
  const target = campaignCharacterPath(campaignId, campaignCharacterId);
  const body = parseApiInput(() => characterProgressionHttpPreviewRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/progression/preview`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Character progression preview");
  const { preview } = characterProgressionHttpPreviewResponseSchema.parse(success.body);
  if (preview.campaignId !== target.campaignId || preview.campaignCharacterId !== target.characterId) throw new Error("Character progression preview did not match the request");
  return preview;
}

/** Applies one opaque server preview exactly once; no failed request is replayed. */
export async function applyCharacterProgression(campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpApplyRequest, expectedPreview: CharacterProgressionHttpPreview): Promise<CharacterProgressionHttpApplyResponse> {
  const target = campaignCharacterPath(campaignId, campaignCharacterId);
  const body = parseApiInput(() => characterProgressionHttpApplyRequestSchema.parse(input));
  if (expectedPreview.campaignId !== target.campaignId || expectedPreview.campaignCharacterId !== target.characterId
    || expectedPreview.previewRevision !== body.previewRevision || expectedPreview.previewToken !== body.previewToken) {
    throw new ApiInputError("Progression apply preview does not match the request");
  }
  const success = await requestResponse<unknown>(`${target.path}/progression/apply`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Character progression apply");
  const response = characterProgressionHttpApplyResponseSchema.parse(success.body);
  if (response.progression.campaignId !== target.campaignId || response.progression.campaignCharacterId !== target.characterId
    || response.receipt.campaignCharacterId !== target.characterId || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.previewRevision || response.receipt.revisionAfter !== response.progression.revision
    || JSON.stringify(response.receipt.appliedLevels) !== JSON.stringify(expectedPreview.levels)
    || response.progression.level !== expectedPreview.eligibleLevel) {
    throw new Error("Character progression apply response did not match the request");
  }
  return response;
}

export async function grantCharacterXp(campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpGrantXpRequest): Promise<CharacterProgressionHttpGrantXpResponse> {
  const target = campaignCharacterPath(campaignId, campaignCharacterId);
  const body = parseApiInput(() => characterProgressionHttpGrantXpRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${target.path}/xp-commands`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Character XP command");
  const response = characterProgressionHttpGrantXpResponseSchema.parse(success.body);
  if (response.progression.campaignId !== target.campaignId || response.progression.campaignCharacterId !== target.characterId
    || response.receipt.campaignCharacterId !== target.characterId || response.receipt.idempotencyKey !== body.idempotencyKey
    || response.receipt.revisionBefore !== body.expectedRevision || response.receipt.revisionAfter !== response.progression.revision) {
    throw new Error("Character XP response did not match the request");
  }
  return response;
}

/** Reads only the strict, path-bound fixed-starter creation projection. */
export async function getCampaignCharacterCreationOptions(campaignId: string): Promise<CampaignCharacterCreationOptionsResponse> {
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters/creation-options`,
    { cache: "no-store" },
  );
  requireStatus(success, 200, "Campaign character creation options");
  const response = campaignCharacterCreationOptionsResponseSchema.parse(success.body);
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
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const normalized = parseApiInput(() => campaignCharacterCreateRequestSchema.parse(input));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/characters`,
    { method: "POST", cache: "no-store", body: JSON.stringify(normalized) },
  );
  requireStatus(success, 201, "Campaign character creation");
  const response = campaignCharacterCreateResponseSchema.parse(success.body);
  if (response.character.characterId !== normalized.characterId) {
    throw new Error("Campaign character creation response did not match the request");
  }
  return response;
}

export async function createCampaign(input: CampaignCreateRequest): Promise<CampaignCreateResponse> {
  const normalized = parseApiInput(() => campaignCreateRequestSchema.parse(input));
  const success = await requestResponse<unknown>("/rpg/v1/campaigns", {
    method: "POST", cache: "no-store",
    body: JSON.stringify(normalized),
  });
  requireStatus(success, 201, "Campaign creation");
  return campaignCreateResponseSchema.parse(success.body);
}

export async function renameCampaign(campaignId: string, input: CampaignRenameRequest): Promise<CampaignRenameResponse> {
  // Validate and normalize before interpolation or network I/O. In addition to
  // the strict wire schema, bind the minimal response to this exact operation.
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const normalized = parseApiInput(() => campaignRenameRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}`, {
    method: "PATCH", cache: "no-store",
    body: JSON.stringify(normalized),
  });
  requireStatus(success, 200, "Campaign rename");
  const response = campaignRenameResponseSchema.parse(success.body);
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
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  // This function intentionally accepts no caller-selected starter or content.
  const body = parseApiInput(() => campaignStarterSetupRequestSchema.parse({ starterId: ORIGINAL_STARTER_ID }));
  const success = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/starter-setup`,
    { method: "PUT", cache: "no-store", body: JSON.stringify(body) },
  );
  requireStatus(success, 200, "Campaign starter setup");
  const response = campaignDetailResponseSchema.parse(success.body);
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
  const validCampaignId = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = parseApiInput(() => campaignMechanicsStarterSetupRequestSchema.parse({ starterId: MECHANICS_STARTER_ID }));
  const result = await requestResponse<unknown>(
    `/rpg/v1/campaigns/${encodeURIComponent(validCampaignId)}/mechanics-starter-setup`,
    { method: "PUT", cache: "no-store", body: JSON.stringify(body) },
    { status: 200, message: "Campaign mechanics starter setup response did not use the committed status" },
  );
  // Check the operation status before attempting to parse any success body.
  requireStatus(result, 200, "Campaign mechanics starter setup");
  const response = campaignMechanicsStarterSetupResponseSchema.parse(result.body);
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
  const success = await requestResponse<unknown>(path, { cache: "no-store" });
  requireStatus(success, 200, "Campaign administration read");
  const response = campaignAdministrationHttpGetResponseSchema.parse(success.body);
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
  const success = await requestResponse<unknown>(path, { method: "PATCH", cache: "no-store", body: JSON.stringify(body) });
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
  const success = await requestResponse<unknown>(path, { method: "DELETE", cache: "no-store", body: JSON.stringify(body) });
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
  const success = await requestResponse<unknown>(path, { cache: "no-store" });
  requireStatus(success, 200, "Campaign membership list");
  return campaignAdministrationHttpMembershipListResponseSchema.parse(success.body);
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
    { method: "POST", cache: "no-store", body: JSON.stringify(body) }, body.expectedRevision, "membership_added", body.role);
}

export async function updateCampaignAdministrationMembership(
  campaignId: string,
  principalId: string,
  input: CampaignAdministrationHttpMembershipUpdateRequest,
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const body = parseApiInput(() => campaignAdministrationHttpMembershipUpdateRequestSchema.parse(input));
  const target = membershipPath(campaignId, principalId);
  return membershipMutation(target.campaignId, parseApiInput(() => resourceIdSchema.parse(principalId)), target.path,
    { method: "PATCH", cache: "no-store", body: JSON.stringify(body) }, body.expectedRevision, "membership_role_changed", body.role);
}

export async function removeCampaignAdministrationMembership(
  campaignId: string,
  principalId: string,
  input: CampaignAdministrationHttpMembershipDeleteRequest,
): Promise<CampaignAdministrationHttpMembershipMutationResponse> {
  const body = parseApiInput(() => campaignAdministrationHttpMembershipDeleteRequestSchema.parse(input));
  const target = membershipPath(campaignId, principalId);
  return membershipMutation(target.campaignId, parseApiInput(() => resourceIdSchema.parse(principalId)), target.path,
    { method: "DELETE", cache: "no-store", body: JSON.stringify(body) }, body.expectedRevision, "membership_removed");
}

export async function listCampaignTimelines(campaignId: string): Promise<CampaignHistoryHttpTimelinesResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/timelines`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign timeline list");
  const response = campaignHistoryHttpTimelinesResponseSchema.parse(success.body);
  if (!response.timelines.some((timeline) => timeline.id === response.activeTimelineId && timeline.active)) {
    throw new Error("Campaign timeline response did not identify its active timeline");
  }
  return response;
}

/** Reads one bounded, stable history page using a revision cursor. */
export async function listCampaignEvents(
  campaignId: string,
  query: CampaignHistoryHttpEventsQuery,
): Promise<CampaignHistoryHttpEventsResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const input = parseApiInput(() => campaignHistoryHttpEventsQuerySchema.parse(query));
  const params = new URLSearchParams({ timelineId: input.timelineId, afterRevision: String(input.afterRevision), limit: String(input.limit) });
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/events?${params}`, { cache: "no-store" });
  if (success.status !== 200) throw new Error("Campaign event page response did not use the documented status");
  const response = campaignHistoryHttpEventsResponseSchema.parse(success.body);
  let previous = input.afterRevision;
  for (const event of response.events) {
    if (event.timelineId !== input.timelineId || event.revision <= previous) throw new Error("Campaign event page was not bound to its cursor");
    previous = event.revision;
  }
  if (response.events.length > input.limit
    || (response.nextAfterRevision !== null && response.nextAfterRevision !== previous)) {
    throw new Error("Campaign event page returned an invalid cursor");
  }
  return response;
}

export async function getCampaignCommandReceipt(campaignId: string, commandId: string): Promise<CampaignHistoryHttpPublicReceiptResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const command = parseApiInput(() => resourceIdSchema.parse(commandId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/commands/${encodeURIComponent(command)}/receipt`, { cache: "no-store" });
  if (success.status !== 200) throw new Error("Campaign receipt response did not use the documented status");
  return campaignHistoryHttpPublicReceiptResponseSchema.parse(success.body);
}

export async function listCampaignRecaps(campaignId: string): Promise<{ recaps: CampaignHistoryHttpRecap[] }> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/recaps`, { cache: "no-store" });
  if (success.status !== 200) throw new Error("Campaign recap response did not use the documented status");
  const value = success.body;
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).join(",") !== "recaps") throw new Error("Campaign recap response was malformed");
  return { recaps: campaignHistoryHttpRecapSchema.array().max(1000).parse((value as { recaps: unknown }).recaps) };
}

export async function createCampaignRecap(campaignId: string, input: CampaignHistoryHttpRecapRequest): Promise<CampaignHistoryHttpRecapResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const body = parseApiInput(() => campaignHistoryHttpRecapRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/recaps`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  if (success.status !== 201) throw new Error("Campaign recap response did not use the committed status");
  const response = campaignHistoryHttpRecapResponseSchema.parse(success.body);
  const event = response.receipt.events[0];
  if (response.recap.timelineId !== body.timelineId || response.recap.throughRevision !== body.throughRevision
    || response.recap.visibility !== body.visibility || response.recap.text !== body.text
    || JSON.stringify(response.recap.selectedSessionIds) !== JSON.stringify(body.selectedSessionIds)
    || response.recap.createdAt !== response.receipt.occurredAt
    || response.receipt.type !== "recap_created" || response.receipt.revisionBefore !== body.expectedRevision
    || event.type !== "recap_created" || event.commandId !== response.receipt.commandId
    || event.data.timelineId !== body.timelineId || event.data.throughRevision !== body.throughRevision
    || event.data.visibility !== body.visibility || JSON.stringify(event.data.selectedSessionIds) !== JSON.stringify(body.selectedSessionIds)
    || "text" in event.data) {
    throw new Error("Campaign recap receipt did not match the request");
  }
  return response;
}

export async function listCampaignCheckpoints(campaignId: string): Promise<{ checkpoints: CampaignHistoryHttpCheckpoint[] }> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/checkpoints`, { cache: "no-store" });
  requireStatus(success, 200, "Campaign checkpoint list");
  const body = success.body;
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
    { method: "POST", cache: "no-store", body: JSON.stringify(body) });
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
    { method: "POST", cache: "no-store", body: JSON.stringify(body) });
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
  const success = await requestResponse<unknown>("/rpg/v1/campaign-imports", { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  if (success.status !== 200) throw new Error("Campaign import report response did not use the documented status");
  return campaignTransferHttpDryRunResponseSchema.parse(success.body);
}

/** Applies exactly one server-stored dry run. Callers must not replay this write. */
export async function applyCampaignImport(importId: string, input: CampaignTransferHttpApplyRequest): Promise<CampaignTransferHttpApplyResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(importId));
  const body = parseApiInput(() => campaignTransferHttpApplyRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`/rpg/v1/campaign-imports/${encodeURIComponent(id)}/apply`, { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  if (success.status !== 200) throw new Error("Campaign import apply response did not use the committed status");
  const response = campaignTransferHttpApplyResponseSchema.parse(success.body);
  const event = response.receipt.events[0];
  if (response.campaign.actorRole !== "owner" || response.receipt.type !== "import_applied"
    || response.receipt.campaignId !== response.campaign.id || event.campaignId !== response.campaign.id
    || event.type !== "import_applied" || event.commandId !== response.receipt.commandId
    || event.revision !== response.receipt.revisionAfter || event.occurredAt !== response.receipt.occurredAt
    || event.data.importId !== id) {
    throw new Error("Campaign import receipt did not match the imported campaign");
  }
  return response;
}

/** Fetches and validates the exact portable export document without caching. */
export async function getCampaignExport(campaignId: string, includeMessages: boolean): Promise<CampaignTransferHttpExportDocument> {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const success = await requestResponse<unknown>(`/rpg/v1/campaigns/${encodeURIComponent(id)}/export?includeMessages=${includeMessages ? "true" : "false"}`, { cache: "no-store" });
  if (success.status !== 200) throw new Error("Campaign export response did not use the documented status");
  const document = campaignTransferHttpExportDocumentSchema.parse(success.body);
  if (document.messages.included !== includeMessages) throw new Error("Campaign export did not match the message choice");
  return document;
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
  const success = await requestResponse<unknown>("/rpg/v1/content-packs/validate", { method: "POST", cache: "no-store", body: JSON.stringify(body) });
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
  const success = await requestResponse<unknown>("/rpg/v1/content-packs", { method: "POST", cache: "no-store", body: JSON.stringify(body) });
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
  const success = await requestResponse<unknown>(target.path, { method: "PUT", cache: "no-store", body: JSON.stringify(body) });
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

type Revisioned<T> = { data: T; revision: number };
function revisionFrom(headers: Headers, name: "x-world-revision" | "x-quest-revision" | "x-story-revision"): number {
  const raw = headers.get(name);
  const revision = raw === null ? NaN : Number(raw);
  if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== raw) throw new Error(`Response omitted a valid ${name} header`);
  return revision;
}
function campaignLane(campaignId: string, suffix: string): string {
  const id = parseApiInput(() => resourceIdSchema.parse(campaignId));
  return `/rpg/v1/campaigns/${encodeURIComponent(id)}/${suffix}`;
}
function resourceLane(prefix: string, id: string, suffix: string): string {
  const valid = parseApiInput(() => resourceIdSchema.parse(id));
  return `/rpg/v1/${prefix}/${encodeURIComponent(valid)}/${suffix}`;
}
function bindReceipt(receipt: { idempotencyKey: string; revisionBefore: number; revisionAfter: number }, body: { idempotencyKey: string; expectedRevision: number }, operation: string): void {
  if (receipt.idempotencyKey !== body.idempotencyKey || receipt.revisionBefore !== body.expectedRevision || receipt.revisionAfter !== body.expectedRevision + 1) {
    throw new Error(`${operation} receipt did not match the request`);
  }
}

/** M2.10 reads expose the mandatory authoritative revision separately from their strict role projection. */
export async function getCampaignWorld(campaignId: string): Promise<Revisioned<CampaignWorldHttpResponse>> {
  const success = await requestResponse<unknown>(campaignLane(campaignId, "world"), { cache: "no-store" });
  requireStatus(success, 200, "Campaign world read");
  return { data: campaignWorldHttpResponseSchema.parse(success.body), revision: revisionFrom(success.headers, "x-world-revision") };
}
export async function travelActor(actorId: string, input: ActorTravelCommandRequest): Promise<ActorTravelCommandResponse> {
  const id = parseApiInput(() => resourceIdSchema.parse(actorId));
  const body = parseApiInput(() => actorTravelCommandRequestSchema.parse(input));
  if (!body.partyActorIds.includes(id)) throw new ApiInputError("Travel party must contain the route actor");
  const success = await requestResponse<unknown>(resourceLane("actors", id, "travel-commands"), { method: "POST", cache: "no-store", body: JSON.stringify(body) });
  requireStatus(success, 200, "Actor travel");
  const response = actorTravelCommandResponseSchema.parse(success.body); bindReceipt(response.receipt, body, "Actor travel");
  if (JSON.stringify(response.locations.map((item) => item.actorId)) !== JSON.stringify(body.partyActorIds)) throw new Error("Actor travel response did not match the exact party");
  return response;
}

export async function listCampaignNpcs(campaignId: string, audience: "gm" | "player"): Promise<Revisioned<CampaignNpcsHttpResponse>> {
  const success = await requestResponse<unknown>(campaignLane(campaignId, "npcs"), { cache: "no-store" }); requireStatus(success, 200, "Campaign NPC read");
  const data=audience==="gm"?gmCampaignNpcsHttpResponseSchema.parse(success.body):playerCampaignNpcsHttpResponseSchema.parse(success.body);
  return { data, revision: revisionFrom(success.headers, "x-world-revision") };
}

function npcPresenceLane(campaignId: string, sessionId: string): string {
  const campaign = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const session = parseApiInput(() => campaignPlaySessionIdSchema.parse(sessionId));
  return `/rpg/v1/campaigns/${encodeOpaquePathSegment(campaign)}/rooms/${encodeOpaquePathSegment(session)}`;
}

/** Reads the authoritative running cast or stopped cast history for one opaque room. */
export async function getCampaignPresentCast(campaignId: string, sessionId: string, audience: "gm" | "player"): Promise<NpcCastHttp> {
  const success = await requestResponse<unknown>(`${npcPresenceLane(campaignId, sessionId)}/present-cast`, { cache: "no-store" });
  requireStatus(success, 200, "NPC present cast read");
  const cast = npcCastHttpSchema.parse(success.body);
  const revision = success.headers.get("x-npc-presence-revision");
  if (cast.audience !== audience) throw new Error("NPC present cast audience did not match the request");
  if (revision === null || String(cast.sessionRevision) !== revision) throw new Error("NPC present cast revision header did not match the response");
  return cast;
}

/** Issues one presence write. Ambiguous outcomes are never retried by this transport. */
export async function commandNpcPresence(campaignId: string, sessionId: string, npcId: string, input: NpcPresenceMutationHttpRequest): Promise<NpcPresenceMutationHttpResponse> {
  const npc = parseApiInput(() => resourceIdSchema.parse(npcId));
  const body = parseApiInput(() => npcPresenceMutationHttpRequestSchema.parse(input));
  const success = await requestResponse<unknown>(`${npcPresenceLane(campaignId, sessionId)}/npcs/${encodeOpaquePathSegment(npc)}/presence-commands`, {
    method: "POST", cache: "no-store", body: JSON.stringify(body),
  });
  requireStatus(success, 200, "NPC presence command");
  const response = npcPresenceMutationHttpResponseSchema.parse(success.body);
  if (response.receipt.kind !== body.mutation.kind || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1) throw new Error("NPC presence receipt did not match the request");
  return response;
}

function companionAdministrationLane(campaignId: string, npcId: string): string {
  const campaign = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const npc = parseApiInput(() => resourceIdSchema.parse(npcId));
  return `/rpg/v1/campaigns/${encodeOpaquePathSegment(campaign)}/npcs/${encodeOpaquePathSegment(npc)}/companion-administration`;
}

/** Reads the strict owner/GM management projection for one path-owned companion. */
export async function getCompanionAdministration(campaignId: string, npcId: string): Promise<CompanionAdministrationHttpGetResponse> {
  const campaign = parseApiInput(() => resourceIdSchema.parse(campaignId));
  const npc = parseApiInput(() => resourceIdSchema.parse(npcId));
  const success = await requestResponse<unknown>(companionAdministrationLane(campaign, npc), { cache: "no-store" });
  requireStatus(success, 200, "Companion administration read");
  const response = companionAdministrationHttpGetResponseSchema.parse(success.body);
  if (response.companion.campaignId !== campaign || response.companion.npcId !== npc) {
    throw new Error("Companion administration response did not match the request");
  }
  return response;
}

/** Issues one companion administration command without automatic retry. */
export async function commandCompanionAdministration(campaignId: string, npcId: string,
  input: CompanionAdministrationHttpCommand): Promise<CompanionAdministrationHttpCommandResponse> {
  const body = parseApiInput(() => companionAdministrationHttpCommandSchema.parse(input));
  const success = await requestResponse<unknown>(`${companionAdministrationLane(campaignId, npcId)}/commands`, {
    method: "POST", cache: "no-store", body: JSON.stringify(body),
  });
  requireStatus(success, 200, "Companion administration command");
  const response = companionAdministrationHttpCommandResponseSchema.parse(success.body);
  if (response.receipt.kind !== body.kind || response.receipt.revisionBefore !== body.expectedRevision
    || response.receipt.revisionAfter !== body.expectedRevision + 1) {
    throw new Error("Companion administration receipt did not match the request");
  }
  return response;
}
export async function createCampaignNpc(campaignId: string, input: CreateCampaignNpcHttpRequest): Promise<ReturnType<typeof createCampaignNpcHttpResponseSchema.parse>> {
  const body=parseApiInput(()=>createCampaignNpcHttpRequestSchema.parse(input)); const success=await requestResponse<unknown>(campaignLane(campaignId,"npcs"),{method:"POST",cache:"no-store",body:JSON.stringify(body)}); requireStatus(success,201,"NPC creation");
  const response=createCampaignNpcHttpResponseSchema.parse(success.body); bindReceipt(response.receipt,body,"NPC creation");
  if(response.npc.personaId!==body.personaId||JSON.stringify(canonicalWireValue(response.npc.publicState))!==JSON.stringify(canonicalWireValue(body.publicState))||JSON.stringify(canonicalWireValue(response.npc.privateState))!==JSON.stringify(canonicalWireValue(body.privateState)))throw new Error("NPC creation response did not match the request"); return response;
}
export async function commandNpcRelationship(npcId:string,input:NpcRelationshipCommandHttpRequest):Promise<ReturnType<typeof npcRelationshipCommandHttpResponseSchema.parse>>{
  const id=parseApiInput(()=>resourceIdSchema.parse(npcId));const body=parseApiInput(()=>npcRelationshipCommandHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(resourceLane("npcs",id,"relationship-commands"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,200,"NPC relationship command");const response=npcRelationshipCommandHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"NPC relationship command");if(response.relationship.npcId!==id||response.relationship.subjectActorId!==body.subjectActorId)throw new Error("NPC relationship response did not match the request");return response;
}

export async function listCampaignFactions(campaignId:string,audience:"gm"|"player"):Promise<Revisioned<CampaignFactionsHttpResponse>>{const success=await requestResponse<unknown>(campaignLane(campaignId,"factions"),{cache:"no-store"});requireStatus(success,200,"Campaign faction read");const data=audience==="gm"?gmCampaignFactionsHttpResponseSchema.parse(success.body):playerCampaignFactionsHttpResponseSchema.parse(success.body);return{data,revision:revisionFrom(success.headers,"x-world-revision")};}
export async function createCampaignFaction(campaignId:string,input:CreateCampaignFactionHttpRequest):Promise<ReturnType<typeof createCampaignFactionHttpResponseSchema.parse>>{const body=parseApiInput(()=>createCampaignFactionHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(campaignLane(campaignId,"factions"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,201,"Faction creation");const response=createCampaignFactionHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"Faction creation");if(response.faction.name!==body.name||JSON.stringify(canonicalWireValue(response.faction.publicState))!==JSON.stringify(canonicalWireValue(body.publicState))||JSON.stringify(canonicalWireValue(response.faction.privateState))!==JSON.stringify(canonicalWireValue(body.privateState)))throw new Error("Faction creation response did not match the request");return response;}
export async function commandFactionReputation(factionId:string,input:FactionReputationCommandHttpRequest):Promise<ReturnType<typeof factionReputationCommandHttpResponseSchema.parse>>{const id=parseApiInput(()=>resourceIdSchema.parse(factionId));const body=parseApiInput(()=>factionReputationCommandHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(resourceLane("factions",id,"reputation-commands"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,200,"Faction reputation command");const response=factionReputationCommandHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"Faction reputation command");if(response.standing.factionId!==id||response.standing.subjectActorId!==body.subjectActorId)throw new Error("Faction reputation response did not match the request");return response;}

export async function listCampaignQuests(campaignId:string,audience:"gm"):Promise<Revisioned<GmCampaignQuestsHttpResponse>>;
export async function listCampaignQuests(campaignId:string,audience:"player"):Promise<Revisioned<PlayerCampaignQuestsHttpResponse>>;
export async function listCampaignQuests(campaignId:string,audience:"gm"|"player"):Promise<Revisioned<CampaignQuestsHttpResponse>>;
export async function listCampaignQuests(campaignId:string,audience:"gm"|"player"):Promise<Revisioned<CampaignQuestsHttpResponse>>{const validCampaignId=parseApiInput(()=>resourceIdSchema.parse(campaignId));const success=await requestResponse<unknown>(campaignLane(validCampaignId,"quests"),{cache:"no-store"});requireStatus(success,200,"Campaign quest read");const data=audience==="gm"?gmCampaignQuestsHttpResponseSchema.parse(success.body):playerCampaignQuestsHttpResponseSchema.parse(success.body);if(data.quests.some((quest)=>quest.campaignId!==validCampaignId))throw new Error("Campaign quest response did not match the request");return{data,revision:revisionFrom(success.headers,"x-quest-revision")};}
export async function createCampaignQuest(campaignId:string,input:CreateCampaignQuestHttpRequest):Promise<ReturnType<typeof createCampaignQuestHttpResponseSchema.parse>>{const body=parseApiInput(()=>createCampaignQuestHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(campaignLane(campaignId,"quests"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,201,"Quest creation");const response=createCampaignQuestHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"Quest creation");const createdObjectives=response.projection.objectives.filter((item)=>item.questId===body.quest.questId).map(({objectiveId,description,targetProgress,dependencyObjectiveIds})=>({objectiveId,description,targetProgress,dependencyObjectiveIds}));const expectedObjectives=body.quest.objectives.map(({objectiveId,description,targetProgress,dependencyObjectiveIds})=>({objectiveId,description,targetProgress,dependencyObjectiveIds}));const createdRewards=response.quest.rewards.map(({rewardId,kind,amount,label})=>({rewardId,kind,amount,label}));const expectedRewards=body.quest.rewards.map(({rewardId,kind,amount,label})=>({rewardId,kind,amount,label}));const journal=response.projection.journal.filter((item)=>item.questId===body.quest.questId);if(JSON.stringify(canonicalWireValue(response.definition))!==JSON.stringify(canonicalWireValue(body.quest))||response.quest.campaignId!==parseApiInput(()=>resourceIdSchema.parse(campaignId))||response.quest.questId!==body.quest.questId||response.quest.storylineId!==body.quest.storylineId||response.quest.title!==body.quest.title||response.quest.description!==body.quest.description||JSON.stringify(canonicalWireValue(createdObjectives))!==JSON.stringify(canonicalWireValue(expectedObjectives))||JSON.stringify(canonicalWireValue(createdRewards))!==JSON.stringify(canonicalWireValue(expectedRewards))||journal.length!==1||journal[0]?.text!==body.quest.journalText)throw new Error("Quest creation response did not match the complete submitted definition");return response;}
/** Advance-objective responses expose no objective outcome; callers must retain the receipt and require an authoritative quest-list refresh. */
export async function commandQuest(questId:string,input:QuestCommandHttpRequest):Promise<ReturnType<typeof questCommandHttpResponseSchema.parse>>{const id=parseApiInput(()=>resourceIdSchema.parse(questId));const body=parseApiInput(()=>questCommandHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(resourceLane("quests",id,"commands"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,200,"Quest command");const response=questCommandHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"Quest command");if(response.quest.questId!==id||(body.kind==="accept"&&response.quest.status!=="active")||(body.kind==="abandon"&&response.quest.status!=="abandoned")||(body.kind==="claim-reward"&&!response.quest.rewards.some((reward)=>reward.rewardId===body.rewardId&&reward.claimedByActorId===body.actorId)))throw new Error("Quest command response did not match the request");return response;}

export async function getCampaignStory(campaignId:string,audience:"gm"):Promise<Revisioned<GmCampaignStoryHttpResponse>>;
export async function getCampaignStory(campaignId:string,audience:"player"):Promise<Revisioned<PlayerCampaignStoryHttpResponse>>;
export async function getCampaignStory(campaignId:string,audience:"gm"|"player"):Promise<Revisioned<CampaignStoryHttpResponse>>;
export async function getCampaignStory(campaignId:string,audience:"gm"|"player"):Promise<Revisioned<CampaignStoryHttpResponse>>{const validCampaignId=parseApiInput(()=>resourceIdSchema.parse(campaignId));const success=await requestResponse<unknown>(campaignLane(validCampaignId,"story"),{cache:"no-store"});requireStatus(success,200,"Campaign story read");const data=audience==="gm"?gmCampaignStoryHttpResponseSchema.parse(success.body):playerCampaignStoryHttpResponseSchema.parse(success.body);if("storylines"in data&&data.storylines.some((storyline)=>storyline.campaignId!==validCampaignId))throw new Error("Campaign story response did not match the request");return{data,revision:revisionFrom(success.headers,"x-story-revision")};}
export async function createCampaignStoryline(campaignId:string,input:CreateCampaignStorylineHttpRequest):Promise<ReturnType<typeof createCampaignStorylineHttpResponseSchema.parse>>{const body=parseApiInput(()=>createCampaignStorylineHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(campaignLane(campaignId,"storylines"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,201,"Storyline creation");const response=createCampaignStorylineHttpResponseSchema.parse(success.body);bindReceipt(response.receipt,body,"Storyline creation");const storylineId=body.storyline.storylineId;const nodes=response.story.nodes.filter((item)=>item.storylineId===storylineId).map(({storylineId:_,status,createdAt,updatedAt,...item})=>item);const edges=response.story.edges.filter((item)=>item.storylineId===storylineId).map(({storylineId:_,...item})=>item);const plotPoints=response.story.plotPoints.filter((item)=>item.storylineId===storylineId).map(({storylineId:_,answered,playerAnswer,answeredAt,...item})=>item);const clues=response.story.clues.filter((item)=>item.storylineId===storylineId).map(({storylineId:_,revealed,revealedAt,...item})=>item);if(response.storyline.campaignId!==parseApiInput(()=>resourceIdSchema.parse(campaignId))||response.storyline.storylineId!==storylineId||response.storyline.title!==body.storyline.title||response.storyline.summary!==body.storyline.summary||JSON.stringify(canonicalWireValue(nodes))!==JSON.stringify(canonicalWireValue(body.storyline.nodes))||JSON.stringify(canonicalWireValue(edges))!==JSON.stringify(canonicalWireValue(body.storyline.edges))||JSON.stringify(canonicalWireValue(plotPoints))!==JSON.stringify(canonicalWireValue(body.storyline.plotPoints))||JSON.stringify(canonicalWireValue(clues))!==JSON.stringify(canonicalWireValue(body.storyline.clues)))throw new Error("Storyline creation response did not match the complete submitted graph");return response;}
export async function commandStoryline(storylineId:string,input:StorylineCommandHttpRequest):Promise<{story:GmCampaignStoryHttpResponse;receipt:ReturnType<typeof storylineCommandHttpResponseSchema.parse>["receipt"]}>{const id=parseApiInput(()=>resourceIdSchema.parse(storylineId));const body=parseApiInput(()=>storylineCommandHttpRequestSchema.parse(input));const success=await requestResponse<unknown>(resourceLane("storylines",id,"commands"),{method:"POST",cache:"no-store",body:JSON.stringify(body)});requireStatus(success,200,"Storyline command");const envelope=storylineCommandHttpResponseSchema.parse(success.body);const response={...envelope,story:gmCampaignStoryHttpResponseSchema.parse(envelope.story)};bindReceipt(response.receipt,body,"Storyline command");const story=response.story;const targetMatches=body.kind==="reveal-node"?story.nodes.some((node)=>node.storylineId===id&&node.nodeId===body.targetId&&node.status==="revealed"):body.kind==="resolve-node"?story.nodes.some((node)=>node.storylineId===id&&node.nodeId===body.targetId&&node.status==="resolved"):body.kind==="reveal-clue"?story.clues.some((clue)=>clue.storylineId===id&&clue.clueId===body.targetId&&clue.revealed):story.plotPoints.some((point)=>point.storylineId===id&&point.plotPointId===body.targetId&&point.answered&&point.playerAnswer===body.data.answer);if(!targetMatches)throw new Error("Storyline command response did not match the exact target");return response;}

/** Explicit GM-to-player previews pass through the public schemas and return newly allocated, secret-free structures. */
export function projectNpcsForPlayers(value:GmCampaignNpcsHttpResponse):PlayerCampaignNpcsHttpResponse{return playerCampaignNpcsHttpResponseSchema.parse({npcs:value.npcs.map(({npcId,publicState,createdAt})=>({npcId,publicState,createdAt})),relationships:value.relationships});}
export function projectFactionsForPlayers(value:GmCampaignFactionsHttpResponse):PlayerCampaignFactionsHttpResponse{return playerCampaignFactionsHttpResponseSchema.parse({factions:value.factions.filter((item)=>item.privateState.visibility!=="gm").map(({factionId,name,publicState,createdAt})=>({factionId,name,publicState,createdAt})),standings:value.standings.filter((standing)=>value.factions.some((item)=>item.factionId===standing.factionId&&item.privateState.visibility!=="gm"))});}
export function projectQuestsForPlayers(value:CampaignQuestsHttpResponse):ReturnType<typeof playerCampaignQuestsHttpResponseSchema.parse>{return playerCampaignQuestsHttpResponseSchema.parse({quests:value.quests.map((quest)=>{if("storylineId" in quest){const{storylineId:_,...playerQuest}=quest;return playerQuest;}return quest;}),objectives:value.objectives,journal:value.journal});}
export function projectStoryForPlayers(value:CampaignStoryHttpResponse):ReturnType<typeof playerCampaignStoryHttpResponseSchema.parse>{if("visibleNodes" in value)return playerCampaignStoryHttpResponseSchema.parse(value);return playerCampaignStoryHttpResponseSchema.parse({visibleNodes:value.nodes.filter((node)=>node.status!=="hidden").map((node)=>({nodeId:node.nodeId,title:node.title,description:node.description,status:node.status,updatedAt:node.updatedAt})),discoveredClues:value.clues.filter((clue)=>clue.revealed&&clue.revealedAt!==null).map((clue)=>({clueId:clue.clueId,title:clue.title,content:clue.content,discoveredAt:clue.revealedAt!}))});}

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
