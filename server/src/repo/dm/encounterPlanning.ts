import type { CampaignCatalogResolutionReport } from "@velvet/contracts";
import {
  planDnd5eEncounter, planDnd5eEncounterRewards, selectDnd5eNpcStatBlocks,
  type Dnd5eEncounterPlan, type EncounterRewardsPlan,
} from "../../rulesets/index.js";

/**
 * Campaign-aware encounter planning. Resolves the pinned enemy templates of a
 * campaign's configured catalog into exact-CR candidates and drives the pure
 * SRD encounter builder, reward preview, and NPC selection. Read-only and
 * deterministic; routes adapt the catalog projection into
 * `EncounterCatalogDefinition`.
 */

export interface EncounterCatalogDefinition {
  reference: { kind: string; definitionId: string };
  name: string;
  tags?: readonly string[];
  mechanics: { challengeRating?: number };
}

export interface EncounterPlanningDependencies {
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): CampaignCatalogResolutionReport | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string): { definitions: readonly EncounterCatalogDefinition[] } | null;
}

export interface EncounterCandidate {
  id: string;
  name: string;
  challengeRating: number;
  tags: readonly string[];
}

/** The public encounter candidate shape; tags are an internal selection input only. */
export interface EncounterCandidateView {
  id: string;
  name: string;
  challengeRating: number;
}

export interface EncounterRewardPreviewRequest {
  defeatedEnemyIds: readonly string[];
  currentXp: number;
  currentLevel: number;
}

export interface EncounterRewardPreview {
  plan: EncounterRewardsPlan;
  /** Defeated enemies resolved to exact pinned challenge ratings, in request order. */
  defeated: readonly { id: string; challengeRating: number }[];
}

export interface NpcSelectionRequest {
  role?: string | undefined;
  minChallengeRating?: number | undefined;
  maxChallengeRating?: number | undefined;
  count: number;
  excludeIds?: readonly string[] | undefined;
}

export interface NpcSelectionResult {
  selected: readonly { id: string; name: string; challengeRating: number }[];
  legal: boolean;
  reasons: readonly string[];
}

export type EncounterPlanningDifficulty = "easy" | "medium" | "hard" | "deadly";

export interface CampaignEncounterRequest {
  partyLevels: readonly number[];
  targetDifficulty: EncounterPlanningDifficulty;
  candidateIds?: readonly string[] | undefined;
  maxMonsters?: number | undefined;
}

export interface CampaignEncounterPlan {
  candidates: readonly EncounterCandidateView[];
  plan: Dnd5eEncounterPlan;
}

export function createEncounterPlanningService(dependencies: EncounterPlanningDependencies) {
  const candidatesFor = (actorPrincipalId: string, campaignId: string): EncounterCandidate[] => {
    const catalog = dependencies.resolveCampaignCatalog(actorPrincipalId, campaignId);
    if (!catalog) return [];
    const candidates: EncounterCandidate[] = [];
    for (const pack of catalog.contentPacks) {
      const projection = dependencies.getCampaignContentCatalog(actorPrincipalId, campaignId, pack.packId, pack.packVersion);
      if (!projection) continue;
      for (const definition of projection.definitions) {
        if (definition.reference.kind !== "enemy-template") continue;
        const challengeRating = definition.mechanics.challengeRating;
        if (typeof challengeRating !== "number") continue;
        candidates.push({ id: definition.reference.definitionId, name: definition.name, challengeRating, tags: Object.freeze([...(definition.tags ?? [])]) });
      }
    }
    return candidates.sort((left, right) => left.challengeRating - right.challengeRating
      || left.id.localeCompare(right.id, "en-US"));
  };

  return Object.freeze({
    hasCampaignCatalog(actorPrincipalId: string, campaignId: string): boolean {
      return dependencies.resolveCampaignCatalog(actorPrincipalId, campaignId) !== null;
    },
    listEncounterCandidates(actorPrincipalId: string, campaignId: string): readonly EncounterCandidate[] {
      return Object.freeze(candidatesFor(actorPrincipalId, campaignId));
    },
    planEncounter(actorPrincipalId: string, campaignId: string, request: CampaignEncounterRequest): CampaignEncounterPlan {
      const all = candidatesFor(actorPrincipalId, campaignId);
      const selected = request.candidateIds === undefined
        ? all
        : all.filter((candidate) => request.candidateIds!.includes(candidate.id));
      const plan = planDnd5eEncounter({
        partyLevels: [...request.partyLevels],
        targetDifficulty: request.targetDifficulty,
        candidates: selected.map((candidate) => ({ id: candidate.id, challengeRating: candidate.challengeRating })),
        ...(request.maxMonsters === undefined ? {} : { maxMonsters: request.maxMonsters }),
      });
      return Object.freeze({
        candidates: Object.freeze(all.map((candidate) => Object.freeze({ id: candidate.id, name: candidate.name, challengeRating: candidate.challengeRating }))),
        plan,
      });
    },
    previewEncounterRewards(actorPrincipalId: string, campaignId: string, request: EncounterRewardPreviewRequest): EncounterRewardPreview {
      const byId = new Map(candidatesFor(actorPrincipalId, campaignId).map((candidate) => [candidate.id, candidate] as const));
      const defeated = request.defeatedEnemyIds.map((id) => {
        const candidate = byId.get(id);
        if (!candidate) throw new Error(`defeated enemy is not a pinned campaign enemy: ${id}`);
        return { id, challengeRating: candidate.challengeRating };
      });
      const plan = planDnd5eEncounterRewards({
        defeated: defeated.map((entry) => ({ challengeRating: entry.challengeRating, count: 1 })),
        currentXp: request.currentXp,
        currentLevel: request.currentLevel,
      });
      return Object.freeze({ plan, defeated: Object.freeze(defeated) });
    },
    selectNpcs(actorPrincipalId: string, campaignId: string, request: NpcSelectionRequest): NpcSelectionResult {
      const candidates = candidatesFor(actorPrincipalId, campaignId);
      const result = selectDnd5eNpcStatBlocks({
        candidates: candidates.map((candidate) => ({ id: candidate.id, challengeRating: candidate.challengeRating, roles: candidate.tags, tags: candidate.tags })),
        ...(request.role === undefined ? {} : { role: request.role }),
        ...(request.minChallengeRating === undefined ? {} : { minChallengeRating: request.minChallengeRating }),
        ...(request.maxChallengeRating === undefined ? {} : { maxChallengeRating: request.maxChallengeRating }),
        count: request.count,
        ...(request.excludeIds === undefined ? {} : { excludeIds: request.excludeIds }),
      });
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
      const selected = result.selected.map((entry) => Object.freeze({ id: entry.id, name: byId.get(entry.id)!.name, challengeRating: entry.challengeRating }));
      return Object.freeze({ selected: Object.freeze(selected), legal: result.legal, reasons: result.reasons });
    },
  });
}

export type EncounterPlanningService = ReturnType<typeof createEncounterPlanningService>;
