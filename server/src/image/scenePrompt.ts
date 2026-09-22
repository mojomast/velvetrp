import {
  SCENE_IMAGE_GUIDANCE_MAX,
  SCENE_IMAGE_GUIDANCE_MIN,
  SCENE_IMAGE_MAX_SEED,
  SCENE_IMAGE_MIN_SEED,
  SCENE_IMAGE_STEPS_MAX,
  SCENE_IMAGE_STEPS_MIN,
  type SceneImageMode,
} from "./settings.js";

/**
 * Deterministic, spoiler-filtered prompt builder for 256x256 campaign scene
 * images. Pure and offline: no provider calls, no clock, no tokenizer import.
 *
 * Assembly order is fixed — location + focal feature, viewpoint/composition,
 * lighting/weather, materials/environment details, then the consistent
 * campaign art style — followed by the composition constraints for a small
 * square image. Spoiler filtering happens before assembly: the player audience
 * sees only `public` facts, a DM sees `public` + `gm`, and `secret` facts are
 * never auto-included for anyone. Hidden entity names must be filtered out
 * before they reach this module; `visibleNameFallback` exists so a caller can
 * pass a name through as a visible characteristic instead.
 */

/** Workflow presets live with the settings; re-exported here for prompt callers. */
export { SCENE_IMAGE_PRESETS as SCENE_PROMPT_PRESETS } from "./settings.js";
export type { SceneImageMode, SceneImagePreset, SceneImagePresetId } from "./settings.js";

export const SCENE_FACT_VISIBILITIES = ["public", "gm", "secret"] as const;
export type SceneFactVisibility = (typeof SCENE_FACT_VISIBILITIES)[number];

/** `player` sees public facts only; `dm` adds gm facts. `secret` is never auto-included. */
export type SceneAudience = "player" | "dm";

export interface SceneFact {
  /**
   * Visible description of the fact. `text` is accepted as an alias for
   * callers that already store the label under that key.
   */
  readonly label?: string;
  readonly text?: string;
  readonly visibility: SceneFactVisibility;
}

/**
 * Word-count target for a finished prompt. This is guidance, not a hard
 * bound: the enforceable ceiling is `SCENE_PROMPT_MAX_CHARS`.
 */
export const PROMPT_WORD_TARGET = Object.freeze({ min: 50, max: 80 });

/** Hard character cap for a built prompt, applied after whitespace trimming. */
export const SCENE_PROMPT_MAX_CHARS = 1_000;

/** Token budget of the image encoder this builder targets. */
export const SCENE_PROMPT_MAX_ENCODER_TOKENS = 128;

/**
 * Approximate token density for the builder's terse, clause-separated style.
 * Deliberately heuristic; see `estimateScenePromptTokens`.
 */
export const SCENE_PROMPT_APPROX_TOKENS_PER_WORD = 1.3;

export const PROMPT_WORD_TARGET_MIN = PROMPT_WORD_TARGET.min;
export const PROMPT_WORD_TARGET_MAX = PROMPT_WORD_TARGET.max;

export interface ScenePromptInput {
  readonly locationName: string;
  readonly focalFeature: string;
  readonly composition: string;
  readonly lighting: string;
  readonly materials: readonly string[];
  readonly stylePhrase: string;
  readonly facts: readonly SceneFact[];
}

export interface ScenePromptBuildOptions {
  /** Defaults to `player`, the least revealing audience. */
  readonly audience?: SceneAudience;
}

function isDmAudience(value: unknown): boolean {
  return value === "dm" || (typeof value === "object" && value !== null && (value as { audience?: unknown }).audience === "dm");
}

function resolveAudience(options: ScenePromptBuildOptions | SceneAudience): SceneAudience {
  return isDmAudience(options) ? "dm" : "player";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanText(value)).filter((value) => value.length > 0);
}

function factText(fact: SceneFact): string {
  return cleanText(fact.label ?? fact.text);
}

/**
 * Keeps only the facts an audience may see. Unknown visibilities fail closed
 * (dropped), and `secret` facts are never returned for either audience. The
 * original fact objects are preserved so callers keep their own metadata.
 */
export function filterSceneFacts<F extends SceneFact>(facts: readonly F[], audience: SceneAudience): readonly F[] {
  const dm = audience === "dm";
  if (!Array.isArray(facts)) return [];
  return facts.filter((fact) => {
    const visibility = fact?.visibility;
    if (visibility === "public") return true;
    if (visibility === "gm") return dm;
    return false;
  });
}

function sentence(text: string): string {
  const clean = cleanText(text);
  if (clean.length === 0) return "";
  return /[.!?;:]$/.test(clean) ? clean : `${clean}.`;
}

/** Clips to the hard character cap on a word boundary and marks the cut. */
function clipPrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  const slice = prompt.slice(0, maxChars - 1);
  const boundary = slice.lastIndexOf(" ");
  // Prefer a word boundary, but never collapse the prompt to a stub just
  // because an early field contained one very long token.
  const clipped = boundary >= Math.floor(maxChars / 2) ? slice.slice(0, boundary) : slice;
  return `${clipped.trimEnd()}…`;
}

/**
 * Builds the image prompt in the fixed clause order. `audience` defaults to
 * `player` and may be passed directly or as `{ audience: "dm" }`.
 */
export function buildScenePrompt(input: ScenePromptInput, options: ScenePromptBuildOptions | SceneAudience = {}): string {
  const audience = resolveAudience(options);
  const location = cleanText(input.locationName);
  const focal = cleanText(input.focalFeature);
  const composition = cleanText(input.composition);
  const lighting = cleanText(input.lighting);
  const materials = cleanList(input.materials);
  const facts = filterSceneFacts(Array.isArray(input.facts) ? input.facts : [], audience)
    .map((fact) => factText(fact))
    .filter((text) => text.length > 0);

  const clauses: string[] = [];
  const subject = location.length > 0 && focal.length > 0 ? `${location} — ${focal}`
    : location.length > 0 ? location
      : focal.length > 0 ? `Focal feature: ${focal}`
        : "";
  if (subject.length > 0) clauses.push(sentence(subject));
  if (composition.length > 0) clauses.push(sentence(composition));
  if (lighting.length > 0) clauses.push(sentence(lighting));
  const environment = [...materials, ...facts];
  if (environment.length > 0) clauses.push(sentence(`Materials and environment: ${environment.join("; ")}`));
  clauses.push(sentence(`Campaign art style: ${cleanText(input.stylePhrase) || "consistent campaign art style"}`));
  clauses.push("One coherent scene with a strong silhouette and few recognizable features.");
  clauses.push("At 256x256, favor clear composition over tiny objects, lettering, crowds, or complicated action; favor unoccupied scenery.");

  return clipPrompt(clauses.join(" "), SCENE_PROMPT_MAX_CHARS);
}

/** Whitespace-delimited word count after trimming. */
export function countScenePromptWords(prompt: string): number {
  const clean = cleanText(prompt);
  return clean.length === 0 ? 0 : clean.split(" ").length;
}

/**
 * Approximate token count: `max(ceil(words × 1.3), ceil(chars / 4))`.
 *
 * This is a heuristic, not a tokenizer. It intentionally imports none and is
 * documented as approximate against the 128-token encoder: a real encoder may
 * truncate earlier or later, so treat the result as a warning threshold.
 */
export function estimateScenePromptTokens(prompt: string): number {
  const clean = cleanText(prompt);
  const words = countScenePromptWords(clean);
  const chars = clean.length;
  return Math.max(1, Math.ceil(words * SCENE_PROMPT_APPROX_TOKENS_PER_WORD), Math.ceil(chars / 4));
}

export interface ScenePromptLengthReport {
  readonly words: number;
  readonly chars: number;
  readonly approximateTokens: number;
  readonly withinWordTarget: boolean;
  readonly withinCharCap: boolean;
  /** Null when the prompt is plausibly inside the encoder budget. */
  readonly warning: string | null;
}

/** Length diagnostics for a finished prompt, using the approximate heuristic. */
export function scenePromptLengthReport(prompt: string): ScenePromptLengthReport {
  const clean = cleanText(prompt);
  const words = countScenePromptWords(clean);
  const chars = clean.length;
  const approximateTokens = estimateScenePromptTokens(clean);
  const tokenOverflow = approximateTokens > SCENE_PROMPT_MAX_ENCODER_TOKENS;
  const charOverflow = chars > SCENE_PROMPT_MAX_CHARS;
  const warning = tokenOverflow || charOverflow
    ? `Scene prompt is ${chars} characters and approximately ${approximateTokens} tokens (word heuristic, not tokenizer-accurate); the ${SCENE_PROMPT_MAX_ENCODER_TOKENS}-token image encoder may truncate it.`
    : null;
  return {
    words,
    chars,
    approximateTokens,
    withinWordTarget: words >= PROMPT_WORD_TARGET.min && words <= PROMPT_WORD_TARGET.max,
    withinCharCap: !charOverflow,
    warning,
  };
}

/**
 * Warns when a prompt is likely to be truncated by the 128-token encoder.
 * Returns null when it plausibly fits. The check is approximate: no tokenizer
 * is imported, and the word/character heuristic is documented as such.
 */
export function scenePromptTruncationWarning(prompt: string): string | null {
  return scenePromptLengthReport(prompt).warning;
}

export { scenePromptTruncationWarning as promptTruncationWarning };

/**
 * Simple catch-all descriptor for a fictional name that has no safe visible
 * translation. It is a fallback, not lore knowledge: it never returns the name
 * and cannot describe the entity, only a plausible silhouette.
 */
const VISIBLE_NAME_FALLBACK_DESCRIPTOR = "a figure with a distinct silhouette and few recognizable features";

/** Name fragments that can pass as visible characteristics, checked in order. */
const VISIBLE_NAME_HINTS: ReadonlyArray<{ readonly pattern: RegExp; readonly descriptor: string }> = [
  { pattern: /iron|steel|forge|anvil/, descriptor: "heavy iron-grey plating" },
  { pattern: /stone|rock|crag|granite|barrow/, descriptor: "a weathered stone-grey bulk" },
  { pattern: /shadow|shade|dusk|night|dark|gloom/, descriptor: "a deep, low-contrast silhouette" },
  { pattern: /ash|ember|cinder|flame|fire|pyre|coal/, descriptor: "warm ember-orange accents" },
  { pattern: /frost|ice|winter|snow|rime/, descriptor: "pale frost-blue tones" },
  { pattern: /thorn|briar|root|moss|wood|leaf|bark|grove/, descriptor: "rough bark-and-moss texture" },
  { pattern: /bone|skull|grave|tomb/, descriptor: "bleached bone-pale detail" },
  { pattern: /blood|crimson|scarlet|ruby|rose/, descriptor: "deep crimson accents" },
  { pattern: /silver|moon|star|pale/, descriptor: "a cool silver sheen" },
  { pattern: /gold|coin|sun|bright|dawn/, descriptor: "warm gold highlights" },
  { pattern: /storm|thunder|wind|gale|sky/, descriptor: "wind-torn layered cloth" },
  { pattern: /glass|crystal|prism|shard/, descriptor: "faceted glass-like edges" },
  { pattern: /smoke|mist|fog|veil|haze/, descriptor: "soft mist-grey layering" },
  { pattern: /scale|serpent|drake|wyrm/, descriptor: "coarse reptilian scale texture" },
  { pattern: /wing|feather|hawk|raven|crow/, descriptor: "a swept feather-and-cloth profile" },
];

/**
 * Turns a fictional name into a concrete visual phrase so the image model
 * receives a visible characteristic instead of an unreadable proper noun. This
 * is a simple fallback keyed on obvious name fragments — it is not lore
 * knowledge, does not know what the entity is, and never echoes the name back.
 * Callers remain responsible for not leaking hidden names elsewhere.
 */
export function visibleNameFallback(name: string): string {
  const cleaned = cleanText(name);
  if (cleaned.length === 0) return VISIBLE_NAME_FALLBACK_DESCRIPTOR;
  const words = cleaned.toLowerCase().split(/[\s'’-]+/).filter((word) => word.length > 0);
  const descriptors: string[] = [];
  for (const hint of VISIBLE_NAME_HINTS) {
    if (descriptors.length >= 2) break;
    if (wordMatchesAny(words, hint.pattern) && !descriptors.includes(hint.descriptor)) descriptors.push(hint.descriptor);
  }
  return descriptors.length > 0 ? `a figure with ${descriptors.join(" and ")}` : VISIBLE_NAME_FALLBACK_DESCRIPTOR;
}

function wordMatchesAny(words: readonly string[], pattern: RegExp): boolean {
  return words.some((word) => pattern.test(word));
}

/** Plan-level guard rails, larger than the per-request image limit. */
export const SCENE_BATCH_MAX_TOTAL = 128;
export const SCENE_BATCH_MAX_COUNT = 32;
export const SCENE_BATCH_MAX_AXIS_VALUES = 8;
export const SCENE_BATCH_LIMITS = Object.freeze({
  maxTotal: SCENE_BATCH_MAX_TOTAL,
  maxCount: SCENE_BATCH_MAX_COUNT,
  maxAxisValues: SCENE_BATCH_MAX_AXIS_VALUES,
  minSteps: SCENE_IMAGE_STEPS_MIN,
  maxSteps: SCENE_IMAGE_STEPS_MAX,
  minGuidance: SCENE_IMAGE_GUIDANCE_MIN,
  maxGuidance: SCENE_IMAGE_GUIDANCE_MAX,
  minSeed: SCENE_IMAGE_MIN_SEED,
  maxSeed: SCENE_IMAGE_MAX_SEED,
});

export interface SceneBatchPlanRequest {
  /** Seeds to reuse across every steps/guidance combination. */
  readonly count: number;
  readonly steps: readonly number[];
  readonly guidance: readonly number[];
  /** First seed; defaults to 0. */
  readonly baseSeed?: number;
}

export interface SceneBatchVariant {
  readonly index: number;
  readonly seed: number;
  readonly steps: number;
  readonly guidance: number;
}

export interface SceneBatchPlan {
  /** `count × steps.length × guidance.length`. */
  readonly total: number;
  readonly count: number;
  readonly steps: readonly number[];
  readonly guidance: readonly number[];
  /** The `count` seeds reused by every combination. */
  readonly seeds: readonly number[];
  /** Expanded in steps-major, guidance-minor, seed-innermost order. */
  readonly variants: readonly SceneBatchVariant[];
}

function assertAxisValues(values: readonly number[], label: string, min: number, max: number): void {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError(`${label} must contain at least one value`);
  if (values.length > SCENE_BATCH_MAX_AXIS_VALUES) {
    throw new RangeError(`${label} must contain at most ${SCENE_BATCH_MAX_AXIS_VALUES} values`);
  }
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} values must be finite numbers`);
    if (value < min || value > max) throw new RangeError(`${label} values must be between ${min} and ${max}`);
  }
}

/**
 * Expands a confirmed batch into individual variants. The same seeds are
 * reused across every steps/guidance combination so a grid isolates the
 * sampler change, and the expansion is reject-loud: states outside the plan
 * bounds throw instead of being clamped.
 */
export function planSceneBatch(request: SceneBatchPlanRequest): SceneBatchPlan {
  if (!Number.isInteger(request.count) || request.count < 1 || request.count > SCENE_BATCH_MAX_COUNT) {
    throw new RangeError(`count must be an integer between 1 and ${SCENE_BATCH_MAX_COUNT}`);
  }
  assertAxisValues(request.steps, "steps", SCENE_IMAGE_STEPS_MIN, SCENE_IMAGE_STEPS_MAX);
  if (request.steps.some((value) => !Number.isInteger(value))) throw new RangeError("steps values must be integers");
  assertAxisValues(request.guidance, "guidance", SCENE_IMAGE_GUIDANCE_MIN, SCENE_IMAGE_GUIDANCE_MAX);

  const total = request.count * request.steps.length * request.guidance.length;
  if (total > SCENE_BATCH_MAX_TOTAL) {
    throw new RangeError(`batch total ${total} exceeds the ${SCENE_BATCH_MAX_TOTAL} image limit`);
  }
  const baseSeed = request.baseSeed === undefined ? SCENE_IMAGE_MIN_SEED : request.baseSeed;
  if (!Number.isInteger(baseSeed) || baseSeed < SCENE_IMAGE_MIN_SEED || baseSeed > SCENE_IMAGE_MAX_SEED) {
    throw new RangeError(`baseSeed must be an integer between ${SCENE_IMAGE_MIN_SEED} and ${SCENE_IMAGE_MAX_SEED}`);
  }
  if (baseSeed + request.count - 1 > SCENE_IMAGE_MAX_SEED) {
    throw new RangeError("baseSeed leaves the supported seed range for this count");
  }

  const seeds = Array.from({ length: request.count }, (_unused, offset) => baseSeed + offset);
  const variants: SceneBatchVariant[] = [];
  let index = 0;
  for (const steps of request.steps) {
    for (const guidance of request.guidance) {
      for (const seed of seeds) {
        variants.push({ index, seed, steps, guidance });
        index += 1;
      }
    }
  }
  return { total, count: request.count, steps: [...request.steps], guidance: [...request.guidance], seeds, variants };
}

/**
 * Whether a batch of `total` images needs a deliberate user confirmation.
 * Automatic mode may run at most one image unattended; a manual single image
 * is itself a deliberate click; larger grids always ask. With images `off`,
 * any generation is opt-in and therefore needs confirmation.
 */
export function requiresConfirmation(total: number, mode: SceneImageMode): boolean {
  if (!Number.isInteger(total) || total < 0) throw new RangeError("total must be a non-negative integer");
  if (mode === "off") return total > 0;
  return total > 1;
}
