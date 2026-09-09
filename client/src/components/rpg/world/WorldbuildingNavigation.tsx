import { useCampaignShell, type CampaignDestination } from "../shell/CampaignShell";
import type { StudioAuthorization } from "../StudioAuthorization";
import "./worldbuilding.css";

export function WorldbuildingNavigation({ current, authorization }: { current: CampaignDestination; authorization: StudioAuthorization }) {
  const { navigate, generationAvailable } = useCampaignShell();
  const gm = authorization.audience === "gm";
  return <section className="worldbuilding-context" aria-label="Connected worldbuilding">
    <p>{gm ? "Prepare a place, the people who matter, and a reason to adventure." : "Explore the world shared with your campaign. Private preparation is not included."}</p>
    {navigate && <nav className="button-row" aria-label="Worldbuilding destinations">
      {([{ id: "world", label: "Locations & opening" }, { id: "cast", label: "NPCs & factions" }, { id: "journal", label: "Quests" }, { id: "story", label: "Story & clues" }] as const).map(item =>
        <button key={item.id} aria-current={current === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}
      {gm && generationAvailable && <button className="primary" onClick={() => navigate("create")}>Generate world material</button>}
    </nav>}
    <p className="field-help">{authorization.role === "observer" ? "Read-only: observers cannot issue commands." : gm ? "Definitions are read-only after creation. Review player visibility before applying material; gameplay commands remain server-authorized." : "Only available gameplay commands can change state; world definitions are read-only."}</p>
  </section>;
}
