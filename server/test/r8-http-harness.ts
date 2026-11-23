// Shared HTTP harness for the round-8 approved tests. A fake planner can pick an exact SRD check
// candidate by skill name; a fake narrator sees the committed receipt outcome and writes the prose.
import { expect } from "vitest";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";

export const R8_FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
export const enableR8Flags = () => {
  for (const flag of R8_FLAGS) process.env[flag] = "true";
};
export const clearR8Flags = () => {
  for (const flag of R8_FLAGS) delete process.env[flag];
};

const done = (toolCalls: { id: string; name: string; arguments: string }[], content: string | null = null) =>
  ({
    message: { role: "assistant", content, toolCalls },
    usage: null,
    model: { requestedModel: "test", responseModel: "test" },
  }) as ProviderCompletionResult;

export type FakeOptions = {
  /** When set, the planner selects this skill's Medium/normal check candidate. */
  pickSkill?: string;
  /** Writes the narration; `outcome` and `skill` come from the committed check receipt, when there is one. */
  narrate: (facts: { outcome: "success" | "failure" | null; skill: string | null }) => string;
};

export function fakeProvider(options: FakeOptions) {
  const log = {
    plannerCalls: 0,
    narrationCalls: 0,
    narrationTexts: [] as string[],
    narrationFacts: [] as { outcome: "success" | "failure" | null; skill: string | null }[],
  };
  const dependencies: AdventureAgentDependencies = {
    complete: async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      const names = (input.tools ?? []).map((tool) => tool.name);
      if (names.includes("submit_adventure_narration")) {
        log.narrationCalls += 1;
        const raw = JSON.stringify(input.messages);
        const facts = raw.indexOf("verifiedReceiptFacts");
        const section = facts >= 0 ? raw.slice(facts) : "";
        const outcome = section.match(/\\"kind\\":\\"check\\"[^}]*?\\"outcome\\":\\"(success|failure)\\"/)?.[1] ?? null;
        const skill = section.match(/\\"skill\\":\\"([A-Za-z ]+)\\"/)?.[1] ?? null;
        const narration = options.narrate({ outcome: (outcome as "success" | "failure" | null) ?? null, skill });
        log.narrationTexts.push(narration);
        log.narrationFacts.push({ outcome: (outcome as "success" | "failure" | null) ?? null, skill });
        return done([
          { id: "r8-narration", name: "submit_adventure_narration", arguments: JSON.stringify({ narration }) },
        ]);
      }
      log.plannerCalls += 1;
      if (options.pickSkill && names.includes("exact_srd_check.select")) {
        const raw = JSON.stringify(input.messages);
        const escaped = options.pickSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
          `\\{\\\\"arguments\\\\":\\{\\\\"candidateId\\\\":\\\\"(check-candidate:[0-9a-f]+)\\\\",\\\\"digest\\\\":\\\\"([0-9a-f]+)\\\\"\\},\\\\"label\\\\":\\{[^}]*?\\\\"source\\\\":\\\\"${escaped} \\([A-Za-z ]+\\), Medium difficulty, normal`,
        );
        const match = raw.match(pattern);
        expect(match, `no ${options.pickSkill} check candidate offered`).toBeTruthy();
        return done([
          {
            id: "r8-check",
            name: "exact_srd_check.select",
            arguments: JSON.stringify({ candidateId: match![1], digest: match![2] }),
          },
        ]);
      }
      return done([], "No action is warranted.");
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  return { dependencies, log };
}

export type R8App = ReturnType<typeof buildApp>;
export type R8Ids = { campaignId: string; sessionId: string; actorId: string };

export async function startQuickAdventure(app: R8App): Promise<R8Ids> {
  const created = await app.inject({
    method: "POST",
    url: "/api/rpg/v1/quick-adventures",
    payload: { idempotencyKey: `r8-${Math.random()}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json() as R8Ids;
}

export async function playR8Turn(app: R8App, ids: R8Ids, declaration: string) {
  const boot = await app.inject({
    method: "GET",
    url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
  });
  expect(boot.statusCode, boot.body).toBe(200);
  const streamed = await app.inject({
    method: "POST",
    url: "/api/rpg/v1/adventure-turns/stream",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    payload: {
      campaignId: ids.campaignId,
      sessionId: ids.sessionId,
      actorId: ids.actorId,
      declaration,
      expectedRevision: boot.json().expectedRevision,
      idempotencyKey: `r8-turn-${Math.random()}`,
    },
  });
  expect(streamed.statusCode, streamed.body).toBe(200);
  const turnId = streamed.headers["x-adventure-turn-id"] as string;
  const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` });
  expect(read.statusCode, read.body).toBe(200);
  return read.json() as {
    turn: { state: string };
    receipts: { commandId: string }[];
    narrationStatus: Record<string, unknown> & { status: string; text?: string | null };
  };
}
