// Approved tests for round-9 change A (PLANNER-DESIGN.md Option A): outside combat the adventure
// planner is a lean single-round planner. No *.read tools are advertised (their content is already in
// the prompt), a compact actor vitals line carries HP/resources, and the candidate-table header no
// longer invites reading. combat_state.read stays available during combat.
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { selectAdventureTools } from "../src/agent/toolRegistry.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";
import { completion, plannerText, recordingProvider } from "./r9-planner-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const snapshot = (overrides: Record<string, unknown> = {}) =>
  ({
    audience: { kind: "player", actorId: "actor" },
    authority: { control: "actor" },
    attributeCandidates: [{ candidateId: "attribute:opaque", digest: "a".repeat(64), label: "Strength" }],
    encounter: null,
    ...overrides,
  }) as any;

describe("round 9 change A: no read tools outside combat", () => {
  it("advertises no *.read tool to a non-combat planner, but keeps mutation tools", () => {
    const names = selectAdventureTools(snapshot()).map((tool) => tool.name);
    expect(names.filter((name) => name.endsWith(".read"))).toEqual([]);
    expect(names).toContain("actor_attribute.set");
  });

  it("keeps combat_state.read during combat", () => {
    const encounter = {
      encounterId: "combat",
      phase: "active" as const,
      revision: 1,
      currentCombatantId: "actor-combatant",
      currentCombatantKind: "actor" as const,
      currentActorId: "actor",
      legalActionCandidates: [],
    };
    const names = selectAdventureTools(snapshot({ encounter })).map((tool) => tool.name);
    expect(names).toContain("combat_state.read");
  });

  it("sends a quick-adventure planner no read tool, an HP/resources line and no 'reading is good' wording", async () => {
    enableR8Flags();
    const { dependencies, planner } = recordingProvider(() => completion([], "No action is warranted."));
    const app = buildApp({ adventureAgentDependencies: dependencies });
    const ids = await startQuickAdventure(app);
    await playR8Turn(app, ids, "I look around the square.");
    expect(planner.length).toBeGreaterThan(0);
    for (const input of planner) {
      expect((input.tools ?? []).map((tool) => tool.name).filter((name) => name.endsWith(".read"))).toEqual([]);
      const text = plannerText(input);
      expect(text).toMatch(/Actor vitals: HP \d+\/\d+/);
      expect(text).not.toMatch(/Reading context is good/);
    }
  });

  it("does not budget-refuse or mutate when a provider still calls an unadvertised read tool", async () => {
    enableR8Flags();
    const { dependencies, planner } = recordingProvider(() =>
      completion([{ id: "stray-read", name: "campaign_context.read", arguments: "{}" }]),
    );
    const app = buildApp({ adventureAgentDependencies: dependencies });
    const ids = await startQuickAdventure(app);
    const turn = await playR8Turn(app, ids, "I look around the square.");
    expect(planner).toHaveLength(1);
    expect(turn.receipts).toEqual([]);
    expect(turn.narrationStatus.status).toBeTruthy();
  });
});
