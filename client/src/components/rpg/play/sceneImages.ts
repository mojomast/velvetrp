import { useState } from "react";
import type { SceneImageGalleryItem, SceneImageSettings } from "../../../api";

/**
 * Client-side scene-image workflow helpers.
 *
 * Everything here is pure or local-storage only: comparison planning mirrors
 * the server batch rules (same seeds reused across every steps/guidance
 * combination), player preferences never leave the browser, and the scene
 * registry remembers which generated job belongs to which scene so the
 * gallery can group images even though the frozen gallery projection does not
 * carry a scene key.
 */

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
export const SCENE_IMAGE_MIN_SEED = 0;
export const SCENE_IMAGE_MAX_SEED = 2_147_483_647;
export const SCENE_IMAGE_BATCH_MAX_TOTAL = 128;
export const SCENE_IMAGE_BATCH_MAX_AXIS_VALUES = 8;

export type SceneImagePresetId = "preview" | "balanced" | "reference" | "experimentalGuidance1";

export interface SceneImagePreset {
  id: SceneImagePresetId;
  label: string;
  steps: number;
  guidance: number;
  description: string;
}

/** Workflow presets, not quality tiers. The experimental row uses guidance 1. */
export const SCENE_IMAGE_PRESETS: readonly SceneImagePreset[] = [
  { id: "preview", label: "Preview 10/3", steps: 10, guidance: 3, description: "Fast workflow default for rough blocking." },
  { id: "balanced", label: "Balanced 20/3", steps: 20, guidance: 3, description: "Everyday workflow default for a small deliberate batch." },
  { id: "reference", label: "Reference 50/3", steps: 50, guidance: 3, description: "Slower workflow default for a keeper image." },
  { id: "experimentalGuidance1", label: "Experimental 20/guidance-1", steps: 20, guidance: 1, description: "Experimental guidance-1 path." },
];

export const SCENE_IMAGE_PRESET_NOTE =
  "Experimental guidance 1 may weaken prompt adherence: it is a workflow default, not equivalent quality to guidance 3. Presets are starting points, not quality tiers.";

export const DEFAULT_SCENE_IMAGE_SETTINGS: SceneImageSettings = {
  enabled: false,
  mode: "off",
  stylePresetId: "campaign-default",
  stylePhrase: "",
  promptOverrides: {},
  steps: 20,
  guidance: 3,
  seedMode: "random",
  fixedSeed: 0,
  variationCount: 1,
  autoPerSessionLimit: 1,
  cooldownSeconds: 0,
  bandwidth: "full",
  hideImages: false,
  advancedOnlyDm: true,
};

export interface SceneImageComparisonRequest {
  steps: number;
  guidance: number;
  seed: number;
  count: number;
}

export interface SceneImageComparisonPlan {
  total: number;
  requests: SceneImageComparisonRequest[];
}

/** Expands a confirmed grid. Every combination reuses the same `count` seeds. */
export function planSceneImageComparison(input: { count: number; steps: readonly number[]; guidance: readonly number[]; baseSeed: number }): SceneImageComparisonPlan {
  const { count, steps, guidance, baseSeed } = input;
  if (!Number.isInteger(count) || count < SCENE_IMAGE_VARIATION_MIN || count > SCENE_IMAGE_VARIATION_MAX) {
    throw new RangeError(`Variation count must be an integer between ${SCENE_IMAGE_VARIATION_MIN} and ${SCENE_IMAGE_VARIATION_MAX}.`);
  }
  const axis = (values: readonly number[], label: string, min: number, max: number, integer: boolean) => {
    if (values.length === 0) throw new RangeError(`${label} needs at least one value.`);
    if (values.length > SCENE_IMAGE_BATCH_MAX_AXIS_VALUES) throw new RangeError(`${label} accepts at most ${SCENE_IMAGE_BATCH_MAX_AXIS_VALUES} values.`);
    for (const value of values) {
      if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new RangeError(`${label} values must be ${integer ? "whole numbers" : "finite numbers"}.`);
      if (value < min || value > max) throw new RangeError(`${label} values must be between ${min} and ${max}.`);
    }
  };
  axis(steps, "Steps", SCENE_IMAGE_STEPS_MIN, SCENE_IMAGE_STEPS_MAX, true);
  axis(guidance, "Guidance", SCENE_IMAGE_GUIDANCE_MIN, SCENE_IMAGE_GUIDANCE_MAX, false);
  if (!Number.isInteger(baseSeed) || baseSeed < SCENE_IMAGE_MIN_SEED || baseSeed > SCENE_IMAGE_MAX_SEED) {
    throw new RangeError(`Seed must be an integer between ${SCENE_IMAGE_MIN_SEED} and ${SCENE_IMAGE_MAX_SEED}.`);
  }
  if (baseSeed + count - 1 > SCENE_IMAGE_MAX_SEED) throw new RangeError("The seed leaves the supported range for this many variations.");
  const total = count * steps.length * guidance.length;
  if (total > SCENE_IMAGE_BATCH_MAX_TOTAL) throw new RangeError(`A grid of ${total} images exceeds the ${SCENE_IMAGE_BATCH_MAX_TOTAL} image limit.`);
  const requests: SceneImageComparisonRequest[] = [];
  for (const step of steps) for (const guidanceValue of guidance) {
    requests.push({ steps: step, guidance: guidanceValue, seed: baseSeed, count });
  }
  return { total, requests };
}

/** Parses a comma-separated comparison axis without silently coercing bad input. */
export function parseSceneImageAxis(text: string, kind: "steps" | "guidance"): { values: number[]; error: string | null } {
  const parts = text.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return { values: [], error: kind === "steps" ? "Enter at least one step count." : "Enter at least one guidance value." };
  if (parts.length > SCENE_IMAGE_BATCH_MAX_AXIS_VALUES) return { values: [], error: `Use at most ${SCENE_IMAGE_BATCH_MAX_AXIS_VALUES} comma-separated values.` };
  const values: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return { values: [], error: `${part} is not a number.` };
    if (kind === "steps" && (!Number.isInteger(value) || value < SCENE_IMAGE_STEPS_MIN || value > SCENE_IMAGE_STEPS_MAX)) {
      return { values: [], error: `Steps must be whole numbers between ${SCENE_IMAGE_STEPS_MIN} and ${SCENE_IMAGE_STEPS_MAX}.` };
    }
    if (kind === "guidance" && (value < SCENE_IMAGE_GUIDANCE_MIN || value > SCENE_IMAGE_GUIDANCE_MAX)) {
      return { values: [], error: `Guidance must be between ${SCENE_IMAGE_GUIDANCE_MIN} and ${SCENE_IMAGE_GUIDANCE_MAX}.` };
    }
    values.push(value);
  }
  return { values, error: null };
}

/** A manual single image is its own deliberate click; larger grids always ask. */
export function requiresSceneImageConfirmation(total: number): boolean {
  return total > 1;
}

export function randomSceneImageSeed(): number {
  return Math.floor(Math.random() * (SCENE_IMAGE_MAX_SEED + 1));
}

/** Job statuses that must never be rendered as a finished illustration. */
const UNFINISHED_SCENE_IMAGE_STATUSES = new Set(["queued", "pending", "running", "generating", "failed", "cancelled", "error"]);

export function isSceneImageRenderable(item: Pick<SceneImageGalleryItem, "status" | "assetId">): boolean {
  return typeof item.assetId === "string" && item.assetId.length > 0 && !UNFINISHED_SCENE_IMAGE_STATUSES.has(item.status.toLowerCase());
}

export function sceneImageStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "ready" || normalized === "completed" || normalized === "succeeded") return "Ready";
  if (normalized === "queued" || normalized === "pending") return "Queued";
  if (normalized === "running" || normalized === "generating") return "Generating";
  if (normalized === "failed" || normalized === "error") return "Failed";
  if (normalized === "cancelled") return "Cancelled";
  return status;
}

export function formatSceneImageSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return `${seconds.toFixed(1)}s`;
}

export function formatSceneImageCreatedAt(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? createdAt : new Date(parsed).toLocaleString();
}

export function sceneImageAltText(sceneLabel: string, item: Pick<SceneImageGalleryItem, "prompt"> | null, audience: "gm" | "player"): string {
  if (!item) return `Scene illustration for ${sceneLabel}`;
  const prompt = item.prompt.trim();
  // Player alt text never repeats a prompt that may contain GM-only facts.
  if (audience === "gm" && prompt.length > 0) {
    const clipped = prompt.length > 200 ? `${prompt.slice(0, 199).trimEnd()}…` : prompt;
    return `${sceneLabel} — ${clipped}`;
  }
  return `Scene illustration for ${sceneLabel}`;
}

/* ----------------------------- player preferences ----------------------------- */

export const SCENE_IMAGE_PREFERENCES_KEY = "velvet.scene-images.preferences.v1";
export const SCENE_IMAGE_MIN_THUMBNAIL = 96;
export const SCENE_IMAGE_MAX_THUMBNAIL = 320;

export interface SceneImagePreferences {
  /** Keep generated images out of this player's play surface. */
  hideImages: boolean;
  /** Text-only mode: never fetch image bytes until explicitly requested. */
  reducedBandwidth: boolean;
  /** Gallery thumbnail size in pixels. */
  galleryThumbnailSize: number;
}

export const DEFAULT_SCENE_IMAGE_PREFERENCES: SceneImagePreferences = {
  hideImages: false,
  reducedBandwidth: false,
  galleryThumbnailSize: 160,
};

function clampThumbnail(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(SCENE_IMAGE_MIN_THUMBNAIL, Math.min(SCENE_IMAGE_MAX_THUMBNAIL, Math.round(value)))
    : DEFAULT_SCENE_IMAGE_PREFERENCES.galleryThumbnailSize;
}

export function readSceneImagePreferences(): SceneImagePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(SCENE_IMAGE_PREFERENCES_KEY) ?? "null") as Partial<SceneImagePreferences> | null;
    if (!value || typeof value !== "object") return { ...DEFAULT_SCENE_IMAGE_PREFERENCES };
    return {
      hideImages: typeof value.hideImages === "boolean" ? value.hideImages : DEFAULT_SCENE_IMAGE_PREFERENCES.hideImages,
      reducedBandwidth: typeof value.reducedBandwidth === "boolean" ? value.reducedBandwidth : DEFAULT_SCENE_IMAGE_PREFERENCES.reducedBandwidth,
      galleryThumbnailSize: clampThumbnail(value.galleryThumbnailSize),
    };
  } catch {
    return { ...DEFAULT_SCENE_IMAGE_PREFERENCES };
  }
}

export function writeSceneImagePreferences(value: SceneImagePreferences): void {
  try { localStorage.setItem(SCENE_IMAGE_PREFERENCES_KEY, JSON.stringify(value)); }
  catch { /* Display preferences never block play. */ }
}

export function useSceneImagePreferences(): [SceneImagePreferences, (next: SceneImagePreferences) => void] {
  const [preferences, setPreferences] = useState(readSceneImagePreferences);
  const update = (next: SceneImagePreferences) => { setPreferences(next); writeSceneImagePreferences(next); };
  return [preferences, update];
}

/* ------------------------------ scene registry ------------------------------ */

export interface SceneImageSceneRecord {
  sceneKey: string;
  label: string;
  jobIds: string[];
  updatedAt: string;
}

const registryKey = (campaignId: string, sessionId: string) => `velvet.scene-images.scenes.v1:${campaignId}:${sessionId}`;

export function readSceneImageScenes(campaignId: string, sessionId: string): SceneImageSceneRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(registryKey(campaignId, sessionId)) ?? "null") as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.sceneKey !== "string" || typeof record.label !== "string") return [];
      const jobIds = Array.isArray(record.jobIds) ? record.jobIds.filter((jobId): jobId is string => typeof jobId === "string") : [];
      return [{ sceneKey: record.sceneKey, label: record.label, jobIds, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "" }];
    });
  } catch { return []; }
}

/** Remembers the client-side job-to-scene binding the gallery projection omits. */
export function rememberSceneImageJobs(campaignId: string, sessionId: string, input: { sceneKey: string; label: string; jobIds: readonly string[] }): SceneImageSceneRecord[] {
  const records = readSceneImageScenes(campaignId, sessionId);
  const existing = records.find((record) => record.sceneKey === input.sceneKey);
  const jobIds = input.jobIds.filter((jobId) => jobId.length > 0);
  const next: SceneImageSceneRecord = existing
    ? { ...existing, label: input.label || existing.label, jobIds: [...new Set([...existing.jobIds, ...jobIds])], updatedAt: new Date().toISOString() }
    : { sceneKey: input.sceneKey, label: input.label, jobIds: [...new Set(jobIds)], updatedAt: new Date().toISOString() };
  const updated = [next, ...records.filter((record) => record.sceneKey !== input.sceneKey)];
  try { localStorage.setItem(registryKey(campaignId, sessionId), JSON.stringify(updated)); }
  catch { /* Grouping falls back to the active scene only. */ }
  return updated;
}

export function findSceneImageRecord(records: readonly SceneImageSceneRecord[], jobId: string): SceneImageSceneRecord | null {
  return records.find((record) => record.jobIds.includes(jobId)) ?? null;
}

function sceneKeyForImage(image: SceneImageGalleryItem, records: readonly SceneImageSceneRecord[]): string | null {
  return image.sceneKey ?? findSceneImageRecord(records, image.jobId)?.sceneKey ?? null;
}

function newestFirst(images: readonly SceneImageGalleryItem[]): SceneImageGalleryItem[] {
  return [...images].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/** The selected illustration for one active scene, or null when none is known. */
export function findActiveSceneImage(images: readonly SceneImageGalleryItem[], sceneKey: string, records: readonly SceneImageSceneRecord[]): SceneImageGalleryItem | null {
  const ready = newestFirst(images.filter(isSceneImageRenderable));
  if (ready.length === 0) return null;
  const exactSelected = ready.find((image) => image.selected && sceneKeyForImage(image, records) === sceneKey);
  if (exactSelected) return exactSelected;
  const unboundSelected = ready.find((image) => image.selected && sceneKeyForImage(image, records) === null);
  if (unboundSelected) return unboundSelected;
  return ready.find((image) => sceneKeyForImage(image, records) === sceneKey) ?? null;
}

export interface SceneImageGroup {
  sceneKey: string;
  label: string;
  images: SceneImageGalleryItem[];
  active: boolean;
}

/**
 * Groups a session gallery by scene. The active scene is always present (even
 * empty) so the DM can select into it; images without any scene binding land
 * in a trailing "Other generated images" group.
 */
export function groupSceneImages(images: readonly SceneImageGalleryItem[], records: readonly SceneImageSceneRecord[], activeSceneKey: string, activeSceneLabel: string): SceneImageGroup[] {
  const groups = new Map<string, SceneImageGroup>();
  groups.set(activeSceneKey, { sceneKey: activeSceneKey, label: activeSceneLabel, images: [], active: true });
  const other: SceneImageGalleryItem[] = [];
  for (const image of newestFirst(images)) {
    const sceneKey = sceneKeyForImage(image, records);
    if (sceneKey === null) { other.push(image); continue; }
    if (!groups.has(sceneKey)) {
      const record = records.find((entry) => entry.sceneKey === sceneKey);
      groups.set(sceneKey, { sceneKey, label: record?.label ?? image.sceneKey ?? sceneKey, images: [], active: sceneKey === activeSceneKey });
    }
    groups.get(sceneKey)!.images.push(image);
  }
  const ordered = [...groups.values()].filter((group) => group.active || group.images.length > 0);
  ordered.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const leftTime = left.images[0] ? Date.parse(left.images[0].createdAt) : 0;
    const rightTime = right.images[0] ? Date.parse(right.images[0].createdAt) : 0;
    return rightTime - leftTime;
  });
  if (other.length > 0) ordered.push({ sceneKey: "other", label: "Other generated images", images: other, active: false });
  return ordered;
}
