// Approved test (round-2 playtest kink 1): the GM narrator was blind to authoritative game state.
// Live: during an API-started combat (Salamander 19/90) it said "no salamander shows itself here";
// with 30 healing potions it said "finds no vial there"; asked for HP it said "no tally of your hurts".
// The narration request must carry a compact, id-free actor state (HP, inventory, quests, live combat),
// and prose that denies a live combat enemy must never become the committed narration.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { closeRepo, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
const STATE_LABEL = "AUTHORITATIVE CURRENT ACTOR STATE";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
  closeRepo();
});

function provider(narrationText: string) {
  const narrationInputs: ProviderCompletionInput[] = [];
  const dependencies: AdventureAgentDependencies = {
    complete: async (input): Promise<ProviderCompletionResult> => {
      const narration = input.tools?.some((tool) => tool.name === "submit_adventure_narration");
      if (narration) {
        narrationInputs.push(input);
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: `n${narrationInputs.length}`,
                name: "submit_adventure_narration",
                arguments: JSON.stringify({ narration: narrationText }),
              },
            ],
          },
          usage: null,
          model: { requestedModel: "test", responseModel: "test" },
        };
      }
      return {
        message: { role: "assistant", content: "No action is warranted.", toolCalls: [] },
        usage: null,
        model: { requestedModel: "test", responseModel: "test" },
      };
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  return { dependencies, narrationInputs };
}

type App = ReturnType<typeof buildApp>;
async function quickWithLiveCombat(app: App) {
  const created = await app.inject({
    method: "POST",
    url: "/api/rpg/v1/quick-adventures",
    payload: { idempotencyKey: `state-context-${Math.random()}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { campaignId, sessionId, actorId } = created.json() as {
    campaignId: string;
    sessionId: string;
    actorId: string;
  };
  const encounters = (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaignId}/encounters` })).json()
    .encounters as Array<{ encounterId: string; revision?: number }>;
  expect(encounters.length).toBeGreaterThan(0);
  const started = await app.inject({
    method: "POST",
    url: `/api/rpg/v1/encounters/${encounters[0]!.encounterId}/start-commands`,
    payload: { expectedRevision: encounters[0]!.revision ?? 0, idempotencyKey: `start-${Math.random()}` },
  });
  expect(started.statusCode, started.body).toBe(200);
  const combatId =
    (started.json().combat?.combatId as string | undefined) ??
    ((await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaignId}/encounters` })).json().encounters[0]
      .combatId as string);
  const combat = (await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${combatId}` })).json() as {
    combatants: Array<{ team: string; displayName: string }>;
  };
  const enemy = combat.combatants.find((c) => c.team === "enemies")!.displayName;
  expect(enemy).toBeTruthy();
  return { campaignId, sessionId, actorId, enemy };
}

async function playTurn(
  app: App,
  ids: { campaignId: string; sessionId: string; actorId: string },
  declaration: string,
) {
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
      idempotencyKey: `turn-${Math.random()}`,
    },
  });
  expect(streamed.statusCode, streamed.body).toBe(200);
  const turnId = streamed.headers["x-adventure-turn-id"] as string;
  const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` });
  return read.json() as { turn: { state: string }; narrationStatus: { status: string; text?: string | null } };
}

function stateMessages(input: ProviderCompletionInput): string[] {
  return input.messages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .filter((content) => content.includes(STATE_LABEL));
}

describe("narrator receives compact authoritative actor state", () => {
  it("includes HP, inventory labels, quests and the live combat enemy without raw ids", async () => {
    const fake = provider("You keep your eyes on the creature and take stock of your wounds.");
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await quickWithLiveCombat(app);
      const resources = (
        await app.inject({
          method: "GET",
          url: `/api/rpg/v1/campaigns/${ids.campaignId}/actors/${ids.actorId}/resources`,
        })
      ).json();
      const health = JSON.stringify(resources).match(/"health"[^}]*?"current":(\d+)[^}]*?"max":(\d+)/);
      expect(health, JSON.stringify(resources).slice(0, 400)).toBeTruthy();
      const quests = (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${ids.campaignId}/quests` })).json()
        .quests as Array<{ title: string }>;
      expect(quests.length).toBeGreaterThan(0);

      const turn = await playTurn(app, ids, "What do I see around me right now, and how hurt am I?");
      expect(turn.turn.state).toBe("completed");
      expect(fake.narrationInputs.length).toBeGreaterThan(0);
      const blocks = stateMessages(fake.narrationInputs[0]!);
      expect(blocks, "a message labelled with the actor-state label").toHaveLength(1);
      const block = blocks[0]!;
      expect(block.toLowerCase()).toContain(ids.enemy.toLowerCase());
      expect(block).toContain(health![1]!);
      expect(block).toContain(health![2]!);
      expect(block).toMatch(/Potion of (Greater|Superior|Supreme) Healing/);
      expect(quests.some((quest) => block.includes(quest.title))).toBe(true);
      // Token discipline: compact state, never a raw dump.
      expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(2_000);
      expect(block).not.toMatch(UUID);
    } finally {
      await app.close();
    }
  });

  it("never commits narration that denies a live combat enemy", async () => {
    let enemyName = "creature";
    const fake = provider("");
    const denial = () =>
      `But no ${enemyName.toLowerCase()} shows itself here; the crossing is only road-worn stone and coal smoke.`;
    const complete = fake.dependencies.complete;
    fake.dependencies.complete = async (input) => {
      const result = await complete(input);
      const call = result.message.toolCalls?.[0];
      if (call?.name === "submit_adventure_narration") call.arguments = JSON.stringify({ narration: denial() });
      return result;
    };
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await quickWithLiveCombat(app);
      enemyName = ids.enemy;
      const turn = await playTurn(app, ids, "What do I see around me right now?");
      expect(turn.turn.state).toBe("completed");
      expect(turn.narrationStatus.status).toBe("completed");
      expect((turn.narrationStatus.text ?? "").toLowerCase()).not.toContain(`no ${ids.enemy.toLowerCase()}`);
    } finally {
      await app.close();
    }
  });

  it("gives the actor state outside combat too, without a combat entry", async () => {
    const fake = provider("You stand on the apron and count what you carry.");
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/quick-adventures",
        payload: { idempotencyKey: `state-context-calm-${Math.random()}` },
      });
      const ids = created.json() as { campaignId: string; sessionId: string; actorId: string };
      const turn = await playTurn(app, ids, "What am I carrying, and how hurt am I?");
      expect(turn.turn.state).toBe("completed");
      const block = stateMessages(fake.narrationInputs[0]!)[0] ?? "";
      expect(block).toMatch(/Potion of (Greater|Superior|Supreme) Healing/);
      expect(block).not.toMatch(/"enemies"/);
    } finally {
      await app.close();
    }
  });
});
