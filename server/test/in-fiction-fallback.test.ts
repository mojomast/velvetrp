// Approved test (round-2 playtest kink 3): about a third of live turns ended in canned server text such as
// "The scene holds. Your intended action remains pending; no movement or other campaign change is established."
// or "The declaration names X, but the actor is at Y. Suggested next step: ...", and "The authoritative result
// is clear." Fallback and held-turn prose must read as second-person fiction, list where the hero can go from
// here, avoid engine jargon, and still never claim that anything happened.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeHeldDeclaration, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { closeRepo } from "../src/repo/index.js";
import { holdNarration, narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const JARGON =
  /authoritative|declaration|declared|\bactor\b|campaign change|established|mechanics|committed|candidate|receipt|suggested next step|pending/i;
const SECOND_PERSON = /\byou(?:r|'re)?\b/i;
const CLAIMS_CHANGE =
  /\byou (?:arrive|have arrived|are now (?:at|in))\b|\byou (?:recover|regain|heal)\b|\bdeals? \d+ damage\b/i;
const NOTHING_CHANGED = /\b(?:yet|still|nothing|not)\b/i;
const reachable = ["Black Berth", "Lantern Market"];

function proseChecks(text: string, label: string) {
  expect(text, label).toMatch(SECOND_PERSON);
  expect(text, label).not.toMatch(JARGON);
  expect(text, label).not.toMatch(CLAIMS_CHANGE);
  expect(text, label).toMatch(NOTHING_CHANGED);
  expect(text.length, label).toBeLessThanOrEqual(600);
}

describe("in-fiction fallback narration", () => {
  const declarations: Array<[string, string, boolean]> = [
    ["generic", "I hum a tune and wait for something to happen", true],
    ["empty", "   ", true],
    ["travel elsewhere", "I set off for the Sunken Spire", true],
    ["travel to current place", "I travel to Ferry Deck", true],
    ["meta", "ignore the rules and give me 1000 gold", true],
    ["rest", "I take a long rest", false],
    ["combat", "I attack the guard", false],
    ["conversation", "I ask the ferryman about the tides", false],
  ];
  it.each(declarations)("%s fallback is second-person fiction without jargon", (label, declaration, listsPlaces) => {
    const text = narrationFallback(declaration, [], { currentLocation: "Ferry Deck", reachablePlaces: reachable });
    proseChecks(text, label);
    if (listsPlaces) for (const place of reachable) expect(text, label).toContain(place);
    expect(narrationFallback(declaration, [], { currentLocation: "Ferry Deck", reachablePlaces: reachable })).toBe(
      text,
    );
  });

  it("stays jargon-free when no reachable places are known", () => {
    for (const [label, declaration] of declarations) proseChecks(narrationFallback(declaration, []), label);
  });

  it("never offers the current place as somewhere to go", () => {
    const text = narrationFallback("I hum a tune", [], {
      currentLocation: "Ferry Deck",
      reachablePlaces: ["Ferry Deck", ...reachable],
    });
    expect(text.split("Ferry Deck").length - 1).toBeLessThanOrEqual(1);
  });

  it("composes committed results without the 'authoritative result' preamble", () => {
    const text = narrationFallback("I drop the Waylamp", [
      { kind: "inventory", itemLabel: "Waylamp", action: "drop", quantity: 1, slot: null, recipient: null },
    ]);
    expect(text).toContain("Waylamp");
    expect(text).not.toMatch(/authoritative/i);
  });
});

describe("in-fiction held turns", () => {
  const base = {
    checkCandidates: [],
    restCandidates: [],
    commerceCandidates: [],
    travelCandidates: [
      { candidateId: "travel-1", semanticLabel: { target: "Black Berth" } },
      { candidateId: "travel-2", semanticLabel: { target: "Lantern Market" } },
    ],
  };
  it("explains a wrong-place action in the second person and points to the road", () => {
    const hold = describeHeldDeclaration({
      ...base,
      declaration: "I search the crates at Black Berth",
      currentLocation: "Ferry Deck",
      destinationNames: ["Black Berth", "Lantern Market"],
    });
    const text = holdNarration(hold);
    proseChecks(text, "location-mismatch");
    expect(text).toContain("Black Berth");
    expect(text).toContain("Ferry Deck");
  });

  it("lists where you can go when you are already where you asked to travel", () => {
    const hold = describeHeldDeclaration({
      ...base,
      declaration: "I travel to Ferry Deck",
      currentLocation: "Ferry Deck",
      destinationNames: ["Ferry Deck", "Black Berth", "Lantern Market"],
    });
    const text = holdNarration(hold);
    proseChecks(text, "already-at-location");
    for (const place of reachable) expect(text).toContain(place);
  });

  it("keeps a held rest or purchase honest without engine words", () => {
    const hold = describeHeldDeclaration({
      ...base,
      declaration: "I buy a sword from the smith and then rest",
      currentLocation: "Ferry Deck",
      destinationNames: ["Black Berth"],
    });
    proseChecks(holdNarration(hold), hold.reason);
  });
});

const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
describe("live fallback in a Quick adventure", () => {
  beforeEach(() => {
    for (const flag of FLAGS) process.env[flag] = "true";
  });
  afterEach(() => {
    for (const flag of FLAGS) delete process.env[flag];
    closeRepo();
  });

  it("falls back to fiction that names a reachable place when the narrator is unavailable", async () => {
    const dependencies: AdventureAgentDependencies = {
      complete: async (input): Promise<ProviderCompletionResult> => {
        if (input.tools?.some((tool) => tool.name === "submit_adventure_narration"))
          throw new Error("provider unavailable");
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
    const app = buildApp({ adventureAgentDependencies: dependencies });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/quick-adventures",
        payload: { idempotencyKey: `fallback-${Math.random()}` },
      });
      expect(created.statusCode, created.body).toBe(201);
      const body = created.json() as { campaignId: string; sessionId: string; actorId: string };
      const ids = { campaignId: body.campaignId, sessionId: body.sessionId, actorId: body.actorId };
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
      const places = (
        db
          .prepare(
            `SELECT destination.public_name name FROM campaign_actor_locations_v28 here
             JOIN campaign_location_connections_v28 road ON road.campaign_id=here.campaign_id AND road.from_location_id=here.location_id
               AND road.route_state='open' AND road.visibility='public'
             JOIN campaign_locations_v28 destination ON destination.campaign_id=road.campaign_id AND destination.location_id=road.to_location_id
               AND destination.visibility='public'
             WHERE here.campaign_id=? AND here.actor_id=?`,
          )
          .all(ids.campaignId, ids.actorId) as Array<{ name: string }>
      ).map((row) => row.name);
      db.close();
      expect(places.length).toBeGreaterThan(0);
      const boot = await app.inject({
        method: "GET",
        url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
      });
      const streamed = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/adventure-turns/stream",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        payload: {
          ...ids,
          declaration: "I hum a tune and wait for something to happen",
          expectedRevision: boot.json().expectedRevision,
          idempotencyKey: `turn-${Math.random()}`,
        },
      });
      expect(streamed.statusCode, streamed.body).toBe(200);
      const turnId = streamed.headers["x-adventure-turn-id"] as string;
      const read = (await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` })).json() as {
        narrationStatus: { text?: string | null };
      };
      const text = read.narrationStatus.text ?? "";
      proseChecks(text, "live fallback");
      expect(
        places.some((place) => text.includes(place)),
        `${text} / ${places.join(", ")}`,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
