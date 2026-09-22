import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectAttackTarget, ATTACK_VERBS } from "../src/agent/attackIntent.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionInput } from "../src/provider/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const AT = "2036-01-01T00:00:00.000Z";
const CULTIST = "srd-5.1:enemy-template:cultist";

const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const base = await dmFixture(true);
  let npcRevision = 0;
  const createNpc = (name: string, description: string, key: string) => {
    const persona = base.repo.createCharacter({ name, age: 40, archetype: "Commoner", boundaries: "", fictionalConfirmed: true });
    return base.repo.createCampaignNpc(OWNER, base.campaign.id, {
      personaId: persona.id,
      publicState: { name, description },
      privateState: { goals: "", gmNotes: "", merchantState: null },
      expectedRevision: npcRevision++,
      idempotencyKey: key,
    }).npc;
  };
  const hob = createNpc("Old Hob", "The village ferryman who tends the crossing.", "attack-npc-hob");
  const watch = createNpc("Gate Watch", "A loyal guard at the east gate.", "attack-npc-watch");
  const turnAs = (principalId: string, declaration: string, key: string) => base.repo.createAdventureTurn(principalId, {
    campaignId: base.campaign.id, timelineId: base.campaign.activeTimelineId, sessionId: base.session.id,
    actorId: base.actorId, declaration,
    expectedCampaignRevision: base.repo.getCampaignAdministration(OWNER, base.campaign.id)!.revision,
    idempotencyKey: key,
  });
  return { ...base, hob, watch, turn: (declaration: string, key: string) => turnAs(OWNER, declaration, key), turnAs };
}

function deps(f: Fixture, complete: AdventureAgentDependencies["complete"]): AdventureAgentDependencies {
  return { complete, getProvider: async () => ({ ...defaultProviderSettings(), model: "attack-fixture" }),
    getHarness: async () => defaultHarnessSettings(), now: f.options.clock.now };
}

/** Records every planning dispatch and answers with a plain completed decision (no tool calls). */
function recorder() {
  const calls: ProviderCompletionInput[] = [];
  const complete: AdventureAgentDependencies["complete"] = async (input) => {
    calls.push(input);
    return { message: { role: "assistant", content: "Private planning prose is discarded.", toolCalls: [] },
      usage: null, model: { requestedModel: "attack-fixture", responseModel: "attack-fixture" } };
  };
  return { calls, complete };
}

describe("detectAttackTarget", () => {
  const candidates = [
    { kind: "npc" as const, id: "npc-hob", name: "Old Hob" },
    { kind: "npc" as const, id: "npc-ferryman", name: "Ferryman" },
    { kind: "actor" as const, id: "actor-bram", name: "Bram the Bold" },
  ];

  it("keeps the violent verb vocabulary in one exported constant", () => {
    expect(ATTACK_VERBS).toEqual([
      "attack", "hit", "strike", "stab", "swing at", "slash", "shoot", "kill", "fight",
      "draw on", "charge", "punch", "kick", "throw at",
    ]);
    expect(Object.isFrozen(ATTACK_VERBS)).toBe(true);
  });

  it.each([
    ["I attack Old Hob with my sword.", "npc-hob"],
    ["I hit Hob.", "npc-hob"],
    ["she attacks Old Hob", "npc-hob"],
    ["I am attacking Old Hob", "npc-hob"],
    ["I stab Hob's boat", "npc-hob"],
    ["I swing at Old Hob", "npc-hob"],
    ["I throw at Hob", "npc-hob"],
    ["I shoot the ferryman", "npc-ferryman"],
    ["I attack Bram", "actor-bram"],
    ["I fight Bram the Bold", "actor-bram"],
  ])("matches an attack declaration %s", (declaration, expectedId) => {
    expect(detectAttackTarget(declaration, candidates)?.id).toBe(expectedId);
  });

  it.each([
    ["I greet Old Hob.", "no violent verb"],
    ["Tell me about Old Hob.", "no violent verb"],
    ["I attack the watchman.", "role-only reference is not a public name"],
    ["I attack the dragon.", "unknown target"],
    ["I attack Hobgoblin.", "word-boundary safety"],
    ["I attack the Hobs.", "plural does not match a singular name token"],
    ["", "empty declaration"],
    ["I attack.", "no named target"],
  ])("returns null for %s (%s)", (declaration) => {
    expect(detectAttackTarget(declaration, candidates)).toBeNull();
  });

  it("returns null when no candidate list is supplied", () => {
    expect(detectAttackTarget("I attack Old Hob", [])).toBeNull();
  });

  it("prefers the most specific full name and refuses unresolved name collisions", () => {
    const nested = [
      { kind: "npc" as const, id: "npc-hob", name: "Hob" },
      { kind: "npc" as const, id: "npc-old-hob", name: "Old Hob" },
    ];
    expect(detectAttackTarget("I attack Old Hob", nested)?.id).toBe("npc-old-hob");
    expect(detectAttackTarget("I attack Hob", nested)?.id).toBe("npc-hob");
    const colliding = [
      { kind: "npc" as const, id: "npc-hob-corr", name: "Hob Corr" },
      { kind: "npc" as const, id: "npc-hob-vale", name: "Hob Vale" },
    ];
    expect(detectAttackTarget("I attack Hob", colliding)).toBeNull();
    expect(detectAttackTarget("I attack Hob Corr", colliding)?.id).toBe("npc-hob-corr");
  });
});

describe("player attack declarations initiate real combat", () => {
  it("materializes and starts a fixture NPC encounter with the resolved template and tactical map", async () => {
    const f = await fixture();
    try {
      const created = f.turn("I attack Old Hob with my longsword.", "attack-create");
      const dispatch = recorder();
      const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, dispatch.complete));

      expect(result.outcome, JSON.stringify(result.turn)).toBe("completed");
      expect(dispatch.calls).toHaveLength(1);
      // The rest of the turn already sees the active encounter and its legal combat actions.
      expect(dispatch.calls[0]!.tools?.map((tool) => tool.name)).toContain("combat_action.execute");

      const db = database();
      try {
        const encounters = db.prepare("SELECT encounter_id,status FROM encounter WHERE campaign_id=?").all(f.campaign.id) as
          Array<{ encounter_id: string; status: string }>;
        expect(encounters).toHaveLength(1);
        expect(encounters[0]!.status).toBe("active");
        expect(db.prepare("SELECT pack_id,pack_version,definition_id FROM encounter_enemy_provenance_v31 WHERE encounter_id=?")
          .get(encounters[0]!.encounter_id)).toEqual({
            pack_id: SRD_5_1_STARTER_CATALOG.manifest.packId,
            pack_version: SRD_5_1_STARTER_CATALOG.manifest.packVersion,
            definition_id: CULTIST,
          });
        const map = db.prepare("SELECT map_id,mode,active FROM tactical_maps_v58 WHERE encounter_id=?")
          .get(encounters[0]!.encounter_id) as { map_id: string; mode: string; active: number } | undefined;
        expect(map).toMatchObject({ mode: "combat", active: 1 });
        const tokens = db.prepare("SELECT disposition,label FROM tactical_map_tokens_v58 WHERE map_id=? ORDER BY token_id")
          .all(map!.map_id) as Array<{ disposition: string; label: string }>;
        expect(tokens).toHaveLength(2);
        expect(tokens.some((token) => token.disposition === "friendly")).toBe(true);
        expect(tokens.some((token) => token.disposition === "hostile")).toBe(true);
      } finally { db.close(); }

      const candidates = f.repo.listCombatInitiationCandidates(OWNER, f.campaign.id, f.session.id, f.actorId);
      expect(candidates).toContainEqual({ kind: "npc", id: f.hob.npcId, name: "Old Hob" });
      expect(candidates.some((candidate) => candidate.kind === "actor" && candidate.id === f.actorId)).toBe(false);
    } finally { f.repo.close(); }
  });

  it.each([
    ["I greet Old Hob politely.", "attack-no-verb"],
    ["I attack the unseen dragon.", "attack-unknown-target"],
  ])("leaves no encounter for %s", async (declaration, key) => {
    const f = await fixture();
    try {
      const created = f.turn(declaration, key);
      const dispatch = recorder();
      const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, dispatch.complete));

      expect(result.outcome).toBe("completed");
      expect(dispatch.calls).toHaveLength(1);
      const db = database();
      try {
        expect(db.prepare("SELECT count(*) count FROM encounter WHERE campaign_id=?").get(f.campaign.id)).toEqual({ count: 0 });
      } finally { db.close(); }
    } finally { f.repo.close(); }
  });

  it("never materializes a second encounter while one is already active", async () => {
    const f = await fixture();
    try {
      const prepared = f.prepare();
      f.repo.startEncounter(OWNER, prepared.encounterId, { expectedRevision: prepared.revision, idempotencyKey: "attack-active-start" });
      const created = f.turn("I attack Gate Watch.", "attack-active");
      const dispatch = recorder();
      const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, dispatch.complete));

      expect(result.outcome).toBe("completed");
      const db = database();
      try {
        expect(db.prepare("SELECT count(*) count FROM encounter WHERE campaign_id=?").get(f.campaign.id)).toEqual({ count: 1 });
        expect(db.prepare(`SELECT provenance.definition_id definition_id FROM encounter_enemy_provenance_v31 provenance
          WHERE provenance.campaign_id=?`).get(f.campaign.id)).toEqual({ definition_id: f.enemy.definitionId });
      } finally { db.close(); }
    } finally { f.repo.close(); }
  });

  it("does not initiate combat from an observer turn", async () => {
    const f = await fixture();
    try {
      const player = "attack-observer-principal";
      const db = database();
      db.pragma("foreign_keys=ON");
      db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(player, player);
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
        .run(f.campaign.id, player, "player", AT);
      db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE campaign_id=? AND actor_id=?")
        .run(player, f.campaign.id, f.actorId);
      db.close();

      const created = f.turnAs(player, "I attack Old Hob with my sword.", "attack-observer-turn");
      // The turn creator becomes an observer and no longer controls the actor. Both facts are
      // changed directly so the campaign administration revision (and the turn's context
      // ancestry) stays intact while the service's own authorization still rejects initiation.
      const demote = database();
      demote.prepare("UPDATE campaign_memberships SET role='observer' WHERE campaign_id=? AND principal_id=?")
        .run(f.campaign.id, player);
      demote.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE campaign_id=? AND actor_id=?")
        .run(OWNER, f.campaign.id, f.actorId);
      demote.close();

      const dispatch = recorder();
      const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(f, dispatch.complete));

      expect(result.outcome).toBe("completed");
      expect(dispatch.calls).toHaveLength(1);
      const after = database();
      try {
        expect(after.prepare("SELECT count(*) count FROM encounter WHERE campaign_id=?").get(f.campaign.id)).toEqual({ count: 0 });
      } finally { after.close(); }
    } finally { f.repo.close(); }
  });
});
