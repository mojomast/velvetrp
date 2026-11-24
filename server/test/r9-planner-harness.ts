// Shared helpers for the round-9 approved tests: a fake provider that records every planner request
// (tools, messages) and lets the test script the planner reply from the candidate table.
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";

export type CandidateOption = {
  toolName: string;
  arguments: { candidateId: string; digest: string } & Record<string, unknown>;
  label: { action?: string; source?: string; target?: string | null } & Record<string, unknown>;
};

/** Parses the "UNTRUSTED CURRENT EXACT CANDIDATE TABLE" message the planner sees. */
export function candidateTable(input: ProviderCompletionInput): CandidateOption[] {
  for (const message of input.messages) {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.startsWith("UNTRUSTED CURRENT EXACT CANDIDATE TABLE")) continue;
    const start = content.indexOf('{"candidateOptions"');
    if (start >= 0) return JSON.parse(content.slice(start)).candidateOptions as CandidateOption[];
  }
  return [];
}

export function plannerText(input: ProviderCompletionInput): string {
  return JSON.stringify(input.messages);
}

export const completion = (
  toolCalls: { id: string; name: string; arguments: string }[],
  content: string | null = null,
): ProviderCompletionResult =>
  ({
    message: { role: "assistant", content, toolCalls },
    usage: null,
    model: { requestedModel: "test", responseModel: "test" },
  }) as ProviderCompletionResult;

export function recordingProvider(plan: (input: ProviderCompletionInput, round: number) => ProviderCompletionResult) {
  const planner: ProviderCompletionInput[] = [];
  const dependencies: AdventureAgentDependencies = {
    complete: async (input) => {
      const names = (input.tools ?? []).map((tool) => tool.name);
      if (names.includes("submit_adventure_narration")) {
        return completion([
          {
            id: "r9-narration",
            name: "submit_adventure_narration",
            arguments: JSON.stringify({ narration: "The moment passes quietly." }),
          },
        ]);
      }
      planner.push(input);
      return plan(input, planner.length);
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  return { dependencies, planner };
}

/** First advertised row for a tool, read from the candidate table (provider schemas no longer list candidates). */
export function firstExactCandidate(
  input: ProviderCompletionInput,
  toolName: string,
): { candidateId: string; digest: string } {
  const row = candidateTable(input).find((option) => option.toolName === toolName);
  if (!row) throw new Error(`no ${toolName} row in the candidate table`);
  return { candidateId: row.arguments.candidateId, digest: row.arguments.digest };
}
