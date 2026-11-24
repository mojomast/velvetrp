// Approved tests for round 9b: a failed planner provider call records WHY it failed. For a
// ProviderProtocolError the stored provider_call_metadata outcome_code carries a short slug of the
// adapter's static reason ("ProviderProtocolError.<slug>[-estimated]"), so a failure like the
// round-9 "tool_calls must be an array" is diagnosable from the database. Other errors keep their
// existing codes, and free-form error text (which could carry provider or secret content) is never stored.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { ProviderProtocolError } from "../src/provider/openAiCompatibleCompletion.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

function failingPlanner(error: () => Error): AdventureAgentDependencies {
  return {
    complete: async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if ((input.tools ?? []).some((tool) => tool.name === "submit_adventure_narration")) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "r9b-n",
                name: "submit_adventure_narration",
                arguments: JSON.stringify({ narration: "You look around." }),
              },
            ],
          },
          usage: null,
          model: { requestedModel: "test", responseModel: "test" },
        } as ProviderCompletionResult;
      }
      throw error();
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
}

async function plannerFailureCodes(error: () => Error): Promise<string[]> {
  enableR8Flags();
  const app = buildApp({ adventureAgentDependencies: failingPlanner(error) });
  const ids = await startQuickAdventure(app);
  await playR8Turn(app, ids, "I look around the square.");
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT outcome_code FROM provider_call_metadata WHERE phase='failed' AND call_id LIKE 'agent-provider:%'",
        )
        .all() as { outcome_code: string }[]
    ).map((row) => row.outcome_code);
  } finally {
    db.close();
  }
}

describe("round 9b: planner failure reason is persisted", () => {
  it("records the tool_calls-not-an-array reason", async () => {
    const codes = await plannerFailureCodes(
      () => new ProviderProtocolError("Provider message tool_calls must be an array"),
    );
    expect(codes).toEqual(["ProviderProtocolError.provider-message-tool-calls-must-be-an-array-estimated"]);
  });

  it("replaces digits so indexed reasons stay stable", async () => {
    const codes = await plannerFailureCodes(() => new ProviderProtocolError("Provider tool_calls[3] is malformed"));
    expect(codes).toEqual(["ProviderProtocolError.provider-tool-calls-n-is-malformed-estimated"]);
  });

  it("keeps the finish reason in the slug", async () => {
    const codes = await plannerFailureCodes(
      () => new ProviderProtocolError("Provider did not complete the tool call (finish_reason: length)"),
    );
    expect(codes).toEqual([
      "ProviderProtocolError.provider-did-not-complete-the-tool-call-finish-reason-length-estimated",
    ]);
  });

  it("bounds the stored code to the column limit", async () => {
    const codes = await plannerFailureCodes(
      () => new ProviderProtocolError(`Provider ${"very long reason ".repeat(40)}`),
    );
    expect(codes).toHaveLength(1);
    expect(codes[0]!.length).toBeLessThanOrEqual(128);
    expect(codes[0]).toMatch(/^ProviderProtocolError\.provider-very-long-reason-[a-z0-9-]*-estimated$/);
  });

  it("never stores free-form text from other errors", async () => {
    const codes = await plannerFailureCodes(() => new Error("upstream said sk-live-abc123 at http://10.0.0.5"));
    expect(codes).toEqual(["Error-estimated"]);
  });
});
