// Approved tests for round-8 change 1b (PLAN.md RC1): a clause that merely STARTS with "At"/"In"
// is not a claim about the current scene, and an honest "You are at N of M hit points." matching
// actor state is accepted by the accepting gate (as narrationGateFailure already does).
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, fakeProvider, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const HERE = "Slake-Head";
const actorState = (current: number, max: number) =>
  ({ health: { current, max }, inventory: [], quests: null, activeCombat: null }) as never;
const gate = (text: string, state: never | null = null) => providerNarrationMatchesReceipts(text, [], HERE, state);

describe("sentences that start with At/In are not location claims", () => {
  it("accepts scene-setting clauses that begin with a preposition", () => {
    expect(gate("At the gallery mouth the apron narrows and the crowd thickens.")).toBe(true);
    expect(gate('"In front of the wardens\' bench," he says.')).toBe(true);
    expect(gate("In the sliding white bands you can pick out the pale dust.")).toBe(true);
  });

  it("still rejects framing a different place as the present scene", () => {
    expect(gate("You stand in Kiln College.")).toBe(false);
    expect(gate("You arrive at The Long Reflectory.")).toBe(false);
    expect(gate("You are at The Steps, looking out over the street.")).toBe(false);
    expect(gate("You remain inside the Draughtwarden Hall.")).toBe(false);
  });

  it("still accepts the current location named in a presence clause", () => {
    expect(gate("You stand in Slake-Head, the bells still ringing.")).toBe(true);
  });
});

describe("honest hit-point statements", () => {
  it("accepts 'You are at 15 of 15 hit points.' when it matches actor state", () => {
    expect(gate("You are at 15 of 15 hit points.", actorState(15, 15))).toBe(true);
    expect(gate("You are at 15 of 15 hit points; the bruises are real but you're standing.", actorState(15, 15))).toBe(
      true,
    );
  });

  it("rejects a hit-point statement that does not match actor state", () => {
    expect(gate("You are at 15 of 15 hit points.", actorState(14, 15))).toBe(false);
  });

  it("an honest HP phrase does not hide a wrong place in the same text", () => {
    expect(gate("You are at 15 of 15 hit points. You stand in Kiln College.", actorState(15, 15))).toBe(false);
  });
});

describe("HP question over HTTP", () => {
  it("ends provider-accepted when the draft states the true HP", async () => {
    enableR8Flags();
    const fake = fakeProvider({
      narrate: () => "You are at 15 of 15 hit points; the bruises are real but you're standing.",
    });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      const turn = await playR8Turn(app, ids, "How hurt am I? Give me my health.");
      const status = turn.narrationStatus;
      expect(status.status).toBe("completed");
      expect(status.narrationOutcome).toBe("provider-accepted");
      expect(status.source).toBe("provider-assisted");
      expect(status.text ?? "").toContain("15 of 15 hit points");
    } finally {
      await app.close();
    }
  });
});
