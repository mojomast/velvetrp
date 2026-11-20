// Approved test (playtest kink #2): a client that disconnects while the turn is still planning must
// not strand the durable turn. Seen live: aborting the stream ~1.5s in (during planning) left the turn
// "declared" with no narration for 90s+; only re-sending the same idempotency key recovered it.
// docs/api.md: "Delivery disconnect does not roll back or cancel deterministic durable orchestration".
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { DND_5E_RULESET_DESCRIPTOR, VELVET_LEGACY_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

function seed(ruleset: "velvet" | "dnd" = "velvet") {
  const initial = createRepository();
  const campaign = initial.createCampaign("local-owner", { name: "HTTP turns" });
  initial.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare(
    "INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')",
  ).run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  const rulesetId = ruleset === "dnd" ? DND_5E_RULESET_DESCRIPTOR.id : VELVET_LEGACY_RULESET_DESCRIPTOR.id;
  const rulesetVersion =
    ruleset === "dnd" ? DND_5E_RULESET_DESCRIPTOR.version : VELVET_LEGACY_RULESET_DESCRIPTOR.version;
  db.prepare("INSERT INTO rpg_rules_profile_bindings_v60 VALUES ('turn-profile',?,?)").run(rulesetId, rulesetVersion);
  db.prepare(
    "INSERT INTO campaign_ruleset_bindings_v60(campaign_id,rules_profile_id,ruleset_id,ruleset_version,bound_at) VALUES(?,'turn-profile',?,?,?)",
  ).run(campaign.id, rulesetId, rulesetVersion, at);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare(
    "INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)",
  ).run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(
    campaign.id,
    at,
    at,
  );
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare(
    "INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)",
  ).run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.close();
  return campaign;
}

/** Places the seeded actor at a discovered public location so narration has a current-location anchor. */
function locateActor(campaignId: string, locationName: string) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('quay',?,NULL,?,'A fog-damp landing.','public',?)").run(
    campaignId,
    locationName,
    at,
  );
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'quay','session',0,?)").run(campaignId, "actor", at);
  db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(campaignId, "actor", "quay", at);
  db.close();
}

const NARRATION = "The keeper looks up from the lantern and answers you plainly.";

/** A provider whose first (planning) call blocks until released; it honours the abort signal like a real HTTP call. */
function gatedProvider() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let planningStarted!: () => void;
  const started = new Promise<void>((resolve) => (planningStarted = resolve));
  let gated = false;
  const dependencies: AdventureAgentDependencies = {
    complete: async (input): Promise<ProviderCompletionResult> => {
      const narration = input.tools?.some((tool) => tool.name === "submit_adventure_narration");
      if (!narration && !gated) {
        gated = true;
        planningStarted();
        await new Promise<void>((resolve, reject) => {
          void released.then(resolve);
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("aborted")), {
            once: true,
          });
          if (input.signal?.aborted) reject(input.signal.reason ?? new Error("aborted"));
        });
      }
      if (narration)
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "n", name: "submit_adventure_narration", arguments: JSON.stringify({ narration: NARRATION }) },
            ],
          },
          usage: null,
          model: { requestedModel: "test", responseModel: "test" },
        };
      return {
        message: { role: "assistant", content: "complete", toolCalls: [] },
        usage: null,
        model: { requestedModel: "test", responseModel: "test" },
      };
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  return { dependencies, started, release };
}

describe("client disconnect during planning", () => {
  it("still settles the durable turn without the client re-sending it", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const campaign = seed();
    locateActor(campaign.id, "Lantern Quay");
    const gate = gatedProvider();
    const app = buildApp({
      campaignRepositoryFactory: () => createRepository(),
      adventureAgentDependencies: gate.dependencies,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const controller = new AbortController();
      const response = await fetch(`${origin}/api/rpg/v1/adventure-turns/stream`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          campaignId: campaign.id,
          sessionId: "session",
          actorId: "actor",
          declaration: "I search the crates along the quay for anything hidden.",
          expectedRevision: 0,
          idempotencyKey: "disconnect-during-planning",
        }),
      });
      expect(response.status).toBe(200);
      const turnId = response.headers.get("x-adventure-turn-id");
      expect(turnId).toBeTruthy();
      await Promise.race([
        gate.started,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("the turn never reached a planning call")), 10_000),
        ),
      ]);
      // The player closes the tab while the DM is still planning.
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
      gate.release();

      let state = "";
      let narration = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const turn = (await (await fetch(`${origin}/api/rpg/v1/adventure-turns/${turnId}`)).json()) as {
          turn: { state: string };
          narrationStatus: { status: string };
        };
        state = turn.turn.state;
        narration = turn.narrationStatus.status;
        if (state === "completed" || state === "failed" || state === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toBe("completed");
      expect(narration).toBe("completed");

      const transcript = (await (
        await fetch(`${origin}/api/rpg/v1/adventure-turns/transcript?campaignId=${campaign.id}&sessionId=session`)
      ).json()) as { turns: Array<{ turnId: string }> };
      expect(transcript.turns.map((entry) => entry.turnId)).toContain(turnId);
    } finally {
      await app.close();
    }
  });
});
