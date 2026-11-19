/**
 * Provider-free builder for the original "Sintermark" SRD 5.1 campaign.
 *
 * The reviewed world ships with the server as `recipes/sintermark-world.json`
 * and is loaded through a static JSON import, so it is emitted into `dist`.
 * No model provider is ever contacted: every content wave is staged through the
 * repository generation API with explicit `reviewed-static-seed` / zero-usage
 * provenance, and every other mutation uses a public repository command.
 *
 * Only two raw-SQL seams exist, both against the caller's configured repository
 * database (never a private connection):
 *   1. `world_route_event_profiles_v1` (no public authoring command exists), and
 *   2. `rpg_wallets_v25` funding for the deterministic vendor economy.
 *
 * Every key and job id is derived from the caller's `keyPrefix`, so the same
 * world can be built into a shared database as many independent campaigns.
 * The builder never reads or writes process environment, files, or the network.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  SRD_5_1_STARTER_PACK_ID,
  SRD_5_1_STARTER_PACK_VERSION,
  SRD_5_1_STARTER_RULES_PROFILE_ID,
  generatedCampaignContentProviderSchema,
  type GeneratedCampaignContentProvider,
} from "@velvet/contracts";
import {
  SRD_5_1_STARTER_CATALOG,
  addMessage,
  createSession,
  type Repository,
} from "../repo/index.js";
import { campaignGenerationArtifactKinds, campaignGenerationReferenceKinds } from "../repo/campaignGenerationReferences.js";
import { getRepositoryDatabase } from "../repo/repoContext.js";
import { createSintermarkParty } from "./sintermarkParty.js";
import recipeJson from "./recipes/sintermark-world.json" with { type: "json" };

const REPORT_FILE = "sintermark-report.json";
const API_BASE = "http://127.0.0.1:18894";
const CLIENT_BASE = "http://127.0.0.1:18895";
const RECIPE_VERSION_FALLBACK = "sintermark-v1";

/** The reviewed recipe name, shared with the in-app quick adventure action. */
export const SINTERMARK_RECIPE_NAME = asText((recipeJson as unknown as Record<string, unknown>).name)
  ?? fail("recipe.name is required");

const CONTENT_FIELDS = [
  "outlines", "arcs", "locations", "connections", "factions", "npcs", "quests", "encounters",
  "clues", "storyNodes", "storyRelationships", "lore", "questItems", "monsterConcepts", "handouts", "scenePrompts",
] as const;
type ContentField = (typeof CONTENT_FIELDS)[number];

const FIELD_CAPS: Record<ContentField, number> = {
  outlines: 1, arcs: 8, locations: 16, connections: 24, factions: 12, npcs: 16, quests: 16,
  encounters: 16, clues: 24, storyNodes: 24, storyRelationships: 32, lore: 24, questItems: 16,
  monsterConcepts: 16, handouts: 12, scenePrompts: 16,
};

/** Waves are ordered so every cross-artifact reference is already accepted. */
const WAVE_GROUPS: readonly (readonly ContentField[])[] = [
  ["factions"],
  ["locations"],
  ["npcs"],
  ["connections"],
  ["arcs", "storyNodes", "storyRelationships", "clues"],
  ["outlines"],
  ["quests"],
  ["monsterConcepts"],
  ["encounters"],
  ["questItems"],
  ["lore"],
  ["handouts"],
  ["scenePrompts"],
];

const FIELD_KIND = campaignGenerationArtifactKinds as unknown as Record<ContentField, string>;
type ProviderView = { [K in ContentField]: Array<Record<string, unknown>> };

const ROUTE_ENVIRONMENTS = ["urban", "road", "wilderness", "water"] as const;
const ROUTE_RISKS = ["safe", "watched", "dangerous"] as const;
type RouteEnvironment = (typeof ROUTE_ENVIRONMENTS)[number];
type RouteRisk = (typeof ROUTE_RISKS)[number];

export interface SintermarkHeroSummary {
  personaId: string;
  actorId: string;
  campaignCharacterId: string;
  name: string;
}

export interface SintermarkCounts {
  acceptedArtifacts: number;
  locations: number;
  publicLocations: number;
  connections: number;
  routeProfiles: number;
  factions: number;
  npcs: number;
  quests: number;
  encounters: number;
  materialDeliveries: number;
  partyActors: number;
  partyLevel: number;
  heroHealthMin: number;
  heroesWithInventory: number;
}

export interface SintermarkSummary {
  status: "created" | "existing" | "validated";
  dataDir: string;
  reportPath: string;
  campaignId: string;
  sessionId: string;
  campaignName: string;
  heroes: SintermarkHeroSummary[];
  counts: SintermarkCounts;
  publicGraph: { startLocationId: string | null; reachablePublicLocations: number; unreachablePublicLocations: string[] };
  launching: { dataDir: string; apiBase: string; clientBase: string; serverEnv: Record<string, string> };
  warnings: string[];
}

interface RecipeHero { name: string; class?: string; role?: string }
interface RecipeRouteProfile { key?: string; connectionKey?: string; environment?: string; risk?: string; chancePercent?: number }
interface RecipeRouteLock {
  key?: string; connectionKey?: string; fromKey: string; toKey: string;
  routeState?: string; requirementKind?: string; requiredFactionKey?: string; minimumReputation?: number;
  visibility?: string; description?: string;
}
interface RecipeQuestObjective { objectiveId?: string; description: string; targetProgress?: number; dependencyObjectiveIds?: string[]; visibility?: string }
interface RecipeQuestReward { rewardId?: string; kind?: string; amount?: number | null; label: string; visibility?: string }
interface RecipeQuest {
  questId?: string; title: string; description?: string | null; journalText?: string;
  visibility?: string; objectives?: RecipeQuestObjective[]; rewards?: RecipeQuestReward[];
}
export interface SintermarkRecipe {
  version: string;
  name: string;
  premise?: string;
  opening?: string;
  heroes: RecipeHero[];
  routeProfiles: RecipeRouteProfile[];
  routeLocks: RecipeRouteLock[];
  operationalQuests: RecipeQuest[];
  /** Raw authored content before strict-schema normalization. */
  rawContent: unknown;
  /** Normalized content, populated by the hydrator/validator after reading. */
  content: GeneratedCampaignContentProvider;
}

interface Wave { label: string; fields: ContentField[]; items: Partial<Record<ContentField, Array<Record<string, unknown>>>> }

interface EncounterSpec { enemySlug: string; name: string; keywords: string[] }

const ENCOUNTER_SPECS: readonly EncounterSpec[] = [
  { enemySlug: "salamander", name: "Ember Salamander Vigil", keywords: ["forge", "furnace", "kiln", "ember", "cinder", "lava", "magma", "crag"] },
  { enemySlug: "water-elemental", name: "Slake Water Elemental", keywords: ["slake", "bay", "harbor", "water", "marsh", "tide", "lake", "sea", "fen"] },
  { enemySlug: "magma-mephit", name: "Magma Mephit Ambush", keywords: ["vent", "spine", "ridge", "peak", "cliff", "caldera", "spire", "ascent"] },
];

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function emptyContent(): GeneratedCampaignContentProvider {
  return generatedCampaignContentProviderSchema.parse({}) as GeneratedCampaignContentProvider;
}

/** Keeps a composed resource id or command key inside the 128-character limit. */
function scopedId(prefix: string, ...parts: string[]): string {
  const raw = [prefix, ...parts].join(".");
  if (raw.length <= 128) return raw;
  return `${prefix.slice(0, 32)}.${createHash("sha256").update(raw).digest("hex")}`;
}

function referenceIdentity(reference: { kind: string; packId: string; packVersion: string; definitionId: string }): string {
  return `${reference.kind}\u0000${reference.packId}\u0000${reference.packVersion}\u0000${reference.definitionId}`;
}

// ---------------------------------------------------------------------------
// Recipe loading and normalization
// ---------------------------------------------------------------------------

export function readSintermarkRecipe(): SintermarkRecipe {
  const parsed: unknown = recipeJson;
  if (!isRecord(parsed)) fail("Sintermark recipe must be a JSON object");
  const name = asText(parsed.name) ?? fail("recipe.name is required");
  if (!isRecord(parsed.content)) fail("recipe.content must be an object with generated sections");

  const heroesRaw = asArray(parsed.heroes);
  const heroes: RecipeHero[] = [];
  for (const hero of heroesRaw) {
    if (!isRecord(hero)) continue;
    const heroName = asText(hero.name);
    if (!heroName) continue;
    const className = asText(hero.class) ?? asText(hero.className);
    const role = asText(hero.role);
    heroes.push({ name: heroName, ...(className ? { class: className } : {}), ...(role ? { role } : {}) });
  }

  const routeProfiles: RecipeRouteProfile[] = [];
  for (const profile of asArray(parsed.routeProfiles)) {
    if (!isRecord(profile)) continue;
    const key = asText(profile.connectionKey) ?? asText(profile.key);
    const environment = asText(profile.environment);
    const risk = asText(profile.risk);
    const chance = profile.chancePercent;
    routeProfiles.push({
      ...(key ? { connectionKey: key } : {}),
      ...(environment ? { environment } : {}),
      ...(risk ? { risk } : {}),
      ...(typeof chance === "number" ? { chancePercent: chance } : {}),
    });
  }

  const routeLocks: RecipeRouteLock[] = [];
  for (const lock of asArray(parsed.routeLocks)) {
    if (!isRecord(lock)) continue;
    const key = asText(lock.key) ?? asText(lock.connectionKey);
    const connection = asArray(parsed.content.connections).find((entry) => isRecord(entry) && entry.key === key);
    const fromKey = asText(lock.fromKey) ?? asText(lock.from) ?? (isRecord(connection) ? asText(connection.fromLocationKey) : undefined);
    const toKey = asText(lock.toKey) ?? asText(lock.to) ?? (isRecord(connection) ? asText(connection.toLocationKey) : undefined);
    if (!fromKey || !toKey) fail(`unresolved route lock: ${key}`);
    const routeState = asText(lock.routeState) ?? asText(lock.state);
    const requiredFactionKey = asText(lock.requiredFactionKey) ?? asText(lock.requiredFaction) ?? asText(lock.factionKey);
    const requirementKind = asText(lock.requirementKind) ?? (requiredFactionKey ? "faction_reputation" : "none");
    const visibility = asText(lock.visibility);
    const description = asText(lock.description);
    const minimum = lock.minimumReputation ?? (requiredFactionKey ? 0 : undefined);
    routeLocks.push({
      fromKey, toKey,
      ...(key ? { key } : {}),
      ...(routeState ? { routeState } : {}),
      ...(requirementKind ? { requirementKind } : {}),
      ...(requiredFactionKey ? { requiredFactionKey } : {}),
      ...(visibility ? { visibility } : {}),
      ...(description ? { description } : {}),
      ...(typeof minimum === "number" ? { minimumReputation: minimum } : {}),
    });
  }

  const operationalQuests: RecipeQuest[] = [];
  for (const quest of asArray(parsed.operationalQuests)) {
    if (!isRecord(quest)) continue;
    const title = asText(quest.title);
    if (!title) continue;
    const objectives: RecipeQuestObjective[] = [];
    for (const objective of asArray(quest.objectives)) {
      if (!isRecord(objective)) continue;
      const description = asText(objective.description);
      if (!description) continue;
      const objectiveId = asText(objective.objectiveId) ?? asText(objective.key);
      const visibility = asText(objective.visibility);
      const target = objective.targetProgress ?? objective.target;
      const deps = asArray(objective.dependencyObjectiveIds ?? objective.dependencyObjectiveKeys).filter((value): value is string => typeof value === "string");
      objectives.push({
        description,
        ...(objectiveId ? { objectiveId } : {}),
        ...(visibility ? { visibility } : {}),
        ...(typeof target === "number" ? { targetProgress: target } : {}),
        ...(deps.length ? { dependencyObjectiveIds: deps } : {}),
      });
    }
    const rewards: RecipeQuestReward[] = [];
    for (const reward of asArray(quest.rewards)) {
      if (!isRecord(reward)) continue;
      const label = asText(reward.label);
      if (!label) continue;
      const rewardId = asText(reward.rewardId);
      const kind = asText(reward.kind);
      const visibility = asText(reward.visibility);
      const amount = reward.amount;
      rewards.push({
        label,
        ...(rewardId ? { rewardId } : {}),
        ...(kind ? { kind } : {}),
        ...(visibility ? { visibility } : {}),
        ...(typeof amount === "number" || amount === null ? { amount: amount as number | null } : {}),
      });
    }
    const journalText = asText(quest.journalText);
    const questId = asText(quest.questId);
    const visibility = asText(quest.visibility);
    const description = quest.description === null ? null : asText(quest.description);
    operationalQuests.push({
      title, objectives, rewards,
      ...(questId ? { questId } : {}),
      ...(visibility ? { visibility } : {}),
      ...(description === null || description ? { description } : {}),
      ...(journalText ? { journalText } : {}),
    });
  }

  return {
    version: asText(parsed.version) ?? RECIPE_VERSION_FALLBACK,
    name,
    heroes, routeProfiles, routeLocks, operationalQuests,
    ...(asText(parsed.premise) ? { premise: asText(parsed.premise) } : {}),
    ...(asText(parsed.opening) ? { opening: asText(parsed.opening) } : {}),
    rawContent: parsed.content,
    content: emptyContent(),
  } as unknown as SintermarkRecipe;
}

function coerceStoryNode(raw: unknown): Record<string, unknown> {
  const value = isRecord(raw) ? raw : {};
  return {
    key: value.key,
    title: value.title,
    description: value.description ?? value.text ?? value.summary,
    visibility: value.visibility ?? "public",
  };
}

function coerceStoryRelationship(raw: unknown): Record<string, unknown> {
  const value = isRecord(raw) ? raw : {};
  return {
    key: value.key,
    fromStoryNodeKey: value.fromStoryNodeKey ?? value.from ?? value.fromNodeKey,
    toStoryNodeKey: value.toStoryNodeKey ?? value.to ?? value.toNodeKey,
    description: value.description ?? value.summary ?? "A story link.",
    visibility: value.visibility ?? "public",
  };
}

function coerceLore(raw: unknown): Record<string, unknown> {
  const value = isRecord(raw) ? raw : {};
  return {
    key: value.key,
    title: value.title ?? value.name,
    summary: value.summary ?? value.text ?? value.content ?? value.description,
    visibility: value.visibility ?? "public",
    details: asArray(value.details),
    locationKeys: asArray(value.locationKeys),
    factionKeys: asArray(value.factionKeys),
    storyNodeKeys: asArray(value.storyNodeKeys),
  };
}

function coerceConnection(raw: unknown): Record<string, unknown> {
  const value = isRecord(raw) ? raw : {};
  return {
    key: value.key,
    fromLocationKey: value.fromLocationKey ?? value.from,
    toLocationKey: value.toLocationKey ?? value.to,
    description: value.description ?? value.summary ?? "A route.",
    visibility: value.visibility ?? "public",
  };
}

const FIELD_KEYS: Record<ContentField, readonly string[]> = {
  outlines: ["key", "opening", "premise", "startLocationKey", "visibility"],
  arcs: ["key", "title", "summary", "visibility"],
  locations: ["key", "name", "description", "visibility", "atmosphere", "discoveries", "hazards", "hooks", "factionKeys"],
  connections: ["key", "fromLocationKey", "toLocationKey", "description", "visibility"],
  factions: ["key", "name", "description", "visibility", "gmNotes"],
  npcs: ["key", "name", "archetype", "description", "visibility", "locationKey", "factionKeys", "privateGoals"],
  quests: ["key", "title", "description", "visibility", "arcKey", "locationKeys", "objectives", "rewards", "journalText"],
  encounters: ["key", "title", "description", "visibility", "locationKey", "participantNpcKeys", "objectives", "terrain", "escalation", "resolution", "enemyReferences", "monsterConceptKeys"],
  clues: ["key", "title", "description", "visibility", "locationKey", "revealsStoryNodeKey"],
  storyNodes: ["key", "title", "description", "visibility"],
  storyRelationships: ["key", "fromStoryNodeKey", "toStoryNodeKey", "description", "visibility"],
  lore: ["key", "title", "summary", "visibility", "details", "locationKeys", "factionKeys", "storyNodeKeys"],
  questItems: ["key", "name", "description", "visibility", "questKeys", "locationKeys", "mechanics"],
  monsterConcepts: ["key", "name", "description", "visibility", "role", "tactics", "mechanics"],
  handouts: ["key", "title", "content", "visibility"],
  scenePrompts: ["key", "title", "prompt", "visibility", "locationKey", "npcKeys"],
};
const QUEST_OBJECTIVE_KEYS = ["key", "description", "targetProgress", "dependencyObjectiveKeys", "visibility"] as const;
const QUEST_REWARD_KEYS = ["key", "label", "kind", "amount", "visibility"] as const;

/** Keeps only schema keys so authored metadata (sources, notes, ids, ...) cannot invalidate an item. */
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const result: Record<string, unknown> = {};
  for (const key of keys) if (key in record) result[key] = record[key];
  return result;
}

function normalizeFieldItem(field: ContentField, item: unknown): Record<string, unknown> {
  const picked = pick(item, FIELD_KEYS[field]);
  if (field === "quests") {
    if (Array.isArray(picked.objectives)) picked.objectives = picked.objectives.map((objective) => pick(objective, QUEST_OBJECTIVE_KEYS));
    if (Array.isArray(picked.rewards)) picked.rewards = picked.rewards.map((reward) => pick(reward, QUEST_REWARD_KEYS));
  }
  return picked;
}

function parseFieldItem(field: ContentField, item: unknown): Record<string, unknown> | null {
  try {
    const parsed = generatedCampaignContentProviderSchema.parse({ [field]: [normalizeFieldItem(field, item)] }) as unknown as Record<ContentField, unknown[]>;
    const list = parsed[field];
    return Array.isArray(list) && list.length === 1 && isRecord(list[0]) ? list[0] : null;
  } catch {
    return null;
  }
}

function normalizeRecipeContent(rawContent: unknown, warnings: string[]): GeneratedCampaignContentProvider {
  const raw = isRecord(rawContent) ? rawContent : {};
  const story = isRecord(raw.story) ? raw.story : undefined;
  const rawByField: Record<ContentField, unknown[]> = {
    outlines: [...asArray(raw.outlines), ...asArray(raw.outline)],
    arcs: asArray(raw.arcs),
    locations: asArray(raw.locations),
    connections: asArray(raw.connections).map(coerceConnection),
    factions: asArray(raw.factions),
    npcs: asArray(raw.npcs),
    quests: asArray(raw.quests),
    encounters: asArray(raw.encounters),
    clues: asArray(raw.clues),
    storyNodes: [
      ...asArray(raw.storyNodes),
      ...(story ? asArray(story.nodes) : []),
      ...(Array.isArray(raw.story) ? asArray(raw.story) : []),
    ].map(coerceStoryNode),
    storyRelationships: [
      ...asArray(raw.storyRelationships),
      ...asArray(raw.relationships),
      ...(story ? [...asArray(story.relationships), ...asArray(story.edges)] : []),
    ].map(coerceStoryRelationship),
    lore: [...asArray(raw.lore), ...asArray(raw.rumors)].map(coerceLore),
    questItems: asArray(raw.questItems),
    monsterConcepts: asArray(raw.monsterConcepts),
    handouts: asArray(raw.handouts),
    scenePrompts: asArray(raw.scenePrompts),
  };

  const fields: Partial<Record<ContentField, Array<Record<string, unknown>>>> = {};
  for (const field of CONTENT_FIELDS) {
    const seen = new Set<string>();
    const kept: Array<Record<string, unknown>> = [];
    for (const item of rawByField[field]) {
      const parsed = parseFieldItem(field, item);
      if (!parsed) {
        warnings.push(`recipe ${field} item was invalid and dropped`);
        continue;
      }
      const key = parsed.key;
      if (typeof key !== "string" || seen.has(key)) {
        if (typeof key === "string") warnings.push(`recipe ${field} duplicate key dropped: ${key}`);
        else warnings.push(`recipe ${field} item without a key was dropped`);
        continue;
      }
      seen.add(key);
      kept.push(parsed);
    }
    fields[field] = kept;
  }

  const provided: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) provided[field] = fields[field] ?? [];
  // Individual entries are validated above; aggregate limits apply to each wave,
  // not to the complete reviewed world.
  return provided as GeneratedCampaignContentProvider;
}

function buildWaves(content: GeneratedCampaignContentProvider, warnings: string[]): Wave[] {
  const waves: Wave[] = [];
  for (const group of WAVE_GROUPS) {
    if (group.length === 1) {
      const field = group[0]!;
      const items = (content[field] as unknown as Array<Record<string, unknown>>);
      const cap = FIELD_CAPS[field];
      for (let index = 0; index < items.length; index += cap) {
        const chunk = items.slice(index, index + cap);
        if (chunk.length === 0) continue;
        const waveItems: Partial<Record<ContentField, Array<Record<string, unknown>>>> = {};
        waveItems[field] = chunk;
        waves.push({ label: `${field}-${Math.floor(index / cap) + 1}`, fields: [field], items: waveItems });
      }
      continue;
    }
    const items: Partial<Record<ContentField, Array<Record<string, unknown>>>> = {};
    let count = 0;
    for (const field of group) {
      const list = content[field] as unknown as Array<Record<string, unknown>>;
      if (list.length > FIELD_CAPS[field]) {
        fail(`recipe ${field} has ${list.length} items, exceeding the ${FIELD_CAPS[field]} cap; the story graph cannot be split across waves`);
      }
      if (list.length > 0) { items[field] = list; count += list.length; }
    }
    if (count > 0) waves.push({ label: group.join("+"), fields: [...group], items });
  }
  if (waves.length === 0) warnings.push("recipe content produced no generation waves");
  return waves;
}

// ---------------------------------------------------------------------------
// Reference sanitizing
// ---------------------------------------------------------------------------

function collectDirectRefs(item: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const refField of Object.keys(campaignGenerationReferenceKinds)) {
    const value = item[refField];
    if (typeof value === "string") refs.push(value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") refs.push(entry);
  }
  return refs;
}

function gmReachable(key: string, edges: Map<string, string[]>, visibility: Map<string, "public" | "gm">, memo: Map<string, boolean>, visiting: Set<string>): boolean {
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  if (visiting.has(key)) return false;
  visiting.add(key);
  let result = visibility.get(key) === "gm";
  if (!result) for (const next of edges.get(key) ?? []) if (gmReachable(next, edges, visibility, memo, visiting)) { result = true; break; }
  visiting.delete(key);
  memo.set(key, result);
  return result;
}

function sanitizeContent(
  content: GeneratedCampaignContentProvider,
  acceptedVisibility: Map<string, "public" | "gm">,
  acceptedKinds: Map<string, string>,
  catalogReferences: Set<string>,
  warnings: string[],
): void {
  const view = content as unknown as ProviderView;
  const kinds = new Map(acceptedKinds);
  const visibility = new Map(acceptedVisibility);
  const seen = new Set(acceptedKinds.keys());

  for (const field of CONTENT_FIELDS) {
    const kept: Array<Record<string, unknown>> = [];
    for (const item of view[field] ?? []) {
      const key = item.key;
      if (typeof key !== "string" || seen.has(key)) continue;
      seen.add(key);
      kinds.set(key, FIELD_KIND[field]);
      visibility.set(key, item.visibility === "gm" ? "gm" : "public");
      kept.push(item);
    }
    view[field] = kept;
  }

  // Quest objectives are nested, not artifacts.
  for (const quest of view.quests ?? []) {
    if (!Array.isArray(quest.objectives)) continue;
    const objectives = quest.objectives.filter(isRecord);
    const objectiveVisibility = new Map<string, unknown>(objectives.map((objective) => [String(objective.key), objective.visibility]));
    for (const objective of objectives) {
      const dependencies = Array.isArray(objective.dependencyObjectiveKeys)
        ? objective.dependencyObjectiveKeys.filter((key): key is string => typeof key === "string"
          && objectiveVisibility.has(key)
          && !(objective.visibility === "public" && objectiveVisibility.get(key) === "gm"))
        : [];
      objective.dependencyObjectiveKeys = dependencies;
    }
  }

  const usable = (owner: Record<string, unknown>, key: string): boolean =>
    visibility.has(key) && !(owner.visibility === "public" && visibility.get(key) === "gm");

  for (const field of CONTENT_FIELDS) {
    for (const item of view[field] ?? []) {
      for (const [refField, refKind] of Object.entries(campaignGenerationReferenceKinds)) {
        const reference = item[refField];
        if (reference === undefined) continue;
        if (Array.isArray(reference)) {
          item[refField] = reference.filter((key): key is string => typeof key === "string" && kinds.get(key) === refKind && usable(item, key));
        } else if (typeof reference !== "string" || kinds.get(reference) !== refKind || !usable(item, reference)) {
          delete item[refField];
        }
      }
      if (field === "encounters" && Array.isArray(item.enemyReferences)) {
        item.enemyReferences = item.enemyReferences.filter((reference) => isRecord(reference) && catalogReferences.has(referenceIdentity(reference as never)));
      }
      if (field === "questItems" || field === "monsterConcepts") {
        const mechanics = item.mechanics;
        if (isRecord(mechanics) && mechanics.state === "catalog-bound" && isRecord(mechanics.reference)) {
          if (!catalogReferences.has(referenceIdentity(mechanics.reference as never))) {
            item.mechanics = { state: "inert", reason: "reference is not pinned to this campaign catalog" };
          }
        }
      }
    }
  }

  // Drop still-unresolved single references and re-filter arrays once more.
  for (const field of CONTENT_FIELDS) {
    for (const item of view[field] ?? []) {
      for (const [refField, refKind] of Object.entries(campaignGenerationReferenceKinds)) {
        const reference = item[refField];
        if (typeof reference === "string" && !(kinds.get(reference) === refKind && usable(item, reference))) delete item[refField];
        if (Array.isArray(reference)) item[refField] = reference.filter((key): key is string => typeof key === "string" && kinds.get(key) === refKind && usable(item, key));
      }
    }
  }

  // Break public -> gm transitive dependencies by removing the offending refs.
  for (let pass = 0; pass < 4; pass += 1) {
    const edges = new Map<string, string[]>();
    for (const field of CONTENT_FIELDS) {
      for (const item of view[field] ?? []) {
        const key = item.key;
        if (typeof key === "string") edges.set(key, collectDirectRefs(item));
      }
    }
    const memo = new Map<string, boolean>();
    let changed = false;
    for (const field of CONTENT_FIELDS) {
      for (const item of view[field] ?? []) {
        if (item.visibility === "gm") continue;
        for (const [refField] of Object.entries(campaignGenerationReferenceKinds)) {
          const reference = item[refField];
          if (typeof reference === "string" && gmReachable(reference, edges, visibility, memo, new Set())) {
            delete item[refField];
            changed = true;
          } else if (Array.isArray(reference)) {
            const filtered = reference.filter((key): key is string => typeof key === "string" && !gmReachable(key, edges, visibility, memo, new Set()));
            if (filtered.length !== reference.length) { item[refField] = filtered; changed = true; }
          }
        }
      }
    }
    if (!changed) break;
  }

  // Required scalar references cannot simply be deleted; drop the owning artifact instead.
  view.connections = (view.connections ?? []).filter((item) =>
    typeof item.fromLocationKey === "string" && typeof item.toLocationKey === "string" && item.fromLocationKey !== item.toLocationKey);
  view.storyRelationships = (view.storyRelationships ?? []).filter((item) =>
    typeof item.fromStoryNodeKey === "string" && typeof item.toStoryNodeKey === "string" && item.fromStoryNodeKey !== item.toStoryNodeKey);

  void warnings;
}

function collectWaveKeys(content: GeneratedCampaignContentProvider): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const field of CONTENT_FIELDS) {
    for (const item of content[field] as unknown as Array<Record<string, unknown>>) {
      const key = item.key;
      if (typeof key === "string" && !seen.has(key)) { seen.add(key); keys.push(key); }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Generation waves (provider-free, actual request digest)
// ---------------------------------------------------------------------------

async function applyWaves(
  repository: Repository,
  ownerId: string,
  campaignId: string,
  keyPrefix: string,
  recipe: SintermarkRecipe,
  content: GeneratedCampaignContentProvider,
  warnings: string[],
): Promise<string[]> {
  const waves = buildWaves(content, warnings);
  const appliedKeys: string[] = [];
  for (const [index, wave] of waves.entries()) {
    const context = repository.getCampaignGenerationContext(ownerId, campaignId, appliedKeys)
      ?? fail("campaign generation context is unavailable");
    const acceptedVisibility = new Map<string, "public" | "gm">(context.artifacts.map((artifact) => [artifact.key, artifact.visibility]));
    const acceptedKinds = new Map<string, string>(context.artifacts.map((artifact) => [artifact.key, artifact.kind]));
    const catalogReferences = new Set(context.catalogDefinitions.map((definition) => referenceIdentity(definition.reference)));

    const candidate = emptyContent();
    const candidateView = candidate as unknown as ProviderView;
    for (const field of wave.fields) {
      const items = wave.items[field];
      if (items) candidateView[field] = items;
    }

    sanitizeContent(candidate, acceptedVisibility, acceptedKinds, catalogReferences, warnings);
    const selectedArtifactKeys = collectWaveKeys(candidate);
    if (selectedArtifactKeys.length === 0) {
      warnings.push(`wave ${wave.label} resolved to no applicable artifacts`);
      continue;
    }

    const current = repository.getCampaignAdministration(ownerId, campaignId)
      ?? fail("campaign administration is unavailable during generation");
    const idempotencyKey = `${keyPrefix}.wave.${index + 1}`;
    const requestDigest = createHash("sha256").update(JSON.stringify({ seed: keyPrefix, wave: wave.label, content: candidate })).digest("hex");
    const jobId = createHash("sha256").update(`${keyPrefix}:${campaignId}:${wave.label}`).digest("hex");
    const call = repository.beginCampaignGenerationCall(campaignId, idempotencyKey, requestDigest, {
      provider: "reviewed-static-seed",
      model: "none",
      operation: "campaign-content-generation",
      stage: `sintermark-wave-${index + 1}`,
      promptVersion: recipe.version,
      schemaVersion: "v52",
      jobId,
    }, null);
    if (!call.acquired) fail(`generation call for wave ${wave.label} was not acquired`);

    const draft = repository.stageCampaignGenerationAtomically(ownerId, {
      campaignId,
      timelineId: current.activeTimelineId,
      kind: "content-pack",
      stagedContent: {
        kind: "campaign-content",
        requestDigest,
        baseContentRevision: context.revision,
        dependencyDigests: {},
        ...candidate,
      },
      validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
      expectedCampaignRevision: current.revision,
      idempotencyKey,
    }, call.attempt, candidate, [], {
      responseModel: "reviewed-static-seed",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      estimatedCostUsd: 0,
    });

    repository.applyCampaignContentGenerationDraftAtomically(ownerId, {
      draftId: draft.draftId,
      expectedDraftRevision: draft.revision,
      expectedCampaignRevision: draft.campaignRevision,
      idempotencyKey: `${idempotencyKey}.apply`,
      selectedArtifactKeys,
    });
    appliedKeys.push(...selectedArtifactKeys);
  }
  return appliedKeys;
}

// ---------------------------------------------------------------------------
// Isolated raw-SQL authoring seams (route profiles + wallets only)
// ---------------------------------------------------------------------------

function withAuthoringDatabase<T>(operation: (db: ReturnType<typeof getRepositoryDatabase>) => T): T {
  const db = getRepositoryDatabase();
  return db.transaction(() => operation(db)).immediate();
}

interface RouteProfileRow { connectionId: string; environment: RouteEnvironment; risk: RouteRisk; chancePercent: number }

function authorRouteProfiles(campaignId: string, rows: RouteProfileRow[]): number {
  if (rows.length === 0) return 0;
  return withAuthoringDatabase((db) => {
    const upsert = db.prepare(`INSERT INTO world_route_event_profiles_v1(campaign_id,connection_id,environment,risk,chance_percent)
      VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,connection_id)
      DO UPDATE SET environment=excluded.environment,risk=excluded.risk,chance_percent=excluded.chance_percent`);
    for (const row of rows) upsert.run(campaignId, row.connectionId, row.environment, row.risk, row.chancePercent);
    return rows.length;
  });
}

interface AcceptedArtifactLike { key: string; kind: string; visibility: string; serverResourceId: string | null }

function authorCampaignRouteProfiles(
  ownerId: string,
  campaignId: string,
  sessionId: string,
  repository: Repository,
  recipe: SintermarkRecipe,
  artifacts: readonly AcceptedArtifactLike[],
  authoredConnections: readonly { key: string; connectionId: string; visibility: "public" | "gm"; open: boolean }[],
  warnings: string[],
): number {
  const world = repository.getCampaignWorld(ownerId, campaignId, sessionId);
  if (!world) return 0;
  const openIds = new Set(world.visibleConnections.map((connection) => connection.connectionId));
  const connectionKeyById = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.kind === "connection" && artifact.visibility === "public" && artifact.serverResourceId && openIds.has(artifact.serverResourceId)) {
      connectionKeyById.set(artifact.serverResourceId, artifact.key);
    }
  }
  for (const connection of authoredConnections) {
    if (connection.open && connection.visibility === "public" && openIds.has(connection.connectionId)) connectionKeyById.set(connection.connectionId, connection.key);
  }
  const overrides = new Map<string, RecipeRouteProfile>();
  for (const profile of recipe.routeProfiles) if (profile.connectionKey) overrides.set(profile.connectionKey, profile);

  const rows: RouteProfileRow[] = [];
  const usedOverrides = new Set<string>();
  for (const [connectionId, key] of connectionKeyById) {
    const override = overrides.get(key);
    if (override) usedOverrides.add(key);
    const environment = override?.environment && (ROUTE_ENVIRONMENTS as readonly string[]).includes(override.environment)
      ? override.environment as RouteEnvironment : "road";
    const risk = override?.risk && (ROUTE_RISKS as readonly string[]).includes(override.risk)
      ? override.risk as RouteRisk : "safe";
    const chancePercent = typeof override?.chancePercent === "number" && override.chancePercent >= 0 && override.chancePercent <= 100
      ? Math.trunc(override.chancePercent) : 0;
    rows.push({ connectionId, environment, risk, chancePercent });
  }
  for (const key of overrides.keys()) {
    const intentionallyClosed = recipe.routeLocks.some((lock) => lock.key === key && lock.routeState === "closed");
    if (!usedOverrides.has(key) && !intentionallyClosed) warnings.push(`route profile ${key} did not match an open public connection`);
  }
  return authorRouteProfiles(campaignId, rows);
}

function readRouteProfileCount(campaignId: string): number {
  return (getRepositoryDatabase().prepare("SELECT count(*) count FROM world_route_event_profiles_v1 WHERE campaign_id=?").get(campaignId) as { count: number }).count;
}

// ---------------------------------------------------------------------------
// Character / summary reads
// ---------------------------------------------------------------------------

interface ProgressionLike { level: number; actorId: string; derived: { maxHp: number } }

function readHeroes(repository: Repository, ownerId: string, campaignId: string, recipe: SintermarkRecipe): SintermarkHeroSummary[] {
  const roster = repository.getCampaignCharacterRoster(ownerId, campaignId);
  if (!roster) fail("campaign character roster is unavailable");
  const characters = repository.listCampaignCharacters(ownerId, campaignId);
  const heroes: SintermarkHeroSummary[] = [];
  for (const character of characters) {
    const campaignCharacter = character.projection.campaignCharacter;
    const actor = character.projection.actor;
    const rosterEntry = roster.characters.find((entry) => entry.id === campaignCharacter.id);
    heroes.push({
      personaId: campaignCharacter.characterId,
      actorId: actor.id,
      campaignCharacterId: campaignCharacter.id,
      name: rosterEntry?.name ?? campaignCharacter.characterId,
    });
  }
  const order = new Map(recipe.heroes.map((hero, index) => [hero.name, index]));
  heroes.sort((left, right) => (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.name) ?? Number.MAX_SAFE_INTEGER));
  return heroes;
}

function publicGraph(
  recipe: SintermarkRecipe,
  resourceIdByArtifactKey: Map<string, string>,
  world: { visibleConnections: Array<{ connectionId: string; fromLocationId: string; toLocationId: string }> },
  startLocationId: string | null,
  warnings: string[],
): { startLocationId: string | null; reachablePublicLocations: number; unreachablePublicLocations: string[] } {
  const publicLocationIds = new Set<string>();
  for (const location of recipe.content.locations) {
    if (location.visibility !== "public") continue;
    const id = resourceIdByArtifactKey.get(location.key);
    if (id) publicLocationIds.add(id);
  }
  if (!startLocationId) {
    warnings.push("no starting location is designated; public graph reachability cannot be proven");
    return { startLocationId: null, reachablePublicLocations: 0, unreachablePublicLocations: [...publicLocationIds] };
  }
  const adjacency = new Map<string, string[]>();
  for (const connection of world.visibleConnections) {
    const list = adjacency.get(connection.fromLocationId) ?? [];
    list.push(connection.toLocationId);
    adjacency.set(connection.fromLocationId, list);
  }
  const reached = new Set<string>([startLocationId]);
  const queue = [startLocationId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const unreachable = [...publicLocationIds].filter((id) => !reached.has(id));
  return { startLocationId, reachablePublicLocations: [...publicLocationIds].filter((id) => reached.has(id)).length, unreachablePublicLocations: unreachable };
}

// ---------------------------------------------------------------------------
// Build orchestration
// ---------------------------------------------------------------------------

export class SintermarkBuildStepError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SintermarkBuildStepError";
    this.step = step;
  }
}

export interface SintermarkBuildResult {
  campaignId: string;
  sessionId: string;
  recipe: SintermarkRecipe;
  content: GeneratedCampaignContentProvider;
  heroes: SintermarkHeroSummary[];
  appliedArtifactKeys: string[];
  encounterIds: string[];
  shops: ShopLike[];
  warnings: string[];
}

export function prepareSintermarkRecipe(recipe: SintermarkRecipe = readSintermarkRecipe()): {
  recipe: SintermarkRecipe;
  content: GeneratedCampaignContentProvider;
  warnings: string[];
} {
  const warnings: string[] = [];
  const content = normalizeRecipeContent(recipe.rawContent, warnings);
  const authoredRouteKeys = new Set(recipe.routeLocks.map((lock) => lock.key).filter((key): key is string => typeof key === "string"));
  content.connections = content.connections.filter((connection) =>
    typeof connection.key !== "string" || !authoredRouteKeys.has(connection.key));
  recipe.content = content;
  return { recipe, content, warnings };
}

async function buildStep<T>(step: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new SintermarkBuildStepError(step, error);
  }
}

function ensureStarterCatalog(repository: Repository, ownerId: string): void {
  const manifest = SRD_5_1_STARTER_CATALOG.manifest;
  if (repository.getContentCatalogForOwner(ownerId, manifest.packId, manifest.packVersion)) return;
  try {
    repository.installSrdStarterCatalog(ownerId);
  } catch (error) {
    if (repository.getContentCatalogForOwner(ownerId, manifest.packId, manifest.packVersion)) return;
    throw error;
  }
}

export interface RunSintermarkBuildInput {
  repository: Repository;
  ownerId: string;
  campaignId: string;
  keyPrefix: string;
  recipe?: SintermarkRecipe;
}

/** Builds the reviewed world into an existing, freshly created campaign. */
export async function runSintermarkBuildIntoCampaign(input: RunSintermarkBuildInput): Promise<SintermarkBuildResult> {
  const { repository, ownerId, campaignId, keyPrefix } = input;
  const { recipe, content, warnings } = prepareSintermarkRecipe(input.recipe ?? readSintermarkRecipe());

  await buildStep("catalog", () => {
    ensureStarterCatalog(repository, ownerId);
    repository.configureSrdStarterCatalog(ownerId, campaignId, { expectedRevision: 0, idempotencyKey: `${keyPrefix}.catalog` });
  });

  const heroes = await buildStep("party", () => createSintermarkParty(repository, ownerId, campaignId, keyPrefix));

  const sessionId = await buildStep("room", async () => {
    const session = await createSession({
      characterIds: heroes.map((hero) => hero.personaId),
      primaryCharacterId: heroes[0]!.personaId,
      title: `${recipe.name} - Opening Table`,
      presetId: "default",
    });
    repository.transitionSession(session.id, "active", "Sintermark campaign opened");
    repository.addConsentEvent(session.id, "campaign-safety", true, "Fictional adults. Follow the reviewed Sintermark safety policy and boundaries.");
    repository.updateSessionContextSource(session.id, recipe.premise ?? `The opening of ${recipe.name}.`);
    await addMessage(session.id, "system", recipe.opening ?? recipe.premise ?? `${recipe.name} begins.`);
    await addMessage(session.id, "character", "Those readings disagree. Orra, keep the street clear while I compare the raw log with the gauge.", { speakerCharacterId: heroes[0]!.personaId });
    repository.attachCampaignSession(ownerId, { campaignId, sessionId: session.id });
    return session.id;
  });

  const waves = await buildStep("waves", async () => {
    const appliedArtifactKeys = await applyWaves(repository, ownerId, campaignId, keyPrefix, recipe, content, warnings);
    const context = repository.getCampaignGenerationContext(ownerId, campaignId, appliedArtifactKeys)
      ?? fail("campaign generation context is unavailable after generation");
    return { appliedArtifactKeys, context };
  });
  const { appliedArtifactKeys, context } = waves;
  const resourceIdByArtifactKey = new Map<string, string>();
  for (const artifact of context.artifacts) if (artifact.serverResourceId) resourceIdByArtifactKey.set(artifact.key, artifact.serverResourceId);

  const authoredConnections = await buildStep("starting-location", () => {
    // Authored closed / reputation-gated shortcuts (never close generated routes).
    const authored: Array<{ key: string; connectionId: string; visibility: "public" | "gm"; open: boolean }> = [];
    for (const [index, lock] of recipe.routeLocks.entries()) {
      const fromLocationId = resourceIdByArtifactKey.get(lock.fromKey);
      const toLocationId = resourceIdByArtifactKey.get(lock.toKey);
      if (!fromLocationId || !toLocationId) {
        warnings.push(`route lock ${lock.fromKey} -> ${lock.toKey} references an unknown location and was skipped`);
        continue;
      }
      const authoredKey = lock.key ?? `sintermark-lock-${index + 1}`;
      const connectionKey = scopedId(keyPrefix, "lock", authoredKey);
      const requirementKind = lock.requirementKind === "faction_reputation" || lock.requirementKind === "discovery" ? lock.requirementKind : "none";
      const requiredFactionId = lock.requiredFactionKey ? resourceIdByArtifactKey.get(lock.requiredFactionKey) : undefined;
      if (requirementKind === "faction_reputation" && !requiredFactionId) {
        warnings.push(`route lock ${connectionKey} requested a reputation gate without a known faction; using an open route`);
      }
      const visibility = lock.visibility === "gm" ? "gm" : lock.visibility === "hidden" ? "hidden" : "public";
      const routeState = lock.routeState === "closed" ? "closed" : "open";
      const created = repository.createLocationConnection(ownerId, {
        campaignId,
        locationConnectionId: connectionKey,
        fromLocationId,
        toLocationId,
        visibility,
        routeState,
        requirementKind: requiredFactionId ? requirementKind : "none",
        ...(requiredFactionId ? { requiredFactionId } : {}),
        ...(typeof lock.minimumReputation === "number" ? { minimumReputation: lock.minimumReputation } : {}),
      });
      authored.push({ key: authoredKey, connectionId: created.locationConnectionId, visibility: visibility === "gm" ? "gm" : "public", open: routeState === "open" });
    }

    // Starting location: outline sets it during apply; otherwise designate the fallback.
    let starting = repository.getCampaignStartingLocation(ownerId, campaignId);
    if (!starting?.startingLocation) {
      const fallbackKey = recipe.content.locations.find((location) => location.key === "slake-head")?.key
        ?? recipe.content.locations.find((location) => location.visibility === "public")?.key;
      const fallbackId = fallbackKey ? resourceIdByArtifactKey.get(fallbackKey) : undefined;
      if (!fallbackId) fail("no public starting location is available to designate");
      repository.designateCampaignStartingLocation(ownerId, campaignId, {
        locationId: fallbackId,
        expectedRevision: starting?.revision ?? 0,
        idempotencyKey: `${keyPrefix}.starting-location`,
      });
      starting = repository.getCampaignStartingLocation(ownerId, campaignId);
    }
    return authored;
  });

  // Operational quests remain offered (status open with actionable objectives/rewards).
  await buildStep("quests", () => createOperationalQuests(repository, ownerId, campaignId, keyPrefix, recipe, resourceIdByArtifactKey, warnings));

  // Publish campaign with the reviewed Sintermark policy before activation.
  await buildStep("publish", () => {
    const administration = repository.getCampaignAdministration(ownerId, campaignId) ?? fail("campaign administration is unavailable");
    if (administration.status !== "published" && administration.status !== "completed") {
      repository.updateCampaignAdministration(ownerId, campaignId, {
        expectedRevision: administration.revision,
        status: "published",
        settings: {
          maxPlayers: 2,
          allowPlayerDice: true,
          safetyMode: "strict",
          recapVisibility: "members",
          gmNotes: `Sintermark reviewed provider-free seed ${recipe.version}.`,
        },
        idempotencyKey: `${keyPrefix}.publish-campaign`,
      });
    }
  });

  await buildStep("activate-room", () => {
    const readiness = repository.getCampaignRoomActivationReadiness(ownerId, campaignId, sessionId);
    if (!readiness.ready) fail(`Sintermark room is not activation-ready: ${readiness.blockers.join(", ")}`);
    repository.activateCampaignRoom(ownerId, campaignId, sessionId, {
      expectedRevision: readiness.expectedRevision,
      idempotencyKey: `${keyPrefix}.activate-room`,
    });
  });

  await buildStep("tactical-map", () => {
    const openingWorld = repository.getCampaignWorld(ownerId, campaignId, sessionId)!;
    const anchor = openingWorld.currentLocations.find((location) => location.actorId === heroes[0]!.actorId)!;
    repository.generateTacticalMapForSession(ownerId, campaignId, sessionId, {
      mode: "exploration", encounterId: null, kind: "arena", seed: "sintermark-slake-head-v1", width: 16, height: 16,
      grounding: { actorId: anchor.actorId, expectedLocationId: anchor.locationId, expectedLocationRevision: anchor.revision },
      tokens: heroes.map((hero, index) => ({ tokenId: `sintermark-opening-${index}`, label: hero.name,
        actorId: hero.actorId, combatantId: null, position: { x: 7 + index, y: 8 },
        footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false })),
      idempotencyKey: `${keyPrefix}.opening-map`,
    });
  });

  // Reviewed route event profiles for every open public edge (defaults safe / 30,
  // overridden only by reviewed recipe entries).
  await buildStep("route-profiles", () => {
    authorCampaignRouteProfiles(ownerId, campaignId, sessionId, repository, recipe, context.artifacts, authoredConnections, warnings);
  });

  // Prepared-only encounters: created but never started, so no active combat.
  const encounterIds = await buildStep("encounters", () =>
    createPreparedEncounters(repository, ownerId, campaignId, sessionId, keyPrefix, recipe, resourceIdByArtifactKey, heroes, warnings));

  // Vendor economy: materialize reviewed freeform shops, then fund wallets.
  const shops = await buildStep("vendors", () =>
    materializeVendors(repository, ownerId, campaignId, sessionId, heroes[0]!.actorId, context, warnings));
  await buildStep("wallets", () => fundPartyWallets(campaignId, heroes, shops, warnings));

  // Publish only public handouts and scene prompts.
  await buildStep("materials", () => publishPublicMaterials(repository, ownerId, campaignId, keyPrefix, warnings));

  return { campaignId, sessionId, recipe, content, heroes, appliedArtifactKeys, encounterIds, shops, warnings };
}

/** Creates a new campaign and builds the reviewed world into it. */
export async function createSintermarkWorld(input: {
  repository: Repository;
  ownerId: string;
  keyPrefix: string;
  recipe?: SintermarkRecipe;
}): Promise<SintermarkBuildResult> {
  const recipe = input.recipe ?? readSintermarkRecipe();
  const campaign = input.repository.createCampaign(input.ownerId, { name: recipe.name });
  return runSintermarkBuildIntoCampaign({
    repository: input.repository,
    ownerId: input.ownerId,
    campaignId: campaign.id,
    keyPrefix: input.keyPrefix,
    recipe,
  });
}

async function createOperationalQuests(
  repository: Repository,
  ownerId: string,
  campaignId: string,
  keyPrefix: string,
  recipe: SintermarkRecipe,
  resourceIdByArtifactKey: Map<string, string>,
  warnings: string[],
): Promise<void> {
  if (recipe.operationalQuests.length === 0) return;
  let storylineId: string | null = null;
  for (const arc of recipe.content.arcs) {
    const id = resourceIdByArtifactKey.get(arc.key);
    if (id) { storylineId = id; break; }
  }
  if (!storylineId) {
    const snapshot = repository.listCampaignQuests(ownerId, campaignId);
    for (const quest of snapshot?.quests ?? []) if ("storylineId" in quest && typeof quest.storylineId === "string") { storylineId = quest.storylineId; break; }
  }
  if (!storylineId) {
    const story = repository.getCampaignStory(ownerId, campaignId);
    storylineId = scopedId(keyPrefix, "storyline");
    repository.createCampaignStorylineGraph(ownerId, campaignId, {
      storyline: {
        storylineId,
        title: `${recipe.name} Operations`,
        summary: "Operational quest container for the reviewed Sintermark campaign.",
        nodes: [{ nodeId: `${storylineId}-root`, title: "Operations Board", description: "Reviewed Sintermark operational leads.", gmNotes: "Reviewed operational container.", revealThreshold: 0 }],
        edges: [],
        plotPoints: [],
        clues: [],
      },
      expectedRevision: story?.revision ?? 0,
      idempotencyKey: `${keyPrefix}.operational-storyline`,
    });
  }

  for (const [index, quest] of recipe.operationalQuests.entries()) {
    // Generated quests already have runnable, receipted objectives and rewards.
    // Do not create a second journal entry for the same reviewed quest.
    if (recipe.content.quests.some((generated) => generated.title === quest.title && resourceIdByArtifactKey.has(generated.key))) continue;
    const objectives = (quest.objectives ?? []).filter((objective) => objective.description.trim().length > 0);
    if (objectives.length === 0) {
      warnings.push(`operational quest ${quest.title} had no objectives and was skipped`);
      continue;
    }
    const objectiveIds = objectives.map((objective) => objective.objectiveId ?? `sintermark-objective-${index + 1}-${objectives.indexOf(objective) + 1}`);
    const revision = repository.listCampaignQuests(ownerId, campaignId)?.revision ?? 0;
    repository.createCampaignQuest(ownerId, campaignId, {
      expectedRevision: revision,
      idempotencyKey: `${keyPrefix}.operational.${index + 1}`,
      quest: {
        questId: quest.questId ?? `sintermark-quest-${index + 1}`,
        storylineId,
        title: quest.title,
        description: quest.description ?? null,
        visibility: quest.visibility === "gm" ? "gm" : "public",
        journalText: quest.journalText ?? "A reviewed Sintermark lead is ready to pursue.",
        objectives: objectives.map((objective, objectiveIndex) => ({
          objectiveId: objectiveIds[objectiveIndex]!,
          description: objective.description,
          targetProgress: typeof objective.targetProgress === "number" && objective.targetProgress >= 1 ? objective.targetProgress : 1,
          dependencyObjectiveIds: (objective.dependencyObjectiveIds ?? []).filter((dependency) => objectiveIds.includes(dependency)),
          visibility: objective.visibility === "gm" ? "gm" : "public",
        })),
        rewards: (quest.rewards ?? []).map((reward, rewardIndex) => ({
          rewardId: reward.rewardId ?? `sintermark-reward-${index + 1}-${rewardIndex + 1}`,
          kind: reward.kind === "xp" || reward.kind === "currency" || reward.kind === "custom" ? reward.kind : "currency",
          amount: reward.amount === null || reward.amount === undefined
            ? null
            : Math.min(1_000, Math.max(1, Math.trunc(reward.amount))),
          label: reward.label,
          visibility: reward.visibility === "gm" ? "gm" : "public",
        })),
      },
    });
  }
}

function resolveEnemyDefinitionId(slug: string, available: Set<string>): { definitionId: string; fallback: boolean } {
  const direct = `srd-5.1:enemy-template:${slug}`;
  if (available.has(direct)) return { definitionId: direct, fallback: false };
  const fallbacks = ["magma-mephit", "steam-mephit", "goblin", "bandit", "wolf", "giant-fire-beetle"];
  for (const fallback of fallbacks) {
    const id = `srd-5.1:enemy-template:${fallback}`;
    if (available.has(id)) return { definitionId: id, fallback: true };
  }
  const first = [...available][0];
  if (!first) fail("no SRD enemy template is available for prepared encounters");
  return { definitionId: first, fallback: true };
}

function createPreparedEncounters(
  repository: Repository,
  ownerId: string,
  campaignId: string,
  sessionId: string,
  keyPrefix: string,
  recipe: SintermarkRecipe,
  resourceIdByArtifactKey: Map<string, string>,
  heroes: readonly SintermarkHeroSummary[],
  warnings: string[],
): string[] {
  const available = new Set(
    SRD_5_1_STARTER_CATALOG.definitions
      .filter((definition) => definition.reference.kind === "enemy-template")
      .map((definition) => definition.reference.definitionId),
  );
  if (heroes.length === 0) fail("no campaign actor is available for a prepared encounter");
  const publicLocations = recipe.content.locations.filter((location) => location.visibility === "public");
  const encounterIds: string[] = [];
  // A room permits only one preparing or active encounter. The other scenarios
  // remain accepted encounter concepts and can be prepared after this one ends.
  for (const [index, spec] of ENCOUNTER_SPECS.slice(0, 1).entries()) {
    const resolved = resolveEnemyDefinitionId(spec.enemySlug, available);
    if (resolved.fallback) warnings.push(`enemy ${spec.enemySlug} was unavailable; encounter "${spec.name}" uses ${resolved.definitionId}`);
    const matched = publicLocations.find((location) => {
      const haystack = `${location.key} ${location.name}`.toLowerCase();
      return spec.keywords.some((keyword) => haystack.includes(keyword));
    });
    const locationId = matched ? resourceIdByArtifactKey.get(matched.key) : undefined;
    if (!locationId) warnings.push(`encounter "${spec.name}" had no thematic location; it is not location-bound`);
    const encounter = repository.createEncounter(ownerId, campaignId, {
      sessionId,
      name: spec.name,
      combatants: [
        ...heroes.map((hero) => ({ kind: "actor" as const, actorId: hero.actorId, team: "allies" as const })),
        {
          kind: "enemy" as const,
          template: { kind: "enemy-template" as const, packId: SRD_5_1_STARTER_PACK_ID, packVersion: SRD_5_1_STARTER_PACK_VERSION, definitionId: resolved.definitionId },
          team: "enemies" as const,
        },
      ],
      idempotencyKey: `${keyPrefix}.encounter.${index + 1}`,
    });
    encounterIds.push(encounter.encounter.encounterId);
  }
  return encounterIds;
}

export interface ShopLineLike { stockId: string; unitPriceMinor: number; currencyCode: string }
export interface ShopLike { shopId: string; npcId: string; status: string; stock: ShopLineLike[] }

function materializeVendors(
  repository: Repository,
  ownerId: string,
  campaignId: string,
  sessionId: string,
  actorId: string,
  context: { artifacts: Array<{ key: string; kind: string; visibility: string; canonical: Record<string, unknown>; serverResourceId: string | null }> },
  warnings: string[],
): ShopLike[] {
  const vendorHints = /merchant|smith|trader|vendor|shop|market|inn|provision|quarter|store|outfitt/i;
  const candidates = context.artifacts
    .filter((artifact) => artifact.kind === "npc" && artifact.visibility === "public" && artifact.serverResourceId)
    .filter((artifact) => {
      const name = typeof artifact.canonical.name === "string" ? artifact.canonical.name : "";
      const archetype = typeof artifact.canonical.archetype === "string" ? artifact.canonical.archetype : "";
      return vendorHints.test(`${name} ${archetype}`);
    });
  const ordered = candidates.length >= 2 ? candidates : context.artifacts.filter((artifact) => artifact.kind === "npc" && artifact.visibility === "public" && artifact.serverResourceId);
  const chosen = ordered.slice(0, 2);
  if (chosen.length < 2) warnings.push("fewer than two public NPCs are available for vendor materialization");
  const shops: ShopLike[] = [];
  for (const npc of chosen) {
    try {
      const materialization = repository.materializeFreeformShop(ownerId, campaignId, sessionId, actorId, npc.serverResourceId!) as unknown as ShopLike;
      if (materialization.status !== "materialized") {
        warnings.push(`vendor ${npc.key} did not materialize a shop: ${materialization.status}`);
        continue;
      }
      shops.push(materialization);
    } catch (error) {
      warnings.push(`vendor ${npc.key} shop materialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return shops;
}

async function fundPartyWallets(
  campaignId: string,
  heroes: SintermarkHeroSummary[],
  shops: ShopLike[],
  warnings: string[],
): Promise<void> {
  const priced = shops.flatMap((shop) => shop.stock).filter((line) => line.unitPriceMinor > 0);
  if (priced.length === 0) {
    warnings.push("no priced shop stock is available; party wallets were not funded");
    return;
  }
  const currencyCode = priced[0]!.currencyCode;
  const balanceMinor = Math.min(1_000_000, Math.max(50_000, ...priced.map((line) => line.unitPriceMinor)));
  withAuthoringDatabase((db) => {
    const upsert = db.prepare(`INSERT INTO rpg_wallets_v25(campaign_id,actor_id,currency_code,balance_minor,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,actor_id,currency_code)
      DO UPDATE SET balance_minor=excluded.balance_minor,updated_at=excluded.updated_at`);
    const at = new Date().toISOString();
    for (const hero of heroes) upsert.run(campaignId, hero.actorId, currencyCode, balanceMinor, at);
  });
}

function publishPublicMaterials(repository: Repository, ownerId: string, campaignId: string, keyPrefix: string, warnings: string[]): void {
  let planning = repository.getCampaignGeneratedPlanning(ownerId, campaignId);
  if (!planning) return;
  for (const material of planning.deliverables.filter((candidate) => candidate.visibility === "public")) {
    try {
      const published = repository.publishCampaignMaterial(ownerId, campaignId, {
        artifactKey: material.artifactKey,
        expectedRevision: planning.deliveryRevision,
        idempotencyKey: `${keyPrefix}.publish.${material.artifactKey}`,
      });
      planning = { ...planning, deliveryRevision: published.receipt.revisionAfter };
    } catch (error) {
      warnings.push(`public material ${material.artifactKey} was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary + validation
// ---------------------------------------------------------------------------

export function readSintermarkActiveSessionId(repository: Repository, ownerId: string, campaignId: string): string | null {
  const attachments = repository.listCampaignSessionAttachments(ownerId, campaignId);
  for (const attachment of attachments) {
    const session = repository.getSession(attachment.sessionId);
    const stoppedAt = (session as unknown as { stoppedAt?: string | null } | null)?.stoppedAt ?? null;
    if (session && session.state === "active" && stoppedAt === null) return session.id;
  }
  return attachments[0]?.sessionId ?? null;
}

export function summarizeSintermarkCampaign(
  repository: Repository,
  ownerId: string,
  dataDir: string,
  recipe: SintermarkRecipe,
  campaignId: string,
  sessionId: string,
  appliedArtifactKeys: string[],
  encounterIds: string[],
  warnings: string[],
  status: "created" | "existing" | "validated",
): SintermarkSummary {
  const heroes = readHeroes(repository, ownerId, campaignId, recipe);
  const context = repository.getCampaignGenerationContext(ownerId, campaignId, appliedArtifactKeys)
    ?? fail("campaign generation context is unavailable for summary");
  const resourceIdByArtifactKey = new Map<string, string>();
  for (const artifact of context.artifacts) if (artifact.serverResourceId) resourceIdByArtifactKey.set(artifact.key, artifact.serverResourceId);

  const world = repository.getCampaignWorld(ownerId, campaignId, sessionId);
  const starting = repository.getCampaignStartingLocation(ownerId, campaignId);
  const startLocationId = starting?.startingLocation?.locationId ?? null;
  const graph = world
    ? publicGraph(recipe, resourceIdByArtifactKey, world, startLocationId, warnings)
    : { startLocationId, reachablePublicLocations: 0, unreachablePublicLocations: [] };

  const acceptedLocations = context.artifacts.filter((artifact) => artifact.kind === "location");
  const publicLocations = acceptedLocations.filter((artifact) => artifact.visibility === "public");
  const connectionCount = (getRepositoryDatabase().prepare("SELECT count(*) count FROM campaign_location_connections_v28 WHERE campaign_id=?").get(campaignId) as { count: number }).count;
  const factions = repository.listCampaignFactions(ownerId, campaignId)?.factions.length ?? 0;
  const npcs = repository.listCampaignNpcs(ownerId, campaignId)?.npcs.length ?? 0;
  const quests = repository.listCampaignQuests(ownerId, campaignId)?.quests.length ?? 0;
  const materials = repository.getCampaignPublishedMaterials(ownerId, campaignId)?.materials.length ?? 0;
  const routeProfiles = readRouteProfileCount(campaignId);

  let partyLevel = 0;
  let heroHealthMin = Number.MAX_SAFE_INTEGER;
  let heroesWithInventory = 0;
  for (const hero of heroes) {
    const progression = repository.getCharacterProgression(ownerId, hero.campaignCharacterId) as unknown as ProgressionLike | null;
    if (!progression) fail(`missing progression for ${hero.name}`);
    partyLevel = partyLevel === 0 ? progression.level : Math.min(partyLevel, progression.level);
    const health = repository.getActorResource(ownerId, campaignId, hero.actorId, "health");
    if (!health) warnings.push(`${hero.name} has no health resource`);
    else {
      heroHealthMin = Math.min(heroHealthMin, health.max);
      if (health.max < 1_000) warnings.push(`${hero.name} baseline health is ${health.max}, below the reviewed 1000 target`);
    }
    const inventory = repository.getActorInventorySnapshot(ownerId, campaignId, hero.actorId);
    if (!inventory) warnings.push(`${hero.name} has no inventory snapshot`);
    else heroesWithInventory += 1;
  }
  if (heroes.length === 0) heroHealthMin = 0;

  return {
    status,
    dataDir,
    reportPath: join(dataDir, REPORT_FILE),
    campaignId,
    sessionId,
    campaignName: recipe.name,
    heroes,
    counts: {
      acceptedArtifacts: context.artifacts.length,
      locations: acceptedLocations.length,
      publicLocations: publicLocations.length,
       connections: connectionCount,
      routeProfiles,
      factions,
      npcs,
      quests,
       encounters: context.artifacts.filter((artifact) => artifact.kind === "encounter").length,
      materialDeliveries: materials,
      partyActors: heroes.length,
      partyLevel,
      heroHealthMin: heroHealthMin === Number.MAX_SAFE_INTEGER ? 0 : heroHealthMin,
      heroesWithInventory,
    },
    publicGraph: graph,
    launching: {
      dataDir,
      apiBase: API_BASE,
      clientBase: CLIENT_BASE,
      serverEnv: {
        VELVET_DATA_DIR: dataDir,
        PORT: "18894",
        FEATURE_RPG_CAMPAIGN: "true",
        FEATURE_RPG_MECHANICS: "true",
        FEATURE_RPG_COMBAT: "true",
        FEATURE_RPG_STUDIO: "true",
      },
    },
    warnings: [...warnings],
  };
}

export function assertSintermarkSummary(summary: SintermarkSummary): void {
  if (summary.heroes.length !== 2) fail(`Sintermark requires exactly two heroes; found ${summary.heroes.length}`);
  if (summary.counts.locations < 26) fail(`Sintermark requires at least 26 accepted locations; found ${summary.counts.locations}`);
  if (summary.counts.factions < 6) fail(`Sintermark requires at least 6 factions; found ${summary.counts.factions}`);
  if (summary.counts.npcs < 15) fail(`Sintermark requires at least 15 NPCs; found ${summary.counts.npcs}`);
  if (summary.counts.quests < 5) fail(`Sintermark requires at least 5 quests; found ${summary.counts.quests}`);
  if (summary.counts.routeProfiles < 1) fail("Sintermark requires at least one route event profile");
  if (summary.counts.encounters < 3) fail(`Sintermark requires at least 3 encounter scenarios; found ${summary.counts.encounters}`);
  if (summary.counts.materialDeliveries < 1) fail("Sintermark requires at least one published public material");
  if (summary.counts.partyLevel < 3) fail(`Sintermark requires level-3 heroes; highest level is ${summary.counts.partyLevel}`);
  if (summary.counts.heroHealthMin < 1_000) fail(`Sintermark requires baseline health 1000 for every hero; minimum is ${summary.counts.heroHealthMin}`);
  if (summary.counts.heroesWithInventory !== 2) fail(`Sintermark requires an inventory snapshot for both heroes; found ${summary.counts.heroesWithInventory}`);
  if (summary.publicGraph.unreachablePublicLocations.length > 0) {
    fail(`Sintermark public graph has ${summary.publicGraph.unreachablePublicLocations.length} unreachable public location(s); connect every public location to the start`);
  }
}
