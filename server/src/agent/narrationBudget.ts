import type { ProviderSettings } from "../types.js";
import type { TurnBudgetPolicy } from "./turnBudget.js";

export const DEFAULT_MAX_NARRATION_TOKENS = 32_768;

export function createNarrationTurnBudgetPolicy(provider: ProviderSettings): TurnBudgetPolicy | null {
  const prices =
    provider.pricing.promptPerMillion !== null && provider.pricing.completionPerMillion !== null
      ? {
          promptPerMillionUsd: provider.pricing.promptPerMillion,
          completionPerMillionUsd: provider.pricing.completionPerMillion,
        }
      : null;
  if (provider.adventureTurnBudget.maxEstimatedCostUsd !== null && !prices) return null;
  const maxNarrationTokens = provider.adventureTurnBudget.maxNarrationTokens ?? DEFAULT_MAX_NARRATION_TOKENS;
  return {
    maxPromptTokens: maxNarrationTokens,
    maxCompletionTokens: maxNarrationTokens,
    maxTotalTokens: maxNarrationTokens,
    maxEstimatedCostUsd: provider.adventureTurnBudget.maxEstimatedCostUsd,
    pricing: prices,
    maxConcurrentRequests: 2,
    maxRequestsPerWindow: 64,
    rateWindowMs: 60_000,
  };
}

export function narrationTurnBudgetKey(turnId: string): string {
  return `${turnId}:narration`;
}
