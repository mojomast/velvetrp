import { mergeRosterNpcs, rankNpcsForLocation, type RankedCast, type RosterNpc } from "./rosterPreference.js";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function listedNpcs(value: unknown): RosterNpc[] {
  const npcs = asRecord(value)?.npcs;
  if (!Array.isArray(npcs)) return [];
  const rows: RosterNpc[] = [];
  for (const entry of npcs) {
    const publicState = asRecord(asRecord(entry)?.publicState);
    const name = publicState?.name;
    if (typeof name !== "string" || !name.trim()) continue;
    const archetype = publicState?.archetype;
    rows.push({
      name,
      ...(typeof archetype === "string" || archetype === null ? { archetype } : {}),
    });
  }
  return rows;
}

function placedNpcs(value: unknown): RosterNpc[] {
  const record = asRecord(value);
  if (record?.state !== "running" || !Array.isArray(record.presentCast)) return [];
  const rows: RosterNpc[] = [];
  for (const entry of record.presentCast) {
    const npc = asRecord(entry);
    const publicState = asRecord(npc?.publicState);
    const name = publicState?.name;
    if (typeof name !== "string" || !name.trim()) continue;
    const archetype = publicState?.archetype;
    const label = asRecord(npc?.location)?.label;
    rows.push({
      name,
      ...(typeof archetype === "string" || archetype === null ? { archetype } : {}),
      ...(typeof label === "string" || label === null ? { homeLocation: label } : {}),
    });
  }
  return rows;
}

/**
 * Builds a ranked preferred cast from already-authorized world reads. Missing or failing reads
 * fail open so narration and planning can continue without roster instructions.
 */
export function preferredCastFromRepositories(input: {
  locationName: string | null | undefined;
  presentNames: readonly string[];
  listNpcs?: () => unknown;
  getCast?: () => unknown;
}): RankedCast | undefined {
  let listed: RosterNpc[] = [];
  let placed: RosterNpc[] = [];
  try {
    listed = listedNpcs(input.listNpcs?.());
  } catch {
    // The roster is optional context; a failed list must not fail the turn.
  }
  try {
    placed = placedNpcs(input.getCast?.());
  } catch {
    // Placement labels are optional; listed names still rank a wider roster.
  }
  const npcs = mergeRosterNpcs(listed, placed);
  if (input.presentNames.length === 0 && npcs.length === 0) return undefined;
  return rankNpcsForLocation({
    locationName: input.locationName,
    presentNames: input.presentNames,
    npcs,
  });
}

/** Ranks a player-safe roster already filtered of GM-only artifacts. */
export function preferredCastFromPublicRoster(input: {
  locationName: string | null | undefined;
  presentNames: readonly string[];
  roster?: readonly { name: string; homeLocation?: string | null }[];
}): RankedCast | undefined {
  const rows = input.roster ?? [];
  return preferredCastFromRepositories({
    locationName: input.locationName,
    presentNames: input.presentNames,
    listNpcs: () => ({ npcs: rows.map((npc) => ({ publicState: { name: npc.name } })) }),
    getCast: () => ({
      state: "running",
      presentCast: rows.map((npc) => ({
        publicState: { name: npc.name },
        location: npc.homeLocation ? { label: npc.homeLocation } : null,
      })),
    }),
  });
}
