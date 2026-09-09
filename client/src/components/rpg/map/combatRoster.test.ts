import { afterEach, describe, expect, it, vi } from "vitest";
import { readCombatRoster, reviewedSpawns, type SpawnReview } from "./combatRoster";

const actors = [
  { kind: "actor" as const, combatantId: "ally", actorId: "actor", team: "allies" as const },
  { kind: "enemy" as const, combatantId: "enemy", template: null, team: "enemies" as const },
];
const encounter = { encounterId: "encounter", combatId: "encounter", sessionId: "session", status: "active", name: "Ambush", revision: 2, combatants: actors, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
const combat = { round: 1, currentCombatant: "enemy", combatants: actors.map((entry) => ({ ...entry, hitPoints: 10, maximumHitPoints: 10, status: "active" })), legalActions: [], revision: 2 };
const cell: SpawnReview = { x: "2", y: "2", width: "1", height: "1", visibility: "visible", disposition: "friendly" };
const roster = { ...encounter, combatants: actors };
const review = { ally: cell, enemy: { ...cell, x: "4", visibility: "hidden" as const, disposition: "hostile" as const } };
afterEach(() => vi.unstubAllGlobals());

describe("authoritative combat roster", () => {
  it("reads the full roster independent of the current turn with abortable no-store GETs", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ encounters: [encounter] }))).mockResolvedValueOnce(new Response(JSON.stringify(combat))).mockResolvedValueOnce(new Response(JSON.stringify({ encounters: [encounter] })));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect((await readCombatRoster("campaign", "session", "encounter", signal)).combatants).toEqual(actors);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/rpg/v1/combats/encounter", { cache: "no-store", signal });
  });
  it.each(["transition", "duplicate-actor", "live-mismatch", "ambiguous"])("rejects %s without a partial roster", async (scenario) => {
    const first = scenario === "duplicate-actor" ? { ...encounter, combatants: [actors[0], { ...actors[0], combatantId: "other" }] } : encounter;
    const last = scenario === "transition" ? { ...first, revision: 3 } : first;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ encounters: scenario === "ambiguous" ? [first, { ...first, encounterId: "other" }] : [first] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(scenario === "live-mismatch" ? { ...combat, combatants: [combat.combatants[1]] } : scenario === "duplicate-actor" ? { ...combat, currentCombatant: "ally", combatants: first.combatants.map((entry) => ({ ...entry, hitPoints: 10, maximumHitPoints: 10, status: "active" })) } : combat)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ encounters: [last] })));
    vi.stubGlobal("fetch", fetcher);
    await expect(readCombatRoster("campaign", "session", "encounter", new AbortController().signal)).rejects.toThrow();
  });
});

describe("reviewed spawns", () => {
  it.each([{ x: "1" }, { y: "1" }, { x: "11", width: "2" }, { y: "9", height: "2" }])("reserves only interior footprints for grounded v2: %j", (boundary) => {
    expect(reviewedSpawns(roster, { ...review, ally: { ...cell, ...boundary } }, true)).toBeNull();
    expect(reviewedSpawns(roster, review, true)).toEqual(reviewedSpawns(roster, review));
  });
  it("preserves exact actor/enemy bindings and explicit hidden state for every combatant", () => {
    expect(reviewedSpawns(roster, review)).toEqual([
      expect.objectContaining({ tokenId: "ally", actorId: "actor", combatantId: "ally", hidden: false, position: { x: 1, y: 1 } }),
      expect.objectContaining({ tokenId: "enemy", actorId: null, combatantId: "enemy", hidden: true, disposition: "hostile" }),
    ]);
  });
  it.each<Record<string, SpawnReview>>([{}, { ally: cell }, { ...review, enemy: { ...review.enemy, visibility: "" as const } }, { ...review, enemy: { ...review.enemy, disposition: "" as const } }, { ...review, enemy: cell }, { ...review, ally: { ...cell, x: "12", width: "2" } }, { ...review, ally: { ...cell, x: "1.5" } }])("rejects incomplete, overlapping, or invalid review", (value) => {
    expect(reviewedSpawns(roster, value)).toBeNull();
  });
  it("rejects duplicate actors or combatant IDs", () => {
    expect(reviewedSpawns({ ...roster, combatants: [actors[0]!, actors[0]!] }, review)).toBeNull();
    expect(reviewedSpawns({ ...roster, combatants: [actors[0]!, { ...actors[0]!, combatantId: "enemy" }] }, review)).toBeNull();
  });
});
