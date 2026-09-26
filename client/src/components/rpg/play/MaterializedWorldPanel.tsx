import { useState } from "react";
import type { CampaignGeneratedPlanning, CampaignWorldHttpResponse, EconomyHttpNpcShopAssociationGetResponse, EconomyHttpShopGetResponse, NpcCastHttp } from "@velvet/contracts";
import type { CampaignFactionsHttpResponse } from "../../../api";

/** The minimal quest projection the GM world view needs; richer server reads satisfy it. */
export interface WorldViewQuestsData {
  quests: Array<{ questId: string; title?: string; status: string }>;
  objectives: Array<{ questId: string }>;
}

/** Narrow read-only transport surface the panel needs; every method is a strict API read. */
export interface MaterializedWorldPanelApi {
  getWorld: (campaignId: string, sessionId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  getPresentCast: (campaignId: string, sessionId: string, audience: "gm") => Promise<NpcCastHttp>;
  getNpcShop: (campaignId: string, npcId: string) => Promise<EconomyHttpNpcShopAssociationGetResponse["association"] | null>;
  getShop: (campaignId: string, shopId: string) => Promise<EconomyHttpShopGetResponse>;
  listFactions: (campaignId: string, audience: "gm") => Promise<{ data: CampaignFactionsHttpResponse; revision: number }>;
  listQuests: (campaignId: string, audience: "gm") => Promise<{ data: WorldViewQuestsData; revision: number }>;
  getGeneratedPlanning: (campaignId: string) => Promise<CampaignGeneratedPlanning>;
}

export interface MaterializedWorldPanelProps {
  campaignId: string;
  sessionId: string;
  /** Owner/GM only; any other audience renders nothing. */
  audience: "gm" | "player";
  api: MaterializedWorldPanelApi;
}

type LocationRow = { locationId: string; name: string; description: string };
type NpcRow = { npcId: string; name: string; locationLabel: string | null };
type ShopRow = { npcId: string; vendorLabel: string; shopId: string; shopLabel: string; name: string; stockLines: number };
type FactionRow = { factionId: string; name: string; visibility: string; description: string };
type QuestRow = { questId: string; title: string; status: string; objectives: number };
type RumorRow = { artifactKey: string; subject: string; summary: string };
type WorldView = { locations: LocationRow[]; npcs: NpcRow[]; shops: ShopRow[];
  factions: FactionRow[] | null; quests: QuestRow[] | null; rumors: RumorRow[] | null; partial: boolean };
type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: WorldView };

function castRows(cast: NpcCastHttp): NpcRow[] {
  if (cast.state === "running") {
    return cast.presentCast.map((npc) => ({ npcId: npc.npcId, name: npc.publicState.name, locationLabel: npc.location?.label ?? null }));
  }
  return cast.castHistory.map((npc) => ({ npcId: npc.npcId, name: npc.publicState.name, locationLabel: npc.lastLocation?.label ?? null }));
}

/** Structural view of a faction that tolerates both the GM and player projections. */
type FactionView = { factionId: string; name: string; publicState: { description: string }; privateState?: { visibility: string } };

/** Public-facing factions only; a GM-only faction is omitted rather than exposed here. */
function factionRows(response: CampaignFactionsHttpResponse): FactionRow[] {
  return [...response.factions]
    .map((faction) => {
      const view: FactionView = faction;
      return { factionId: view.factionId, name: view.name, visibility: view.privateState?.visibility ?? "public",
        description: view.publicState.description };
    })
    .filter((faction) => faction.visibility !== "gm");
}

function questRows(response: WorldViewQuestsData): QuestRow[] {
  const objectivesByQuest = new Map<string, number>();
  for (const objective of response.objectives) objectivesByQuest.set(objective.questId, (objectivesByQuest.get(objective.questId) ?? 0) + 1);
  return response.quests.map((quest) => ({ questId: quest.questId, title: quest.title ?? quest.questId, status: quest.status,
    objectives: objectivesByQuest.get(quest.questId) ?? 0 }));
}

/** The server tags public hearsay lore with a fixed title prefix; only those are rumors. */
const HEARSAY_TITLE_PREFIX = "Hearsay: ";

function rumorRows(planning: CampaignGeneratedPlanning): RumorRow[] {
  return planning.lore
    .filter((entry) => entry.visibility === "public" && entry.title.startsWith(HEARSAY_TITLE_PREFIX))
    .map((entry) => ({ artifactKey: entry.artifactKey, subject: entry.title.slice(HEARSAY_TITLE_PREFIX.length), summary: entry.summary }));
}

/**
 * Read-only GM/owner projection of the materialized public world. It renders only
 * server data from existing world, present-cast, association, shop, faction,
 * quest, and generated-planning reads. It never fires on mount, never issues a
 * command, and never fabricates content: the GM must press "Load world view"
 * before any read happens, and any unreadable section is omitted with a notice.
 */
export function MaterializedWorldPanel({ campaignId, sessionId, audience, api }: MaterializedWorldPanelProps) {
  const [load, setLoad] = useState<Load>({ kind: "idle" });

  if (audience !== "gm") return null;
  const busy = load.kind === "loading";

  async function refresh() {
    if (busy) return;
    setLoad({ kind: "loading" });
    try {
      const [world, cast, factionsRead, questsRead, planningRead] = await Promise.all([
        api.getWorld(campaignId, sessionId),
        api.getPresentCast(campaignId, sessionId, "gm"),
        api.listFactions(campaignId, "gm").catch(() => null),
        api.listQuests(campaignId, "gm").catch(() => null),
        api.getGeneratedPlanning(campaignId).catch(() => null),
      ]);
      const npcs = castRows(cast);
      let partial = false;
      const associations = await Promise.all(npcs.map(async (npc) => {
        try { return await api.getNpcShop(campaignId, npc.npcId); }
        catch { partial = true; return null; }
      }));
      const shops = await Promise.all(associations.map(async (association) => {
        if (!association) return null;
        try {
          const shop = await api.getShop(campaignId, association.shopId);
          return { npcId: association.npcId, vendorLabel: association.vendorLabel, shopId: association.shopId, shopLabel: association.shopLabel, name: shop.shop.name, stockLines: shop.stock.length };
        } catch { partial = true; return null; }
      }));
      setLoad({ kind: "ready", value: {
        locations: world.data.visibleLocations.map((location) => ({ locationId: location.locationId, name: location.name, description: location.description })),
        npcs,
        shops: shops.filter((shop): shop is ShopRow => shop !== null),
        factions: factionsRead ? factionRows(factionsRead.data) : null,
        quests: questsRead ? questRows(questsRead.data) : null,
        rumors: planningRead ? rumorRows(planningRead) : null,
        partial,
      } });
    } catch {
      setLoad({ kind: "error" });
    }
  }

  return <section className="materialized-world-panel" aria-labelledby="materialized-world-heading">
    <div className="actor-section-heading"><h2 id="materialized-world-heading">Materialized world</h2></div>
    <p className="actor-help">Read-only GM projection of the server&apos;s public locations, present characters, shops, factions, quests, and rumors. Loading it issues reads only; it never creates or changes content.</p>
    <button type="button" className="primary" disabled={busy} onClick={() => void refresh()}>
      {load.kind === "ready" ? "Refresh world view" : busy ? "Loading world view..." : "Load world view"}
    </button>
    {load.kind === "idle" && <p className="actor-help">Nothing is loaded yet. This panel does not read on mount.</p>}
    {load.kind === "loading" && <p role="status">Loading the materialized world from the server...</p>}
    {load.kind === "error" && <p role="alert">The materialized world could not be loaded. Nothing was changed; try again.</p>}
    {load.kind === "ready" && <>
      {load.value.partial && <p role="status">Some shops could not be read; those entries are omitted rather than guessed.</p>}
      <h3>Public locations</h3>
      {load.value.locations.length === 0
        ? <p>No public locations are visible to the server viewpoint.</p>
        : <ul>{load.value.locations.map((location) => <li key={location.locationId}><strong>{location.name}</strong>{location.description ? <p>{location.description}</p> : null}</li>)}</ul>}
      <h3>Public characters</h3>
      {load.value.npcs.length === 0
        ? <p>No characters are present in this room.</p>
        : <ul>{load.value.npcs.map((npc) => <li key={npc.npcId}>{npc.name}{npc.locationLabel ? ` - ${npc.locationLabel}` : ""}</li>)}</ul>}
      <h3>Shops</h3>
      {load.value.shops.length === 0
        ? <p>No present merchant has a materialized shop.</p>
        : <ul>{load.value.shops.map((shop) => <li key={shop.shopId}><strong>{shop.name}</strong> ({shop.vendorLabel}) — {shop.stockLines} stock line{shop.stockLines === 1 ? "" : "s"}</li>)}</ul>}
      <h3>Public factions</h3>
      {load.value.factions === null
        ? <p role="status">Public factions could not be read; that section is omitted rather than guessed.</p>
        : load.value.factions.length === 0
          ? <p>No public factions are visible to the server viewpoint.</p>
          : <ul>{load.value.factions.map((faction) => <li key={faction.factionId}>Faction {faction.name} ({faction.visibility}){faction.description ? ` — ${faction.description}` : ""}</li>)}</ul>}
      <h3>Public quests</h3>
      {load.value.quests === null
        ? <p role="status">Public quests could not be read; that section is omitted rather than guessed.</p>
        : load.value.quests.length === 0
          ? <p>No public quests are visible to the server viewpoint.</p>
          : <ul>{load.value.quests.map((quest) => <li key={quest.questId}>Quest {quest.title} ({quest.status}) — {quest.objectives} objective{quest.objectives === 1 ? "" : "s"}</li>)}</ul>}
      <h3>Public rumors</h3>
      {load.value.rumors === null
        ? <p role="status">Public rumors could not be read; that section is omitted rather than guessed.</p>
        : load.value.rumors.length === 0
          ? <p>No public rumors have been materialized.</p>
          : <ul>{load.value.rumors.map((rumor) => <li key={rumor.artifactKey}>Rumor {rumor.subject}{rumor.summary ? ` — ${rumor.summary}` : ""}</li>)}</ul>}
    </>}
  </section>;
}
