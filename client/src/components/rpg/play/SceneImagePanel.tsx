import { useEffect, useMemo, useState } from "react";
import type { SceneImageApi, SceneImageGalleryItem, SceneImageSettings } from "../../../api";
import { ApiError } from "../../../api";
import { createClientId } from "../../../utils/clientId";
import {
  SCENE_IMAGE_AUTO_SESSION_LIMIT_MAX,
  SCENE_IMAGE_AUTO_SESSION_LIMIT_MIN,
  SCENE_IMAGE_COOLDOWN_MAX_SECONDS,
  SCENE_IMAGE_COOLDOWN_MIN_SECONDS,
  SCENE_IMAGE_GUIDANCE_MAX,
  SCENE_IMAGE_GUIDANCE_MIN,
  SCENE_IMAGE_MAX_SEED,
  SCENE_IMAGE_MIN_SEED,
  SCENE_IMAGE_MIN_THUMBNAIL,
  SCENE_IMAGE_MAX_THUMBNAIL,
  SCENE_IMAGE_PRESETS,
  SCENE_IMAGE_PRESET_NOTE,
  SCENE_IMAGE_STEPS_MAX,
  SCENE_IMAGE_STEPS_MIN,
  SCENE_IMAGE_VARIATION_MAX,
  SCENE_IMAGE_VARIATION_MIN,
  findActiveSceneImage,
  formatSceneImageCreatedAt,
  formatSceneImageSeconds,
  groupSceneImages,
  parseSceneImageAxis,
  planSceneImageComparison,
  randomSceneImageSeed,
  readSceneImageScenes,
  rememberSceneImageJobs,
  requiresSceneImageConfirmation,
  sceneImageAltText,
  sceneImageStatusLabel,
  useSceneImagePreferences,
  type SceneImageComparisonPlan,
  type SceneImagePreset,
} from "./sceneImages";
import "./sceneImages.css";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function receiptRevisionAfter(receipt: Record<string, unknown>): number | null {
  const value = receipt.revisionAfter;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

type GalleryLoad = { state: "loading" } | { state: "ready"; images: SceneImageGalleryItem[] } | { state: "error" };
type PanelNotice = { kind: "status" | "alert"; text: string } | null;

export interface SceneIllustrationProps {
  campaignId: string;
  sessionId: string;
  sceneKey: string;
  sceneLabel: string;
  /** Player-visible location description shown as a small caption under the image. */
  sceneDescription?: string;
  audience: "gm" | "player";
  /** Feature discovery: this component renders nothing while the images flag is off. */
  enabled: boolean;
  api: SceneImageApi;
  onOpenControls?: () => void;
}

/**
 * Selected illustration for the active scene. Image loading never blocks the
 * narration surface: an unloaded, missing, or broken image always degrades to
 * a text-only line, and local preferences can keep bytes off the wire.
 */
export function SceneIllustration({ campaignId, sessionId, sceneKey, sceneLabel, sceneDescription, audience, enabled, api, onOpenControls }: SceneIllustrationProps) {
  const [preferences, updatePreferences] = useSceneImagePreferences();
  const [gallery, setGallery] = useState<GalleryLoad>({ state: "loading" });
  const [display, setDisplay] = useState<"loading" | "ready" | "error">("loading");
  const [refreshRequest, setRefreshRequest] = useState(0);
  const fetching = enabled && !preferences.hideImages && !preferences.reducedBandwidth;

  useEffect(() => {
    if (!fetching) return;
    let current = true;
    setGallery({ state: "loading" });
    void api.getGallery(campaignId, sessionId).then((value) => {
      if (current) setGallery({ state: "ready", images: value.images });
    }).catch(() => { if (current) setGallery({ state: "error" }); });
    return () => { current = false; };
  }, [api, campaignId, fetching, refreshRequest, sessionId]);

  const records = useMemo(() => readSceneImageScenes(campaignId, sessionId), [campaignId, sessionId, gallery]);
  const image = gallery.state === "ready" ? findActiveSceneImage(gallery.images, sceneKey, records) : null;
  useEffect(() => { setDisplay("loading"); }, [image?.assetId]);

  if (!enabled) return null;
  const alt = sceneImageAltText(sceneLabel, image, audience);
  return <section className="scene-illustration" aria-label="Scene illustration" data-scene-key={sceneKey}>
    <header className="scene-illustration-heading">
      <p className="scene-illustration-scene"><span>SCENE</span> <strong>{sceneLabel}</strong></p>
      <div className="scene-illustration-preferences" role="group" aria-label="Scene image preferences">
        <label><input type="checkbox" checked={preferences.hideImages} onChange={(event) => updatePreferences({ ...preferences, hideImages: event.target.checked })} /> Hide images</label>
        <label><input type="checkbox" checked={preferences.reducedBandwidth} onChange={(event) => updatePreferences({ ...preferences, reducedBandwidth: event.target.checked })} /> Text-only</label>
        {audience === "gm" && onOpenControls && <button type="button" className="ghost" onClick={onOpenControls}>Scene image controls</button>}
      </div>
    </header>
    {preferences.hideImages
      ? <p className="scene-illustration-fallback">Images are hidden by your local preference. Narration continues as text.</p>
      : preferences.reducedBandwidth
        ? <p className="scene-illustration-fallback">Text-only mode is on; no image data is requested.</p>
        : gallery.state === "error"
          ? <div className="scene-illustration-fallback"><p>An illustration is unavailable for this scene; narration continues as text.</p><button type="button" className="ghost" onClick={() => setRefreshRequest((value) => value + 1)}>Retry illustration</button></div>
          : !image
            ? (gallery.state === "loading"
              ? <p role="status" className="scene-illustration-fallback">Loading scene illustration…</p>
              : <p className="scene-illustration-fallback">No illustration has been selected for this scene yet.</p>)
            : display === "error"
              ? <p className="scene-illustration-fallback">The illustration could not be displayed; narration continues as text.</p>
              : <figure className="scene-illustration-figure">
                <img src={api.assetUrl(campaignId, image.assetId)} alt={alt} loading="lazy" decoding="async"
                  onLoad={() => setDisplay("ready")} onError={() => setDisplay("error")} />
                {display === "loading" && <figcaption role="status">Loading illustration…</figcaption>}
              </figure>}
    {sceneDescription ? <p className="scene-illustration-caption" title={sceneDescription}>{sceneDescription}</p> : null}
  </section>;
}

export interface SceneImageDmPanelProps {
  campaignId: string;
  sessionId: string;
  sceneKey: string;
  sceneLabel: string;
  api: SceneImageApi;
  /** Owner/GM only; the play surface also keeps this panel behind the images flag. */
  canManage: boolean;
  enabled: boolean;
}

/** DM generation settings, advanced comparison grid, and the session gallery. */
export function SceneImageDmPanel({ campaignId, sessionId, sceneKey, sceneLabel, api, canManage, enabled }: SceneImageDmPanelProps) {
  const [preferences, updatePreferences] = useSceneImagePreferences();
  const [settings, setSettings] = useState<SceneImageSettings | null>(null);
  const [settingsState, setSettingsState] = useState<"loading" | "ready" | "error">("loading");
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [dispatching, setDispatching] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonSteps, setComparisonSteps] = useState("");
  const [comparisonGuidance, setComparisonGuidance] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [images, setImages] = useState<SceneImageGalleryItem[]>([]);
  const [galleryState, setGalleryState] = useState<"loading" | "ready" | "error">("loading");
  const [galleryRefresh, setGalleryRefresh] = useState(0);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [expanded, setExpanded] = useState<SceneImageGalleryItem | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [loadedThumbs, setLoadedThumbs] = useState<string[]>([]);
  const audience = canManage ? "gm" as const : "player" as const;

  useEffect(() => {
    let current = true;
    setSettingsState("loading");
    void api.getSettings(campaignId).then((value) => {
      if (!current) return;
      setSettings(value.settings); setRevision(value.revision); setSettingsState("ready");
    }).catch(() => { if (current) setSettingsState("error"); });
    return () => { current = false; };
  }, [api, campaignId, settingsRefresh]);

  const promptOverrides = settings?.promptOverrides;
  useEffect(() => {
    if (!promptOverrides) return;
    setPrompt(promptOverrides[sceneKey] ?? "");
  }, [promptOverrides, sceneKey]);

  useEffect(() => {
    let current = true;
    setGalleryState("loading");
    void api.getGallery(campaignId, sessionId).then((value) => {
      if (!current) return;
      setImages(value.images); setGalleryState("ready");
    }).catch(() => { if (current) setGalleryState("error"); });
    return () => { current = false; };
  }, [api, campaignId, galleryRefresh, sessionId]);

  const records = useMemo(() => readSceneImageScenes(campaignId, sessionId), [campaignId, sessionId, galleryRefresh]);
  const groups = useMemo(() => groupSceneImages(images, records, sceneKey, sceneLabel), [images, records, sceneKey, sceneLabel]);
  const compared = compareIds.flatMap((assetId) => images.find((item) => item.assetId === assetId) ?? []);

  const stepAxis = useMemo(() => parseSceneImageAxis(comparisonSteps, "steps"), [comparisonSteps]);
  const guidanceAxis = useMemo(() => parseSceneImageAxis(comparisonGuidance, "guidance"), [comparisonGuidance]);
  const comparisonPlan = useMemo<SceneImageComparisonPlan | null>(() => {
    if (!settings || stepAxis.error || guidanceAxis.error) return null;
    try {
      return planSceneImageComparison({ count: settings.variationCount, steps: stepAxis.values, guidance: guidanceAxis.values, baseSeed: settings.fixedSeed });
    } catch { return null; }
  }, [guidanceAxis.error, guidanceAxis.values, settings, stepAxis.error, stepAxis.values]);
  const comparisonError = stepAxis.error ?? guidanceAxis.error;
  const comparisonTotal = comparisonPlan?.total ?? 0;
  const comparisonNeedsConfirmation = comparisonTotal > 0 && requiresSceneImageConfirmation(comparisonTotal);
  const comparisonReady = Boolean(comparisonPlan) && (!comparisonNeedsConfirmation || confirmed);

  function updateSettings(patch: Partial<SceneImageSettings>): void {
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  function applyPreset(preset: SceneImagePreset): void {
    updateSettings({ steps: preset.steps, guidance: preset.guidance });
    setConfirmed(false);
    setNotice({ kind: "status", text: `${preset.label} applied to the form. Save settings to persist this workflow default.` });
  }

  async function saveSettings(): Promise<void> {
    if (!settings || dispatching) return;
    setDispatching(true); setNotice(null);
    try {
      const overrides = prompt.trim().length > 0
        ? { ...settings.promptOverrides, [sceneKey]: prompt.trim() }
        : Object.fromEntries(Object.entries(settings.promptOverrides).filter(([key]) => key !== sceneKey));
      const result = await api.putSettings(campaignId, { expectedRevision: revision, idempotencyKey: createClientId(), settings: { ...settings, promptOverrides: overrides } });
      setSettings(result.settings); setRevision(result.revision);
      setNotice({ kind: "status", text: "Scene-image settings saved." });
    } catch (error) {
      setNotice({ kind: "alert", text: errorMessage(error, "The settings change was not confirmed. Reload settings before retrying.") });
    } finally { setDispatching(false); }
  }

  async function submitGeneration(request: { prompt?: string; seed?: number; steps?: number; guidance?: number; count?: number }): Promise<boolean> {
    if (dispatching) return false;
    setDispatching(true); setNotice(null);
    try {
      const result = await api.generate(campaignId, {
        sessionId, sceneKey, idempotencyKey: createClientId(),
        ...(request.prompt && request.prompt.trim().length > 0 ? { prompt: request.prompt.trim() } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.steps !== undefined ? { steps: request.steps } : {}),
        ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
        ...(request.count !== undefined ? { count: request.count } : {}),
      });
      rememberSceneImageJobs(campaignId, sessionId, { sceneKey, label: sceneLabel, jobIds: [result.job.jobId] });
      setGalleryRefresh((value) => value + 1);
      setNotice({ kind: "status", text: result.deduped
        ? "An identical generation already existed, so the existing image was reused."
        : `Generation ${sceneImageStatusLabel(result.job.status).toLowerCase()} for ${sceneLabel}.` });
      return true;
    } catch (error) {
      setNotice({ kind: "alert", text: errorMessage(error, "The generation request was not confirmed. Nothing is retried automatically.") });
      return false;
    } finally { setDispatching(false); }
  }

  async function generateManual(): Promise<void> {
    if (!settings) return;
    await submitGeneration({ prompt, seed: settings.seedMode === "fixed" ? settings.fixedSeed : undefined, steps: settings.steps, guidance: settings.guidance, count: settings.variationCount });
  }

  async function submitComparison(): Promise<void> {
    if (!settings || !comparisonPlan || !comparisonReady || dispatching) return;
    const baseSeed = settings.seedMode === "fixed" ? settings.fixedSeed : randomSceneImageSeed();
    setDispatching(true); setNotice(null);
    let completed = 0;
    try {
      for (const request of comparisonPlan.requests) {
        const result = await api.generate(campaignId, {
          sessionId, sceneKey, idempotencyKey: createClientId(),
          ...(prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
          seed: baseSeed, steps: request.steps, guidance: request.guidance, count: request.count,
        });
        rememberSceneImageJobs(campaignId, sessionId, { sceneKey, label: sceneLabel, jobIds: [result.job.jobId] });
        completed += 1;
        setProgress(`Queued ${completed} of ${comparisonPlan.requests.length} combinations.`);
      }
      setNotice({ kind: "status", text: `Grid submitted: ${comparisonPlan.total} image${comparisonPlan.total === 1 ? "" : "s"} across ${comparisonPlan.requests.length} request${comparisonPlan.requests.length === 1 ? "" : "s"}; every combination reused the same seeds.` });
    } catch (error) {
      setNotice({ kind: "alert", text: `${completed} of ${comparisonPlan.requests.length} combinations were accepted before the grid stopped. ${errorMessage(error, "The remaining combinations were not retried automatically.")}` });
    } finally {
      setDispatching(false); setProgress(null); setGalleryRefresh((value) => value + 1);
    }
  }

  async function selectAsset(item: SceneImageGalleryItem): Promise<void> {
    if (dispatching) return;
    setDispatching(true); setNotice(null);
    try {
      const result = await api.select(campaignId, { sessionId, sceneKey, assetId: item.assetId, expectedRevision: selectionRevision, idempotencyKey: createClientId() });
      const nextRevision = receiptRevisionAfter(result.receipt);
      if (nextRevision !== null) setSelectionRevision(nextRevision);
      setNotice({ kind: "status", text: `Selected this illustration for ${sceneLabel}.` });
      setGalleryRefresh((value) => value + 1);
    } catch (error) {
      setNotice({ kind: "alert", text: errorMessage(error, "The selection was not confirmed.") });
    } finally { setDispatching(false); }
  }

  async function regenerate(item: SceneImageGalleryItem): Promise<void> {
    await submitGeneration({ prompt: item.prompt, seed: item.seed, steps: item.steps, guidance: item.guidance, count: 1 });
  }

  function reuseSettings(item: SceneImageGalleryItem): void {
    setSettings((current) => current ? { ...current, steps: item.steps, guidance: item.guidance, seedMode: "fixed", fixedSeed: item.seed } : current);
    setPrompt(item.prompt);
    setNotice({ kind: "status", text: "Loaded this image's prompt and sampler settings into the form; the seed is pinned for reuse." });
  }

  function toggleCompare(item: SceneImageGalleryItem): void {
    setCompareIds((current) => current.includes(item.assetId) ? current.filter((id) => id !== item.assetId) : [...current.slice(-1), item.assetId]);
  }

  if (!enabled) return <p>Scene images are unavailable in this deployment.</p>;
  if (!canManage) return <p>Scene image controls require the campaign owner or GM.</p>;
  if (settingsState === "loading" && !settings) return <p role="status">Loading scene-image settings…</p>;
  if (settingsState === "error" && !settings) return <div><p role="alert">Scene-image settings could not be loaded.</p><button type="button" onClick={() => setSettingsRefresh((value) => value + 1)}>Retry settings</button></div>;
  if (!settings) return null;

  return <section className="scene-image-dm" aria-label="Scene images administration">
    <div className="admin-section-heading"><div><p className="eyebrow">GENERATED ILLUSTRATIONS</p><h2>Scene images</h2></div><span className="status-pill">{settings.enabled ? settings.mode : "disabled"}</span></div>
    <p className="builder-help">Active scene: <strong>{sceneLabel}</strong> <code>{sceneKey}</code>. Generated images are candidates for review; selecting one shows it to players for this scene.</p>
    {(notice || progress) && <div className={`admin-status ${notice?.kind === "alert" ? "is-error" : "is-success"}`} role={notice?.kind === "alert" ? "alert" : "status"}><p>{notice?.text ?? progress}</p></div>}

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Generation</legend>
      <label><input type="checkbox" checked={settings.enabled} onChange={(event) => updateSettings({ enabled: event.target.checked })} /> Scene images enabled</label>
      <div className="scene-image-mode" role="radiogroup" aria-label="Generation mode">
        <label><input type="radio" name="scene-image-mode" checked={settings.mode === "off"} onChange={() => updateSettings({ mode: "off" })} /> Off</label>
        <label><input type="radio" name="scene-image-mode" checked={settings.mode === "manual"} onChange={() => updateSettings({ mode: "manual" })} /> Manual</label>
        <label><input type="radio" name="scene-image-mode" checked={settings.mode === "automatic"} onChange={() => updateSettings({ mode: "automatic" })} /> Automatic</label>
      </div>
    </fieldset>

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Workflow presets</legend>
      <div className="button-row">{SCENE_IMAGE_PRESETS.map((preset) => <button type="button" key={preset.id} onClick={() => applyPreset(preset)}>{preset.label}</button>)}</div>
      <p className="builder-help">{SCENE_IMAGE_PRESET_NOTE}</p>
    </fieldset>

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Prompt and style</legend>
      <label className="field"><span>Style preset text</span><input type="text" maxLength={200} value={settings.stylePhrase} onChange={(event) => updateSettings({ stylePhrase: event.target.value })} placeholder="consistent campaign art style" /></label>
      <label className="field"><span>Generated prompt (editable)</span><textarea rows={4} maxLength={500} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Leave empty to let the server build the prompt from spoiler-filtered scene facts." /></label>
      <p className="builder-help">The prompt is saved as this scene's override when you save settings; an empty field clears the override.</p>
    </fieldset>

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Sampler</legend>
      <div className="scene-image-sampler">
        <label className="field"><span>Steps</span><input type="number" min={SCENE_IMAGE_STEPS_MIN} max={SCENE_IMAGE_STEPS_MAX} value={settings.steps} onChange={(event) => updateSettings({ steps: Number(event.target.value) })} /></label>
        <label className="field"><span>Guidance</span><input type="number" min={SCENE_IMAGE_GUIDANCE_MIN} max={SCENE_IMAGE_GUIDANCE_MAX} step={0.5} value={settings.guidance} onChange={(event) => updateSettings({ guidance: Number(event.target.value) })} /></label>
        <label className="field"><span>Variation count</span><input type="number" min={SCENE_IMAGE_VARIATION_MIN} max={SCENE_IMAGE_VARIATION_MAX} value={settings.variationCount} onChange={(event) => { updateSettings({ variationCount: Number(event.target.value) }); setConfirmed(false); }} /></label>
      </div>
      <div className="scene-image-mode" role="radiogroup" aria-label="Seed mode">
        <label><input type="radio" name="scene-image-seed" checked={settings.seedMode === "random"} onChange={() => updateSettings({ seedMode: "random" })} /> Random seed</label>
        <label><input type="radio" name="scene-image-seed" checked={settings.seedMode === "fixed"} onChange={() => updateSettings({ seedMode: "fixed" })} /> Fixed seed</label>
      </div>
      <label className="field"><span>Seed</span><input type="number" min={SCENE_IMAGE_MIN_SEED} max={SCENE_IMAGE_MAX_SEED} value={settings.fixedSeed} disabled={settings.seedMode !== "fixed"} onChange={(event) => updateSettings({ fixedSeed: Number(event.target.value) })} /></label>
    </fieldset>

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Automatic limits</legend>
      <div className="scene-image-sampler">
        <label className="field"><span>Images per session</span><input type="number" min={SCENE_IMAGE_AUTO_SESSION_LIMIT_MIN} max={SCENE_IMAGE_AUTO_SESSION_LIMIT_MAX} value={settings.autoPerSessionLimit} onChange={(event) => updateSettings({ autoPerSessionLimit: Number(event.target.value) })} /></label>
        <label className="field"><span>Cooldown seconds</span><input type="number" min={SCENE_IMAGE_COOLDOWN_MIN_SECONDS} max={SCENE_IMAGE_COOLDOWN_MAX_SECONDS} value={settings.cooldownSeconds} onChange={(event) => updateSettings({ cooldownSeconds: Number(event.target.value) })} /></label>
      </div>
      <p className="builder-help">Automatic mode generates up to the per-session limit and respects the cooldown; manual generations are deliberate clicks.</p>
    </fieldset>

    <fieldset className="scene-image-group" disabled={dispatching}>
      <legend>Advanced comparison mode</legend>
      <label><input type="checkbox" checked={comparisonOpen} onChange={(event) => { setComparisonOpen(event.target.checked); setConfirmed(false); }} /> Compare steps and guidance combinations</label>
      {comparisonOpen && <>
        <p className="builder-help">Comma-separated values. Every steps/guidance combination reuses the same {settings.variationCount} seed{settings.variationCount === 1 ? "" : "s"} so differences isolate the sampler change.</p>
        <div className="scene-image-sampler">
          <label className="field"><span>Steps to compare</span><input type="text" value={comparisonSteps} onChange={(event) => { setComparisonSteps(event.target.value); setConfirmed(false); }} placeholder="20, 30" /></label>
          <label className="field"><span>Guidance to compare</span><input type="text" value={comparisonGuidance} onChange={(event) => { setComparisonGuidance(event.target.value); setConfirmed(false); }} placeholder="3" /></label>
        </div>
        {comparisonError && <p className="field-error" role="alert">{comparisonError}</p>}
        {comparisonPlan && <p className="scene-image-total" role="status">Grid: {comparisonPlan.total} image{comparisonPlan.total === 1 ? "" : "s"} from {comparisonPlan.requests.length} request{comparisonPlan.requests.length === 1 ? "" : "s"}, reusing {settings.variationCount} seed{settings.variationCount === 1 ? "" : "s"} across every combination.</p>}
        {comparisonNeedsConfirmation && <label className="scene-image-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm generating {comparisonTotal} images</label>}
        <button type="button" className="primary" disabled={dispatching || !comparisonReady} onClick={() => void submitComparison()}>{dispatching ? "Working…" : `Generate comparison grid${comparisonTotal > 0 ? ` (${comparisonTotal})` : ""}`}</button>
      </>}
    </fieldset>

    <div className="button-row scene-image-actions">
      <button type="button" className="primary" disabled={dispatching} onClick={() => void saveSettings()}>Save settings</button>
      <button type="button" disabled={dispatching} onClick={() => void generateManual()}>Generate now{settings.variationCount > 1 ? ` (${settings.variationCount} images)` : ""}</button>
    </div>

    <section className="scene-image-gallery" aria-label="Scene image gallery">
      <div className="admin-section-heading"><div><h3>Generated images</h3><p>Grouped by scene; the active scene is marked. Compare any two images side by side.</p></div></div>
      <div className="scene-image-gallery-tools">
        <button type="button" className="ghost" disabled={galleryState === "loading"} onClick={() => setGalleryRefresh((value) => value + 1)}>Refresh gallery</button>
        <label className="field"><span>Thumbnail size</span><input type="range" min={SCENE_IMAGE_MIN_THUMBNAIL} max={SCENE_IMAGE_MAX_THUMBNAIL} step={8} value={preferences.galleryThumbnailSize} onChange={(event) => updatePreferences({ ...preferences, galleryThumbnailSize: Number(event.target.value) })} /></label>
      </div>
      {galleryState === "loading" && images.length === 0 && <p role="status">Loading gallery…</p>}
      {galleryState === "error" && <p role="alert">The gallery could not be loaded. Refresh to try again; nothing was changed.</p>}
      {(galleryState === "ready" || images.length > 0) && groups.map((group) => <section key={group.sceneKey} className={`scene-image-scene ${group.active ? "is-active" : ""}`} aria-label={`Scene group ${group.label}`}>
        <h4>{group.label}{group.active && <span className="scene-image-active-badge">Active scene</span>}</h4>
        {group.images.length === 0
          ? <p className="builder-help">No images generated for this scene yet.</p>
          : <div className="scene-image-grid">{group.images.map((item) => <article key={item.assetId} className="scene-image-card" data-asset-id={item.assetId}>
            {preferences.reducedBandwidth && !loadedThumbs.includes(item.assetId)
              ? <button type="button" className="scene-image-thumb-load" onClick={() => setLoadedThumbs((current) => [...current, item.assetId])}>Load thumbnail</button>
              : <button type="button" className="scene-image-thumb" onClick={() => setExpanded(item)} aria-label={`Open full image from ${group.label}`}>
                <img src={api.assetUrl(campaignId, item.assetId)} alt={sceneImageAltText(sceneLabel, item, audience)} loading="lazy" decoding="async"
                  style={{ width: `${preferences.galleryThumbnailSize}px` }} />
              </button>}
            <div className="scene-image-meta">
              <p><strong>{sceneImageStatusLabel(item.status)}</strong>{item.selected && <span> · Selected</span>}</p>
              <p>seed {item.seed} · steps {item.steps} · guidance {item.guidance}{formatSceneImageSeconds(item.seconds) ? ` · ${formatSceneImageSeconds(item.seconds)}` : ""}</p>
              <p>{formatSceneImageCreatedAt(item.createdAt)}</p>
            </div>
            <div className="button-row">
              <button type="button" disabled={dispatching || item.selected} onClick={() => void selectAsset(item)}>Use for active scene</button>
              <button type="button" disabled={dispatching} onClick={() => void regenerate(item)}>Regenerate</button>
              <button type="button" onClick={() => reuseSettings(item)}>Reuse settings</button>
              <button type="button" aria-pressed={compareIds.includes(item.assetId)} onClick={() => toggleCompare(item)}>Compare</button>
            </div>
          </article>)}</div>}
      </section>)}
      {compared.length === 2 && <section className="scene-image-compare" aria-label="Image comparison">
        <h4>Side-by-side comparison</h4>
        <div className="scene-image-compare-grid">{compared.map((item) => <figure key={item.assetId}>
          <img src={api.assetUrl(campaignId, item.assetId)} alt={sceneImageAltText(sceneLabel, item, audience)} loading="lazy" decoding="async" />
          <figcaption>seed {item.seed} · steps {item.steps} · guidance {item.guidance}{formatSceneImageSeconds(item.seconds) ? ` · ${formatSceneImageSeconds(item.seconds)}` : ""}</figcaption>
        </figure>)}</div>
        <button type="button" className="ghost" onClick={() => setCompareIds([])}>Clear comparison</button>
      </section>}
      {expanded && <section className="scene-image-full" role="dialog" aria-label="Full illustration">
        <header><h4>Full image</h4><button type="button" onClick={() => setExpanded(null)}>Close full view</button></header>
        <img src={api.assetUrl(campaignId, expanded.assetId)} alt={sceneImageAltText(sceneLabel, expanded, audience)} />
        <p>seed {expanded.seed} · steps {expanded.steps} · guidance {expanded.guidance}{formatSceneImageSeconds(expanded.seconds) ? ` · ${formatSceneImageSeconds(expanded.seconds)}` : ""} · {sceneImageStatusLabel(expanded.status)}</p>
      </section>}
    </section>
  </section>;
}
