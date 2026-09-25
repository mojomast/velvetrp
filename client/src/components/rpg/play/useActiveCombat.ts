import { useEffect, useState } from "react";
import type { CombatReadResponse, EncounterPublic } from "@velvet/contracts";

/** Narrow reader needed to discover the active encounter combat for one room. */
export interface ActiveCombatApi {
  listEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
}

export interface ActiveCombatState {
  combatId: string;
  combat: CombatReadResponse;
}

/**
 * Reads the active encounter combat bound to one room, refreshing with the
 * caller's key. Returns null while loading, when no encounter is active, or
 * when the read fails; combat commands stay authoritative on the server.
 */
export function useActiveCombat(
  campaignId: string,
  sessionId: string,
  api: ActiveCombatApi | undefined,
  refreshKey: number,
): ActiveCombatState | null {
  const [state, setState] = useState<ActiveCombatState | null>(null);
  useEffect(() => {
    if (!api) { setState(null); return; }
    let alive = true;
    void (async () => {
      try {
        const { encounters } = await api.listEncounters(campaignId);
        const active = encounters.find((encounter) => encounter.sessionId === sessionId && encounter.status === "active" && encounter.combatId);
        if (!active?.combatId) { if (alive) setState(null); return; }
        const combat = await api.getCombat(active.combatId);
        if (alive) setState({ combatId: active.combatId, combat });
      } catch { if (alive) setState(null); }
    })();
    return () => { alive = false; };
  }, [api, campaignId, refreshKey, sessionId]);
  return state;
}
