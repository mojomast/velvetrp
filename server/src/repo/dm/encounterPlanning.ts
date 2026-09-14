import type { CampaignCatalogResolutionReport, CatalogDefinition } from "@velvet/contracts";
import { planDnd5eEncounter, type Dnd5eEncounterPlan } from "../../rulesets/index.js";

/**
 * Campaign-aware encounter planning. Resolves the pinned enemy templates of a
 * campaign's configured catalog into exact-CR candidates and drives the pure
 * SRD encounter builder. Read-only and deterministic; the HTTP surface is a
 * separate Wave 4 concern.
 */

export interface EncounterPlanningDependencies {
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): CampaignCatalogResolutionReport | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string): { definitions: readonly CatalogDefinition[] } | null;
}

export interface EncounterCandidate {
  id: string;
  name: string;
  challengeRating: number;
}

export type EncounterPlanningDifficulty = "easy" | "medium" | "hard" | "deadly";

export interface CampaignEncounterRequest {
  partyLevels: readonly number[];
  targetDifficulty: EncounterPlanningDifficulty;
  candidateIds?: readonly string[];
  maxMonsters?: number;
}

export interface CampaignEncounterPlan {
  candidates: readonly EncounterCandidate[];
  plan: Dnd5eEncounterPlan;
}

function isEnemyTemplate(definition: CatalogDefinition): definition is Extract<CatalogDefinition, { reference: { kind: "enemy-template" } }> {
  return definition.reference.kind === "enemy-template";
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
        if (!isEnemyTemplate(definition)) continue;
        const challengeRating = definition.mechanics.challengeRating;
        if (typeof challengeRating !== "number") continue;
        candidates.push({ id: definition.reference.definitionId, name: definition.name, challengeRating });
      }
    }
    return candidates.sort((left, right) => left.challengeRating - right.challengeRating
      || left.id.localeCompare(right.id, "en-US"));
  };

  return Object.freeze({
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
      return Object.freeze({ candidates: Object.freeze(all), plan });
    },
  });
}

export type EncounterPlanningService = ReturnType<typeof createEncounterPlanningService>;
