// Approved test (round-2 playtest kink 4): Quick adventure heroes were boosted to 1000/1000 health while
// the prepared Ember Salamander Vigil enemy has 90 HP and resists their damage. Live: after 16 rounds the
// salamander was still at 19/90 and the party was untouched, so the fight could be neither won nor lost.
// Heroes need normal level-appropriate health and the prepared fight must end in a reasonable number of rounds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
  closeRepo();
});

type App = ReturnType<typeof buildApp>;
type Combatant = {
  combatantId: string;
  kind: string;
  team: string;
  status: string;
  hitPoints: number;
  maximumHitPoints: number;
};
type Combat = {
  round: number;
  currentCombatant: string;
  revision: number;
  combatants: Combatant[];
  legalActions?: Array<{ legalActionId: string; kind: string; targetIds?: string[] }>;
};

async function quick(app: App, key: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/rpg/v1/quick-adventures",
    payload: { idempotencyKey: key },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json() as { campaignId: string; sessionId: string; actorId: string };
}

const down = (c: Combatant) => c.status !== "active" || c.hitPoints <= 0;

/** Plays the prepared encounter with a plain policy: heroes attack the first standing enemy, then end turn. */
async function fight(app: App, campaignId: string): Promise<{ rounds: number; ended: boolean; final: Combatant[] }> {
  const encounter = (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaignId}/encounters` })).json()
    .encounters[0] as { encounterId: string; revision?: number };
  const started = await app.inject({
    method: "POST",
    url: `/api/rpg/v1/encounters/${encounter.encounterId}/start-commands`,
    payload: { expectedRevision: encounter.revision ?? 0, idempotencyKey: `start-${campaignId}` },
  });
  expect(started.statusCode, started.body).toBe(200);
  const combatId =
    (started.json().combat?.combatId as string | undefined) ??
    ((await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaignId}/encounters` })).json().encounters[0]
      .combatId as string);
  let step = 0;
  for (; step < 400; step += 1) {
    const combat = (await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${combatId}` })).json() as Combat;
    const enemies = combat.combatants.filter((c) => c.team === "enemies");
    const allies = combat.combatants.filter((c) => c.team === "allies");
    if (enemies.every(down) || allies.every(down))
      return { rounds: combat.round, ended: true, final: combat.combatants };
    if (combat.round > 12) return { rounds: combat.round, ended: false, final: combat.combatants };
    const current = combat.combatants.find((c) => c.combatantId === combat.currentCombatant);
    let response;
    if (current?.kind === "actor") {
      const actions = combat.legalActions ?? [];
      const attack = actions.find((a) => a.kind === "attack" && (a.targetIds?.length ?? 0) > 0);
      const end = actions.find((a) => a.kind === "end-turn");
      const chosen = attack ?? end;
      expect(chosen, JSON.stringify(actions.map((a) => a.kind))).toBeDefined();
      response = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/combats/${combatId}/action-commands`,
        payload: {
          legalActionId: chosen!.legalActionId,
          targetIds: chosen === attack ? attack!.targetIds!.slice(0, 1) : [],
          choices: [],
          expectedRevision: combat.revision,
          idempotencyKey: `act-${campaignId}-${step}`,
        },
      });
    } else {
      response = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/combats/${combatId}/enemy-turn-commands`,
        payload: { expectedRevision: combat.revision, idempotencyKey: `enemy-${campaignId}-${step}` },
      });
    }
    expect(response.statusCode, response.body).toBe(200);
  }
  throw new Error("combat loop did not settle");
}

describe("Quick adventure balance", () => {
  it("gives every hero normal level-appropriate health, not a 1000 boost", async () => {
    const app = buildApp();
    try {
      const ids = await quick(app, "balance-health");
      const boot = (
        await app.inject({
          method: "GET",
          url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
        })
      ).json() as { playableActors: Array<{ actorId: string; name: string }> };
      expect(boot.playableActors.length).toBeGreaterThanOrEqual(2);
      for (const actor of boot.playableActors) {
        const resources = (
          await app.inject({
            method: "GET",
            url: `/api/rpg/v1/campaigns/${ids.campaignId}/actors/${actor.actorId}/resources`,
          })
        ).json() as { resources: Array<{ name: string; current: number; max: number }> };
        const health = resources.resources.find((r) => r.name === "health");
        expect(health, actor.name).toBeDefined();
        expect(health!.max, `${actor.name} max health`).toBeGreaterThanOrEqual(10);
        expect(health!.max, `${actor.name} max health`).toBeLessThanOrEqual(60);
        expect(health!.current).toBe(health!.max);
      }
    } finally {
      await app.close();
    }
  });

  it("ends the prepared fight within ten rounds", async () => {
    const app = buildApp();
    try {
      for (let run = 0; run < 4; run += 1) {
        const ids = await quick(app, `balance-fight-${run}`);
        const result = await fight(app, ids.campaignId);
        expect(
          result.ended && result.rounds <= 10,
          `run ${run}: rounds=${result.rounds} ${result.final.map((c) => `${c.team}:${c.hitPoints}/${c.maximumHitPoints}:${c.status}`).join(" ")}`,
        ).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 240_000);
});
