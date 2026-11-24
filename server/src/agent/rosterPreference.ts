export type RosterNpc = {
  name: string;
  homeLocation?: string | null;
  factionIds?: readonly string[];
  questIds?: readonly string[];
  archetype?: string | null;
};

export type LocationTies = {
  locationName: string;
  factionIds?: readonly string[];
  questIds?: readonly string[];
};

export type RankedCast = {
  present: string[];
  tiedToLocation: string[];
  widerRoster: string[];
};

const normalize = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

const uniqueIds = (ids: readonly string[] | undefined): Set<string> =>
  new Set((ids ?? []).map((id) => id.trim()).filter(Boolean));

function sharesId(values: readonly string[] | undefined, ids: Set<string>): boolean {
  return Boolean(values?.some((value) => ids.has(value.trim())));
}

/**
 * Ranks the known roster for one location without changing presence: names appear in at most one
 * list, and a wider-roster NPC is a known name, never an assertion that it is co-located.
 */
export function rankNpcsForLocation(input: {
  locationName: string | null | undefined;
  presentNames?: readonly string[];
  npcs: readonly RosterNpc[];
  locationTies?: LocationTies;
}): RankedCast {
  const npcs = input.npcs;
  const used = new Set<string>();
  const present: string[] = [];
  for (const raw of input.presentNames ?? []) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!key || used.has(key)) continue;
    used.add(key);
    const match = npcs.find((npc) => npc.name.trim().toLowerCase() === key);
    present.push(match ? match.name : name);
  }

  const location = normalize(input.locationName);
  const tiedToLocation: string[] = [];
  const remaining: RosterNpc[] = [];
  for (const npc of npcs) {
    const key = npc.name.trim().toLowerCase();
    if (used.has(key)) continue;
    if (location && normalize(npc.homeLocation) === location) {
      used.add(key);
      tiedToLocation.push(npc.name);
    } else {
      remaining.push(npc);
    }
  }

  if (location) {
    const factionIds = uniqueIds(input.locationTies?.factionIds);
    const questIds = uniqueIds(input.locationTies?.questIds);
    if (factionIds.size || questIds.size) {
      for (const npc of remaining) {
        const key = npc.name.trim().toLowerCase();
        if (used.has(key)) continue;
        if (sharesId(npc.factionIds, factionIds) || sharesId(npc.questIds, questIds)) {
          used.add(key);
          tiedToLocation.push(npc.name);
        }
      }
    }
  }

  const widerRoster: string[] = [];
  for (const npc of npcs) {
    const key = npc.name.trim().toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    widerRoster.push(npc.name);
  }

  return { present, tiedToLocation, widerRoster };
}

export function rosterPreferenceInstructions(ranked: RankedCast): string {
  const list = (names: readonly string[]): string => (names.length ? names.join(", ") : "none");
  return [
    "ROSTER PREFERENCE FOR THIS LOCATION",
    "If the scene needs a character, use the present NPCs first, then the NPCs tied to this location, then the wider roster. Do not invent named extras or new NPCs when these lists can fill the role.",
    "Wider-roster NPCs are not established as present here: do not place them at this location or give them immediate dialogue as if they lived here. Do not move an NPC away from their home location.",
    `Present NPCs (only these are established as present): ${list(ranked.present)}`,
    `NPCs tied to this location: ${list(ranked.tiedToLocation)}`,
    `Wider roster (known NPCs, not present here): ${list(ranked.widerRoster)}`,
  ].join("\n");
}

/** Reads an optional preferredCast from untrusted public context, ignoring malformed shapes. */
export function preferredCastFromContext(context: unknown): RankedCast | null {
  if (!context || typeof context !== "object") return null;
  const candidate = (context as { preferredCast?: unknown }).preferredCast;
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  return strings(record.present) && strings(record.tiedToLocation) && strings(record.widerRoster)
    ? { present: [...record.present], tiedToLocation: [...record.tiedToLocation], widerRoster: [...record.widerRoster] }
    : null;
}

function rosterRow(name: string, ...parts: readonly RosterNpc[]): RosterNpc {
  const row: RosterNpc = { name };
  const home = parts.map((part) => part.homeLocation).find((value) => Boolean(value)) ?? parts[0]?.homeLocation;
  if (home !== undefined) row.homeLocation = home;
  const archetype = parts.map((part) => part.archetype).find((value) => Boolean(value)) ?? parts[0]?.archetype;
  if (archetype !== undefined) row.archetype = archetype;
  const factionIds = parts.map((part) => part.factionIds).find((value) => value && value.length);
  if (factionIds) row.factionIds = factionIds;
  const questIds = parts.map((part) => part.questIds).find((value) => value && value.length);
  if (questIds) row.questIds = questIds;
  return row;
}

/** Merges roster rows by case-insensitive name, keeping the first name spelling and filling blanks. */
export function mergeRosterNpcs(...groups: Array<readonly RosterNpc[] | null | undefined>): RosterNpc[] {
  const byName = new Map<string, RosterNpc>();
  for (const group of groups) {
    for (const npc of group ?? []) {
      const name = npc.name.trim();
      const key = name.toLowerCase();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, rosterRow(name, npc));
        continue;
      }
      byName.set(key, rosterRow(existing.name, existing, npc));
    }
  }
  return [...byName.values()];
}
