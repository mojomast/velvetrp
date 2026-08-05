import { useEffect, useState } from "react";
import {
  HarnessSettings, PromptTemplateDefinition, ProviderSettings, FeatureFlags,
  listPromptTemplates, updateHarness, updatePromptTemplate, updateProvider,
} from "../api";

interface Props {
  provider: ProviderSettings | null;
  harness: HarnessSettings | null;
  features: FeatureFlags;
  onProviderChange: (value: ProviderSettings) => void;
  onHarnessChange: (value: HarnessSettings) => void;
  onClose: () => void;
}

export function PromptSettings({ provider, harness, features, onProviderChange, onHarnessChange, onClose }: Props) {
  const [templates, setTemplates] = useState<PromptTemplateDefinition[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void listPromptTemplates().then(({ templates: loaded }) => { setTemplates(loaded); const first = loaded[0]; if (first) { setSelectedId(first.id); setDraft(first.template); } }).catch(() => setStatus("Could not load prompt templates.")); }, []);
  const selected = templates.find((template) => template.id === selectedId) ?? null;
  const choose = (id: string) => { const next = templates.find((template) => template.id === id); setSelectedId(id); setDraft(next?.template ?? ""); };
  async function saveTemplate(template: string | null) { try { const result = await updatePromptTemplate(selectedId, template); setTemplates(result.templates); const next = result.templates.find((entry) => entry.id === selectedId); setDraft(next?.template ?? ""); setStatus(template === null ? "Prompt reset to default." : "Prompt template saved."); } catch { setStatus("Could not save prompt template."); } }
  async function saveHarness() { if (!harness) return; try { const value = await updateHarness({ systemPrompt: harness.systemPrompt, personaPreamble: harness.personaPreamble, styleGuide: harness.styleGuide, postHistoryInstructions: harness.postHistoryInstructions, recentTurns: harness.recentTurns, memoryChars: harness.memoryChars, summaryChars: harness.summaryChars, loreChars: harness.loreChars, temperature: harness.temperature }); onHarnessChange(value); setStatus("Harness settings saved."); } catch { setStatus("Could not save harness settings."); } }
  async function saveProvider() { if (!provider) return; try { const value = await updateProvider({ providerType: provider.providerType, baseUrl: provider.baseUrl, model: provider.model, streaming: provider.streaming, httpReferer: provider.httpReferer, appTitle: provider.appTitle, requireParameters: provider.requireParameters, allowFallbacks: provider.allowFallbacks, routingSort: provider.routingSort, dataCollection: provider.dataCollection, zdr: provider.zdr, requestTimeoutSeconds: provider.requestTimeoutSeconds, pricing: provider.pricing, samplers: provider.samplers }); onProviderChange(value); setStatus("Provider settings saved."); } catch { setStatus("Could not save provider settings."); } }
  const numeric = (value: number | null) => value ?? "";
  return <section className="prompt-settings">
    <header className="settings-header"><div><p className="eyebrow">CONTROL SURFACE</p><h2>Prompt & settings</h2></div><div className="button-row"><span className="status-pill active">live</span><button className="ghost small" onClick={onClose}>Close</button></div></header>
    <p className="notice">Changes apply to the next generation. Key: {provider?.hasApiKey ? "configured" : "not configured"}. Voice: {features.voice ? "on" : "off"} · Images: {features.images ? "on" : "off"}.</p>
    {status && <p className={/saved|reset/.test(status) ? "success" : "error"}>{status}</p>}
    <details open className="settings-group"><summary>Prompt studio <span>{templates.length} layers</span></summary><div className="prompt-studio">
      <label className="field"><span>Underlying prompt layer</span><select aria-label="Underlying prompt layer" value={selectedId} onChange={(event) => choose(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.label}{template.overridden ? " · modified" : ""}</option>)}</select></label>
      {selected && <><p className="meta-text">{selected.description}</p><div className="placeholder-list">{selected.placeholders.map((placeholder) => <code key={placeholder}>{`{{${placeholder}}}`}</code>)}</div><label className="field"><span>{selected.label}</span><textarea aria-label="Prompt template editor" rows={14} value={draft} onChange={(event) => setDraft(event.target.value)} /></label><div className="button-row"><button className="primary" onClick={() => void saveTemplate(draft)}>Save layer</button><button className="ghost" disabled={!selected.overridden} onClick={() => void saveTemplate(null)}>Reset default</button></div></>}
    </div></details>
    {harness && <details open className="settings-group"><summary>Harness context <span>global</span></summary><div className="settings-fields">
      <label className="field full"><span>Global system prompt</span><textarea rows={8} value={harness.systemPrompt} onChange={(event) => onHarnessChange({ ...harness, systemPrompt: event.target.value })} /></label>
      <label className="field full"><span>Persona preamble</span><textarea rows={3} value={harness.personaPreamble} onChange={(event) => onHarnessChange({ ...harness, personaPreamble: event.target.value })} /></label>
      <label className="field full"><span>Style guide</span><textarea rows={4} value={harness.styleGuide} onChange={(event) => onHarnessChange({ ...harness, styleGuide: event.target.value })} /></label>
      <label className="field full"><span>Post-history instructions</span><textarea rows={4} value={harness.postHistoryInstructions} onChange={(event) => onHarnessChange({ ...harness, postHistoryInstructions: event.target.value })} /></label>
      {(["recentTurns", "memoryChars", "summaryChars", "loreChars"] as const).map((key) => <label className="field" key={key}><span>{key}</span><input type="number" value={harness[key]} onChange={(event) => onHarnessChange({ ...harness, [key]: Number(event.target.value) })} /></label>)}
      <label className="field"><span>Temperature</span><input type="number" min={0} max={2} step={.1} value={numeric(harness.temperature)} onChange={(event) => onHarnessChange({ ...harness, temperature: event.target.value === "" ? null : Number(event.target.value) })} /></label>
      <button className="primary full" onClick={() => void saveHarness()}>Save harness</button>
    </div></details>}
    {provider && <details open className="settings-group"><summary>Provider & generation <span>{provider.model}</span></summary><div className="settings-fields">
      <label className="field"><span>Provider type</span><select value={provider.providerType} onChange={(event) => onProviderChange({ ...provider, providerType: event.target.value as ProviderSettings["providerType"] })}><option value="openai-compatible">OpenAI compatible</option><option value="ollama">Ollama</option><option value="llamacpp">llama.cpp</option><option value="koboldcpp">KoboldCpp</option></select></label>
      <label className="field"><span>Model</span><input value={provider.model} onChange={(event) => onProviderChange({ ...provider, model: event.target.value })} /></label>
      <label className="field"><span>Streaming</span><select value={provider.streaming ? "yes" : "no"} onChange={(event) => onProviderChange({ ...provider, streaming: event.target.value === "yes" })}><option value="yes">On</option><option value="no">Off</option></select></label>
      <label className="field full"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => onProviderChange({ ...provider, baseUrl: event.target.value })} /></label>
      <label className="field"><span>Timeout seconds</span><input type="number" min={15} max={300} value={provider.requestTimeoutSeconds} onChange={(event) => onProviderChange({ ...provider, requestTimeoutSeconds: Number(event.target.value) })} /></label>
      <label className="field"><span>Input USD per million tokens</span><input type="number" min={0} step="0.01" value={numeric(provider.pricing?.promptPerMillion ?? null)} onChange={(event) => onProviderChange({ ...provider, pricing: { ...provider.pricing, promptPerMillion: event.target.value === "" ? null : Number(event.target.value) } })} /></label>
      <label className="field"><span>Output USD per million tokens</span><input type="number" min={0} step="0.01" value={numeric(provider.pricing?.completionPerMillion ?? null)} onChange={(event) => onProviderChange({ ...provider, pricing: { ...provider.pricing, completionPerMillion: event.target.value === "" ? null : Number(event.target.value) } })} /></label>
      {(["maxTokens", "topP", "topK", "minP", "repetitionPenalty", "frequencyPenalty", "presencePenalty", "seed"] as const).map((key) => <label className="field" key={key}><span>{key}</span><input type="number" value={numeric(provider.samplers[key])} onChange={(event) => onProviderChange({ ...provider, samplers: { ...provider.samplers, [key]: event.target.value === "" ? null : Number(event.target.value) } })} /></label>)}
      <label className="field"><span>Reasoning</span><select value={provider.samplers.reasoningEffort ?? ""} onChange={(event) => onProviderChange({ ...provider, samplers: { ...provider.samplers, reasoningEffort: (event.target.value || null) as ProviderSettings["samplers"]["reasoningEffort"] } })}><option value="">Default</option><option value="none">None</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
      <label className="field full"><span>Stop strings</span><input value={provider.samplers.stopStrings.join(", ")} onChange={(event) => onProviderChange({ ...provider, samplers: { ...provider.samplers, stopStrings: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } })} /></label>
      <label className="field full"><span>Start reply with</span><input value={provider.samplers.startReplyWith} onChange={(event) => onProviderChange({ ...provider, samplers: { ...provider.samplers, startReplyWith: event.target.value } })} /></label>
      <label className="field"><span>Routing priority</span><select value={provider.routingSort} onChange={(event) => onProviderChange({ ...provider, routingSort: event.target.value as ProviderSettings["routingSort"] })}><option value="default">Default</option><option value="price">Price</option><option value="throughput">Throughput</option><option value="latency">Latency</option></select></label>
      <label className="field"><span>Data collection</span><select value={provider.dataCollection} onChange={(event) => onProviderChange({ ...provider, dataCollection: event.target.value as ProviderSettings["dataCollection"] })}><option value="default">Default</option><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
      <label className="field full"><span>Application title</span><input value={provider.appTitle} onChange={(event) => onProviderChange({ ...provider, appTitle: event.target.value })} /></label>
      <label className="field full"><span>HTTP referer</span><input value={provider.httpReferer} onChange={(event) => onProviderChange({ ...provider, httpReferer: event.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={provider.allowFallbacks} onChange={(event) => onProviderChange({ ...provider, allowFallbacks: event.target.checked })} /><span>Allow fallbacks</span></label>
      <label className="checkbox"><input type="checkbox" checked={provider.requireParameters} onChange={(event) => onProviderChange({ ...provider, requireParameters: event.target.checked })} /><span>Require parameters</span></label>
      <label className="checkbox"><input type="checkbox" checked={provider.zdr} onChange={(event) => onProviderChange({ ...provider, zdr: event.target.checked })} /><span>Zero-data retention</span></label>
      <button className="primary full" onClick={() => void saveProvider()}>Save provider settings</button>
    </div></details>}
  </section>;
}
