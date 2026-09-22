import { useEffect, useState } from "react";
import { ATLAS_TOOLS, type AtlasDrawerSide, type AtlasTool } from "./PlaySurface";

export type CampaignTheme = "system" | "light" | "dark" | "contrast";
export type CampaignDensity = "compact" | "comfortable" | "spacious";
export type CampaignContextWidget = "location" | "cast" | "objectives" | "resources" | "encounter";

export interface CampaignWorkbenchPreferences {
  theme: CampaignTheme;
  density: CampaignDensity;
  contextVisible: boolean;
  quickToolsVisible: boolean;
  contextWidth: number;
  quickToolsWidth: number;
  widgets: CampaignContextWidget[];
  /** Per-tool screen edge for the Command Center tool drawers. */
  drawerSides: Record<AtlasTool, AtlasDrawerSide>;
  /** Automatic receipt-bound narration retry after a deterministic mechanics-only turn. */
  autoNarrateMechanics: boolean;
}

export const CAMPAIGN_WORKBENCH_PREFERENCES_KEY = "velvet.campaign-workbench.v1";
export const CAMPAIGN_CONTEXT_WIDGETS: readonly CampaignContextWidget[] = ["location", "cast", "objectives", "resources", "encounter"];

/** Every tool defaults to the right edge; Command Center readers override per tool. */
export function defaultCampaignDrawerSides(): Record<AtlasTool, AtlasDrawerSide> {
  return Object.fromEntries(ATLAS_TOOLS.map((tool) => [tool, "right"])) as Record<AtlasTool, AtlasDrawerSide>;
}

export const DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES: CampaignWorkbenchPreferences = {
  theme: "system",
  density: "comfortable",
  contextVisible: true,
  quickToolsVisible: true,
  contextWidth: 280,
  quickToolsWidth: 300,
  widgets: [...CAMPAIGN_CONTEXT_WIDGETS],
  drawerSides: defaultCampaignDrawerSides(),
  autoNarrateMechanics: true,
};

const themes = new Set<CampaignTheme>(["system", "light", "dark", "contrast"]);
const densities = new Set<CampaignDensity>(["compact", "comfortable", "spacious"]);
const drawerSideValues = new Set<AtlasDrawerSide>(["left", "right"]);
const clampWidth = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(220, Math.min(520, Math.round(value))) : fallback;

function readDrawerSides(value: unknown): Record<AtlasTool, AtlasDrawerSide> {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sides = defaultCampaignDrawerSides();
  for (const tool of ATLAS_TOOLS) {
    const side = stored[tool];
    if (typeof side === "string" && drawerSideValues.has(side as AtlasDrawerSide)) sides[tool] = side as AtlasDrawerSide;
  }
  return sides;
}

export function readCampaignWorkbenchPreferences(): CampaignWorkbenchPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY) ?? "null") as Partial<CampaignWorkbenchPreferences> | null;
    if (!value) return { ...DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES, widgets: [...CAMPAIGN_CONTEXT_WIDGETS], drawerSides: defaultCampaignDrawerSides() };
    const ordered = Array.isArray(value.widgets)
      ? value.widgets.filter((widget): widget is CampaignContextWidget => CAMPAIGN_CONTEXT_WIDGETS.includes(widget as CampaignContextWidget))
      : [];
    return {
      theme: typeof value.theme === "string" && themes.has(value.theme as CampaignTheme) ? value.theme as CampaignTheme : "system",
      density: typeof value.density === "string" && densities.has(value.density as CampaignDensity) ? value.density as CampaignDensity : "comfortable",
      contextVisible: typeof value.contextVisible === "boolean" ? value.contextVisible : true,
      quickToolsVisible: typeof value.quickToolsVisible === "boolean" ? value.quickToolsVisible : true,
      contextWidth: clampWidth(value.contextWidth, DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES.contextWidth),
      quickToolsWidth: clampWidth(value.quickToolsWidth, DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES.quickToolsWidth),
      // Persisted v1 payloads written before drawer sides lack the key; migration keeps
      // every tool on the right edge rather than inventing a side for unknown tools.
      drawerSides: readDrawerSides(value.drawerSides),
      // Persisted payloads written before automatic mechanics narration lack the key;
      // migration keeps the enabled default rather than silently disabling provider prose.
      autoNarrateMechanics: typeof value.autoNarrateMechanics === "boolean" ? value.autoNarrateMechanics : true,
      widgets: [...new Set(ordered)],
    };
  } catch {
    return { ...DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES, widgets: [...CAMPAIGN_CONTEXT_WIDGETS], drawerSides: defaultCampaignDrawerSides() };
  }
}

export function applyCampaignWorkbenchPreferences(value: Pick<CampaignWorkbenchPreferences, "theme" | "density">): void {
  document.documentElement.dataset.theme = value.theme;
  document.documentElement.dataset.density = value.density;
}

export function applyStoredCampaignWorkbenchPreferences(): void {
  applyCampaignWorkbenchPreferences(readCampaignWorkbenchPreferences());
}

export function useCampaignWorkbenchPreferences(): [CampaignWorkbenchPreferences, (next: CampaignWorkbenchPreferences) => void] {
  const [preferences, setPreferences] = useState(readCampaignWorkbenchPreferences);
  useEffect(() => {
    applyCampaignWorkbenchPreferences(preferences);
  }, [preferences]);
  const update = (next: CampaignWorkbenchPreferences) => {
    setPreferences(next); applyCampaignWorkbenchPreferences(next);
    try { localStorage.setItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY, JSON.stringify(next)); }
    catch { /* Presentation preferences never block campaign play. */ }
  };
  return [preferences, update];
}
