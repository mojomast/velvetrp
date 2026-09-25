import { createHash } from "node:crypto";

/**
 * Scene-image settings: a strict shape with defaults, workflow presets, a
 * stable cache key, and the pure limit/cooldown math used by the automatic
 * path.
 *
 * This module is pure and offline: it never calls a provider, reads storage,
 * reads the clock, or imports a tokenizer. Bounds mirror
 * `imageGenerationRequestSchema` in @velvet/contracts (steps 10–100, guidance
 * 1–8, seed within a signed 32-bit range) so validated settings can be handed
 * to the transport adapter without translation. The plan-level count limit is
 * deliberately larger than the per-request image limit because a confirmed
 * grid is chunked by the caller.
 */

/** How the image path participates in a turn. */
export const SCENE_IMAGE_MODES = ["off", "manual", "automatic"] as const;
export type SceneImageMode = (typeof SCENE_IMAGE_MODES)[number];

/** Whether seeds are sampled per image or pinned to `fixedSeed`. */
export const SCENE_IMAGE_SEED_MODES = ["random", "fixed"] as const;
export type SceneImageSeedMode = (typeof SCENE_IMAGE_SEED_MODES)[number];

/** How much image data a client is willing to receive. */
export const SCENE_IMAGE_BANDWIDTHS = ["full", "reduced", "text-only"] as const;
export type SceneImageBandwidth = (typeof SCENE_IMAGE_BANDWIDTHS)[number];

export const SCENE_IMAGE_STEPS_MIN = 10;
export const SCENE_IMAGE_STEPS_MAX = 100;
export const SCENE_IMAGE_GUIDANCE_MIN = 1;
export const SCENE_IMAGE_GUIDANCE_MAX = 8;
export const SCENE_IMAGE_VARIATION_MIN = 1;
export const SCENE_IMAGE_VARIATION_MAX = 32;
export const SCENE_IMAGE_AUTO_SESSION_LIMIT_MIN = 0;
export const SCENE_IMAGE_AUTO_SESSION_LIMIT_MAX = 32;
export const SCENE_IMAGE_COOLDOWN_MIN_SECONDS = 0;
export const SCENE_IMAGE_COOLDOWN_MAX_SECONDS = 3_600;

/** Lowest accepted seed, matching the provider contract. */
export const SCENE_IMAGE_MIN_SEED = 0;
/** Highest accepted seed, matching the provider contract's signed 32-bit limit. */
export const SCENE_IMAGE_MAX_SEED = 2_147_483_647;

export const SCENE_IMAGE_STEPS_BOUNDS = { min: SCENE_IMAGE_STEPS_MIN, max: SCENE_IMAGE_STEPS_MAX } as const;
export const SCENE_IMAGE_GUIDANCE_BOUNDS = { min: SCENE_IMAGE_GUIDANCE_MIN, max: SCENE_IMAGE_GUIDANCE_MAX } as const;
export const SCENE_IMAGE_VARIATION_BOUNDS = { min: SCENE_IMAGE_VARIATION_MIN, max: SCENE_IMAGE_VARIATION_MAX } as const;
export const SCENE_IMAGE_AUTO_SESSION_LIMIT_BOUNDS = {
  min: SCENE_IMAGE_AUTO_SESSION_LIMIT_MIN,
  max: SCENE_IMAGE_AUTO_SESSION_LIMIT_MAX,
} as const;
export const SCENE_IMAGE_COOLDOWN_BOUNDS_SECONDS = {
  min: SCENE_IMAGE_COOLDOWN_MIN_SECONDS,
  max: SCENE_IMAGE_COOLDOWN_MAX_SECONDS,
} as const;

export const SCENE_IMAGE_STYLE_PRESET_ID_MAX_CHARS = 64;
export const SCENE_IMAGE_STYLE_PHRASE_MAX_CHARS = 200;
export const SCENE_IMAGE_PROMPT_OVERRIDE_MAX_ENTRIES = 16;
export const SCENE_IMAGE_PROMPT_OVERRIDE_KEY_MAX_CHARS = 64;
export const SCENE_IMAGE_PROMPT_OVERRIDE_VALUE_MAX_CHARS = 500;

/** The fixed workflow presets accepted by `applySceneImagePreset`. */
export type SceneImagePresetId = "preview" | "balanced" | "reference" | "experimentalGuidance1";

export interface SceneImagePreset {
  readonly id: SceneImagePresetId;
  readonly label: string;
  readonly steps: number;
  readonly guidance: number;
  readonly description: string;
}

/** Keep every property name of `SceneImageSettings` here; unknown keys are rejected. */
const SCENE_IMAGE_SETTING_KEYS = [
  "enabled",
  "mode",
  "stylePresetId",
  "stylePhrase",
  "promptOverrides",
  "steps",
  "guidance",
  "seedMode",
  "fixedSeed",
  "variationCount",
  "autoPerSessionLimit",
  "cooldownSeconds",
  "bandwidth",
  "hideImages",
  "advancedOnlyDm",
] as const;

/**
 * Workflow presets, not quality tiers. They only set a step budget and a
 * guidance scale; the same model, prompt, and seeds still decide the result.
 *
 * Note on `experimentalGuidance1`: guidance 1 skips the unconditional
 * prediction, so prompt adherence is markedly weaker. It is not a comparable
 * shortcut to guidance 3, unlike the official implementation's CFG path, and
 * its output should not be compared as if it were a cheaper guidance 3.
 */
export const SCENE_IMAGE_PRESETS: Readonly<Record<SceneImagePresetId, SceneImagePreset>> = Object.freeze({
  preview: Object.freeze({
    id: "preview" as const,
    label: "Preview",
    steps: 10,
    guidance: 3,
    description: "Fast workflow default for rough blocking. Not a lower quality tier.",
  }),
  balanced: Object.freeze({
    id: "balanced" as const,
    label: "Balanced",
    steps: 20,
    guidance: 3,
    description: "Everyday workflow default for a small, deliberate batch.",
  }),
  reference: Object.freeze({
    id: "reference" as const,
    label: "Reference",
    steps: 50,
    guidance: 3,
    description: "Slower workflow default for a keeper image.",
  }),
  experimentalGuidance1: Object.freeze({
    id: "experimentalGuidance1" as const,
    label: "Guidance 1 (experimental)",
    steps: 20,
    guidance: 1,
    description:
      "Experimental: guidance 1 skips the unconditional prediction, so prompt adherence is weaker. Not a comparable shortcut to guidance 3.",
  }),
});

/** One-line reminder suitable for settings UIs and API docs. */
export const SCENE_IMAGE_PRESET_NOTE =
  "Presets are workflow defaults, not equivalent quality tiers; guidance 1 is an experimental path, not a faster guidance 3.";

/** Whether an arbitrary value names one of the fixed workflow presets. */
export function isSceneImagePresetId(value: unknown): value is SceneImagePresetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCENE_IMAGE_PRESETS, value);
}

/** Whether an arbitrary value is a valid image path mode. */
export function isSceneImageMode(value: unknown): value is SceneImageMode {
  return SCENE_IMAGE_MODES.includes(value as SceneImageMode);
}

/** Whether an arbitrary value is a valid seed mode. */
export function isSceneImageSeedMode(value: unknown): value is SceneImageSeedMode {
  return SCENE_IMAGE_SEED_MODES.includes(value as SceneImageSeedMode);
}

/** Whether an arbitrary value is a valid bandwidth preference. */
export function isSceneImageBandwidth(value: unknown): value is SceneImageBandwidth {
  return SCENE_IMAGE_BANDWIDTHS.includes(value as SceneImageBandwidth);
}

/**
 * Strict persisted shape. Every field is always present after parsing; a
 * patch only replaces the fields it names.
 */
export interface SceneImageSettings {
  /** Off by default: images are opt-in per installation. */
  readonly enabled: boolean;
  readonly mode: SceneImageMode;
  /** Opaque campaign style reference resolved elsewhere; only used for provenance. */
  readonly stylePresetId: string;
  /** Art-direction phrase appended after the scene details. */
  readonly stylePhrase: string;
  /** Keyed prompt overrides applied by the caller, not by the pure builder. */
  readonly promptOverrides: Readonly<Record<string, string>>;
  readonly steps: number;
  readonly guidance: number;
  readonly seedMode: SceneImageSeedMode;
  readonly fixedSeed: number;
  /** Number of seed variations per prompt in a deliberate batch. */
  readonly variationCount: number;
  /** Automatic mode may generate at most this many images per session. */
  readonly autoPerSessionLimit: number;
  readonly cooldownSeconds: number;
  readonly bandwidth: SceneImageBandwidth;
  /** Client-side preference: keep generated images out of the transcript. */
  readonly hideImages: boolean;
  /** Keep the image controls out of the player-facing UI. */
  readonly advancedOnlyDm: boolean;
}

export const DEFAULT_SCENE_IMAGE_SETTINGS: SceneImageSettings = Object.freeze({
  enabled: true,
  mode: "automatic",
  stylePresetId: "campaign-default",
  stylePhrase: "",
  promptOverrides: {},
  steps: SCENE_IMAGE_PRESETS.balanced.steps,
  guidance: SCENE_IMAGE_PRESETS.balanced.guidance,
  seedMode: "random",
  fixedSeed: 0,
  variationCount: 1,
  autoPerSessionLimit: 1,
  cooldownSeconds: 0,
  bandwidth: "full",
  hideImages: false,
  advancedOnlyDm: true,
});

/** A sparse settings update; merge helpers fill the rest from the base shape. */
export type SceneImageSettingsPatch = Partial<SceneImageSettings>;

export interface SceneImageSettingsValidationSuccess {
  readonly valid: true;
  readonly settings: SceneImageSettings;
}

export interface SceneImageSettingsValidationFailure {
  readonly valid: false;
  readonly issues: readonly string[];
}

export type SceneImageSettingsValidation = SceneImageSettingsValidationSuccess | SceneImageSettingsValidationFailure;

/** Thrown by `parseSceneImageSettings` with every issue it found. */
export class SceneImageSettingsValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid scene-image settings: ${issues.join("; ")}`);
    this.name = "SceneImageSettingsValidationError";
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates an unknown payload against the strict settings shape. Missing
 * fields take their defaults; unknown keys, wrong types, and out-of-bounds
 * values are reported instead of silently coerced.
 */
export function validateSceneImageSettings(value: unknown): SceneImageSettingsValidation {
  if (!isPlainObject(value)) return { valid: false, issues: ["settings must be a plain object"] };
  const issues: string[] = [];
  const known = new Set<string>(SCENE_IMAGE_SETTING_KEYS);
  for (const key of Object.keys(value)) if (!known.has(key)) issues.push(`unknown setting "${key}"`);

  const bool = (key: string, fallback: boolean): boolean => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "boolean") {
      issues.push(`${key} must be a boolean`);
      return fallback;
    }
    return raw;
  };
  const text = (key: string, fallback: string, maxChars: number, minChars = 0): string => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "string") {
      issues.push(`${key} must be a string`);
      return fallback;
    }
    const trimmed = raw.trim();
    if (trimmed.length < minChars) issues.push(`${key} must be at least ${minChars} characters`);
    else if (trimmed.length > maxChars) issues.push(`${key} must be at most ${maxChars} characters`);
    else return trimmed;
    return fallback;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      issues.push(`${key} must be an integer`);
      return fallback;
    }
    if (raw < min || raw > max) {
      issues.push(`${key} must be between ${min} and ${max}`);
      return fallback;
    }
    return raw;
  };
  const boundedNumber = (key: string, fallback: number, min: number, max: number): number => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      issues.push(`${key} must be a finite number`);
      return fallback;
    }
    if (raw < min || raw > max) {
      issues.push(`${key} must be between ${min} and ${max}`);
      return fallback;
    }
    return raw;
  };
  const member = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
      issues.push(`${key} must be one of ${allowed.join(", ")}`);
      return fallback;
    }
    return raw as T;
  };

  const promptOverrides: Record<string, string> = {};
  const rawOverrides = value.promptOverrides;
  if (rawOverrides !== undefined) {
    if (!isPlainObject(rawOverrides)) issues.push("promptOverrides must be a plain object");
    else {
      const entries = Object.entries(rawOverrides);
      if (entries.length > SCENE_IMAGE_PROMPT_OVERRIDE_MAX_ENTRIES) {
        issues.push(`promptOverrides must have at most ${SCENE_IMAGE_PROMPT_OVERRIDE_MAX_ENTRIES} entries`);
      }
      for (const [key, override] of entries) {
        if (key.length === 0 || key.length > SCENE_IMAGE_PROMPT_OVERRIDE_KEY_MAX_CHARS) {
          issues.push(`promptOverrides keys must be 1–${SCENE_IMAGE_PROMPT_OVERRIDE_KEY_MAX_CHARS} characters`);
          continue;
        }
        if (typeof override !== "string") {
          issues.push(`promptOverrides["${key}"] must be a string`);
          continue;
        }
        if (override.length > SCENE_IMAGE_PROMPT_OVERRIDE_VALUE_MAX_CHARS) {
          issues.push(`promptOverrides["${key}"] must be at most ${SCENE_IMAGE_PROMPT_OVERRIDE_VALUE_MAX_CHARS} characters`);
          continue;
        }
        promptOverrides[key] = override;
      }
    }
  }

  const settings: SceneImageSettings = {
    enabled: bool("enabled", DEFAULT_SCENE_IMAGE_SETTINGS.enabled),
    mode: member("mode", SCENE_IMAGE_MODES, DEFAULT_SCENE_IMAGE_SETTINGS.mode),
    stylePresetId: text("stylePresetId", DEFAULT_SCENE_IMAGE_SETTINGS.stylePresetId, SCENE_IMAGE_STYLE_PRESET_ID_MAX_CHARS, 1),
    stylePhrase: text("stylePhrase", DEFAULT_SCENE_IMAGE_SETTINGS.stylePhrase, SCENE_IMAGE_STYLE_PHRASE_MAX_CHARS),
    promptOverrides,
    steps: integer("steps", DEFAULT_SCENE_IMAGE_SETTINGS.steps, SCENE_IMAGE_STEPS_MIN, SCENE_IMAGE_STEPS_MAX),
    guidance: boundedNumber("guidance", DEFAULT_SCENE_IMAGE_SETTINGS.guidance, SCENE_IMAGE_GUIDANCE_MIN, SCENE_IMAGE_GUIDANCE_MAX),
    seedMode: member("seedMode", SCENE_IMAGE_SEED_MODES, DEFAULT_SCENE_IMAGE_SETTINGS.seedMode),
    fixedSeed: integer("fixedSeed", DEFAULT_SCENE_IMAGE_SETTINGS.fixedSeed, SCENE_IMAGE_MIN_SEED, SCENE_IMAGE_MAX_SEED),
    variationCount: integer("variationCount", DEFAULT_SCENE_IMAGE_SETTINGS.variationCount, SCENE_IMAGE_VARIATION_MIN, SCENE_IMAGE_VARIATION_MAX),
    autoPerSessionLimit: integer(
      "autoPerSessionLimit",
      DEFAULT_SCENE_IMAGE_SETTINGS.autoPerSessionLimit,
      SCENE_IMAGE_AUTO_SESSION_LIMIT_MIN,
      SCENE_IMAGE_AUTO_SESSION_LIMIT_MAX,
    ),
    cooldownSeconds: integer(
      "cooldownSeconds",
      DEFAULT_SCENE_IMAGE_SETTINGS.cooldownSeconds,
      SCENE_IMAGE_COOLDOWN_MIN_SECONDS,
      SCENE_IMAGE_COOLDOWN_MAX_SECONDS,
    ),
    bandwidth: member("bandwidth", SCENE_IMAGE_BANDWIDTHS, DEFAULT_SCENE_IMAGE_SETTINGS.bandwidth),
    hideImages: bool("hideImages", DEFAULT_SCENE_IMAGE_SETTINGS.hideImages),
    advancedOnlyDm: bool("advancedOnlyDm", DEFAULT_SCENE_IMAGE_SETTINGS.advancedOnlyDm),
  };
  return issues.length === 0 ? { valid: true, settings } : { valid: false, issues };
}

/** Parses a settings payload, applying defaults and throwing on any issue. */
export function parseSceneImageSettings(value: unknown = {}): SceneImageSettings {
  const result = validateSceneImageSettings(value);
  if (!result.valid) throw new SceneImageSettingsValidationError(result.issues);
  return result.settings;
}

/** Deep-copies a settings object; nested `promptOverrides` are never shared. */
export function cloneSceneImageSettings(settings: SceneImageSettings): SceneImageSettings {
  return parseSceneImageSettings(settings);
}

/**
 * Applies a sparse patch over a base shape. `promptOverrides` merge key by
 * key (patch wins); every other field replaces the base value. Invalid patches
 * throw instead of silently keeping stale bounds.
 */
export function mergeSceneImageSettings(base: SceneImageSettings, patch: SceneImageSettingsPatch): SceneImageSettings {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, entry]) => entry !== undefined));
  const promptOverrides = patch.promptOverrides === undefined
    ? base.promptOverrides
    : { ...base.promptOverrides, ...patch.promptOverrides };
  return parseSceneImageSettings({ ...base, ...defined, promptOverrides });
}

/**
 * Applies a workflow preset's steps and guidance to existing settings. The
 * preset is a starting point, not a quality tier: `reference` is slower, not
 * automatically better, and `experimentalGuidance1` is weaker, not cheaper.
 */
export function applySceneImagePreset(settings: SceneImageSettings, presetId: string): SceneImageSettings {
  if (!isSceneImagePresetId(presetId)) {
    throw new RangeError(`Unknown scene-image preset "${presetId}"; expected one of ${Object.keys(SCENE_IMAGE_PRESETS).join(", ")}`);
  }
  const preset = SCENE_IMAGE_PRESETS[presetId];
  return mergeSceneImageSettings(settings, { steps: preset.steps, guidance: preset.guidance });
}

export const SCENE_IMAGE_CACHE_KEY_PREFIX = "scene-image:";

export interface SceneImageCacheKeyInput {
  readonly prompt: string;
  readonly seed: number;
  readonly steps: number;
  readonly guidance: number;
  /**
   * Optional model identity. When absent (null, undefined, or blank) it is
   * omitted from the key material rather than replaced with a placeholder, so
   * an unknown model never collides with a real version string.
   */
  readonly modelVersion?: string | null;
}

/**
 * Stable content key for one generated image. Only the provided values are
 * hashed: there is no clock, random source, or default model version, so the
 * same request always yields the same key within and across sessions.
 */
export function sceneImageCacheKey(input: SceneImageCacheKeyInput): string {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length === 0) throw new RangeError("sceneImageCacheKey requires a non-empty prompt");
  if (!Number.isInteger(input.seed) || input.seed < SCENE_IMAGE_MIN_SEED || input.seed > SCENE_IMAGE_MAX_SEED) {
    throw new RangeError(`sceneImageCacheKey seed must be an integer between ${SCENE_IMAGE_MIN_SEED} and ${SCENE_IMAGE_MAX_SEED}`);
  }
  if (!Number.isInteger(input.steps) || input.steps < SCENE_IMAGE_STEPS_MIN || input.steps > SCENE_IMAGE_STEPS_MAX) {
    throw new RangeError(`sceneImageCacheKey steps must be an integer between ${SCENE_IMAGE_STEPS_MIN} and ${SCENE_IMAGE_STEPS_MAX}`);
  }
  if (!Number.isFinite(input.guidance) || input.guidance < SCENE_IMAGE_GUIDANCE_MIN || input.guidance > SCENE_IMAGE_GUIDANCE_MAX) {
    throw new RangeError(`sceneImageCacheKey guidance must be between ${SCENE_IMAGE_GUIDANCE_MIN} and ${SCENE_IMAGE_GUIDANCE_MAX}`);
  }
  const material: Array<string | number> = [prompt, input.seed, input.steps, input.guidance];
  const modelVersion = typeof input.modelVersion === "string" ? input.modelVersion.trim() : "";
  if (modelVersion.length > 0) material.push(modelVersion);
  return `${SCENE_IMAGE_CACHE_KEY_PREFIX}${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 48)}`;
}

export interface SceneImageUsageState {
  /** Images already generated during the current session. */
  readonly imagesThisSession: number;
  /** ISO timestamp of the most recent image, or null when none was generated. */
  readonly lastGeneratedAt: string | null;
}

export type SceneImageAutoLimitReason = "allowed" | "disabled" | "manual" | "session-limit" | "cooldown";

export interface SceneImageAutoLimitDecision {
  readonly allowed: boolean;
  readonly reason: SceneImageAutoLimitReason;
  /** Automatic images still available this session; 0 when the auto path is unavailable. */
  readonly remaining: number;
  /** End of the most recent image's cooldown, or null when no cooldown applies. */
  readonly cooldownEndsAt: string | null;
}

/**
 * Cooldown end for the most recent image. Returns null when no cooldown is
 * configured, no image exists, or the timestamp cannot be parsed.
 */
export function nextCooldownAt(lastGeneratedAt: string | null, cooldownSeconds: number): string | null {
  if (!lastGeneratedAt || !Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return null;
  const started = Date.parse(lastGeneratedAt);
  if (Number.isNaN(started)) return null;
  return new Date(started + Math.floor(cooldownSeconds) * 1_000).toISOString();
}

/**
 * Pure per-session automatic-path decision with an injected `now`. Manual mode
 * never runs through this helper: a manual click is bounded by the UI and the
 * confirmation rule, not by the automatic limits.
 */
export function withinAutoLimits(state: SceneImageUsageState, settings: SceneImageSettings, now: Date): SceneImageAutoLimitDecision {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("withinAutoLimits requires a valid Date");
  const images = Number.isFinite(state.imagesThisSession) ? Math.max(0, Math.floor(state.imagesThisSession)) : 0;
  const remaining = Math.max(0, settings.autoPerSessionLimit - images);
  const cooldownEndsAt = nextCooldownAt(state.lastGeneratedAt, settings.cooldownSeconds);
  if (!settings.enabled || settings.mode === "off") return { allowed: false, reason: "disabled", remaining: 0, cooldownEndsAt };
  if (settings.mode !== "automatic") return { allowed: false, reason: "manual", remaining: 0, cooldownEndsAt };
  if (images >= settings.autoPerSessionLimit) return { allowed: false, reason: "session-limit", remaining: 0, cooldownEndsAt };
  if (cooldownEndsAt !== null && now.getTime() < Date.parse(cooldownEndsAt)) {
    return { allowed: false, reason: "cooldown", remaining, cooldownEndsAt };
  }
  return { allowed: true, reason: "allowed", remaining, cooldownEndsAt };
}
