import { combatReadResponseSchema, encounterListResponseSchema, type EncounterPublic, type TacticalMapGenerationToken } from "@velvet/contracts";
import { ApiError } from "../../../api";

export type CombatRoster = Pick<EncounterPublic, "encounterId" | "combatId" | "revision" | "combatants">;

/** Read twice so a room transition cannot silently substitute another encounter. */
export async function readCombatRoster(campaignId: string, sessionId: string, encounterId: string, signal: AbortSignal): Promise<CombatRoster> {
  const read = async (path: string) => {
    const response = await fetch(`/api${path}`, { signal, cache: "no-store" });
    if (response.status !== 200) throw new ApiError(response.status, "Combat roster unavailable");
    return response.json() as Promise<unknown>;
  };
  const path = `/rpg/v1/campaigns/${encodeURIComponent(campaignId)}/encounters`;
  const active = (value: unknown) => encounterListResponseSchema.parse(value).encounters.filter((entry) => entry.sessionId === sessionId && entry.status === "active");
  const before = active(await read(path));
  if (before.length !== 1 || before[0]!.encounterId !== encounterId || !before[0]!.combatId) throw new Error("Encounter binding is ambiguous or stale");
  const encounter = before[0]!;
  const combat = combatReadResponseSchema.parse(await read(`/rpg/v1/combats/${encodeURIComponent(encounter.combatId!)}`));
  const after = active(await read(path));
  const identity = (entries: { combatantId: string; kind: string; actorId?: string; team: string }[]) => entries.map((entry) => `${entry.combatantId}:${entry.kind}:${entry.actorId ?? ""}:${entry.team}`).sort().join("|");
  if (after.length !== 1 || after[0]!.encounterId !== encounterId || after[0]!.combatId !== encounter.combatId || after[0]!.revision !== encounter.revision
    || identity(encounter.combatants) !== identity(combat.combatants) || identity(after[0]!.combatants) !== identity(encounter.combatants)) throw new Error("Encounter roster changed during review");
  const actors = encounter.combatants.flatMap((entry) => entry.kind === "actor" ? [entry.actorId] : []);
  if (!encounter.combatants.length || new Set(actors).size !== actors.length || new Set(combat.combatants.map((entry) => entry.combatantId)).size !== combat.combatants.length) throw new Error("Duplicate or empty combat roster");
  return encounter;
}

export type SpawnReview = { x: string; y: string; width: string; height: string; visibility: "" | "visible" | "hidden"; disposition: "" | TacticalMapGenerationToken["disposition"] };

export function reviewedSpawns(roster: CombatRoster, review: Record<string, SpawnReview>, grounded = false): TacticalMapGenerationToken[] | null {
  if (grounded && roster.combatants.length > 64) return null;
  const occupied = new Set<string>();
  const actors = new Set<string>();
  const ids = new Set<string>();
  const tokens: TacticalMapGenerationToken[] = [];
  for (const entry of roster.combatants) {
    const cell = review[entry.combatantId];
    if (!cell || !cell.x || !cell.y || !cell.width || !cell.height || !cell.visibility || !cell.disposition || ids.has(entry.combatantId)) return null;
    ids.add(entry.combatantId);
    if (entry.kind === "actor") { if (actors.has(entry.actorId)) return null; actors.add(entry.actorId); }
    const x = Number(cell.x) - 1, y = Number(cell.y) - 1, width = Number(cell.width), height = Number(cell.height);
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > 12 || y + height > 10) return null;
    if (grounded && (x < 1 || y < 1 || x + width >= 12 || y + height >= 10)) return null;
    for (let dx = 0; dx < width; dx++) for (let dy = 0; dy < height; dy++) {
      const key = `${x + dx},${y + dy}`;
      if (occupied.has(key)) return null;
      occupied.add(key);
    }
    tokens.push({ tokenId: entry.combatantId, combatantId: entry.combatantId, actorId: entry.kind === "actor" ? entry.actorId : null,
      label: entry.kind === "actor" ? entry.actorId : entry.combatantId, position: { x, y }, footprint: { width, height }, disposition: cell.disposition, hidden: cell.visibility === "hidden" });
  }
  return tokens.length ? tokens : null;
}
