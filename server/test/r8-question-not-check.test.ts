// Approved tests for round-8 change 4 (PLAN.md RC4): a plain question to a present NPC is
// conversation, not a skill check. 34 of 74 r5-r7 checks were on speech/question declarations
// (e.g. "ask the seller, quietly, whether..." became Persuasion). The planner LLM proposes the
// check, so the server must refuse a social check proposal for a question declaration and narrate
// on the conversation lane. A declaration that really tries to change someone's mind still rolls.
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, fakeProvider, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const ANSWER = '"Dead glass? Folk have been buying it by the crate," the seller murmurs, glancing at the road.';

async function run(declaration: string, pickSkill: string) {
  enableR8Flags();
  const fake = fakeProvider({ pickSkill, narrate: () => ANSWER });
  const app = buildApp({ adventureAgentDependencies: fake.dependencies });
  try {
    const ids = await startQuickAdventure(app);
    const turn = await playR8Turn(app, ids, declaration);
    return { turn, fake };
  } finally {
    await app.close();
  }
}

describe("questions are conversation, not checks", () => {
  it("refuses a Persuasion check proposed for a plain question and keeps the NPC's answer", async () => {
    const { turn, fake } = await run(
      "I ask the seller, quietly, whether anyone's been buying up dead glass.",
      "Persuasion",
    );
    expect(turn.turn.state).toBe("completed");
    expect(turn.receipts).toHaveLength(0);
    expect(fake.log.narrationFacts.every((facts) => facts.outcome === null)).toBe(true);
    const status = turn.narrationStatus;
    expect(status.source).toBe("provider-assisted");
    expect(status.text ?? "").toContain("buying it by the crate");
    expect(status.text ?? "").not.toMatch(/Persuasion check/);
  });

  it("refuses a Persuasion check proposed for a second plain question", async () => {
    const { turn, fake } = await run(
      "Tell me, what do you know about the Throttle? I ask the bell-keeper politely.",
      "Persuasion",
    );
    expect(turn.receipts).toHaveLength(0);
    expect(fake.log.narrationFacts.every((facts) => facts.outcome === null)).toBe(true);
    expect(turn.narrationStatus.text ?? "").not.toMatch(/Persuasion check/);
  });

  it("still rolls when the player tries to persuade someone", async () => {
    const { turn, fake } = await run("I try to persuade the bell-keeper to ring the bell. Persuasion.", "Persuasion");
    expect(turn.receipts).toHaveLength(1);
    expect(fake.log.narrationFacts.some((facts) => facts.skill === "Persuasion" && facts.outcome !== null)).toBe(true);
    expect(turn.narrationStatus.text ?? "").toMatch(/Persuasion/);
  });
});
