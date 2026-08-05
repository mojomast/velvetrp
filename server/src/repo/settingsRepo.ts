import type DatabaseDriver from "better-sqlite3";
import {
  DEFAULT_SAMPLERS,
  clampInt,
  clampNullableInt,
  clampNullableNumber,
  clampText,
  defaultHarnessSettings,
  defaultProviderSettings,
  now,
  toPublicProvider,
} from "../defaults.js";
import { systemRuntime } from "../runtime.js";
import type { Clock } from "../runtime.js";
import type {
  HarnessSettings,
  ProviderSettings,
  PublicProviderSettings,
  SamplerSettings,
  UpdateHarnessInput,
  UpdateProviderInput,
} from "../types.js";
import { getRepositoryDatabase } from "./repoContext.js";

function readHarness(db: DatabaseDriver.Database): HarnessSettings {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 'harness'").get() as { payload: string } | undefined;
  if (!row) return defaultHarnessSettings();
  try {
    const parsed = JSON.parse(row.payload) as Partial<HarnessSettings>;
    return { ...defaultHarnessSettings(), ...parsed, promptOverrides: { ...(parsed.promptOverrides ?? {}) }, id: "harness" };
  } catch {
    return defaultHarnessSettings();
  }
}

export async function getHarnessSettings(): Promise<HarnessSettings> {
  return readHarness(getRepositoryDatabase());
}

/** Synchronous update path used by the Repository factory. */
export function updateHarnessSettingsSync(
  db: DatabaseDriver.Database,
  clock: Clock,
  patch: UpdateHarnessInput,
): HarnessSettings {
  const next: HarnessSettings = { ...readHarness(db) };
  if (patch.systemPrompt !== undefined) next.systemPrompt = clampText(patch.systemPrompt, 64_000);
  if (patch.personaPreamble !== undefined) next.personaPreamble = clampText(patch.personaPreamble, 500);
  if (patch.styleGuide !== undefined) next.styleGuide = clampText(patch.styleGuide, 900);
  if (patch.postHistoryInstructions !== undefined) next.postHistoryInstructions = clampText(patch.postHistoryInstructions, 700);
  if (patch.recentTurns !== undefined && Number.isFinite(patch.recentTurns)) next.recentTurns = clampInt(patch.recentTurns, 4, 32);
  if (patch.memoryChars !== undefined && Number.isFinite(patch.memoryChars)) next.memoryChars = clampInt(patch.memoryChars, 200, 3000);
  if (patch.summaryChars !== undefined && Number.isFinite(patch.summaryChars)) next.summaryChars = clampInt(patch.summaryChars, 200, 2000);
  if (patch.loreChars !== undefined && Number.isFinite(patch.loreChars)) next.loreChars = clampInt(patch.loreChars, 200, 2000);
  if (patch.temperature === null) next.temperature = null;
  if (typeof patch.temperature === "number" && Number.isFinite(patch.temperature)) {
    next.temperature = Math.max(0, Math.min(2, patch.temperature));
  }
  if (patch.promptOverrides !== undefined) {
    next.promptOverrides = Object.fromEntries(Object.entries(patch.promptOverrides)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([id, template]) => [id, template.slice(0, 64_000)]));
  }
  next.updatedAt = clock.now().toISOString();
  db.prepare(
    "INSERT INTO settings (id, payload) VALUES ('harness', ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
  ).run(JSON.stringify(next));
  return next;
}

export async function updateHarnessSettings(patch: UpdateHarnessInput): Promise<HarnessSettings> {
  return updateHarnessSettingsSync(getRepositoryDatabase(), systemRuntime.clock, patch);
}

function readProvider(db: DatabaseDriver.Database): ProviderSettings {
  const row = db.prepare("SELECT payload FROM provider WHERE id = 'provider'").get() as { payload: string } | undefined;
  if (!row) return defaultProviderSettings();
  try {
    const parsed = JSON.parse(row.payload) as Partial<ProviderSettings>;
    return {
      ...defaultProviderSettings(),
      ...parsed,
      id: "provider",
      pricing: { ...defaultProviderSettings().pricing, ...(parsed.pricing ?? {}) },
      samplers: { ...DEFAULT_SAMPLERS, ...(parsed.samplers ?? {}) },
    };
  } catch {
    return defaultProviderSettings();
  }
}

export async function getProviderSettings(): Promise<ProviderSettings> {
  return readProvider(getRepositoryDatabase());
}

export async function getPublicProviderSettings(): Promise<PublicProviderSettings> {
  return toPublicProvider(await getProviderSettings());
}

export async function updateProviderSettings(patch: UpdateProviderInput): Promise<PublicProviderSettings> {
  const db = getRepositoryDatabase();
  const current = readProvider(db);
  const next: ProviderSettings = {
    ...current,
    pricing: { ...current.pricing, ...(patch.pricing ?? {}) },
    samplers: { ...current.samplers, ...(patch.samplers ?? {}) } as SamplerSettings,
  };
  if (patch.providerType !== undefined) next.providerType = patch.providerType;
  if (patch.baseUrl !== undefined) next.baseUrl = clampText(patch.baseUrl, 300);
  if (patch.model !== undefined) next.model = clampText(patch.model, 120);
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim().slice(0, 300);
  if (patch.streaming !== undefined) next.streaming = patch.streaming;
  if (patch.httpReferer !== undefined) next.httpReferer = clampText(patch.httpReferer, 300);
  if (patch.appTitle !== undefined) next.appTitle = clampText(patch.appTitle, 120);
  if (patch.requireParameters !== undefined) next.requireParameters = patch.requireParameters;
  if (patch.allowFallbacks !== undefined) next.allowFallbacks = patch.allowFallbacks;
  if (patch.routingSort !== undefined && ["default", "price", "throughput", "latency"].includes(patch.routingSort)) next.routingSort = patch.routingSort;
  if (patch.dataCollection !== undefined && ["default", "allow", "deny"].includes(patch.dataCollection)) next.dataCollection = patch.dataCollection;
  if (patch.zdr !== undefined) next.zdr = patch.zdr;
  if (patch.requestTimeoutSeconds !== undefined && Number.isFinite(patch.requestTimeoutSeconds)) next.requestTimeoutSeconds = clampInt(patch.requestTimeoutSeconds, 15, 300);
  if (patch.pricing) {
    if (patch.pricing.promptPerMillion === null) next.pricing.promptPerMillion = null;
    if (typeof patch.pricing.promptPerMillion === "number" && Number.isFinite(patch.pricing.promptPerMillion)) next.pricing.promptPerMillion = Math.max(0, Math.min(1_000_000, patch.pricing.promptPerMillion));
    if (patch.pricing.completionPerMillion === null) next.pricing.completionPerMillion = null;
    if (typeof patch.pricing.completionPerMillion === "number" && Number.isFinite(patch.pricing.completionPerMillion)) next.pricing.completionPerMillion = Math.max(0, Math.min(1_000_000, patch.pricing.completionPerMillion));
  }
  if (patch.samplers) {
    if (patch.samplers.maxTokens !== undefined) next.samplers.maxTokens = clampNullableInt(patch.samplers.maxTokens, 1, 32768);
    if (patch.samplers.topP !== undefined) next.samplers.topP = clampNullableNumber(patch.samplers.topP, 0, 1);
    if (patch.samplers.topK !== undefined) next.samplers.topK = clampNullableInt(patch.samplers.topK, 0, 500);
    if (patch.samplers.minP !== undefined) next.samplers.minP = clampNullableNumber(patch.samplers.minP, 0, 1);
    if (patch.samplers.repetitionPenalty !== undefined)
      next.samplers.repetitionPenalty = clampNullableNumber(patch.samplers.repetitionPenalty, 0.01, 2);
    if (patch.samplers.frequencyPenalty !== undefined)
      next.samplers.frequencyPenalty = clampNullableNumber(patch.samplers.frequencyPenalty, -2, 2);
    if (patch.samplers.presencePenalty !== undefined)
      next.samplers.presencePenalty = clampNullableNumber(patch.samplers.presencePenalty, -2, 2);
    if (patch.samplers.seed !== undefined)
      next.samplers.seed = clampNullableInt(patch.samplers.seed, -2147483648, 2147483647);
    if (patch.samplers.reasoningEffort !== undefined && [null, "none", "high", "xhigh"].includes(patch.samplers.reasoningEffort))
      next.samplers.reasoningEffort = patch.samplers.reasoningEffort;
    if (patch.samplers.stopStrings !== undefined) {
      next.samplers.stopStrings = patch.samplers.stopStrings
        .map((stop) => clampText(stop, 80))
        .filter((stop) => stop.length > 0)
        .slice(0, 12);
    }
    if (patch.samplers.startReplyWith !== undefined) next.samplers.startReplyWith = clampText(patch.samplers.startReplyWith, 200);
  }
  next.updatedAt = now();
  db.prepare(
    "INSERT INTO provider (id, payload) VALUES ('provider', ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
  ).run(JSON.stringify(next));
  return toPublicProvider(next);
}
