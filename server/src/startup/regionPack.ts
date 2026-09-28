import {
  MAX_REGION_PACK_CONNECTIONS,
  MAX_REGION_PACK_LOCATIONS,
  MAX_REGION_PACK_SELECTED_KEYS,
  MIN_REGION_PACK_LOCATIONS,
  type CampaignContentGenerationRequest,
  type CampaignRegionPackLinked,
  type GeneratedCampaignContentProvider,
} from "@velvet/contracts";

/**
 * Fixed region-pack sections. A region pack is always one request that covers
 * the outline, the new location graph, and the linked cast/quest/story material.
 */
export const REGION_PACK_SECTIONS = ["outline", "locations", "factions", "npcs", "quests", "clues", "story"] as const;

/** Only `linked.encounters` adds a section; every other hint is advisory prose. */
export function regionPackSections(linked: CampaignRegionPackLinked | undefined): CampaignContentGenerationRequest["sections"] {
  const sections: CampaignContentGenerationRequest["sections"] = [...REGION_PACK_SECTIONS];
  if (linked?.encounters === true) sections.push("encounters");
  return sections;
}

export interface RegionPackBriefInput {
  brief: string;
  tone?: string | undefined;
  exclusions?: readonly string[] | undefined;
  locationCount: number;
  linked?: CampaignRegionPackLinked | undefined;
  anchorLocationKey?: string | undefined;
  /** True when the campaign already designates an immutable starting location. */
  anchorRequired: boolean;
}

/**
 * Compose the server-owned region constraint text. It is carried to the
 * provider through the existing content-generation brief channel so the region
 * route reuses the generation core without a second provider prompt shape.
 */
export function buildRegionPackBrief(input: RegionPackBriefInput): string {
  const linked = input.linked ?? {};
  const wants = (...values: Array<boolean | undefined>) => values.some((value) => value !== false);
  const lines = [
    "REGION PACK: create one coherent, immediately playable opening/quest area.",
    `Operator brief: ${input.brief}`,
    `Return exactly one outline, ${input.locationCount} new public locations, and public connections that make one connected traversable region.`,
    "Every location and connection in this pack must be public. Do not emit GM-only locations or connections in the opening area.",
    "Every connection endpoint must be a new location key in this pack or the supplied accepted anchor location key. Never connect a location to itself and never repeat the same directed connection.",
  ];
  if (input.anchorRequired) {
    lines.push(`The campaign already has an immutable starting location. Do not re-anchor it. Connect at least one connection to the accepted anchor location '${input.anchorLocationKey}', and keep every new location reachable from that anchor.`);
  } else {
    lines.push("Set the outline startLocationKey to one of the new locations in this pack (self-anchoring). The server designates it as the campaign starting location.");
  }
  if (input.anchorLocationKey && !input.anchorRequired) {
    lines.push(`You may additionally connect the new region to the accepted anchor location '${input.anchorLocationKey}'.`);
  }
  if (wants(linked.factions)) lines.push("Link at least one faction to the new area.");
  if (wants(linked.npcs)) lines.push("Link at least one NPC to a new location (and optionally a new faction).");
  if (wants(linked.quests)) lines.push("Create at least one quest whose locationKeys use new locations in this pack and whose objectives are actionable in the opening area.");
  if (wants(linked.clues)) lines.push("Create at least one clue that resolves to a new location or to accepted canon.");
  if (wants(linked.storyNodes)) lines.push("Create public opening story nodes and relationships that connect the region to the campaign premise.");
  if (linked.encounters === true) lines.push("Prepare at least one narrative encounter plan tied to the new area; do not assume combat without an exact pinned catalog enemy reference.");
  lines.push("Keep every public field spoiler-free and every unrevealed discovery, hazard, or secret in GM-only artifacts.");
  return lines.join("\n");
}

export class RegionPackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionPackValidationError";
  }
}

export interface RegionPackValidationInput {
  locationCount: number;
  anchorLocationKey?: string | undefined;
  /** True when the campaign already designates an immutable starting location. */
  anchorRequired: boolean;
  /** Accepted public location artifact keys usable as external anchors or references. */
  acceptedLocationKeys: ReadonlySet<string>;
}

const artifactFields = [
  "outlines", "arcs", "locations", "connections", "factions", "npcs", "quests", "encounters",
  "clues", "storyNodes", "storyRelationships", "lore", "questItems", "monsterConcepts",
  "handouts", "scenePrompts",
] as const;

/** Every generated artifact key in stable collection order. */
export function regionPackArtifactKeys(content: GeneratedCampaignContentProvider): string[] {
  const value = content as unknown as Record<string, ReadonlyArray<{ key: string }>>;
  return artifactFields.flatMap((field) => (value[field] ?? []).map((artifact) => artifact.key));
}

/**
 * Fail-closed region checks that run after `sanitizeGeneratedCampaignContent`
 * and after `validateContent` (which owns full reference closure). This function
 * additionally enforces the graph and anchoring guarantees a region pack needs.
 */
export function validateRegionPack(content: GeneratedCampaignContentProvider, input: RegionPackValidationInput): void {
  const fail = (message: string): never => { throw new RegionPackValidationError(message); };

  const locations = content.locations;
  if (locations.length > MAX_REGION_PACK_LOCATIONS) fail("region pack exceeds the location bound");
  if (locations.length < MIN_REGION_PACK_LOCATIONS) fail("region pack needs at least four locations");
  if (locationCountMismatch(locations.length, input.locationCount)) fail("region pack location count is outside the requested bound");

  const connections = content.connections;
  if (connections.length > MAX_REGION_PACK_CONNECTIONS) fail("region pack exceeds the connection bound");
  if (connections.length < locations.length - 1) fail("region pack connections cannot form a connected location graph");

  const keys = new Set(regionPackArtifactKeys(content));
  if (keys.size > MAX_REGION_PACK_SELECTED_KEYS) fail("region pack exceeds the applied artifact bound");

  if (content.outlines.length !== 1) fail("region pack requires exactly one outline");

  const packKeys = new Set(locations.map((location) => location.key));
  if (packKeys.size !== locations.length) fail("region pack location keys must be unique");
  for (const location of locations) if (location.visibility !== "public") fail("region pack opening locations must be public");

  const anchor = input.anchorLocationKey;
  if (anchor !== undefined) {
    if (packKeys.has(anchor)) fail("region pack anchor must be an accepted location, not a new pack location");
    if (!input.acceptedLocationKeys.has(anchor)) fail("region pack anchor location is not accepted public canon");
  }
  if (input.anchorRequired) {
    if (anchor === undefined) fail("region pack anchoring to existing canon requires an accepted anchor location");
  } else {
    const start = content.outlines[0]?.startLocationKey;
    if (start === undefined) fail("region pack outline must self-anchor to a new pack location");
    else if (!packKeys.has(start)) fail("region pack start location must be one of its new locations");
  }

  const adjacency = new Map<string, Set<string>>();
  const directed = new Set<string>();
  const allowedEndpoint = (key: string) => packKeys.has(key) || key === anchor;
  for (const connection of connections) {
    if (connection.visibility !== "public") fail("region pack opening connections must be public");
    if (connection.fromLocationKey === connection.toLocationKey) fail("region pack connections cannot connect a location to itself");
    if (!allowedEndpoint(connection.fromLocationKey) || !allowedEndpoint(connection.toLocationKey)) fail("region pack connection endpoint must resolve in-pack or to the accepted anchor");
    const signature = `${connection.fromLocationKey}\u0000${connection.toLocationKey}`;
    if (directed.has(signature)) fail("region pack contains a duplicate directed connection");
    directed.add(signature);
    for (const [from, to] of [[connection.fromLocationKey, connection.toLocationKey], [connection.toLocationKey, connection.fromLocationKey]] as const) {
      const neighbors = adjacency.get(from) ?? new Set<string>();
      neighbors.add(to);
      adjacency.set(from, neighbors);
    }
  }

  const nodes = new Set<string>(packKeys);
  if (anchor !== undefined) nodes.add(anchor);
  const first = nodes.values().next().value as string | undefined;
  const reachable = new Set<string>();
  if (first !== undefined) {
    const stack = [first];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const neighbor of adjacency.get(current) ?? []) if (!reachable.has(neighbor)) stack.push(neighbor);
    }
  }
  if (reachable.size !== nodes.size) fail("region pack location graph must be connected including every location and the anchor");

  const resolves = (key: string) => packKeys.has(key) || input.acceptedLocationKeys.has(key);
  for (const npc of content.npcs) if (npc.locationKey !== undefined && !resolves(npc.locationKey)) fail("region pack NPC location must resolve in-pack or to accepted canon");
  for (const quest of content.quests) for (const locationKey of quest.locationKeys) if (!resolves(locationKey)) fail("region pack quest location must resolve in-pack or to accepted canon");
  for (const clue of content.clues) if (clue.locationKey !== undefined && !resolves(clue.locationKey)) fail("region pack clue location must resolve in-pack or to accepted canon");
}

function locationCountMismatch(actual: number, requested: number): boolean {
  // A provider may under-deliver bounded locations but may never exceed the request.
  return actual > requested;
}
