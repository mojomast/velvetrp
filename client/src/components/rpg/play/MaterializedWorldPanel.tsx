import { useState } from "react";
import type { CampaignWorldHttpResponse, EconomyHttpNpcShopAssociationGetResponse, EconomyHttpShopGetResponse, NpcCastHttp } from "@velvet/contracts";

/** Narrow read-only transport surface the panel needs; every method is a strict API read. */
export interface MaterializedWorldPanelApi {
  getWorld: (campaignId: string, sessionId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  getPresentCast: (campaignId: string, sessionId: string, audience: "gm") => Promise<NpcCastHttp>;
  getNpcShop: (campaignId: string, npcId: string) => Promise<EconomyHttpNpcShopAssociationGetResponse["association"] | null>;
  getShop: (campaignId: string, shopId: string) => Promise<EconomyHttpShopGetResponse>;
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
type WorldView = { locations: LocationRow[]; npcs: NpcRow[]; shops: ShopRow[]; partial: boolean };
type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: WorldView };

function castRows(cast: NpcCastHttp): NpcRow[] {
  if (cast.state === "running") {
    return cast.presentCast.map((npc) => ({ npcId: npc.npcId, name: npc.publicState.name, locationLabel: npc.location?.label ?? null }));
  }
  return cast.castHistory.map((npc) => ({ npcId: npc.npcId, name: npc.publicState.name, locationLabel: npc.lastLocation?.label ?? null }));
}

/**
 * Read-only GM/owner projection of the materialized public world. It renders only
 * server data from existing world, present-cast, association, and shop reads. It
 * never fires on mount, never issues a command, and never fabricates content:
 * the GM must press "Load world view" before any read happens.
 */
export function MaterializedWorldPanel({ campaignId, sessionId, audience, api }: MaterializedWorldPanelProps) {
  const [load, setLoad] = useState<Load>({ kind: "idle" });

  if (audience !== "gm") return null;
  const busy = load.kind === "loading";

  async function refresh() {
    if (busy) return;
    setLoad({ kind: "loading" });
    try {
      const [world, cast] = await Promise.all([
        api.getWorld(campaignId, sessionId),
        api.getPresentCast(campaignId, sessionId, "gm"),
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
        partial,
      } });
    } catch {
      setLoad({ kind: "error" });
    }
  }

  return <section className="materialized-world-panel" aria-labelledby="materialized-world-heading">
    <div className="actor-section-heading"><h2 id="materialized-world-heading">Materialized world</h2></div>
    <p className="actor-help">Read-only GM projection of the server&apos;s public locations, present characters, and shops. Loading it issues reads only; it never creates or changes content.</p>
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
    </>}
  </section>;
}
