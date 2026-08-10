import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_RACE,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assembleCampaignAgentContext,
  CAMPAIGN_COMPANION_CONTEXT_SUPPORTED,
  type CampaignAgentContextSnapshot,
} from "../src/context.js";
import { createRepository, createSession, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
  .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;

async function roleFixture() {
  let id = 0;
  const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `context-${++id}` } });
  const campaign = repo.createCampaign("local-owner", { name: "Context" });
  repo.installOriginalStarterContent("local-owner", campaign.id);
  repo.configureOriginalStarterContent("local-owner", campaign.id);
  const createActor = (name: string) => {
    const persona = repo.createCharacter({ name, age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const actorId = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id,
      characterId: persona.id, controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference,
      background: ORIGINAL_STARTER_BACKGROUND.reference, classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
      attributes: [], proficiencies: [], choices: [] }).projection.actor.id;
    return { persona, actorId };
  };
  const playerActor = createActor("Aster");
  const unrelatedActor = createActor("Bex");
  const session = await createSession({ characterId: playerActor.persona.id, title: "Context room" });
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
  repo.updateSessionContextSource(session.id, "HUMAN_CANON_SAFE");
  const npcPersona = repo.createCharacter({ name: "Marrow persona", age: 40, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
  const npc = repo.createCampaignNpc("local-owner", campaign.id, { personaId: npcPersona.id, publicState: { name: "Marrow" },
    privateState: { goals: "NPC_TARGET_GOAL", gmNotes: "NPC_TARGET_GM_NOTE", merchantState: null },
    expectedRevision: 0, idempotencyKey: "npc" }).npc;
  const unrelatedNpcPersona = repo.createCharacter({ name: "Other persona", age: 41, archetype: "Spy", boundaries: "", fictionalConfirmed: true });
  repo.createCampaignNpc("local-owner", campaign.id, { personaId: unrelatedNpcPersona.id, publicState: { name: "Other" },
    privateState: { goals: "UNRELATED_NPC_GOAL", gmNotes: "UNRELATED_NPC_GM_NOTE", merchantState: null },
    expectedRevision: 1, idempotencyKey: "other-npc" });
  repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "public-place", name: "PUBLIC_LOCATION", visibility: "public" });
  repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "gm-place", name: "GM_ONLY_LOCATION", visibility: "hidden" });
  repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "hidden-route",
    fromLocationId: "public-place", toLocationId: "gm-place", visibility: "hidden", routeState: "open" });
  repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "story", title: "STORY_GRAPH_SENTINEL",
    summary: "STORY_SUMMARY_SENTINEL", nodes: [{ nodeId: "node", title: "Node", description: null,
      gmNotes: "STORY_GM_NOTE", revealThreshold: 0 }], edges: [], plotPoints: [], clues: [] },
    expectedRevision: 0, idempotencyKey: "story" });
  repo.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "public-quest", storylineId: "story",
    title: "PUBLIC_QUEST", description: "PUBLIC_QUEST_TEXT", visibility: "public", journalText: "Public",
    objectives: [{ objectiveId: "public-objective", description: "Public objective", targetProgress: 1,
      dependencyObjectiveIds: [], visibility: "public" }], rewards: [] }, expectedRevision: 0, idempotencyKey: "public-quest" });
  repo.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "gm-quest", storylineId: "story",
    title: "GM_ONLY_QUEST", description: "GM_QUEST_SECRET", visibility: "gm", journalText: "Secret",
    objectives: [{ objectiveId: "gm-objective", description: "Secret objective", targetProgress: 1,
      dependencyObjectiveIds: [], visibility: "gm" }], rewards: [] }, expectedRevision: 1, idempotencyKey: "gm-quest" });

  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  for (const [principal, role] of [["gm", "gm"], ["player", "player"], ["other-player", "player"], ["observer", "observer"]] as const) {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal, principal);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run(campaign.id, principal, role, at);
  }
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='player',private_notes='PLAYER_TARGET_SECRET' WHERE actor_id=?")
    .run(playerActor.actorId);
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player',private_notes='OTHER_PLAYER_SECRET' WHERE actor_id=?")
    .run(unrelatedActor.actorId);
  db.prepare("INSERT INTO session_characters(session_id,character_id,position) VALUES(?,?,1)").run(session.id, unrelatedActor.persona.id);
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)")
    .run(campaign.id, playerActor.actorId, "public-place", session.id, at);
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)")
    .run(campaign.id, unrelatedActor.actorId, "gm-place", session.id, at);
  db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("unattested", "story", campaign.id,
    "UNATTESTED_QUEST", "UNATTESTED_SECRET", "open", 2, at, at);
  db.prepare("UPDATE session_context SET synthesized_source='SYNTHESIZED_SCENE_SENTINEL',synthesized_updated_at=? WHERE session_id=?")
    .run(at, session.id);
  db.close();

  const recapRevision = repo.getCampaignAdministration("local-owner", campaign.id)!.revision;
  repo.createCampaignRecap("local-owner", campaign.id, { timelineId: campaign.activeTimelineId, throughRevision: 0,
    selectedSessionIds: [session.id], visibility: "members", text: "MEMBERS_RECAP",
    expectedRevision: recapRevision, idempotencyKey: "members-recap" });
  repo.createCampaignRecap("local-owner", campaign.id, { timelineId: campaign.activeTimelineId, throughRevision: 0,
    selectedSessionIds: [session.id], visibility: "gm-only", text: "GM_ONLY_RECAP",
    expectedRevision: recapRevision + 1, idempotencyKey: "gm-recap" });

  const otherSession = await createSession({ characterId: playerActor.persona.id, title: "Other room" });
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: otherSession.id } as any);
  const foreignCampaign = repo.createCampaign("local-owner", { name: "Foreign" });
  return { repo, campaignId: campaign.id, sessionId: session.id, otherSessionId: otherSession.id,
    foreignCampaignId: foreignCampaign.id, actorId: playerActor.actorId, playerPersonaId: playerActor.persona.id,
    unrelatedActorId: unrelatedActor.actorId, npcId: npc.npcId, npcPersonaId: npcPersona.id };
}

function allText(snapshot: CampaignAgentContextSnapshot): string {
  return JSON.stringify(snapshot);
}

describe("campaign agent context repository", () => {
  it("derives audience visibility and excludes every role-sensitive sentinel", async () => {
    const f = await roleFixture();
    const player = f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })!;
    expect(player.authority).toEqual({ role: "player", control: "controlled" });
    expect(player.speakerPersona).toEqual({ characterId: f.playerPersonaId, displayName: "Aster" });
    expect(player.privateTargetFacts.join(" ")).toContain("PLAYER_TARGET_SECRET");
    expect(player.visibleWorld.join(" ")).toContain("PUBLIC_LOCATION");
    expect(player.visibleQuests.join(" ")).toContain("PUBLIC_QUEST");
    expect(player.recap).toContain("MEMBERS_RECAP");
    expect(player.synthesizedSummaryFacts).toEqual(["SYNTHESIZED_SCENE_SENTINEL"]);
    expect(allText(player)).not.toMatch(/GM_ONLY_LOCATION|GM_ONLY_QUEST|GM_QUEST_SECRET|UNATTESTED_QUEST|GM_ONLY_RECAP|OTHER_PLAYER_SECRET|NPC_TARGET_GOAL|NPC_TARGET_GM_NOTE|UNRELATED_NPC_GOAL|UNRELATED_NPC_GM_NOTE|STORY_GRAPH_SENTINEL|STORY_GM_NOTE|hidden-route|other-player|local-owner/i);

    const visibilityDb = new DatabaseDriver(dbPath());
    visibilityDb.prepare("DELETE FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?")
      .run(f.campaignId, f.actorId, f.sessionId);
    visibilityDb.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)")
      .run(f.campaignId, f.actorId, "gm-place", f.sessionId, at);
    visibilityDb.close();
    const hiddenCurrent = f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })!;
    expect(allText(hiddenCurrent)).not.toContain("GM_ONLY_LOCATION");
    expect(hiddenCurrent.visibleWorld).toEqual([]);

    const dm = f.repo.getCampaignAgentContextSnapshot("gm", f.campaignId, f.sessionId, { kind: "dm" })!;
    expect(dm.authority).toEqual({ role: "gm", control: "all" });
    expect(allText(dm)).toMatch(/GM_ONLY_LOCATION/);
    expect(allText(dm)).toMatch(/PUBLIC_QUEST/);
    expect(allText(dm)).toMatch(/GM_ONLY_QUEST/);
    expect(allText(dm)).toMatch(/UNATTESTED_QUEST/);
    expect(allText(dm)).toMatch(/GM_ONLY_RECAP/);
    expect(allText(dm)).not.toMatch(/PLAYER_TARGET_SECRET|OTHER_PLAYER_SECRET|NPC_TARGET_GOAL|NPC_TARGET_GM_NOTE|UNRELATED_NPC_GOAL|UNRELATED_NPC_GM_NOTE|STORY_GRAPH_SENTINEL|STORY_GM_NOTE|hidden-route|other-player|local-owner/i);

    const npc = f.repo.getCampaignAgentContextSnapshot("gm", f.campaignId, f.sessionId, { kind: "npc", npcId: f.npcId })!;
    expect(npc.speakerPersona).toEqual({ characterId: f.npcPersonaId, displayName: "Marrow persona" });
    expect(npc.privateTargetFacts.join(" ")).toContain("NPC_TARGET_GOAL");
    expect(allText(npc)).not.toMatch(/NPC_TARGET_GM_NOTE|UNRELATED_NPC_GOAL|UNRELATED_NPC_GM_NOTE|GM_ONLY_LOCATION|GM_ONLY_QUEST|UNATTESTED_QUEST|GM_ONLY_RECAP|PLAYER_TARGET_SECRET|OTHER_PLAYER_SECRET/);
    expect(npc.visibleWorld).toEqual([]);
    expect(npc.visibleCast.every((line) => !line.includes(" at "))).toBe(true);
    expect(npc.visibleQuests.join(" ")).toContain("PUBLIC_QUEST");
    expect(npc.recap).toContain("MEMBERS_RECAP");
    f.repo.close();
  });

  it("explicitly fail-closes unsupported companions and rejects every unauthorized matrix entry", async () => {
    const f = await roleFixture();
    expect(CAMPAIGN_COMPANION_CONTEXT_SUPPORTED).toBe(false);
    for (const principal of ["local-owner", "gm", "player", "observer", "missing"]) {
      expect(f.repo.getCampaignAgentContextSnapshot(principal, f.campaignId, f.sessionId,
        { kind: "companion", actorId: f.actorId })).toBeNull();
    }
    for (const audience of [{ kind: "dm" } as const, { kind: "npc", npcId: f.npcId } as const,
      { kind: "enemy", combatantId: "missing" } as const]) {
      expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId, audience)).toBeNull();
      expect(f.repo.getCampaignAgentContextSnapshot("observer", f.campaignId, f.sessionId, audience)).toBeNull();
      expect(f.repo.getCampaignAgentContextSnapshot("missing", f.campaignId, f.sessionId, audience)).toBeNull();
    }
    for (const principal of ["observer", "missing"]) {
      expect(f.repo.getCampaignAgentContextSnapshot(principal, f.campaignId, f.sessionId,
        { kind: "player", actorId: f.actorId })).toBeNull();
    }
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.unrelatedActorId })).toBeNull();
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.otherSessionId,
      { kind: "player", actorId: f.unrelatedActorId })).toBeNull();
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.foreignCampaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })).toBeNull();
    f.repo.close();
  });

  it("revalidates role, membership, and actor control on every read", async () => {
    const f = await roleFixture();
    const db = new DatabaseDriver(dbPath());
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })).not.toBeNull();
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player' WHERE actor_id=?").run(f.actorId);
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })).toBeNull();
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='player' WHERE actor_id=?").run(f.actorId);
    db.prepare("UPDATE campaign_memberships SET role='observer' WHERE campaign_id=? AND principal_id='player'").run(f.campaignId);
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })).toBeNull();
    db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id='player'").run(f.campaignId);
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player' WHERE actor_id=?").run(f.actorId);
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id='player'").run(f.campaignId);
    expect(f.repo.getCampaignAgentContextSnapshot("player", f.campaignId, f.sessionId,
      { kind: "player", actorId: f.actorId })).toBeNull();
    db.close(); f.repo.close();
  });

  it("uses authoritative plans with binary deterministic enemy targeting and DM current-combatant actions", async () => {
    let id = 0;
    const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `combat-context-${++id}` },
      rng: { integer: (minimum) => minimum } });
    const campaign = repo.createCampaign("local-owner", { name: "Combat context" });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const createActor = (name: string) => {
      const persona = repo.createCharacter({ name, age: 30, archetype: "Scout", boundaries: "", fictionalConfirmed: true });
      const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id,
        controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores },
        idempotencyKey: `${name}-draft` });
      const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0,
        idempotencyKey: `${name}-select`, selections: {
          race: definitions.find((item) => item.reference.kind === "race")!.reference,
          background: definitions.find((item) => item.reference.kind === "background")!.reference,
          class: definitions.find((item) => item.reference.kind === "class")!.reference, starterGrant: "kit",
        } } as any);
      return { persona, actorId: repo.finalizeCharacterDraft("local-owner", draft.draft.id,
        { expectedRevision: selected.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId };
    };
    const zeta = createActor("Zeta");
    const alpha = createActor("Alpha");
    const session = await createSession({ characterId: zeta.persona.id, title: "Combat room" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const db = new DatabaseDriver(dbPath());
    db.prepare("INSERT INTO session_characters(session_id,character_id,position) VALUES(?,?,1)").run(session.id, alpha.persona.id);
    db.close();
    const enemyDefinition = definitions.find((entry) => entry.reference.kind === "enemy-template")!;
    const template = { kind: "enemy-template" as const, packId: enemyDefinition.reference.packId,
      packVersion: enemyDefinition.reference.packVersion, definitionId: enemyDefinition.reference.definitionId };
    repo.updateSessionContextSource(session.id, "ENEMY_HUMAN_CANON");
    const enemyNpcPersona = repo.createCharacter({ name: "Enemy hidden NPC", age: 44, archetype: "Spy", boundaries: "", fictionalConfirmed: true });
    repo.createCampaignNpc("local-owner", campaign.id, { personaId: enemyNpcPersona.id, publicState: { name: "Hidden NPC" },
      privateState: { goals: "ENEMY_FIXTURE_NPC_GOAL", gmNotes: "ENEMY_FIXTURE_NPC_GM_NOTE", merchantState: null },
      expectedRevision: 0, idempotencyKey: "enemy-hidden-npc" });
    repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "enemy-public", name: "ENEMY_PUBLIC_LOCATION", visibility: "public" });
    repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "enemy-hidden", name: "ENEMY_GM_LOCATION", visibility: "hidden" });
    repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "enemy-hidden-route",
      fromLocationId: "enemy-public", toLocationId: "enemy-hidden", visibility: "hidden", routeState: "open" });
    repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "enemy-story",
      title: "ENEMY_STORY_GRAPH", summary: "ENEMY_STORY_SUMMARY", nodes: [{ nodeId: "enemy-node", title: "Node",
        description: null, gmNotes: "ENEMY_STORY_GM_NOTE", revealThreshold: 0 }], edges: [], plotPoints: [], clues: [] },
      expectedRevision: 0, idempotencyKey: "enemy-story" });
    repo.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "enemy-public-quest", storylineId: "enemy-story",
      title: "ENEMY_PUBLIC_QUEST", description: "Public", visibility: "public", journalText: "Public",
      objectives: [{ objectiveId: "enemy-public-objective", description: "Public", targetProgress: 1,
        dependencyObjectiveIds: [], visibility: "public" }], rewards: [] }, expectedRevision: 0, idempotencyKey: "enemy-public-quest" });
    repo.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "enemy-gm-quest", storylineId: "enemy-story",
      title: "ENEMY_GM_QUEST", description: "ENEMY_GM_QUEST_SECRET", visibility: "gm", journalText: "Secret",
      objectives: [{ objectiveId: "enemy-gm-objective", description: "Secret", targetProgress: 1,
        dependencyObjectiveIds: [], visibility: "gm" }], rewards: [] }, expectedRevision: 1, idempotencyKey: "enemy-gm-quest" });
    const hiddenDb = new DatabaseDriver(dbPath());
    hiddenDb.prepare("UPDATE campaign_actor_private_state SET private_notes='ENEMY_FIXTURE_CONTROLLER_NOTE' WHERE actor_id=?").run(zeta.actorId);
    hiddenDb.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id, zeta.actorId, "enemy-hidden", session.id, at);
    hiddenDb.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("enemy-unattested", "enemy-story", campaign.id,
      "ENEMY_UNATTESTED_QUEST", "ENEMY_UNATTESTED_SECRET", "open", 2, at, at);
    hiddenDb.prepare("UPDATE session_context SET synthesized_source='ENEMY_SYNTHESIZED_SENTINEL',synthesized_updated_at=? WHERE session_id=?")
      .run(at, session.id);
    hiddenDb.close();
    const recapRevision = repo.getCampaignAdministration("local-owner", campaign.id)!.revision;
    repo.createCampaignRecap("local-owner", campaign.id, { timelineId: campaign.activeTimelineId, throughRevision: 0,
      selectedSessionIds: [session.id], visibility: "members", text: "ENEMY_MEMBERS_RECAP", expectedRevision: recapRevision,
      idempotencyKey: "enemy-members-recap" });
    repo.createCampaignRecap("local-owner", campaign.id, { timelineId: campaign.activeTimelineId, throughRevision: 0,
      selectedSessionIds: [session.id], visibility: "gm-only", text: "ENEMY_GM_RECAP", expectedRevision: recapRevision + 1,
      idempotencyKey: "enemy-gm-recap" });
    const enemyIntents = Array.from({ length: 30 }, () => ({ kind: "enemy" as const, team: "enemies" as const, template }));
    const prepared = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Mite",
      combatants: [{ kind: "actor", actorId: zeta.actorId, team: "allies" },
        { kind: "actor", actorId: alpha.actorId, team: "allies" }, ...enemyIntents], idempotencyKey: "prepare" });
    let combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
    expect(combat.combatants).toHaveLength(32);
    const binaryCombatants = [...combat.combatants].sort((a, b) => a.combatantId < b.combatantId ? -1 : a.combatantId > b.combatantId ? 1 : 0);
    const target = [...binaryCombatants].reverse().find((combatant) => combatant.kind === "enemy")!;
    const enemyId = target.combatantId;
    expect(binaryCombatants.findIndex((combatant) => combatant.combatantId === enemyId)).toBeGreaterThanOrEqual(24);
    let steps = 0;
    while (combat.currentCombatant !== enemyId && steps++ < 40) {
      combat = repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [],
        expectedRevision: combat.revision, idempotencyKey: `advance-${steps}` }).combat;
    }
    expect(combat.currentCombatant).toBe(enemyId);
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const enemy = repo.getCampaignAgentContextSnapshot("local-owner", campaign.id, session.id,
      { kind: "enemy", combatantId: enemyId })!;
    const attack = enemy.legalActions.find((line) => line.startsWith("attack:basic"))!;
    const actorCombatants = combat.combatants.filter((item) => item.kind === "actor").map((item) => item.combatantId)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    expect(attack).toContain(`exactly one target ${actorCombatants[0]}`);
    expect(attack).not.toContain(actorCombatants[1]!);
    expect(enemy.legalActions.map((line) => line.split(";")[0])).toEqual([expect.stringMatching(/^attack:basic:target:[0-9a-f]{12}$/), "flee", "end-turn"]);
    expect(enemy.visibleWorld).toEqual([]);
    expect(enemy.visibleCast.every((line) => !line.includes(" at "))).toBe(true);
    expect(enemy.committedMechanics).toHaveLength(34);
    expect(allText(enemy)).not.toMatch(/ENEMY_FIXTURE_NPC_GOAL|ENEMY_FIXTURE_NPC_GM_NOTE|ENEMY_GM_LOCATION|enemy-hidden-route|ENEMY_GM_QUEST|ENEMY_GM_QUEST_SECRET|ENEMY_UNATTESTED_QUEST|ENEMY_UNATTESTED_SECRET|ENEMY_GM_RECAP|ENEMY_FIXTURE_CONTROLLER_NOTE|ENEMY_STORY_GRAPH|ENEMY_STORY_GM_NOTE/);
    expect(enemy.synthesizedSummaryFacts).toEqual(["ENEMY_SYNTHESIZED_SENTINEL"]);
    const basket = assembleCampaignAgentContext({ snapshot: enemy, declaration: "plan", budgets: { mechanicsUtf16CodeUnits: 64_000 } });
    expect(basket.truncation.mechanicsUtf16CodeUnits).toMatchObject({ inputLines: 37, includedLines: 37, omittedLines: 0, truncated: false });
    const dm = repo.getCampaignAgentContextSnapshot("local-owner", campaign.id, session.id, { kind: "dm" })!;
    expect(dm.legalActions).toEqual(enemy.legalActions);
    const sentinelDb = new DatabaseDriver(dbPath());
    const catalogSentinel = (sentinelDb.prepare("SELECT definition_id value FROM rpg_catalog_definitions WHERE kind='race' ORDER BY definition_id COLLATE BINARY LIMIT 1")
      .get() as { value: string } | undefined)?.value;
    sentinelDb.close();
    expect(catalogSentinel).toBeTruthy();
    expect(allText(dm)).not.toContain(catalogSentinel!);
    const overflowDb = new DatabaseDriver(dbPath());
    overflowDb.prepare(`INSERT INTO combatant
      (combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,enemy_tactic,initiative,initiative_tiebreaker,
        hit_points,maximum_hit_points,status,state_revision,created_at,updated_at)
      VALUES('zz-overflow-combatant',?,?,NULL,'enemy','enemies','basic_attack',0,999999,1,1,'active',0,?,?)`)
      .run(combat.combatId, campaign.id, at, at);
    overflowDb.close();
    expect(repo.getCampaignAgentContextSnapshot("local-owner", campaign.id, session.id,
      { kind: "enemy", combatantId: enemyId })).toBeNull();
    expect(transaction).toHaveBeenCalled();
    transaction.mockRestore(); repo.close();
  });
});
