import type { HarnessSettings, ProviderSettings, PublicProviderSettings, SamplerSettings } from "./types.js";

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
    samplers: { ...DEFAULT_SAMPLERS },
    updatedAt,
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
    samplers: provider.samplers,
    updatedAt: provider.updatedAt,
  };
}
