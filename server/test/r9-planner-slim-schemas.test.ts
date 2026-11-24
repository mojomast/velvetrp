// Approved tests for round-9 change C1 (PLANNER-DESIGN.md Option C1): provider-facing select-tool
// schemas no longer repeat every candidate id/digest (enum + oneOf const branches, ~9k tokens of hex).
// The exact candidate table stays the single provider-visible source, and the server still validates
// exact selections: a forged id or a wrong digest never produces a proposal or receipt.
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adventureProviderPromptEstimate } from "../src/agent/adventureOrchestrator.js";
import { labeled } from "../src/agent/providerCandidateProjection.js";
import { selectAdventureTools } from "../src/agent/toolRegistry.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";
import { candidateTable, completion, recordingProvider } from "./r9-planner-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const rows = (family: string) =>
  labeled(
    Array.from({ length: 32 }, (_, n) => ({ candidateId: `${family}:${hex(n, 48)}`, digest: hex(n + 1, 64) })),
    (candidate) => ({
      action: "act",
      source: `source ${candidate.candidateId.slice(-2)}`,
      target: null,
      cost: null,
      consequence: "something happens",
    }),
  );
const snap = () =>
  ({
    audience: { kind: "player", actorId: "actor" },
    authority: { control: "actor" },
    attributeCandidates: [],
    encounter: null,
  }) as any;

describe("round 9 change C1: slim provider schemas", () => {
  it.each([
    ["exact_quest_objective.select", 1],
    ["exact_srd_check.select", 2],
    ["exact_inventory_action.select", 3],
    ["exact_vendor_commerce.select", 4],
    ["exact_power_use.select", 5],
    ["exact_rest.select", 6],
    ["exact_quest_lifecycle.select", 9],
    ["exact_progression_apply.select", 10],
  ] as const)("%s schema carries no candidate copies", (toolName, position) => {
    const args = Array.from({ length: 10 }, () => []) as any[];
    args[position - 1] = rows(toolName);
    const tool = selectAdventureTools(snap(), [], ...args).find((entry) => entry.name === toolName)!;
    expect(tool).toBeDefined();
    const serialized = JSON.stringify(tool.provider.parameters);
    expect(serialized).not.toMatch(/oneOf|enum|"const"/);
    expect(serialized).not.toMatch(/[0-9a-f]{40}/);
    expect(serialized.length).toBeLessThan(600);
    expect(tool.provider.parameters).toMatchObject({
      type: "object",
      required: ["candidateId", "digest"],
      additionalProperties: false,
      properties: { candidateId: { type: "string" }, digest: { type: "string" } },
    });
  });
});

describe("round 9 change C1: server still validates exact selections", () => {
  const drink = async (mode: "valid" | "digest" | "id") => {
    enableR8Flags();
    const { dependencies } = recordingProvider((input) => {
      const row = candidateTable(input).find(
        (option) => option.toolName === "exact_inventory_action.select" && option.label.action === "consume",
      );
      if (!row) return completion([], "No consume row.");
      const args = { ...row.arguments };
      const flip = (value: string) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
      if (mode === "digest") args.digest = flip(args.digest);
      if (mode === "id") args.candidateId = flip(args.candidateId);
      return completion([{ id: "pick", name: "exact_inventory_action.select", arguments: JSON.stringify(args) }]);
    });
    const app = buildApp({ adventureAgentDependencies: dependencies });
    const ids = await startQuickAdventure(app);
    const read = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/rpg/v1/campaigns/${ids.campaignId}/actors/${ids.actorId}/inventory`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.body;
    };
    const before = await read();
    const turn = await playR8Turn(app, ids, "I drink a healing potion.");
    return { turn, before, after: await read() };
  };

  it("a forged candidate id or a wrong digest yields no receipt and leaves inventory unchanged", async () => {
    for (const mode of ["digest", "id"] as const) {
      const attempt = await drink(mode);
      expect(attempt.turn.receipts, mode).toEqual([]);
      expect(attempt.after, mode).toEqual(attempt.before);
    }
  });
});

describe("round 9 change C1: planner prompt size", () => {
  it("keeps the first quick-adventure planner prompt small (slim schemas, no reads)", async () => {
    enableR8Flags();
    const { dependencies, planner } = recordingProvider(() => completion([], "No action is warranted."));
    const app = buildApp({ adventureAgentDependencies: dependencies });
    const ids = await startQuickAdventure(app);
    await playR8Turn(app, ids, "I look around the square.");
    expect(planner.length).toBeGreaterThan(0);
    const bytes = adventureProviderPromptEstimate(planner[0]).length;
    expect(bytes).toBeLessThan(BYTES_LIMIT);
  });
});
// Baseline on main (b347311) is 69,406 bytes of serialized request; C1 removes the hex copies in the schemas.
const BYTES_LIMIT = 48_000;
