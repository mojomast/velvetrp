import type DatabaseDriver from "better-sqlite3";
import {
  DEFAULT_SAMPLERS,
  DEFAULT_SYSTEM_ONE_LANE_MODE,
  clampInt,
  clampNullableInt,
  clampNullableNumber,
  clampText,
  defaultHarnessSettings,
  defaultProviderSettings,
  defaultSystemOneSettings,
  isSystemOneLaneMode,
  now,
  toPublicProvider,
  toPublicSystemOne,
} from "../defaults.js";
import { SYSTEM_ONE_LANES } from "../types.js";
import type { SystemOneLaneMode } from "../types.js";
import { systemRuntime } from "../runtime.js";
import type { Clock } from "../runtime.js";
import type {
  HarnessSettings,
  ProviderSettings,
  PublicProviderSettings,
  PublicSystemOneSettings,
  SamplerSettings,
  SystemOneSettings,
  UpdateHarnessInput,
  UpdateProviderInput,
  UpdateSystemOneInput,
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
      adventureTurnBudget: { ...defaultProviderSettings().adventureTurnBudget, ...(parsed.adventureTurnBudget ?? {}) },
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
    adventureTurnBudget: { ...current.adventureTurnBudget, ...(patch.adventureTurnBudget ?? {}) },
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
  if (patch.adventureTurnBudget) {
    if (typeof patch.adventureTurnBudget.maxTotalTokens === "number" && Number.isFinite(patch.adventureTurnBudget.maxTotalTokens)) {
      next.adventureTurnBudget.maxTotalTokens = clampInt(patch.adventureTurnBudget.maxTotalTokens, 1, 1_000_000_000);
    }
    if (patch.adventureTurnBudget.maxEstimatedCostUsd === null) next.adventureTurnBudget.maxEstimatedCostUsd = null;
    if (typeof patch.adventureTurnBudget.maxEstimatedCostUsd === "number" && Number.isFinite(patch.adventureTurnBudget.maxEstimatedCostUsd)) {
      next.adventureTurnBudget.maxEstimatedCostUsd = Math.max(0, Math.min(1_000_000, patch.adventureTurnBudget.maxEstimatedCostUsd));
    }
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

/**
 * Resolves a lane mode, migrating the legacy boolean `shadow` field: `true` mapped to
 * record-only `shadow`, `false` to `active` (acting still requires a promotion record). A
 * missing or malformed value falls back to the safe record-only default.
 */
function migrateSystemOneLaneMode(value: unknown, legacyShadow: unknown): SystemOneLaneMode {
  if (isSystemOneLaneMode(value)) return value;
  if (typeof legacyShadow === "boolean") return legacyShadow ? "shadow" : "active";
  return DEFAULT_SYSTEM_ONE_LANE_MODE;
}

export function readSystemOne(db: DatabaseDriver.Database): SystemOneSettings {
  const row = db.prepare("SELECT payload FROM provider WHERE id = 'system-one'").get() as { payload: string } | undefined;
  const defaults = defaultSystemOneSettings();
  if (!row) return defaults;
  try {
    const parsed = JSON.parse(row.payload) as Partial<SystemOneSettings> & { shadow?: unknown };
    const { shadow: legacyShadow, ...rest } = parsed;
    return {
      ...defaults,
      ...rest,
      id: "system-one",
      providerType: "system-one",
      laneModes: Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [
        lane,
        migrateSystemOneLaneMode(parsed.laneModes?.[lane], legacyShadow),
      ])) as SystemOneSettings["laneModes"],
      pricing: { ...defaults.pricing, ...(parsed.pricing ?? {}) },
      budget: { ...defaults.budget, ...(parsed.budget ?? {}) },
      confidencePolicy: Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [
        lane,
        { ...defaults.confidencePolicy[lane], ...(parsed.confidencePolicy?.[lane] ?? {}) },
      ])) as SystemOneSettings["confidencePolicy"],
      confidenceCalibration: Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [
        lane,
        { ...defaults.confidenceCalibration[lane], ...(parsed.confidenceCalibration?.[lane] ?? {}) },
      ])) as SystemOneSettings["confidenceCalibration"],
    };
  } catch {
    return defaults;
  }
}

export async function getSystemOneSettings(): Promise<SystemOneSettings> {
  return readSystemOne(getRepositoryDatabase());
}

export async function getPublicSystemOneSettings(): Promise<PublicSystemOneSettings> {
  return toPublicSystemOne(await getSystemOneSettings());
}

export async function updateSystemOneSettings(patch: UpdateSystemOneInput): Promise<PublicSystemOneSettings> {
  const db = getRepositoryDatabase();
  const current = readSystemOne(db);
  const next: SystemOneSettings = {
    ...current,
    pricing: { ...current.pricing, ...(patch.pricing ?? {}) },
    budget: { ...current.budget, ...(patch.budget ?? {}) },
    confidencePolicy: Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [
      lane,
      { ...current.confidencePolicy[lane], ...(patch.confidencePolicy?.[lane] ?? {}) },
    ])) as SystemOneSettings["confidencePolicy"],
    confidenceCalibration: Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [
      lane,
      { ...current.confidenceCalibration[lane], ...(patch.confidenceCalibration?.[lane] ?? {}) },
    ])) as SystemOneSettings["confidenceCalibration"],
  };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.laneModes) {
    next.laneModes = Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => {
      const requested = patch.laneModes?.[lane];
      return [lane, isSystemOneLaneMode(requested) ? requested : next.laneModes[lane]];
    })) as SystemOneSettings["laneModes"];
  }
  if (patch.baseUrl !== undefined) next.baseUrl = clampText(patch.baseUrl, 300);
  if (patch.model !== undefined) next.model = clampText(patch.model, 120);
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim().slice(0, 300);
  if (patch.requestTimeoutSeconds !== undefined && Number.isFinite(patch.requestTimeoutSeconds)) {
    next.requestTimeoutSeconds = clampInt(patch.requestTimeoutSeconds, 5, 120);
  }
  if (patch.pricing) {
    if (patch.pricing.promptPerMillion === null) next.pricing.promptPerMillion = null;
    if (typeof patch.pricing.promptPerMillion === "number" && Number.isFinite(patch.pricing.promptPerMillion)) {
      next.pricing.promptPerMillion = Math.max(0, Math.min(1_000_000, patch.pricing.promptPerMillion));
    }
    if (patch.pricing.completionPerMillion === null) next.pricing.completionPerMillion = null;
    if (typeof patch.pricing.completionPerMillion === "number" && Number.isFinite(patch.pricing.completionPerMillion)) {
      next.pricing.completionPerMillion = Math.max(0, Math.min(1_000_000, patch.pricing.completionPerMillion));
    }
  }
  if (patch.budget) {
    if (typeof patch.budget.maxTotalTokens === "number" && Number.isFinite(patch.budget.maxTotalTokens)) {
      next.budget.maxTotalTokens = clampInt(patch.budget.maxTotalTokens, 1, 1_000_000_000);
    }
    if (patch.budget.maxEstimatedCostUsd === null) next.budget.maxEstimatedCostUsd = null;
    if (typeof patch.budget.maxEstimatedCostUsd === "number" && Number.isFinite(patch.budget.maxEstimatedCostUsd)) {
      next.budget.maxEstimatedCostUsd = Math.max(0, Math.min(1_000_000, patch.budget.maxEstimatedCostUsd));
    }
    if (typeof patch.budget.maxRequestsPerWindow === "number" && Number.isFinite(patch.budget.maxRequestsPerWindow)) {
      next.budget.maxRequestsPerWindow = clampInt(patch.budget.maxRequestsPerWindow, 1, 100_000);
    }
    if (typeof patch.budget.rateWindowMs === "number" && Number.isFinite(patch.budget.rateWindowMs)) {
      next.budget.rateWindowMs = clampInt(patch.budget.rateWindowMs, 1_000, 3_600_000);
    }
  }
  if (patch.confidencePolicy) {
    next.confidencePolicy = Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => {
      const thresholds = next.confidencePolicy[lane];
      const action = clampNullableNumber(thresholds.actionThreshold, 0, 1) ?? 0;
      const review = clampNullableNumber(thresholds.reviewThreshold, 0, 1) ?? 0;
      return [lane, { actionThreshold: action, reviewThreshold: Math.min(review, action) }];
    })) as SystemOneSettings["confidencePolicy"];
  }
  if (patch.confidenceCalibration) {
    next.confidenceCalibration = Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => {
      const calibration = next.confidenceCalibration[lane];
      const a = clampNullableNumber(calibration.a, 0, 1_000) ?? 1;
      const b = clampNullableNumber(calibration.b, -1_000, 1_000) ?? 0;
      return [lane, { a, b }];
    })) as SystemOneSettings["confidenceCalibration"];
  }
  next.updatedAt = now();
  db.prepare(
    "INSERT INTO provider (id, payload) VALUES ('system-one', ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
  ).run(JSON.stringify(next));
  return toPublicSystemOne(next);
}
