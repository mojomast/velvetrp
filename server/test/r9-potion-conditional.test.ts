// Approved tests for the round-9 conditional potion fix: a clear drink declaration with a trailing
// "if I have one" style condition on holding the item still names the held healing potion, while
// real negations and other conditions are still rejected. Round-9 replay showed "I drink a healing
// potion if I have one." never proposed a consume because the declaration-attempt guard rejects "if".
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { selectHeldHealingPotionConsumeCandidate } from "../src/agent/adventureOrchestrator.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, fakeProvider, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const rows = [
  { action: "gift", itemLabel: "Potion of Greater Healing" },
  { action: "consume", itemLabel: "Potion of Greater Healing" },
  { action: "consume", itemLabel: "Rations (1 day)" },
];
const pick = (declaration: string) => selectHeldHealingPotionConsumeCandidate(declaration, rows);

describe("conditional potion wording", () => {
  it.each([
    "I drink a healing potion if I have one.",
    "I drink a healing potion if I have one",
    "I drink a healing potion, if I have one.",
    "I drink a healing potion if any.",
    "I drink a healing potion if I have it.",
    "I drink a healing potion if I've got one.",
    "I drink a healing potion if I\u2019ve got one.",
    "I quaff a potion if I have any.",
    "I drink a healing potion if there is one.",
  ])("accepts %s", (declaration) => {
    expect(pick(declaration)).toEqual(rows[1]);
  });

  it.each([
    "I don't drink a healing potion if I have one.",
    "I do not drink a healing potion if I have one.",
    "I never drink a healing potion if I have one.",
    "I won't drink a healing potion if I have one.",
    "I would drink a healing potion if I had one.",
    "If I have one, I drink a healing potion.",
    "I drink a healing potion if the cleric agrees.",
    "I drink a healing potion if I have one, but not yet.",
    "Do I drink a healing potion if I have one?",
    'I drink a healing potion if I have one and then say "thanks".',
  ])("still rejects %s", (declaration) => {
    expect(pick(declaration)).toBeNull();
  });

  it("keeps the plain declarations working", () => {
    expect(pick("I drink a healing potion.")).toEqual(rows[1]);
    expect(pick("I eat the rations.")).toBeNull();
  });

  it("proposes the consume over HTTP when the planner holds on the conditional declaration", async () => {
    enableR8Flags();
    const fake = fakeProvider({ narrate: () => "You tip the vial back." });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    const ids = await startQuickAdventure(app);
    const boot = await app.inject({
      method: "GET",
      url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
    });
    const streamed = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      payload: {
        campaignId: ids.campaignId,
        sessionId: ids.sessionId,
        actorId: ids.actorId,
        declaration: "I drink a healing potion if I have one.",
        expectedRevision: boot.json().expectedRevision,
        idempotencyKey: `r9-cond-${Math.random()}`,
      },
    });
    expect(streamed.statusCode, streamed.body.slice(0, 800)).toBe(200);
    expect(streamed.body).toContain("confirmation_required");
    expect(streamed.body).toContain("inventory_item_consume");
  });
});
