import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { atlasToolLabels, type AtlasTool } from "./PlaySurface";
import "./commandCenter.css";
import {
  CAMPAIGN_CONTEXT_WIDGETS,
  DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES,
  type CampaignContextWidget,
  type CampaignWorkbenchPreferences,
} from "./campaignWorkbenchPreferences";

/** Public props for the one-screen Campaign Command Center table. */
export interface CommandCenterProps {
  headingRef: RefObject<HTMLHeadingElement>;
  title: string;
  role: string;
  phase: string;
  actor: ReactNode;
  tools: readonly AtlasTool[];
  activeTool: AtlasTool | null;
  onTool: (tool: AtlasTool) => void;
  onBack: () => void;
  exitDisabled: boolean;
  context: ReactNode;
  center: ReactNode;
  tool: ReactNode;
  campaignNav?: ReactNode;
  preferences: CampaignWorkbenchPreferences;
  onPreferences: (value: CampaignWorkbenchPreferences) => void;
}

const widgetLabels: Record<CampaignContextWidget, string> = {
  location: "Location", cast: "Present cast", objectives: "Objectives", resources: "Party resources", encounter: "Encounter",
};

/** Tools that configure or administer the table rather than drive the current scene. */
const SETUP_TOOLS: ReadonlySet<AtlasTool> = new Set(["director", "gm", "security", "create", "images"]);

function clampPaneWidth(value: number) { return Math.max(220, Math.min(520, Math.round(value))); }

function PanelSeparator({ side, value, controls, label, onChange, onCollapse }: { side: "left" | "right"; value: number; controls: string; label: string;
  onChange: (value: number) => void; onCollapse: () => void }) {
  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX; const startWidth = value;
    const move = (next: PointerEvent) => onChange(clampPaneWidth(startWidth + (side === "left" ? next.clientX - startX : startX - next.clientX)));
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  }
  return <div className="campaign-panel-separator" role="separator" aria-label={label} aria-controls={controls} aria-orientation="vertical"
    aria-valuemin={220} aria-valuemax={520} aria-valuenow={value} tabIndex={0} onPointerDown={resize} onKeyDown={(event) => {
      const inward = side === "left" ? "ArrowRight" : "ArrowLeft"; const outward = side === "left" ? "ArrowLeft" : "ArrowRight";
      if (event.key === inward) { event.preventDefault(); onChange(clampPaneWidth(value + (event.shiftKey ? 64 : 16))); }
      if (event.key === outward) { event.preventDefault(); onChange(clampPaneWidth(value - (event.shiftKey ? 64 : 16))); }
      if (event.key === "Home") { event.preventDefault(); onChange(220); }
      if (event.key === "End") { event.preventDefault(); onChange(520); }
      if (event.key === "Enter") { event.preventDefault(); onCollapse(); }
    }} />;
}

function WorkbenchPreferencesDialog({ dialogRef, preferences, onChange }: { dialogRef: RefObject<HTMLDialogElement>; preferences: CampaignWorkbenchPreferences;
  onChange: (value: CampaignWorkbenchPreferences) => void }) {
  const moveWidget = (widget: CampaignContextWidget, direction: -1 | 1) => {
    const index = preferences.widgets.indexOf(widget); const target = index + direction;
    if (index < 0 || target < 0 || target >= preferences.widgets.length) return;
    const widgets = [...preferences.widgets]; [widgets[index], widgets[target]] = [widgets[target]!, widgets[index]!];
    onChange({ ...preferences, widgets });
  };
  return <dialog ref={dialogRef} className="workbench-dialog" aria-labelledby="workbench-preferences-heading"><form method="dialog">
    <header><div><p className="eyebrow">LOCAL DISPLAY</p><h2 id="workbench-preferences-heading">Campaign workbench</h2></div><button className="ghost" value="close">Close</button></header>
    <div className="workbench-preference-grid"><label>Theme<select value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as CampaignWorkbenchPreferences["theme"] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Velvet dark</option><option value="contrast">High contrast</option></select></label>
      <label>Layout density<select value={preferences.density} onChange={(event) => onChange({ ...preferences, density: event.target.value as CampaignWorkbenchPreferences["density"] })}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></label></div>
    <fieldset><legend>Panels</legend><label><input type="checkbox" checked={preferences.contextVisible} onChange={(event) => onChange({ ...preferences, contextVisible: event.target.checked })} /> Campaign context and map</label><label><input type="checkbox" checked={preferences.quickToolsVisible} onChange={(event) => onChange({ ...preferences, quickToolsVisible: event.target.checked })} /> Tools and character summary</label></fieldset>
    <fieldset><legend>Context widgets and order</legend>{CAMPAIGN_CONTEXT_WIDGETS.map((widget) => { const index = preferences.widgets.indexOf(widget); const enabled = index >= 0; return <div className="widget-preference" key={widget}><label><input type="checkbox" checked={enabled} onChange={(event) => onChange({ ...preferences, widgets: event.target.checked ? [...preferences.widgets, widget] : preferences.widgets.filter((item) => item !== widget) })} /> {widgetLabels[widget]}</label><div className="button-row"><button type="button" className="ghost" aria-label={`Move ${widgetLabels[widget]} earlier`} disabled={!enabled || index === 0} onClick={() => moveWidget(widget, -1)}>Up</button><button type="button" className="ghost" aria-label={`Move ${widgetLabels[widget]} later`} disabled={!enabled || index === preferences.widgets.length - 1} onClick={() => moveWidget(widget, 1)}>Down</button></div></div>; })}</fieldset>
    <button type="button" className="ghost" onClick={() => onChange({ ...DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES, widgets: [...CAMPAIGN_CONTEXT_WIDGETS] })}>Reset workbench</button>
  </form></dialog>;
}

function ShortcutDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement> }) {
  return <dialog ref={dialogRef} className="workbench-dialog shortcut-dialog" aria-labelledby="shortcut-heading"><form method="dialog"><header><div><p className="eyebrow">KEYBOARD MAP</p><h2 id="shortcut-heading">Campaign shortcuts</h2></div><button className="ghost" value="close">Close</button></header><dl>
    <div><dt><kbd>F6</kbd></dt><dd>Move to the next visible workbench pane</dd></div><div><dt><kbd>Shift</kbd> + <kbd>F6</kbd></dt><dd>Move to the previous pane</dd></div><div><dt><kbd>Alt</kbd> + <kbd>1</kbd></dt><dd>Focus campaign context and map</dd></div><div><dt><kbd>Alt</kbd> + <kbd>2</kbd></dt><dd>Focus narration and action workspace</dd></div><div><dt><kbd>Alt</kbd> + <kbd>3</kbd></dt><dd>Focus tools and character summary</dd></div><div><dt><kbd>?</kbd></dt><dd>Open this keyboard map outside text fields</dd></div>
  </dl><p>Splitters use arrow keys, Shift + arrow for larger steps, Home/End for minimum/maximum, and Enter to collapse.</p></form></dialog>;
}

/** The one-screen Command Center: context + map, narration and composer, and tools/character summary. */
export function CommandCenter({ headingRef, title, role, phase, actor, tools, activeTool, onTool, onBack, exitDisabled,
  context, center, tool, campaignNav, preferences, onPreferences }: CommandCenterProps) {
  const rootRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const preferencesDialogRef = useRef<HTMLDialogElement>(null);
  const shortcutDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && Boolean(event.target.closest("input,textarea,select,[contenteditable=true]"));
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "?" && !editing && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); onTool("help"); return; }
      const panes = [preferences.contextVisible ? document.getElementById("campaign-context-panel") : null, centerRef.current,
        preferences.quickToolsVisible ? document.getElementById("campaign-quick-tools") : null].filter((pane): pane is HTMLElement => pane !== null);
      if (event.key === "F6" && panes.length) {
        event.preventDefault();
        const current = panes.findIndex((pane) => pane === document.activeElement || pane.contains(document.activeElement));
        const next = (current + (event.shiftKey ? panes.length - 1 : 1)) % panes.length;
        panes[next]?.focus({ preventScroll: true });
        return;
      }
      if (event.altKey && ["1", "2", "3"].includes(event.key)) {
        const pane = [document.getElementById("campaign-context-panel"), centerRef.current, document.getElementById("campaign-quick-tools")][Number(event.key) - 1];
        if (pane) { event.preventDefault(); pane.focus(); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onTool, preferences.contextVisible, preferences.quickToolsVisible]);

  const gridStyle = { "--campaign-context-width": `${preferences.contextWidth}px`, "--campaign-quick-width": `${preferences.quickToolsWidth}px` } as CSSProperties;
  const gridClass = `campaign-play-grid ${preferences.contextVisible ? "has-context" : ""} ${preferences.quickToolsVisible ? "has-quick-tools" : ""}`;
  const sessionTools = tools.filter((tool) => !SETUP_TOOLS.has(tool));
  const setupTools = tools.filter((tool) => SETUP_TOOLS.has(tool));
  const toolButton = (tool: AtlasTool) => {
    const expanded = activeTool === tool || (tool === "character" && (activeTool === "inventory" || activeTool === "advancement"));
    return <button type="button" className="ghost" key={tool} data-atlas-tool={tool} aria-pressed={activeTool === tool}
      aria-expanded={expanded} aria-controls={`atlas-${tool === "character" && (activeTool === "inventory" || activeTool === "advancement") ? activeTool : tool}`}
      onClick={() => onTool(tool)}>{atlasToolLabels[tool]}</button>;
  };
  return <main ref={rootRef} className="campaign-play-page" data-command-center="true">
    <header className="campaign-play-header">
      <div className="campaign-play-title">
        <button type="button" className="back-link" disabled={exitDisabled} onClick={onBack} aria-label="Back to campaign">← Back to campaign</button>
        <p className="eyebrow">CAMPAIGN COMMAND CENTER</p>
        <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
      </div>
      <div className="campaign-play-status"><span role="status">{role} access from server</span><p className="play-phase" role="status">{phase.replaceAll("-", " ")}</p>{actor}</div>
    </header>
    <nav className="campaign-play-nav" aria-label="In-room tools">
      <div className="campaign-nav-group" role="group" aria-label="Session tools">{sessionTools.map(toolButton)}</div>
      <div className="campaign-nav-group campaign-nav-group-setup" role="group" aria-label="Table setup and administration">
        <span className="campaign-nav-group-label">Table setup</span>
        {setupTools.map(toolButton)}
        {campaignNav}
        <button type="button" className="ghost" onClick={() => preferencesDialogRef.current?.showModal()}>Display</button>
        <button type="button" className="ghost" onClick={() => shortcutDialogRef.current?.showModal()}>Shortcuts</button>
      </div>
    </nav>
    <div className={gridClass} style={gridStyle}>
      {preferences.contextVisible && <>{context}<PanelSeparator side="left" value={preferences.contextWidth} controls="campaign-context-panel"
        label="Resize campaign context" onChange={(contextWidth) => onPreferences({ ...preferences, contextWidth })} onCollapse={() => onPreferences({ ...preferences, contextVisible: false })} /></>}
      <section ref={centerRef} tabIndex={-1} className="campaign-play-center" aria-label="Campaign narration and actions">{center}</section>
      {preferences.quickToolsVisible && <><PanelSeparator side="right" value={preferences.quickToolsWidth} controls="campaign-quick-tools"
        label="Resize tools and character summary" onChange={(quickToolsWidth) => onPreferences({ ...preferences, quickToolsWidth })} onCollapse={() => onPreferences({ ...preferences, quickToolsVisible: false })} />
        <div id="campaign-quick-tools" className="campaign-quick-tools" tabIndex={-1}>{tool}</div></>}
    </div>
    <WorkbenchPreferencesDialog dialogRef={preferencesDialogRef} preferences={preferences} onChange={onPreferences} />
    <ShortcutDialog dialogRef={shortcutDialogRef} />
  </main>;
}
