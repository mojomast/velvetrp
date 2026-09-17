import { useEffect, useState } from "react";
import {
  SystemOneLane,
  SystemOneLaneMode,
  SystemOneSettings as SystemOneSettingsValue,
  getSystemOne,
  preflightSystemOne,
  updateSystemOne,
} from "../api";

const LANES: ReadonlyArray<{ id: SystemOneLane; label: string }> = [
  { id: "director-selection", label: "Director selection" },
  { id: "adventure-selection", label: "Adventure selection" },
  { id: "narration-verification", label: "Narration verification" },
  { id: "memory-reranking", label: "Memory reranking" },
  { id: "speaker-routing", label: "Speaker routing" },
  { id: "guardrails", label: "Guardrails" },
  { id: "cost-router", label: "Cost router" },
];

const loadFailure = "Could not load System One settings.";

type SettingsPatch = Partial<Omit<SystemOneSettingsValue, "laneModes">> & {
  laneModes?: Partial<Record<SystemOneLane, SystemOneLaneMode>>;
};

function threshold(value: number | null | undefined): number | string {
  return value === null || value === undefined ? "" : value;
}

export function SystemOneSettings() {
  const [settings, setSettings] = useState<SystemOneSettingsValue | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [preflightStatus, setPreflightStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const busy = saving || testing;

  useEffect(() => {
    let active = true;
    void getSystemOne()
      .then((value) => { if (active) setSettings(value); })
      .catch(() => { if (active) setStatus(loadFailure); });
    return () => { active = false; };
  }, []);

  async function refresh() {
    try { setSettings(await getSystemOne()); setStatus(""); }
    catch { setStatus(loadFailure); }
  }

  function patchSettings(next: SettingsPatch) {
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        ...next,
        laneModes: next.laneModes ? { ...current.laneModes, ...next.laneModes } : current.laneModes,
      };
    });
  }

  function patchLane(lane: SystemOneLane, key: "actionThreshold" | "reviewThreshold", value: number) {
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        confidencePolicy: {
          ...current.confidencePolicy,
          [lane]: { ...current.confidencePolicy[lane], [key]: value },
        },
      };
    });
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const patch: Parameters<typeof updateSystemOne>[0] = {
        enabled: settings.enabled,
        laneModes: settings.laneModes,
        baseUrl: settings.baseUrl,
        model: settings.model,
        requestTimeoutSeconds: settings.requestTimeoutSeconds,
        confidencePolicy: settings.confidencePolicy,
      };
      const key = apiKey.trim();
      if (key) patch.apiKey = key;
      const saved = await updateSystemOne(patch);
      setSettings(saved);
      setApiKey("");
      setStatus("System One settings saved.");
    } catch {
      setStatus("Could not save System One settings.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setPreflightStatus("Checking System One connection...");
    try {
      const result = await preflightSystemOne();
      if (result.ok) {
        const parts = ["ok", `model ${result.model}`];
        if (result.latencyMs !== undefined) parts.push(`${result.latencyMs} ms`);
        if (result.requestId) parts.push(`request ${result.requestId}`);
        setPreflightStatus(parts.join(" · "));
      } else {
        setPreflightStatus(`failure kind: ${result.failure?.kind ?? "unknown"}`);
      }
    } catch {
      setPreflightStatus("System One preflight could not be completed.");
    } finally {
      setTesting(false);
    }
  }

  const keyHint = settings?.hasApiKey
    ? "A key is configured. Enter a new value only to replace it."
    : "No key is configured yet.";

  const summaryState = !settings
    ? "optional"
    : !settings.enabled
      ? "disabled"
      : Object.values(settings.laneModes).includes("active")
        ? "live"
        : "shadow";

  return <details className="settings-group"><summary>System One (Jev) <span>{summaryState}</span></summary>
    <div className="settings-fields">
      <p className="notice full">Optional decision layer. When enabled it answers bounded lane questions. Each lane can be off (no call), shadow (record decisions without changing behavior), or active (may change behavior once promoted).</p>
      {status && <p className={/saved/.test(status) ? "success full" : "error full"} role="alert">{status}</p>}
      {!settings && !status && <p className="meta-text full">Loading System One settings…</p>}
      {settings && <>
        <label className="checkbox full"><input type="checkbox" aria-label="Enable System One" checked={settings.enabled} onChange={(event) => patchSettings({ enabled: event.target.checked })} /><span>Enable System One lane decisions</span></label>
        <label className="field full" htmlFor="system-one-base-url"><span>Base URL</span><input id="system-one-base-url" value={settings.baseUrl} onChange={(event) => patchSettings({ baseUrl: event.target.value })} /></label>
        <label className="field" htmlFor="system-one-model"><span>Model</span><input id="system-one-model" value={settings.model} onChange={(event) => patchSettings({ model: event.target.value })} /></label>
        <label className="field" htmlFor="system-one-timeout"><span>Timeout seconds</span><input id="system-one-timeout" type="number" min={1} max={300} value={settings.requestTimeoutSeconds} onChange={(event) => patchSettings({ requestTimeoutSeconds: Number(event.target.value) })} /></label>
        <label className="field" htmlFor="system-one-api-key"><span>API key</span><input id="system-one-api-key" type="password" autoComplete="off" aria-label="System One API key" placeholder={settings.hasApiKey ? "Stored key — leave blank to keep" : "Enter key"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /><small>{keyHint}</small></label>
        <fieldset className="full settings-group"><legend>Per-lane mode</legend><div className="settings-fields">
          {LANES.map((lane) => <label className="field" key={lane.id} htmlFor={`system-one-${lane.id}-mode`}><span>{lane.label}</span><select id={`system-one-${lane.id}-mode`} aria-label={`${lane.id} mode`} value={settings.laneModes[lane.id]} onChange={(event) => patchSettings({ laneModes: { [lane.id]: event.target.value as SystemOneLaneMode } })}>
            <option value="off">Off</option>
            <option value="shadow">Shadow</option>
            <option value="active">Active</option>
          </select></label>)}
        </div></fieldset>
        <fieldset className="full settings-group"><legend>Per-lane confidence thresholds</legend><div className="settings-fields">
          {LANES.map((lane) => {
            const thresholds = settings.confidencePolicy[lane.id];
            return <div className="field full" key={lane.id}>
              <span>{lane.label}</span>
              <div className="button-row">
                <label className="field" htmlFor={`system-one-${lane.id}-action`}><span>Action threshold</span><input id={`system-one-${lane.id}-action`} type="number" min={0} max={1} step={0.05} aria-label={`${lane.label} action threshold`} value={threshold(thresholds?.actionThreshold)} onChange={(event) => patchLane(lane.id, "actionThreshold", Number(event.target.value))} /></label>
                <label className="field" htmlFor={`system-one-${lane.id}-review`}><span>Review threshold</span><input id={`system-one-${lane.id}-review`} type="number" min={0} max={1} step={0.05} aria-label={`${lane.label} review threshold`} value={threshold(thresholds?.reviewThreshold)} onChange={(event) => patchLane(lane.id, "reviewThreshold", Number(event.target.value))} /></label>
              </div>
            </div>;
          })}
        </div></fieldset>
        <div className="button-row full">
          <button className="primary" disabled={busy} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button>
          <button className="ghost" disabled={busy} onClick={() => void test()}>{testing ? "Testing…" : "Test connection"}</button>
          <button className="ghost" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        {preflightStatus && <p className="meta-text full" role="status">{preflightStatus}</p>}
      </>}
    </div>
  </details>;
}
