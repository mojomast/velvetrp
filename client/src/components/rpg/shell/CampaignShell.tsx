import { Component, createContext, createRef, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { getCampaignDetail, type CampaignDetail } from "../../../api";
import type { View } from "../../../roleplay/navigation";
import "./campaign-shell.css";

export type CampaignDestination = "overview" | "play" | "characters" | "world" | "journal" | "create" | "manage" | "combat" | "cast" | "story" | "history";
type Identity = Pick<CampaignDetail, "id" | "name" | "actorRole">;
type ShellContextValue = {
  report: (identity: Identity | null) => void;
  navigate?: (destination: CampaignDestination) => void;
  generationAvailable?: boolean;
  blockNavigation: (blocked: boolean) => void;
};
const ShellContext = createContext<ShellContextValue>({ report: () => undefined, blockNavigation: () => undefined });
export const useCampaignShell = () => useContext(ShellContext);

class CampaignWorkspaceBoundary extends Component<{
  children: ReactNode;
  onOverview: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  private failure = createRef<HTMLElement>();

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Campaign workspace render failed", error, info.componentStack);
    this.failure.current?.focus();
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return <section ref={this.failure} className="control-workspace-failure" role="alert" tabIndex={-1} aria-labelledby="campaign-workspace-failure-heading">
      <span className="control-kicker">Workspace interrupted</span>
      <h1 id="campaign-workspace-failure-heading">Campaign workspace failed</h1>
      <p>This workspace could not be displayed. The campaign navigation remains available.</p>
      <div className="control-workspace-failure-actions">
        <button type="button" onClick={this.props.onOverview}>Return to campaign overview</button>
        <button type="button" onClick={this.retry}>Retry workspace</button>
      </div>
    </section>;
  }
}

export function campaignDestinations(role: CampaignDetail["actorRole"] | null, studio: boolean, combat: boolean) {
  const administer = role === "owner" || role === "gm";
  return [
    { id: "overview", label: "Overview", hint: "Your next chapter", enabled: true },
    { id: "play", label: "Play", hint: role === "observer" ? "Watch an attached room" : "Rooms & gameplay", enabled: true },
    { id: "characters", label: "Characters", hint: "Party & character sheets", enabled: true },
    { id: "world", label: "World", hint: studio ? "Locations & routes" : "World tools unavailable", enabled: studio },
    { id: "journal", label: "Journal", hint: studio ? "Quests & discoveries" : "History & recaps", enabled: true },
    ...(administer ? [
      { id: "create", label: "Create", hint: combat ? "Reviewed AI generation" : "Generation requires combat features", enabled: combat },
      { id: "manage", label: "Manage", hint: role === "owner" ? "Settings, members & safety" : "Settings & safety", enabled: true },
    ] : []),
  ] as Array<{ id: CampaignDestination; label: string; hint: string; enabled: boolean }>;
}

export function destinationForView(view: View): CampaignDestination {
  if (view === "campaign-create") return "create";
  if (view === "campaign-rooms") return "play";
  if (view === "campaign-party") return "characters";
  if (view === "campaign-play" || view === "chat" || view === "campaign-combat") return "play";
  if (view.startsWith("campaign-character")) return "characters";
  if (view === "campaign-world" || view === "campaign-cast") return "world";
  if (["campaign-journal", "campaign-story", "campaign-history"].includes(view)) return "journal";
  if (view === "campaign-administration" || view === "campaign-transfer") return "manage";
  return "overview";
}

export function CampaignShell({ campaignId, view, selection, studio, combat, onNavigate, onCampaigns, children }: {
  campaignId: string; view: View; selection: { destination: CampaignDestination; view: View; request: number } | null;
  studio: boolean; combat: boolean; onNavigate: (destination: CampaignDestination) => void;
  onCampaigns: () => void; children: ReactNode;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [failed, setFailed] = useState(false);
  const [blocked, blockNavigation] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const report = useCallback((next: Identity | null) => {
    setIdentity(next?.id === campaignId ? next : null);
    setFailed(false);
  }, [campaignId]);
  // These pages already read authority. Reuse their result instead of issuing
  // a competing request that could disagree with the page's projection.
  const delegated = ["campaign-overview", "campaign-rooms", "campaign-party", "campaign-create", "campaign-detail", "campaign-play", "campaign-world", "campaign-cast", "campaign-journal", "campaign-story", "campaign-history", "campaign-transfer"].includes(view);
  useEffect(() => {
    if (delegated) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      report(null);
      void getCampaignDetail(campaignId).then(({ campaign }) => { if (current && request === generation) report(campaign); })
        .catch(() => { if (current && request === generation) { setIdentity(null); setFailed(true); } });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [campaignId, delegated, report, view]);

  useEffect(() => {
    if (!selection || selection.view !== view) return;
    const targetId = selection.destination === "characters" && view === "campaign-detail" ? "campaign-roster-heading"
      : selection.destination === "play" && view === "campaign-detail" ? "campaign-rooms-heading"
      : null;
    const focus = () => {
      if (["campaign-overview", "campaign-rooms", "campaign-party"].includes(view) && !content.current?.querySelector("[data-testid]")) return false;
      const target = targetId ? content.current?.querySelector<HTMLElement>(`#${targetId}`) : content.current?.querySelector<HTMLElement>("h1");
      if (!target) return false;
      target.tabIndex = -1;
      target.focus();
      target.scrollIntoView?.({ block: "start" });
      return true;
    };
    // Generation and roster headings arrive after authoritative reads.
    if (focus()) return;
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect(); });
    if (content.current) observer.observe(content.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selection, view]);

  const role = identity?.actorRole ?? null;
  const active = selection?.view === view ? selection.destination : destinationForView(view);
  const navigate = (destination: CampaignDestination) => {
    if (blocked) return;
    if ((destination === "create" || destination === "manage") && role !== "owner" && role !== "gm") return;
    if (destination === "create" && !combat) return;
    onNavigate(destination);
  };
  return <ShellContext.Provider value={{ report, navigate, generationAvailable: combat, blockNavigation }}><div className="control-plane">
    <a className="control-skip" href="#campaign-workspace">Skip to campaign workspace</a>
    <aside className="control-rail" aria-label="Campaign control plane">
      <button className="control-brand" disabled={blocked} onClick={onCampaigns}><span className="control-monogram" aria-hidden="true">V</span><span>VELVET<small>Campaigns</small></span></button>
      <div className="control-identity"><span className="control-kicker">Campaign workspace</span><strong>{identity?.name ?? "Your campaign"}</strong><span className="control-role">{role === "owner" ? "DM / Owner" : role === "gm" ? "DM" : role === "observer" ? "Spectator / Read-only" : role === "player" ? "Player" : failed ? "Role unavailable" : "Checking role..."}</span></div>
      <nav className="control-nav" aria-label="Campaign destinations">{campaignDestinations(role, studio, combat).map((item, index) => <button key={item.id} aria-label={`${item.label} workspace`} aria-current={active === item.id ? "page" : undefined} disabled={blocked || !item.enabled} title={item.hint} onClick={() => navigate(item.id)}><span className="control-nav-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span>{item.label}<small>{item.hint}</small></span></button>)}</nav>
      <div className="control-rail-note"><span className="control-kicker">At your table</span><p>{role === "observer" ? "Follow the story. Read shared material without issuing gameplay commands." : role === "player" ? "Your character, your choices. Available actions are verified by the server." : "Prepare the world. Review AI candidates. Keep the final say."}</p><small>Server-reported role. No role switching or remote sign-in is provided here.</small></div>
    </aside>
    <div className="control-stage">
      <header className="control-toolbar"><span>{active === "create" ? "Create / Reviewed generation" : active === "play" ? "Play / Table tools" : "Campaign / " + active.charAt(0).toUpperCase() + active.slice(1)}</span><nav aria-label="Table tools">
        {combat && <button disabled={blocked} aria-current={view === "campaign-combat" ? "page" : undefined} onClick={() => navigate("combat")}>Combat tracker</button>}
        {studio && <><button disabled={blocked} onClick={() => navigate("world")}>World & routes</button><button disabled={blocked} onClick={() => navigate("cast")}>Browse cast & factions</button></>}
        <button disabled={blocked} onClick={() => navigate("history")}>Read history & recaps</button>
      </nav></header>
      <div id="campaign-workspace" tabIndex={-1} ref={content} className="control-workspace"><CampaignWorkspaceBoundary key={`${campaignId}:${view}`} onOverview={() => onNavigate("overview")}>{children}</CampaignWorkspaceBoundary></div>
    </div>
  </div></ShellContext.Provider>;
}
