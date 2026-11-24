// Approved tests for round-9 change N: narration and repair calls get their own token budget
// (adventureTurnBudget.maxNarrationTokens, default 32,768), separate from the planner's
// maxTotalTokens cap (65,536, unchanged). Planner usage must not starve narration, and narration
// has its own cap.
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { closeRepo } from "../src/repo/index.js";
import { createNarrationTurnBudgetPolicy } from "../src/agent/narrationBudget.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const NARRATION = "A cold wind crosses the square and the crowd shifts; nothing else changes just yet.";
const done = (
  toolCalls: { id: string; name: string; arguments: string }[],
  content: string | null,
  usage: { promptTokens: number; completionTokens: number } | null,
) =>
  ({
    message: { role: "assistant", content, toolCalls },
    usage: usage ? { totalTokens: usage.promptTokens + usage.completionTokens, ...usage } : null,
    model: { requestedModel: "test", responseModel: "test" },
  }) as unknown as ProviderCompletionResult;

function deps(options: { plannerPromptTokens: number; narrationCap?: number; planCap?: number }) {
  const dependencies: AdventureAgentDependencies = {
    complete: async (input: ProviderCompletionInput) => {
      const names = (input.tools ?? []).map((tool) => tool.name);
      if (names.includes("submit_adventure_narration"))
        return done(
          [{ id: "n", name: "submit_adventure_narration", arguments: JSON.stringify({ narration: NARRATION }) }],
          null,
          { promptTokens: 7_000, completionTokens: 100 },
        );
      return done([], "No action is warranted.", { promptTokens: options.plannerPromptTokens, completionTokens: 20 });
    },
    getProvider: async () => {
      const provider = defaultProviderSettings();
      return {
        ...provider,
        model: "test",
        adventureTurnBudget: {
          ...provider.adventureTurnBudget,
          ...(options.planCap ? { maxTotalTokens: options.planCap } : {}),
          ...(options.narrationCap ? { maxNarrationTokens: options.narrationCap } : {}),
        },
      };
    },
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  return dependencies;
}

async function narrationAfterPlanner(options: Parameters<typeof deps>[0]) {
  enableR8Flags();
  const app = buildApp({ adventureAgentDependencies: deps(options) });
  const ids = await startQuickAdventure(app);
  const turn = await playR8Turn(app, ids, "I look around the square.");
  return turn.narrationStatus.text ?? "";
}

describe("round 9 change N: separate narration budget", () => {
  it("defaults narration to 32,768 tokens and leaves the planner cap at 65,536", () => {
    const budget = defaultProviderSettings().adventureTurnBudget as {
      maxTotalTokens: number;
      maxNarrationTokens?: number;
    };
    expect(budget.maxTotalTokens).toBe(65_536);
    expect(budget.maxNarrationTokens).toBe(32_768);
  });

  it("builds a narration policy from its own setting, independent of the planner cap", () => {
    const provider = defaultProviderSettings();
    const policy = createNarrationTurnBudgetPolicy({
      ...provider,
      adventureTurnBudget: { ...provider.adventureTurnBudget, maxTotalTokens: 200_000, maxNarrationTokens: 12_345 },
    } as never)!;
    expect(policy.maxTotalTokens).toBe(12_345);
    expect(policy.maxPromptTokens).toBe(12_345);
    const fallback = createNarrationTurnBudgetPolicy(provider)!;
    expect(fallback.maxTotalTokens).toBe(32_768);
  });

  it("control: a light planner leaves narration accepted", async () => {
    expect(await narrationAfterPlanner({ plannerPromptTokens: 20_000 })).toContain("cold wind");
  });

  it("heavy planner usage no longer starves narration", async () => {
    // 60k planner tokens leave under 6k of the 65,536 planner cap; narration (~7k) would have been refused.
    expect(await narrationAfterPlanner({ plannerPromptTokens: 60_000 })).toContain("cold wind");
  });

  it("narration has its own cap: a tiny narration budget refuses narration even with planner headroom", async () => {
    expect(await narrationAfterPlanner({ plannerPromptTokens: 20_000, narrationCap: 1_000 })).not.toContain(
      "cold wind",
    );
  });
});
