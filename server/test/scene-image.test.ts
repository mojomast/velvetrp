import { describe, expect, it } from "vitest";
import {
  PROMPT_WORD_TARGET,
  SCENE_PROMPT_MAX_CHARS,
  SCENE_PROMPT_PRESETS,
  buildScenePrompt,
  countScenePromptWords,
  estimateScenePromptTokens,
  filterSceneFacts,
  planSceneBatch,
  requiresConfirmation,
  scenePromptLengthReport,
  scenePromptTruncationWarning,
  visibleNameFallback,
  type SceneFact,
  type SceneFactVisibility,
  type ScenePromptInput,
} from "../src/image/scenePrompt.js";
import {
  DEFAULT_SCENE_IMAGE_SETTINGS,
  SCENE_IMAGE_PRESETS,
  applySceneImagePreset,
  cloneSceneImageSettings,
  mergeSceneImageSettings,
  nextCooldownAt,
  parseSceneImageSettings,
  sceneImageCacheKey,
  validateSceneImageSettings,
  withinAutoLimits,
  type SceneImageSettings,
} from "../src/image/settings.js";

const richFacts: SceneFact[] = [
  { label: "a cracked stone well at the centre of the yard", visibility: "public" },
  { label: "the hidden assassin Vex waits behind the mill wheel", visibility: "gm" },
  { label: "a secret door behind the mill wheel hides unrevealed treasure", visibility: "secret" },
];

const richScene: ScenePromptInput = {
  locationName: "Ruined mill at Blackwater",
  focalFeature: "a broken waterwheel above a still pond",
  composition: "wide establishing shot from across the pond",
  lighting: "overcast late-afternoon light with thin mist",
  materials: ["weathered granite", "moss", "rusted iron"],
  stylePhrase: "muted painterly fantasy illustration",
  facts: richFacts,
};

const compactScene: ScenePromptInput = {
  locationName: "Ruined mill",
  focalFeature: "a broken waterwheel",
  composition: "",
  lighting: "overcast light",
  materials: ["granite", "moss"],
  stylePhrase: "muted fantasy",
  facts: [{ label: "a cracked stone well at the centre", visibility: "public" }],
};

describe("scene prompt builder", () => {
  it("orders the clause stages and pins the square-image constraints", () => {
    const prompt = buildScenePrompt(richScene, { audience: "dm" });
    const markers = [
      "Ruined mill at Blackwater",
      "broken waterwheel",
      "wide establishing shot",
      "overcast late-afternoon",
      "Materials and environment",
      "Campaign art style",
    ];
    const positions = markers.map((marker) => prompt.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(prompt).toContain("strong silhouette");
    expect(prompt).toContain("few recognizable features");
    expect(prompt).toContain("256x256");
    expect(prompt).toContain("lettering");
    expect(prompt).toContain("unoccupied scenery");
  });

  it("filters spoilers by audience and never leaks hidden names to players", () => {
    const player = buildScenePrompt(richScene);
    expect(player).toContain("cracked stone well");
    expect(player).not.toContain("Vex");
    expect(player).not.toContain("assassin");
    expect(player).not.toContain("secret door");
    expect(player).not.toContain("unrevealed treasure");
    const dm = buildScenePrompt(richScene, "dm");
    expect(dm).toContain("cracked stone well");
    expect(dm).toContain("Vex");
    expect(dm).not.toContain("secret door");
    expect(dm).not.toContain("unrevealed treasure");
    expect(filterSceneFacts(richFacts, "player")).toHaveLength(1);
    expect(filterSceneFacts(richFacts, "dm")).toHaveLength(2);
    expect(filterSceneFacts([{ label: "unknown", visibility: "later" as SceneFactVisibility }], "dm")).toHaveLength(0);
    expect(filterSceneFacts(richFacts, "dm").map((fact) => fact.label)).not.toContain("a secret door behind the mill wheel hides unrevealed treasure");
  });

  it("hits the word target with a compact scene and enforces the hard character cap", () => {
    const compact = buildScenePrompt(compactScene);
    const words = countScenePromptWords(compact);
    expect(words).toBeGreaterThanOrEqual(PROMPT_WORD_TARGET.min);
    expect(words).toBeLessThanOrEqual(PROMPT_WORD_TARGET.max);
    expect(scenePromptLengthReport(compact).withinWordTarget).toBe(true);
    expect(scenePromptTruncationWarning(compact)).toBeNull();
    const huge = buildScenePrompt({
      ...compactScene,
      focalFeature: "x".repeat(4_000),
      materials: Array.from({ length: 8 }, () => "y".repeat(200)),
    });
    expect(huge.length).toBeLessThanOrEqual(SCENE_PROMPT_MAX_CHARS);
    expect(huge.endsWith("…")).toBe(true);
    expect(scenePromptTruncationWarning(huge)).toMatch(/128-token/);
    expect(estimateScenePromptTokens("wide establishing shot ".repeat(60))).toBeGreaterThan(128);
  });

  it("converts fictional names to visible fallback phrases without echoing them", () => {
    const generic = visibleNameFallback("Vex the Unseen");
    expect(generic).not.toMatch(/vex/i);
    expect(generic).toMatch(/^a figure with/);
    const hinted = visibleNameFallback("Ash-Barrow");
    expect(hinted).not.toMatch(/ash|barrow/i);
    expect(hinted).toMatch(/ember/);
    expect(visibleNameFallback("")).toMatch(/distinct silhouette/);
  });
});

describe("scene batch planning", () => {
  it("expands count × steps × guidance and reuses the same seeds across combinations", () => {
    const plan = planSceneBatch({ count: 2, steps: [10, 20], guidance: [1, 3], baseSeed: 100 });
    expect(plan.total).toBe(8);
    expect(plan.variants).toHaveLength(8);
    expect(plan.seeds).toEqual([100, 101]);
    const seeds = plan.variants.map((variant) => variant.seed);
    expect(new Set(seeds)).toEqual(new Set([100, 101]));
    expect(seeds.filter((seed) => seed === 100)).toHaveLength(4);
    expect(plan.variants[0]).toEqual({ index: 0, seed: 100, steps: 10, guidance: 1 });
    expect(plan.variants[7]).toEqual({ index: 7, seed: 101, steps: 20, guidance: 3 });
    expect(new Set(plan.variants.map((variant) => `${variant.seed}:${variant.steps}:${variant.guidance}`)).size).toBe(8);
    const defaulted = planSceneBatch({ count: 1, steps: [20], guidance: [3] });
    expect(defaulted.seeds).toEqual([0]);
  });

  it("rejects oversized, over-wide, and out-of-bounds plans", () => {
    expect(() => planSceneBatch({ count: 3, steps: [10, 20, 30, 40, 50, 60, 70, 80], guidance: [1, 3, 5, 6, 7, 8] }))
      .toThrow(/exceeds the 128 image limit/);
    expect(() => planSceneBatch({ count: 33, steps: [20], guidance: [3] })).toThrow(/count/);
    expect(() => planSceneBatch({ count: 1, steps: Array.from({ length: 9 }, () => 20), guidance: [3] })).toThrow(/at most 8/);
    expect(() => planSceneBatch({ count: 1, steps: [5], guidance: [3] })).toThrow(/steps values must be between/);
    expect(() => planSceneBatch({ count: 1, steps: [20.5], guidance: [3] })).toThrow(/steps values must be integers/);
    expect(() => planSceneBatch({ count: 1, steps: [20], guidance: [99] })).toThrow(/guidance values must be between/);
    expect(() => planSceneBatch({ count: 1, steps: [20], guidance: [3], baseSeed: -1 })).toThrow(/baseSeed/);
    expect(planSceneBatch({ count: 2, steps: [10, 20, 30, 40, 50, 60, 70, 100], guidance: [1, 3, 5, 6, 7, 8] }).total).toBe(96);
    expect(planSceneBatch({ count: 2, steps: [10, 20, 30, 40, 50, 60, 70, 100], guidance: [1, 2, 3, 4, 5, 6, 7, 8] }).total).toBe(128);
  });

  it("keeps automatic mode at one image and asks before larger grids", () => {
    expect(requiresConfirmation(0, "automatic")).toBe(false);
    expect(requiresConfirmation(1, "automatic")).toBe(false);
    expect(requiresConfirmation(8, "automatic")).toBe(true);
    expect(requiresConfirmation(1, "manual")).toBe(false);
    expect(requiresConfirmation(4, "manual")).toBe(true);
    expect(requiresConfirmation(0, "off")).toBe(false);
    expect(requiresConfirmation(1, "off")).toBe(true);
    expect(() => requiresConfirmation(-1, "manual")).toThrow(/non-negative/);
  });
});

describe("scene image settings", () => {
  it("parses the strict defaults and rejects unknown or out-of-bounds settings", () => {
    expect(parseSceneImageSettings({})).toEqual(DEFAULT_SCENE_IMAGE_SETTINGS);
    expect(parseSceneImageSettings()).toEqual(DEFAULT_SCENE_IMAGE_SETTINGS);
    expect(DEFAULT_SCENE_IMAGE_SETTINGS).toMatchObject({
      enabled: true,
      mode: "automatic",
      steps: 20,
      guidance: 3,
      seedMode: "random",
      variationCount: 1,
      autoPerSessionLimit: 1,
      cooldownSeconds: 0,
      bandwidth: "full",
      hideImages: false,
      advancedOnlyDm: true,
    });
    const invalid = validateSceneImageSettings({ steps: 1_000, mystery: true });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.issues.join(" ")).toMatch(/unknown setting "mystery"/);
      expect(invalid.issues.join(" ")).toMatch(/steps/);
    }
    expect(() => parseSceneImageSettings({ mode: "sometimes" })).toThrow(/mode/);
    expect(() => parseSceneImageSettings({ guidance: 12 })).toThrow(/guidance/);
    expect(() => parseSceneImageSettings({ variationCount: 0 })).toThrow(/variationCount/);
    expect(() => parseSceneImageSettings({ bandwidth: "tiny" })).toThrow(/bandwidth/);
    expect(() => parseSceneImageSettings({ cooldownSeconds: -1 })).toThrow(/cooldownSeconds/);
    expect(() => parseSceneImageSettings({ promptOverrides: { ["k".repeat(65)]: "x" } })).toThrow(/promptOverrides/);
  });

  it("clones and merges without aliasing nested overrides", () => {
    const base = parseSceneImageSettings({ enabled: true, mode: "manual", promptOverrides: { "scene.prompt": "keep" }, steps: 20 });
    const clone = cloneSceneImageSettings(base);
    expect(clone).toEqual(base);
    expect(clone.promptOverrides).not.toBe(base.promptOverrides);
    const clonedOverrides = clone.promptOverrides as Record<string, string>;
    clonedOverrides["scene.prompt"] = "changed";
    expect(base.promptOverrides["scene.prompt"]).toBe("keep");
    const merged = mergeSceneImageSettings(base, { enabled: false, promptOverrides: { "scene.style": "added", "scene.prompt": "replaced" } });
    expect(merged.enabled).toBe(false);
    expect(merged.mode).toBe("manual");
    expect(merged.promptOverrides).toEqual({ "scene.prompt": "replaced", "scene.style": "added" });
    expect(base.enabled).toBe(true);
    expect(() => mergeSceneImageSettings(base, { steps: 1 })).toThrow(/steps/);
  });

  it("applies workflow presets and labels them as defaults, not quality tiers", () => {
    expect(SCENE_IMAGE_PRESETS.preview).toMatchObject({ steps: 10, guidance: 3 });
    expect(SCENE_IMAGE_PRESETS.balanced).toMatchObject({ steps: 20, guidance: 3 });
    expect(SCENE_IMAGE_PRESETS.reference).toMatchObject({ steps: 50, guidance: 3 });
    expect(SCENE_IMAGE_PRESETS.experimentalGuidance1).toMatchObject({ steps: 20, guidance: 1 });
    expect(SCENE_PROMPT_PRESETS.reference.steps).toBe(50);
    expect(SCENE_IMAGE_PRESETS.experimentalGuidance1.description).toMatch(/weaker/);
    const base = parseSceneImageSettings({ enabled: true, mode: "manual" });
    expect(applySceneImagePreset(base, "reference")).toMatchObject({ steps: 50, guidance: 3, enabled: true, mode: "manual" });
    expect(applySceneImagePreset(base, "experimentalGuidance1")).toMatchObject({ steps: 20, guidance: 1 });
    expect(() => applySceneImagePreset(base, "turbo")).toThrow(/Unknown scene-image preset/);
  });

  it("keeps cache keys stable and omits an unavailable model version", () => {
    const base = sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 3 });
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 3 })).toBe(base);
    expect(sceneImageCacheKey({ prompt: "a ruined mill ", seed: 7, steps: 20, guidance: 3 })).toBe(base);
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 3, modelVersion: null })).toBe(base);
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 3, modelVersion: "" })).toBe(base);
    const versioned = sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 3, modelVersion: "supra2-img-v3" });
    expect(versioned).not.toBe(base);
    expect(versioned).toMatch(/^scene-image:[0-9a-f]{48}$/);
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 8, steps: 20, guidance: 3 })).not.toBe(base);
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 50, guidance: 3 })).not.toBe(base);
    expect(sceneImageCacheKey({ prompt: "a ruined mill", seed: 7, steps: 20, guidance: 1 })).not.toBe(base);
    expect(sceneImageCacheKey({ prompt: "another mill", seed: 7, steps: 20, guidance: 3 })).not.toBe(base);
    expect(() => sceneImageCacheKey({ prompt: " ", seed: 7, steps: 20, guidance: 3 })).toThrow(/prompt/);
  });
});

describe("scene image automatic limits", () => {
  const now = new Date("2030-01-01T12:00:00.000Z");
  const automatic: SceneImageSettings = parseSceneImageSettings({ enabled: true, mode: "automatic", autoPerSessionLimit: 2, cooldownSeconds: 60 });

  it("allows unattended images only inside the per-session limit and cooldown", () => {
    expect(withinAutoLimits({ imagesThisSession: 0, lastGeneratedAt: null }, automatic, now))
      .toMatchObject({ allowed: true, reason: "allowed", remaining: 2, cooldownEndsAt: null });
    expect(withinAutoLimits({ imagesThisSession: 2, lastGeneratedAt: null }, automatic, now))
      .toMatchObject({ allowed: false, reason: "session-limit", remaining: 0 });
    const cooling = withinAutoLimits({ imagesThisSession: 1, lastGeneratedAt: "2030-01-01T11:59:30.000Z" }, automatic, now);
    expect(cooling).toMatchObject({ allowed: false, reason: "cooldown", remaining: 1, cooldownEndsAt: "2030-01-01T12:00:30.000Z" });
    const warmed = withinAutoLimits({ imagesThisSession: 1, lastGeneratedAt: "2030-01-01T11:58:00.000Z" }, automatic, now);
    expect(warmed).toMatchObject({ allowed: true, reason: "allowed", remaining: 1 });
  });

  it("keeps the automatic path closed when disabled, manual, or limited to zero", () => {
    expect(withinAutoLimits({ imagesThisSession: 0, lastGeneratedAt: null }, parseSceneImageSettings({ enabled: false, mode: "automatic" }), now).reason)
      .toBe("disabled");
    expect(withinAutoLimits({ imagesThisSession: 0, lastGeneratedAt: null }, parseSceneImageSettings({ enabled: true, mode: "manual" }), now).reason)
      .toBe("manual");
    expect(withinAutoLimits({ imagesThisSession: 0, lastGeneratedAt: null }, parseSceneImageSettings({ enabled: true, mode: "automatic", autoPerSessionLimit: 0 }), now).reason)
      .toBe("session-limit");
  });

  it("computes cooldown ends purely from the injected state", () => {
    expect(nextCooldownAt("2030-01-01T11:59:30.000Z", 60)).toBe("2030-01-01T12:00:30.000Z");
    expect(nextCooldownAt("2030-01-01T11:59:30.000Z", 0)).toBeNull();
    expect(nextCooldownAt(null, 60)).toBeNull();
    expect(nextCooldownAt("not-a-date", 60)).toBeNull();
  });
});
