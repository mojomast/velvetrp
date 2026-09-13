import { afterEach, describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
} from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2036-06-01T12:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => [
  id, CHARACTER_BUILDER_STANDARD_ARRAY[index],
])) as Record<string, number>;

type ApiResponse = { statusCode: number; body: string; json(): any };

async function api(app: { inject: (input: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => Promise<ApiResponse> },
  method: string, url: string, payload?: unknown, expectedStatus = method === "POST" ? 201 : 200): Promise<any> {
  const response = await app.inject({ method, url, headers: { "content-type": "application/json" }, payload });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expectedStatus);
  return response.json();
}

function narrationResult(text: string): ProviderCompletionResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "dm-narration", name: "submit_adventure_narration", arguments: JSON.stringify({ narration: text }) }],
    },
    usage: { promptTokens: 20, completionTokens: 18, totalTokens: 38 },
    model: { requestedModel: "two-player-test-dm", responseModel: "two-player-test-dm" },
  };
}

function streamEvents(body: string): Array<{ type: string; payload: any }> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) return [];
    const event = JSON.parse(data) as { type?: string; payload?: unknown };
    return [{ type: event.type ?? frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7) ?? "", payload: event.payload }];
  });
}

function definition(kind: string, definitionId: string) {
  const value = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === kind && entry.reference.definitionId === definitionId);
  if (!value) throw new Error(`missing SRD definition ${kind}:${definitionId}`);
  return value.reference;
}

describe("two-player DM gameplay API", () => {
  afterEach(() => {
    delete process.env.FEATURE_RPG_CAMPAIGN;
    delete process.env.FEATURE_RPG_MECHANICS;
  });

  it("hydrates a fresh SRD game and runs two natural player declarations through the DM", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";

    let planningCalls = 0;
    let narrationCalls = 0;
    const narrations = [
      "Rain ticks against the observatory dome as Mara's lantern catches a brass route marker. Noor recognizes the same symbol on the chart, pointing toward a sealed stair below.",
      "The two explorers compare the chart and the marker. A safe path opens toward the lower archive, but fresh dust across the threshold says something arrived there first.",
    ] as const;
    const adventureAgentDependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        if (input.tools?.some((tool) => tool.name === "submit_adventure_narration")) {
          return narrationResult(narrations[narrationCalls++] ?? "The observatory waits in the rain.");
        }
        planningCalls += 1;
        return {
          message: { role: "assistant", content: "The DM considers the declared action before narrating the committed scene." },
          usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
          model: { requestedModel: "two-player-test-dm", responseModel: "two-player-test-dm" },
        };
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "two-player-test-dm" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date(at),
    };
    const app = buildApp({
      campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(at) } }),
      adventureAgentDependencies,
    });

    try {
      await api(app, "POST", "/api/rpg/v1/content-packs", SRD_5_1_STARTER_CATALOG);
      const campaignResponse = await api(app, "POST", "/api/rpg/v1/campaigns", { name: "Rain Over the Observatory" });
      const campaignId = campaignResponse.campaign.id as string;
      const administration = await api(app, "GET", `/api/rpg/v1/campaigns/${campaignId}/administration`);
      await api(app, "PUT", `/api/rpg/v1/campaigns/${campaignId}/content`, {
        rulesProfileId: SRD_5_1_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
        contentPacks: [{ packId: SRD_5_1_STARTER_CATALOG.manifest.packId, packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion }],
        expectedRevision: administration.campaign.revision,
        idempotencyKey: "two-player-srd-content",
      });

      const mara = await api(app, "POST", "/api/characters", {
        name: "Mara", age: 31, archetype: "Dwarven pathfinder", boundaries: "Fictional deterministic test character.", fictionalConfirmed: true,
      });
      const noor = await api(app, "POST", "/api/characters", {
        name: "Noor", age: 28, archetype: "Elven archivist", boundaries: "Fictional deterministic test character.", fictionalConfirmed: true,
      });

      const finalize = async (personaId: string, name: string, race: string, classId: string, preparedSpells?: unknown[]) => {
        const created = await api(app, "POST", `/api/rpg/v1/campaigns/${campaignId}/character-drafts`, {
          personaId, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft`,
        });
        const selected = await api(app, "PATCH", `/api/rpg/v1/campaigns/${campaignId}/character-drafts/${created.draft.id}`, {
          expectedRevision: created.draft.revision,
          idempotencyKey: `${name}-selections`,
          selections: {
            race: definition("race", race),
            background: definition("background", "srd-5.1:background:acolyte"),
            class: definition("class", classId),
            starterGrant: "kit",
            ...(preparedSpells ? { preparedSpells } : {}),
          },
        });
        return api(app, "POST", `/api/rpg/v1/campaigns/${campaignId}/character-drafts/${created.draft.id}/finalize`, {
          expectedRevision: selected.draft.revision, idempotencyKey: `${name}-finalize`,
        }, 201);
      };

      const maraFinalized = await finalize(mara.id, "mara", "srd-5.1:race:dwarf", "srd-5.1:class:fighter");
      const preparedSpells = ["srd-5.1:spell:bless", "srd-5.1:spell:cure-wounds", "srd-5.1:spell:healing-word"]
        .map((spellId) => definition("spell", spellId));
      const noorFinalized = await finalize(noor.id, "noor", "srd-5.1:race:elf", "srd-5.1:class:cleric", preparedSpells);

      const room = await api(app, "POST", "/api/sessions", {
        characterIds: [mara.id, noor.id], primaryCharacterId: mara.id, title: "Rain Over the Observatory",
      });
      await api(app, "PUT", `/api/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: room.id });
      const opening = await api(app, "POST", `/api/sessions/${room.id}/room-turn`, {
        content: "The DM opens on rain, brass, and the sealed observatory stair.", maxSpeakers: 2,
      }, 200);
      expect(opening.session.state).toBe("active");

      const storylineId = "observatory-story";
      await api(app, "POST", `/api/rpg/v1/campaigns/${campaignId}/storylines`, {
        storyline: { storylineId, title: "The Observatory Door", summary: "A brass chart points beneath the dome.", nodes: [], edges: [], plotPoints: [], clues: [] },
        expectedRevision: 0, idempotencyKey: "observatory-storyline",
      });
      await api(app, "POST", `/api/rpg/v1/campaigns/${campaignId}/quests`, {
        quest: {
          questId: "observatory-quest", storylineId, title: "Find the sealed stair", description: "Follow the brass marker below the dome.",
          visibility: "public", journalText: "The rain has revealed a route beneath the observatory.", objectives: [{
            objectiveId: "sealed-stair", description: "Locate the sealed stair", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public",
          }], rewards: [],
        },
        expectedRevision: 0, idempotencyKey: "observatory-quest",
      });

      const playBootstrap = await api(app, "GET", `/api/rpg/v1/campaigns/${campaignId}/rooms/${room.id}/play-bootstrap`);
      expect(playBootstrap.playableActors).toHaveLength(2);
      const maraActor = playBootstrap.playableActors.find((actor: { name: string }) => actor.name === "Mara");
      const noorActor = playBootstrap.playableActors.find((actor: { name: string }) => actor.name === "Noor");
      if (!maraActor || !noorActor) throw new Error("hydrated player actors are unavailable");

      const maraSheet = await api(app, "GET", `/api/rpg/v1/actors/${maraActor.actorId}/gameplay-sheet`);
      const noorSheet = await api(app, "GET", `/api/rpg/v1/actors/${noorActor.actorId}/gameplay-sheet`);
      expect(maraSheet.identity.name).toBe("Mara");
      expect(maraSheet.race.label).toBe("Dwarf");
      expect(maraSheet.derived.speed).toBe(25);
      expect(noorSheet.identity.name).toBe("Noor");
      expect(noorSheet.race.label).toBe("Elf");
      expect(noorSheet.knownPowers.some((power: { label: string }) => power.label === "Healing Word")).toBe(true);

      const tacticalMap = await api(app, "POST", `/api/rpg/v1/campaigns/${campaignId}/rooms/${room.id}/tactical-maps`, {
        mode: "exploration", encounterId: null, kind: "arena", seed: "observatory-rain", width: 10, height: 8,
        tokens: [
          { tokenId: maraActor.actorId, actorId: maraActor.actorId, combatantId: null, label: "Mara", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false },
          { tokenId: noorActor.actorId, actorId: noorActor.actorId, combatantId: null, label: "Noor", position: { x: 2, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false },
        ],
        idempotencyKey: "observatory-map",
      }, 200);
      expect(tacticalMap.projection.tokens).toHaveLength(2);

      const play = async (actorId: string, declaration: string, idempotencyKey: string, expectedNarration: string) => {
        const currentAdministration = await api(app, "GET", `/api/rpg/v1/campaigns/${campaignId}/administration`);
        const response = await app.inject({
          method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" },
          payload: { campaignId, sessionId: room.id, actorId, declaration, expectedRevision: currentAdministration.campaign.revision, idempotencyKey },
        });
        expect(response.statusCode, response.body).toBe(200);
        const events = streamEvents(response.body);
        expect(events.some((event) => event.type === "narration_delta" && event.payload.text === expectedNarration)).toBe(true);
        expect(events.at(-1)?.type).toBe("terminal");
      };

      await play(maraActor.actorId, "I raise my lantern and study the brass route marker beneath the observatory dome.", "mara-opening", narrations[0]);
      await play(noorActor.actorId, "I compare the marker with the chart and check whether the sealed stair is safe for both of us.", "noor-opening", narrations[1]);
      expect(planningCalls).toBe(2);
      expect(narrationCalls).toBe(2);

      const transcript = await api(app, "GET", `/api/rpg/v1/adventure-turns/transcript?campaignId=${campaignId}&sessionId=${room.id}`);
      expect(transcript.turns).toHaveLength(2);
      expect(transcript.turns.map((turn: { actorId: string }) => turn.actorId)).toEqual([maraActor.actorId, noorActor.actorId]);
      expect(transcript.turns.map((turn: { narration: string }) => turn.narration)).toEqual(narrations);
      expect(maraFinalized.character.id).toEqual(expect.any(String));
      expect(noorFinalized.character.id).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });
});
