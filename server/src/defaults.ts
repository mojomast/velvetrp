import type {
  HarnessSettings,
  ProviderSettings,
  PublicProviderSettings,
  PublicSystemOneSettings,
  SamplerSettings,
  SystemOneAdventurePayloadVariant,
  SystemOneCalibration,
  SystemOneConfidenceThresholds,
  SystemOneLane,
  SystemOneLaneMode,
  SystemOneSettings,
} from "./types.js";
import { SYSTEM_ONE_ADVENTURE_PAYLOAD_VARIANTS, SYSTEM_ONE_LANES } from "./types.js";

/** Safe default: a lane records its would-be decision but never changes behavior. */
export const DEFAULT_SYSTEM_ONE_LANE_MODE: SystemOneLaneMode = "shadow";

/** Whether an arbitrary value is a valid lane mode. */
export function isSystemOneLaneMode(value: unknown): value is SystemOneLaneMode {
  return value === "off" || value === "shadow" || value === "active";
}

export function defaultSystemOneLaneModes(): Record<SystemOneLane, SystemOneLaneMode> {
  return Object.fromEntries(
    SYSTEM_ONE_LANES.map((lane) => [lane, DEFAULT_SYSTEM_ONE_LANE_MODE]),
  ) as Record<SystemOneLane, SystemOneLaneMode>;
}

/** The effective mode for a lane, defaulting to shadow for any missing or malformed value. */
export function systemOneLaneMode(settings: SystemOneSettings, lane: SystemOneLane): SystemOneLaneMode {
  const mode = settings.laneModes?.[lane];
  return isSystemOneLaneMode(mode) ? mode : DEFAULT_SYSTEM_ONE_LANE_MODE;
}

/** The safe evaluation default: the production battery, never the experimental payload. */
export const DEFAULT_SYSTEM_ONE_ADVENTURE_PAYLOAD: SystemOneAdventurePayloadVariant = "legacy";

/** Whether an arbitrary value is a valid adventure-selection shadow payload variant. */
export function isSystemOneAdventurePayloadVariant(value: unknown): value is SystemOneAdventurePayloadVariant {
  return typeof value === "string" && (SYSTEM_ONE_ADVENTURE_PAYLOAD_VARIANTS as readonly string[]).includes(value);
}

/**
 * The effective adventure-selection shadow payload, defaulting to the production legacy battery
 * for any missing or malformed value. It selects only what the advisory shadow lane composes and
 * records; it never changes provider planning and never grants commit authority.
 */
export function systemOneAdventurePayload(settings: SystemOneSettings): SystemOneAdventurePayloadVariant {
  return isSystemOneAdventurePayloadVariant(settings.shadowAdventurePayload)
    ? settings.shadowAdventurePayload
    : DEFAULT_SYSTEM_ONE_ADVENTURE_PAYLOAD;
}

export function now(): string {
  return new Date().toISOString();
}

export function defaultHarnessSettings(updatedAt = now()): HarnessSettings {
  return {
    id: "harness",
    systemPrompt: "",
    personaPreamble: "",
    styleGuide: "",
    postHistoryInstructions: "",
    recentTurns: 32,
    memoryChars: 2400,
    summaryChars: 1600,
    loreChars: 1600,
    temperature: 0.8,
    promptOverrides: {},
    updatedAt,
  };
}

export const DEFAULT_SAMPLERS: SamplerSettings = {
  maxTokens: null,
  topP: null,
  topK: null,
  minP: null,
  repetitionPenalty: null,
  frequencyPenalty: null,
  presencePenalty: null,
  seed: null,
  reasoningEffort: null,
  stopStrings: [],
  startReplyWith: "",
};

export function defaultProviderSettings(updatedAt = now()): ProviderSettings {
  return {
    id: "provider",
    providerType: "openai-compatible",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    streaming: false,
    httpReferer: process.env.OPENROUTER_HTTP_REFERER ?? "",
    appTitle: process.env.OPENROUTER_APP_TITLE ?? "Velvet",
    requireParameters: false,
    allowFallbacks: true,
    routingSort: "default",
    dataCollection: "default",
    zdr: false,
    requestTimeoutSeconds: 90,
    pricing: { promptPerMillion: null, completionPerMillion: null },
    adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null },
    samplers: { ...DEFAULT_SAMPLERS },
    updatedAt,
  };
}

/** Conservative starting thresholds; every lane begins at confirm-or-fallback. */
export const DEFAULT_SYSTEM_ONE_THRESHOLDS: SystemOneConfidenceThresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

export function defaultSystemOneConfidencePolicy(): Record<SystemOneLane, SystemOneConfidenceThresholds> {
  return Object.fromEntries(
    SYSTEM_ONE_LANES.map((lane) => [lane, { ...DEFAULT_SYSTEM_ONE_THRESHOLDS }]),
  ) as Record<SystemOneLane, SystemOneConfidenceThresholds>;
}

/** The identity calibration: a lane reports its raw confidence until a fitted map is applied. */
export const DEFAULT_SYSTEM_ONE_CALIBRATION: SystemOneCalibration = { a: 1, b: 0 };

export function defaultSystemOneConfidenceCalibration(): Record<SystemOneLane, SystemOneCalibration> {
  return Object.fromEntries(
    SYSTEM_ONE_LANES.map((lane) => [lane, { ...DEFAULT_SYSTEM_ONE_CALIBRATION }]),
  ) as Record<SystemOneLane, SystemOneCalibration>;
}

export function defaultSystemOneSettings(updatedAt = now()): SystemOneSettings {
  return {
    id: "system-one",
    providerType: "system-one",
    enabled: false,
    laneModes: defaultSystemOneLaneModes(),
    shadowAdventurePayload: DEFAULT_SYSTEM_ONE_ADVENTURE_PAYLOAD,
    baseUrl: process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1",
    model: process.env.TYPESAFE_MODEL ?? "jev-latest",
    apiKey: process.env.TYPESAFE_API_KEY ?? "",
    requestTimeoutSeconds: 30,
    pricing: { promptPerMillion: 0.042, completionPerMillion: 0 },
    budget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null, maxRequestsPerWindow: 60, rateWindowMs: 60_000 },
    confidencePolicy: defaultSystemOneConfidencePolicy(),
    confidenceCalibration: defaultSystemOneConfidenceCalibration(),
    updatedAt,
  };
}

export function toPublicSystemOne(settings: SystemOneSettings): PublicSystemOneSettings {
  return {
    id: "system-one",
    providerType: "system-one",
    enabled: settings.enabled,
    laneModes: settings.laneModes,
    shadowAdventurePayload: settings.shadowAdventurePayload,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: settings.apiKey.length > 0,
    requestTimeoutSeconds: settings.requestTimeoutSeconds,
    pricing: settings.pricing,
    budget: settings.budget,
    confidencePolicy: settings.confidencePolicy,
    confidenceCalibration: settings.confidenceCalibration,
    updatedAt: settings.updatedAt,
  };
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function clampNullableInt(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return clampInt(value, min, max);
}

export function clampNullableNumber(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return Math.max(min, Math.min(max, value));
}

export function clampText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export function toPublicProvider(provider: ProviderSettings): PublicProviderSettings {
  return {
    id: "provider",
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    model: provider.model,
    hasApiKey: provider.apiKey.length > 0,
    streaming: provider.streaming,
    httpReferer: provider.httpReferer,
    appTitle: provider.appTitle,
    requireParameters: provider.requireParameters,
    allowFallbacks: provider.allowFallbacks,
    routingSort: provider.routingSort,
    dataCollection: provider.dataCollection,
    zdr: provider.zdr,
    requestTimeoutSeconds: provider.requestTimeoutSeconds,
    pricing: provider.pricing,
    adventureTurnBudget: provider.adventureTurnBudget,
    samplers: provider.samplers,
    updatedAt: provider.updatedAt,
  };
}
