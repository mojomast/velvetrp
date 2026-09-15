import type { CampaignContentDraftView, CampaignContentGenerationRequest } from "@velvet/contracts";

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
  return [
    { id: "factions", label: "Factions", sections: ["factions"], brief: "Create the factions whose competing aims give the premise traction.", desiredCounts: { factions: 4 } },
    { id: "foundation", label: "Foundation", sections: ["outline", "arcs"], brief: "State the opening situation, the player-facing premise, and the longer narrative arcs.", desiredCounts: { outlines: 1, arcs: 3 } },
    { id: "locations", label: "Locations", sections: ["locations"], brief: "Map distinct, traversable places and the routes that connect them.", desiredCounts: { locations: 6, connections: 4 } },
    { id: "cast", label: "Cast", sections: ["npcs"], brief: "Populate the world with characters bound to the accepted places and factions.", desiredCounts: { npcs: 6 } },
    { id: "story", label: "Story", sections: ["story", "clues"], brief: "Shape narrative beats and discoverable clues that can be recovered in more than one way.", desiredCounts: { storyNodes: 8, storyRelationships: 6, clues: 5 } },
    { id: "quests", label: "Quests", sections: ["quests"], brief: "Turn the arcs into actionable objectives with bounded, typed rewards.", desiredCounts: { quests: 5 } },
    { id: "bestiary", label: "Bestiary", sections: ["monster-concepts"], brief: "Create narrative monster concepts; mark mechanics inert unless an accepted pin exists.", desiredCounts: { monsterConcepts: 4 } },
    { id: "items", label: "Items", sections: ["quest-items"], brief: "Create quest items tied to accepted quests and places, binding mechanics only to accepted pins.", desiredCounts: { questItems: 4 } },
    { id: "encounters", label: "Encounters", sections: ["encounters"], brief: "Prepare encounter plans with objectives, terrain, escalation, and resolution.", desiredCounts: { encounters: 5 } },
    { id: "lore", label: "Lore", sections: ["lore"], brief: "Record typed campaign history, customs, truths, and beliefs tied to accepted canon.", desiredCounts: { lore: 6 } },
    { id: "table", label: "Table material", sections: ["handouts", "scene-prompts"], brief: "Prepare review-only public handouts and runnable GM scene prompts.", desiredCounts: { handouts: 3, scenePrompts: 4 } },
  ];
}

export function buildDefaultPlan(tone: string, exclusions: string[]): WorldbuildingPlan {
  return { tone: tone.trim() || "adventurous and grounded", exclusions, stages: defaultWorldbuildingStages() };
}

export function composeStageBrief(prompt: string, stage: WorldbuildingStagePlan): string {
  const targets = Object.entries(stage.desiredCounts).map(([field, count]) => `${count} ${field}`).join(", ");
  const direction = prompt.trim();
  return `${direction ? `${direction}\n\n` : ""}${stage.brief}\n\nHydration target for this additive candidate: ${targets}. Return as many requested items as safely fit; do not duplicate accepted canon.`;
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
