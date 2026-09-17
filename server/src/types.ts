import type { PersonaProfile } from "@velvet/contracts";

export interface Character {
  id: string;
  name: string;
  age: number;
  archetype: string;
  boundaries: string;
  profile?: PersonaProfile;
  fictionalConfirmed: boolean;
  isRealPerson: boolean;
  createdAt: string;
}

export interface CreateCharacterInput {
  name: string;
  age: number;
  archetype: string;
  boundaries: string;
  profile?: PersonaProfile;
  fictionalConfirmed: boolean;
}

export type {
  AddCampaignMembershipInput,
  ApplyCampaignImportInput,
  ActorResource,
  AttachCampaignSessionInput,
  Campaign,
  CampaignAdministration,
  CampaignAdministrationPatch,
  CampaignAdministrationReceipt,
  CampaignCheckpoint,
  CampaignExportManifest,
  CampaignImportDryRun,
  CampaignLifecycleStatus,
  CampaignMembershipMutation,
  CampaignMembershipRoleMutation,
  CampaignRecap,
  CampaignRevisionMutation,
  CampaignRoomMutation,
  CampaignSettings,
  CampaignTimelineHistory,
  CampaignTransferPackage,
  CampaignAccess,
  CampaignContentConfiguration,
  CampaignDetail,
  CampaignMembership,
  CampaignMembershipRead,
  CampaignRenameRequest,
  CampaignCharacterRead,
  CampaignCharacterCreationOptionsResponse,
  CampaignSessionAttachment,
  CampaignTimeline,
  CommandEnvelope,
  CommandReceipt,
  ContentPack,
  ContentPackIdentifier,
  ContentPublicationManifest,
  CatalogDefinition,
  CatalogDefinitionReference,
  CatalogValidationReport,
  CampaignCatalogResolutionReport,
  CampaignCatalogReceipt,
  CampaignCatalogConfigurationResult,
  ConfigureCampaignCatalogInput,
  ConfigureCampaignContentInput,
  CreateCampaignCharacterInput,
  CreateCampaignInput,
  CreateCampaignCheckpointInput,
  CreateCampaignExportInput,
  CreateCampaignRecapInput,
  DetachCampaignSessionInput,
  DefinitionReference,
  InstallContentPackInput,
  OwnerCatalogProjection,
  PlayerCatalogProjection,
  GmCatalogProjection,
  ObserverCatalogProjection,
  PublicationSummary,
  PublishContentCatalogInput,
  ForkCampaignTimelineInput,
  PrivilegedCampaignCharacterProjection,
  RenameCampaignInput,
  RpgEvent,
  RpgDefinition,
  RulesProfile,
  RulesProfileIdentifier,
  CharacterBuilderAllocation,
  CharacterBuilderAllocationRequest,
  CharacterBuilderAttributeScores,
  CharacterDerivedCalculatorInput,
  CharacterDerivedStats,
  CharacterDraftFinalizationResult,
  CharacterDraftMutationReceipt,
  CharacterDraftMutationResult,
  CharacterDraftView,
  CharacterFinalizationReceipt,
  CharacterStartingGrant,
  CreateCharacterDraftInput,
  UpdateCharacterDraftInput,
  FinalizeCharacterDraftInput,
} from "@velvet/contracts";

export type SceneState = "setup" | "active" | "paused" | "cooldown" | "closed";

export interface ConsentEvent {
  id: string;
  at: string;
  scope: string;
  granted: boolean;
  note: string;
}

export interface Session {
  id: string;
  /** Backward-compatible alias for primaryCharacterId. */
  characterId: string;
  primaryCharacterId: string;
  participants: Character[];
  title: string;
  state: SceneState;
  presetId: string;
  consentLog: ConsentEvent[];
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

export interface CreateSessionInput {
  characterId?: string;
  characterIds?: string[];
  primaryCharacterId?: string;
  title?: string;
  presetId?: string;
}

export type MessageRole = "system" | "user" | "character";

export type MessageStatus = "final" | "aborted";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
  model: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  speakerCharacterId: string | null;
  content: string;
  parentId: string | null;
  swipeGroupId: string | null;
  swipeIndex: number;
  seq: number;
  status: MessageStatus;
  createdAt: string;
  usage?: TokenUsage | null;
}

export interface AddMessageOptions {
  speakerCharacterId?: string | null;
  parentId?: string | null;
  swipeGroupId?: string | null;
  swipeIndex?: number;
  status?: MessageStatus;
  usage?: TokenUsage | null;
}

export interface PostMessageInput {
  content: string;
  speakerCharacterId?: string;
}

export interface RoomTurnInput {
  content: string;
  maxSpeakers?: number;
}

export interface RoomContinueInput {
  maxSpeakers?: number;
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

export interface NewMemoryFact {
  kind: MemoryKind;
  content: string;
  sourceTurnId: string;
  userApproved: boolean;
}

export interface EpisodeSummary {
  sessionId: string;
  summary: string;
  keyEvents: string[];
  emotionalBeat: string;
  updatedAt: string;
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

export interface NewLoreEntry {
  characterId?: string | null;
  characterIds?: string[];
  keys: string[];
  content: string;
  enabled: boolean;
  insertionOrder: number;
}

export type { RoleplayFeatureFlags as FeatureFlags } from "@velvet/contracts";

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

export interface UpdateHarnessInput {
  systemPrompt?: string;
  personaPreamble?: string;
  styleGuide?: string;
  postHistoryInstructions?: string;
  recentTurns?: number;
  memoryChars?: number;
  summaryChars?: number;
  loreChars?: number;
  temperature?: number | null;
  promptOverrides?: Record<string, string>;
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
  apiKey: string;
  streaming: boolean;
  httpReferer: string;
  appTitle: string;
  requireParameters: boolean;
  allowFallbacks: boolean;
  routingSort: "default" | "price" | "throughput" | "latency";
  dataCollection: "default" | "allow" | "deny";
  zdr: boolean;
  requestTimeoutSeconds: number;
  pricing: ProviderPricing;
  adventureTurnBudget: AdventureTurnBudgetSettings;
  samplers: SamplerSettings;
  updatedAt: string;
}

export interface PublicProviderSettings {
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
  pricing: ProviderPricing;
  adventureTurnBudget: AdventureTurnBudgetSettings;
  samplers: SamplerSettings;
  updatedAt: string;
}

export interface UpdateProviderInput {
  providerType?: ProviderType;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  streaming?: boolean;
  httpReferer?: string;
  appTitle?: string;
  requireParameters?: boolean;
  allowFallbacks?: boolean;
  routingSort?: "default" | "price" | "throughput" | "latency";
  dataCollection?: "default" | "allow" | "deny";
  zdr?: boolean;
  requestTimeoutSeconds?: number;
  pricing?: Partial<ProviderPricing>;
  adventureTurnBudget?: Partial<AdventureTurnBudgetSettings>;
  samplers?: Partial<SamplerSettings>;
}

export interface AdventureTurnBudgetSettings {
  maxTotalTokens: number;
  maxEstimatedCostUsd: number | null;
}

export interface ProviderPricing {
  promptPerMillion: number | null;
  completionPerMillion: number | null;
}

/** The fixed set of Jev/System One decision lanes that may carry confidence thresholds. */
export const SYSTEM_ONE_LANES = [
  "director-selection",
  "adventure-selection",
  "narration-verification",
  "memory-reranking",
  "speaker-routing",
  "guardrails",
  "cost-router",
] as const;

export type SystemOneLane = (typeof SYSTEM_ONE_LANES)[number];

/** Confidence bands that convert a Jev answer into act/confirm/fallback. */
export interface SystemOneConfidenceThresholds {
  /** Minimum confidence (or noul probability) to act on the selection. */
  actionThreshold: number;
  /** Minimum confidence to hold for review; below this the deterministic fallback runs. */
  reviewThreshold: number;
}

export interface SystemOneBudgetSettings {
  maxTotalTokens: number;
  maxEstimatedCostUsd: number | null;
  maxRequestsPerWindow: number;
  rateWindowMs: number;
}

/** The independent System One provider profile; never shares the OpenAI-compatible row. */
export interface SystemOneSettings {
  id: "system-one";
  providerType: "system-one";
  enabled: boolean;
  /** When true, decisions are recorded for comparison but never change behavior. */
  shadow: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  requestTimeoutSeconds: number;
  pricing: ProviderPricing;
  budget: SystemOneBudgetSettings;
  confidencePolicy: Record<SystemOneLane, SystemOneConfidenceThresholds>;
  updatedAt: string;
}

export interface PublicSystemOneSettings {
  id: "system-one";
  providerType: "system-one";
  enabled: boolean;
  shadow: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  requestTimeoutSeconds: number;
  pricing: ProviderPricing;
  budget: SystemOneBudgetSettings;
  confidencePolicy: Record<SystemOneLane, SystemOneConfidenceThresholds>;
  updatedAt: string;
}

export interface UpdateSystemOneInput {
  enabled?: boolean;
  shadow?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  requestTimeoutSeconds?: number;
  pricing?: Partial<ProviderPricing>;
  budget?: Partial<SystemOneBudgetSettings>;
  confidencePolicy?: Partial<Record<SystemOneLane, Partial<SystemOneConfidenceThresholds>>>;
}

export interface UsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerMeasuredTokens: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  pricing: ProviderPricing;
  byKind: Array<{ kind: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number | null }>;
  byModel: Array<{ model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number | null }>;
  bySession: Array<{ sessionId: string; title: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number | null }>;
}

export interface PolicyResult {
  allowed: boolean;
  violations: string[];
}

export interface Database {
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  memories: MemoryFact[];
  summaries: EpisodeSummary[];
  lore: LoreEntry[];
  settings: HarnessSettings;
  provider: ProviderSettings;
}
