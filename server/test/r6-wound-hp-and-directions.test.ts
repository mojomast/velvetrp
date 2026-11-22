// Approved tests from the round-6 playtest on aa3f05e.
// 1. Qualitative wound checks still omit current/max HP when the provider is accepted.
//    Mech 7 "check my wounds" became a failed Perception check of the ground and never
//    stated current/max. Combat2 2 described being "whole" / "nothing that won't keep"
//    and the numbers arrived only on the follow-up "Give me my hit points." Fallback
//    for "how bad is it" also missed the HP report. When health context is present,
//    these declarations must include current and max HP, even if the provider returns
//    qualitative scene dressing.
// 2. Fighter 7 ("Then I'll be here when you ring the evening count... Point me at the
//    deep galleries so I can find the pale dust first.") was canned as stay-put
//    ("You stay where you are; nothing has changed yet") after an unsupported-transaction
//    repair skip. Asking to be pointed at a place, while staying put for the evening
//    count, is a direction request, not a transaction or a hold.
import { afterEach, describe, expect, it } from "vitest";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { closeRepo } from "../src/repo/index.js";
import { narrationFallback, type NarrationFallbackContext } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
  closeRepo();
});

const health = { current: 8, max: 15 };
const fallbackContext = {
  currentLocation: "Slake-Head",
  reachablePlaces: ["Slake Market", "The Steps", "Draughtwarden Hall"],
  health,
} as NarrationFallbackContext;

const QUALITATIVE_WOUNDS =
  "You take stock of yourself. Your wounds are shallow things: a hot graze along one forearm, a knuckle split from the swing, ash ground into the leather at your knee. Nothing that won't keep. You're whole, and the warm reek off the grate is doing nothing to make the aches feel worse than they are.";

const FIGHTER_7 =
  "Then I'll be here when you ring the evening count — and I'll be on the third rung before your ghost is. Point me at the deep galleries so I can find the pale dust first.";

describe("qualitative wound checks report current and max HP", () => {
  it("falls back to a hit-point report for 'how bad is it' when health context is present", () => {
    const text = narrationFallback("how bad is it", [], fallbackContext);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/\b8\b/);
    expect(text).toMatch(/\b15\b/);
    expect(text).not.toMatch(/stay where you are/i);
    expect(text).not.toMatch(/have not left yet/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });

  it("includes current and max HP when the provider accepts qualitative 'check my wounds' prose", async () => {
    for (const flag of FLAGS) process.env[flag] = "true";
    const fake = provider(QUALITATIVE_WOUNDS);
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/quick-adventures",
        payload: { idempotencyKey: `wound-hp-${Math.random()}` },
      });
      expect(created.statusCode, created.body).toBe(201);
      const ids = created.json() as { campaignId: string; sessionId: string; actorId: string };
      const resources = (
        await app.inject({
          method: "GET",
          url: `/api/rpg/v1/campaigns/${ids.campaignId}/actors/${ids.actorId}/resources`,
        })
      ).json();
      const numbers = JSON.stringify(resources).match(/"health"[^}]*?"current":(\d+)[^}]*?"max":(\d+)/);
      expect(numbers, JSON.stringify(resources).slice(0, 400)).toBeTruthy();
      const current = numbers![1]!;
      const max = numbers![2]!;

      const turn = await playTurn(
        app,
        ids,
        "Breathing hard, I look at what's left of the beetles and check my wounds.",
      );
      expect(turn.turn.state).toBe("completed");
      expect(turn.narrationStatus.status).toBe("completed");
      const text = turn.narrationStatus.text ?? "";
      expect(text).toMatch(/\byou(?:r|'re)?\b/i);
      expect(text).toMatch(new RegExp(`\\b${current}\\b`));
      expect(text).toMatch(new RegExp(`\\b${max}\\b`));
      expect(text).not.toMatch(/stay where you are/i);
      expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
    } finally {
      await app.close();
    }
  });
});

describe("asking to be pointed at a place is not a stay-put hold", () => {
  it("does not use the stay-put line when the actor asks to be pointed at the deep galleries", () => {
    const text = narrationFallback(FIGHTER_7, [], fallbackContext);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).not.toMatch(/stay where you are/i);
    expect(text).not.toMatch(/nothing has changed yet/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });
});

function provider(narrationText: string) {
  const dependencies: AdventureAgentDependencies = {
    complete: async (input): Promise<ProviderCompletionResult> => {
      if (input.tools?.some((tool) => tool.name === "submit_adventure_narration")) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "wound-hp-narration",
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
  return { dependencies };
}

type App = ReturnType<typeof buildApp>;
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
