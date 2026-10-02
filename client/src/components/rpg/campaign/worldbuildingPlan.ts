import { campaignGenerationDesiredCountsSchema, type CampaignContentDraftView, type CampaignContentGenerationRequest } from "@velvet/contracts";

export type WorldbuildingSection = CampaignContentGenerationRequest["sections"][number];
export type ArtifactField = Exclude<keyof CampaignContentDraftView["preview"], "npcStats">;

export const WORLDBUILDING_SECTIONS: readonly WorldbuildingSection[] = [
  "outline", "arcs", "locations", "factions", "npcs", "quests", "encounters",
  "clues", "story", "lore", "quest-items", "monster-concepts", "handouts", "scene-prompts",
];

export const WORLDBUILDING_FIELDS: readonly ArtifactField[] = [
  "outlines", "arcs", "locations", "connections", "factions", "npcs", "quests", "encounters",
  "clues", "storyNodes", "storyRelationships", "lore", "questItems", "monsterConcepts", "handouts", "scenePrompts",
];

export const SECTION_FIELDS: Record<WorldbuildingSection, readonly ArtifactField[]> = {
  outline: ["outlines"],
  arcs: ["arcs"],
  locations: ["locations", "connections"],
  factions: ["factions"],
  npcs: ["npcs"],
  quests: ["quests"],
  encounters: ["encounters"],
  clues: ["clues"],
  story: ["storyNodes", "storyRelationships"],
  lore: ["lore"],
  "quest-items": ["questItems"],
  "monster-concepts": ["monsterConcepts"],
  handouts: ["handouts"],
  "scene-prompts": ["scenePrompts"],
};

export interface WorldbuildingExpandSelector {
  stageId: string;
  fields: ArtifactField[];
  limit?: number;
}

export interface WorldbuildingStagePlan {
  id: string;
  label: string;
  sections: WorldbuildingSection[];
  brief: string;
  tone?: string;
  exclusions?: string[];
  desiredCounts: Record<string, number>;
  expandFrom?: WorldbuildingExpandSelector[];
}

export interface WorldbuildingPlan {
  tone: string;
  exclusions: string[];
  stages: WorldbuildingStagePlan[];
}

export class WorldbuildingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldbuildingPlanError";
  }
}

function fail(message: string): never {
  throw new WorldbuildingPlanError(message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) fail(`${label} must be an array of non-empty strings`);
  return value.map((item) => (item as string).trim());
}

const slug = /^[a-z][a-z0-9-]*$/;

/** Validates the advanced-mode plan exactly as the client will dispatch it. */
export function parseWorldbuildingPlan(value: unknown): WorldbuildingPlan {
  const raw = asObject(value, "plan");
  const tone = raw.tone === undefined ? "adventurous and grounded" : asString(raw.tone, "plan.tone");
  if (tone.length > 200) fail("plan.tone must be 200 characters or fewer");
  const exclusions = raw.exclusions === undefined ? [] : asStringArray(raw.exclusions, "plan.exclusions");
  if (exclusions.length > 16) fail("plan.exclusions must contain at most 16 entries");
  if (exclusions.some((item) => item.length > 200)) fail("each plan exclusion must be 200 characters or fewer");
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) fail("plan.stages must be a non-empty array");
  if (raw.stages.length > 24) fail("plan.stages must contain at most 24 entries");
  const seen = new Set<string>();
  const stageFields = new Map<string, Set<ArtifactField>>();
  const stages = raw.stages.map((entry, index): WorldbuildingStagePlan => {
    const stage = asObject(entry, `plan.stages[${index}]`);
    const id = asString(stage.id, `plan.stages[${index}].id`);
    if (!slug.test(id) || id.length > 40) fail(`plan.stages[${index}].id must be a lowercase hyphenated slug`);
    if (seen.has(id)) fail(`duplicate stage id: ${id}`);
    seen.add(id);
    const sectionValues = asStringArray(stage.sections, `${id}.sections`);
    if (sectionValues.length === 0 || sectionValues.length > 14) fail(`${id}.sections must contain between 1 and 14 sections`);
    if (new Set(sectionValues).size !== sectionValues.length) fail(`${id}.sections must not repeat a section`);
    const sections = sectionValues.map((section): WorldbuildingSection => {
      if (!WORLDBUILDING_SECTIONS.includes(section as WorldbuildingSection)) fail(`${id}.sections contains unsupported section "${section}"`);
      return section as WorldbuildingSection;
    });
    const brief = asString(stage.brief, `${id}.brief`);
    if (brief.length > 4_000) fail(`${id}.brief must be 4000 characters or fewer`);
    const stageTone = stage.tone === undefined ? undefined : asString(stage.tone, `${id}.tone`);
    if (stageTone !== undefined && stageTone.length > 200) fail(`${id}.tone must be 200 characters or fewer`);
    const stageExclusions = stage.exclusions === undefined ? undefined : asStringArray(stage.exclusions, `${id}.exclusions`);
    if (stageExclusions !== undefined && (stageExclusions.length > 16 || stageExclusions.some((item) => item.length > 200))) fail(`${id}.exclusions is invalid`);
    const countsRaw = asObject(stage.desiredCounts, `${id}.desiredCounts`);
    const fields = new Set<ArtifactField>(sections.flatMap((section) => SECTION_FIELDS[section]));
    const desiredCounts: Record<string, number> = {};
    for (const [field, count] of Object.entries(countsRaw)) {
      if (!fields.has(field as ArtifactField)) fail(`${id}.desiredCounts.${field} is not part of the requested sections`);
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) fail(`${id}.desiredCounts.${field} must be a positive integer`);
      desiredCounts[field] = count;
    }
    if (Object.keys(desiredCounts).length === 0) fail(`${id}.desiredCounts must not be empty`);
    if (!campaignGenerationDesiredCountsSchema.safeParse(desiredCounts).success) fail(`${id}.desiredCounts exceeds the supported per-field limits`);
    let expandFrom: WorldbuildingExpandSelector[] | undefined;
    if (stage.expandFrom !== undefined) {
      if (!Array.isArray(stage.expandFrom)) fail(`${id}.expandFrom must be an array`);
      const selectorIds = new Set<string>();
      let budget = 0;
      expandFrom = stage.expandFrom.map((entrySelector, selectorIndex): WorldbuildingExpandSelector => {
        const selector = asObject(entrySelector, `${id}.expandFrom[${selectorIndex}]`);
        const stageId = asString(selector.stageId, `${id}.expandFrom[${selectorIndex}].stageId`);
        if (!seen.has(stageId) || stageId === id) fail(`${id}.expandFrom must reference an earlier stage id`);
        if (selectorIds.has(stageId)) fail(`${id}.expandFrom repeats stage ${stageId}`);
        selectorIds.add(stageId);
        const sourceFields = stageFields.get(stageId)!;
        const selectorFields = asStringArray(selector.fields, `${id}.expandFrom[${selectorIndex}].fields`).map((field): ArtifactField => {
          if (!WORLDBUILDING_FIELDS.includes(field as ArtifactField) || !sourceFields.has(field as ArtifactField)) fail(`${id}.expandFrom.${field} is not produced by stage ${stageId}`);
          return field as ArtifactField;
        });
        const limit = selector.limit;
        if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 16)) fail(`${id}.expandFrom[${selectorIndex}].limit must be between 1 and 16`);
        budget += limit ?? 16;
        if (budget > 16) fail(`${id}.expandFrom selects more than 16 context keys`);
        return { stageId, fields: selectorFields, ...(limit === undefined ? {} : { limit }) };
      });
    }
    stageFields.set(id, fields);
    return {
      id,
      label: labelForSections(sections),
      sections,
      brief,
      ...(stageTone === undefined ? {} : { tone: stageTone }),
      ...(stageExclusions === undefined ? {} : { exclusions: stageExclusions }),
      desiredCounts,
      ...(expandFrom === undefined ? {} : { expandFrom }),
    };
  });
  return { tone, exclusions, stages };
}

export function labelForSections(sections: readonly WorldbuildingSection[]): string {
  return sections.map((section) => section.replace(/-/g, " ")).join(" / ");
}

/** The reviewed default plan run by prompt mode. */
export function defaultWorldbuildingStages(): WorldbuildingStagePlan[] {
  const stages: WorldbuildingStagePlan[] = [
    { id: "factions", label: "Factions", sections: ["factions"], brief: "Create the factions whose competing aims give the premise traction. Give each public visibility and a spoiler-free description; put hidden aims and secrets in gmNotes.", desiredCounts: { factions: 4 } },
    { id: "locations", label: "Locations", sections: ["locations"], brief: "Map distinct traversable places. Every location and connection must have visibility public with spoiler-free descriptions. Keep secrets for later GM lore and scenes. Every place must be reachable from every other through directed routes, including explicit reverse connections for return travel; no stranded destinations.", desiredCounts: { locations: 6, connections: 10 } },
    { id: "foundation", label: "Foundation", sections: ["outline", "arcs"], brief: "State the opening situation, player-facing premise, and narrative arcs. The public outline must set startLocationKey to an accepted public location.", desiredCounts: { outlines: 1, arcs: 3 } },
    { id: "cast", label: "Cast", sections: ["npcs"], brief: "Populate accepted places and factions with public characters, including allies, rivals, and enemies. Bind each locationKey to an accepted place. Public descriptions cover observable behavior; privateGoals contain agendas, secrets and reactions to player choices.", desiredCounts: { npcs: 6 } },
    { id: "story", label: "Story", sections: ["story", "clues"], brief: "Shape narrative beats and discoverable clues that can be recovered in more than one way.", desiredCounts: { storyNodes: 8, storyRelationships: 6, clues: 5 } },
    { id: "quests", label: "Quests", sections: ["quests"], brief: "Offer actionable optional objectives with bounded typed rewards. Each quest must reference accepted places through locationKeys; use accepted public arcs when available.", desiredCounts: { quests: 5 } },
    { id: "bestiary", label: "Enemies and monsters", sections: ["monster-concepts"], brief: "Create enemies and monsters with habitats, motives, tells, and noncombat approaches; mark mechanics inert unless an accepted pin exists.", desiredCounts: { monsterConcepts: 4 } },
    { id: "items", label: "Items", sections: ["quest-items"], brief: "Create quest items tied to accepted quests and places, binding mechanics only to accepted pins.", desiredCounts: { questItems: 4 } },
    { id: "encounters", label: "Encounters", sections: ["encounters"], brief: "Prepare situated encounter plans with objectives, terrain, escalation, and resolution. For combat rosters use exact pinned enemy references; otherwise describe noncombat situations without a mechanical roster.", desiredCounts: { encounters: 5 } },
    { id: "lore", label: "Lore", sections: ["lore"], brief: "Record typed campaign history, customs, truths, and beliefs tied to accepted canon.", desiredCounts: { lore: 6 } },
    { id: "table", label: "Table material", sections: ["handouts", "scene-prompts"], brief: "Prepare review-only public handouts and runnable GM scenes. Each scene must use an accepted locationKey and relevant accepted npcKeys, with multiple approaches and reactions rather than prescribed player actions.", desiredCounts: { handouts: 3, scenePrompts: 4 } },
  ];
  const dependencies: Record<string, WorldbuildingExpandSelector[]> = {
    locations: [{ stageId: "factions", fields: ["factions"], limit: 4 }],
    foundation: [{ stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "factions", fields: ["factions"], limit: 4 }],
    cast: [{ stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "factions", fields: ["factions"], limit: 4 }],
    story: [{ stageId: "cast", fields: ["npcs"], limit: 6 }, { stageId: "locations", fields: ["locations"], limit: 6 }],
    quests: [{ stageId: "story", fields: ["storyNodes", "clues"], limit: 4 }, { stageId: "cast", fields: ["npcs"], limit: 3 }, { stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "foundation", fields: ["arcs"], limit: 3 }],
    bestiary: [{ stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "factions", fields: ["factions"], limit: 4 }],
    items: [{ stageId: "quests", fields: ["quests"], limit: 5 }, { stageId: "locations", fields: ["locations"], limit: 6 }],
    encounters: [{ stageId: "bestiary", fields: ["monsterConcepts"], limit: 4 }, { stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "quests", fields: ["quests"], limit: 5 }],
    lore: [{ stageId: "factions", fields: ["factions"], limit: 4 }, { stageId: "locations", fields: ["locations"], limit: 6 }],
    table: [{ stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "cast", fields: ["npcs"], limit: 6 }, { stageId: "encounters", fields: ["encounters"], limit: 2 }, { stageId: "lore", fields: ["lore"], limit: 2 }],
  };
  return stages.map((stage) => ({ ...stage, expandFrom: dependencies[stage.id] }));
}

export function buildDefaultPlan(tone: string, exclusions: string[]): WorldbuildingPlan {
  return { tone: tone.trim() || "adventurous and grounded", exclusions, stages: defaultWorldbuildingStages() };
}

export function composeStageBrief(prompt: string, stage: WorldbuildingStagePlan): string {
  const targets = Object.entries(stage.desiredCounts).map(([field, count]) => `${count} ${field}`).join(", ");
  const direction = prompt.trim();
  return `${direction ? `${direction}\n\n` : ""}${stage.brief}\n\nMinimum coverage: ${targets}. Preserve accepted canon and connect new material to it. Support free exploration and player choices rather than a mandatory plot sequence.`;
}

export function coverageIssues(preview: CampaignContentDraftView["preview"], counts: Record<string, number>): string[] {
  return Object.entries(counts).flatMap(([field, minimum]) => {
    const items = preview[field as ArtifactField] ?? [];
    const actual = new Set(items.map((item) => item.key).filter(Boolean)).size;
    return actual < minimum ? [`Coverage incomplete: ${field} requires ${minimum}, received ${actual}.`] : [];
  });
}

/** Additional prompt-mode readiness checks; server apply remains authoritative for typed references. */
export function worldLinkIssues(preview: CampaignContentDraftView["preview"], accepted: Record<string, Record<string, string[]>>): string[] {
  const issues: string[] = [];
  const places = new Set([...Object.values(accepted).flatMap((fields) => fields.locations ?? []), ...preview.locations.filter((place) => place.visibility === "public").map((place) => place.key)]);
  for (const outline of preview.outlines) {
    if (outline.visibility !== "public" || !outline.startLocationKey || !places.has(outline.startLocationKey)) issues.push("The opening must reference an accepted public starting location.");
  }
  if (preview.npcs.some((npc) => !npc.locationKey || !places.has(npc.locationKey))) issues.push("Every character needs an accepted public location.");
  if (preview.quests.some((quest) => !quest.objectives?.length)) issues.push("Every quest needs actionable objectives.");
  if (preview.quests.some((quest) => !quest.locationKeys?.length || quest.locationKeys.some((key) => !places.has(key)))) issues.push("Every quest needs accepted public location anchors.");
  if (preview.scenePrompts.some((scene) => !scene.locationKey || !places.has(scene.locationKey))) issues.push("Every scene needs an accepted public location.");
  const publicPlaces = preview.locations.filter((place) => place.visibility === "public");
  if (preview.locations.length && publicPlaces.length !== preview.locations.length) issues.push("World-map locations must be public; place secrets in GM lore and scenes.");
  if (publicPlaces.length > 1) {
    const edges = preview.connections.filter((edge) => edge.visibility === "public");
    const root = publicPlaces[0]!.key;
    const reachable = (reverse: boolean) => {
      const visited = new Set([root]);
      for (let pass = 0; pass < places.size; pass++) for (const edge of edges) {
        const from = reverse ? edge.toLocationKey : edge.fromLocationKey;
        const to = reverse ? edge.fromLocationKey : edge.toLocationKey;
        if (visited.has(from)) visited.add(to);
      }
      return visited;
    };
    const outward = reachable(false), homeward = reachable(true);
    if (publicPlaces.some((place) => !outward.has(place.key) || !homeward.has(place.key))) issues.push("Locations need directed outward and return routes; the map contains a stranded destination.");
  }
  return issues;
}

export function artifactKeysFromPreview(preview: CampaignContentDraftView["preview"]): string[] {
  const keys = new Set<string>();
  for (const field of WORLDBUILDING_FIELDS) {
    const items = preview[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const key = item && typeof item === "object" ? (item as { key?: unknown }).key : undefined;
      if (typeof key === "string") keys.add(key);
    }
  }
  return [...keys];
}

export function acceptedPublicArtifactKeys(preview: CampaignContentDraftView["preview"]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const field of WORLDBUILDING_FIELDS) {
    const items = preview[field];
    if (!Array.isArray(items)) continue;
    const keys = items.flatMap((item) => item && typeof item === "object" && (item as { visibility?: unknown }).visibility === "public" && typeof (item as { key?: unknown }).key === "string"
      ? [(item as { key: string }).key] : []);
    if (keys.length) result[field] = [...new Set(keys)];
  }
  return result;
}

export function resolveExpansionKeys(
  stage: WorldbuildingStagePlan,
  accepted: Record<string, Record<string, string[]>>,
): string[] {
  const keys = new Set<string>();
  for (const selector of stage.expandFrom ?? []) {
    const source = accepted[selector.stageId] ?? {};
    const selected = selector.fields.flatMap((field) => source[field] ?? []);
    const limit = selector.limit ?? selected.length;
    for (const key of selected.slice(0, limit)) keys.add(key);
  }
  return [...keys].slice(0, 16);
}
