import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2038-03-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;

function fixture() {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `aware-${++sequence}` } });
  const campaign = repo.createCampaign(OWNER, { name: "Agent awareness" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const makeActor = (name: string) => {
    const persona = repo.createCharacter({ name, age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft` });
    const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-base`, selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
      background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
    return { personaId: persona.id, actorId: repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId };
  };
  const hero = makeActor("Hero"), ally = makeActor("Ally");
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("aware-session", hero.personaId, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0),(?,?,1)").run("aware-session", hero.personaId, "aware-session", ally.personaId);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("aware-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "aware-session", name: "Awareness",
    combatants: [{ kind: "actor", actorId: hero.actorId, team: "allies" }, { kind: "actor", actorId: ally.actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  let combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = combat.combatants.find((entry: any) => entry.actorId === hero.actorId)!.combatantId;
  for (let step = 0; step < 20 && combat.currentCombatant !== heroCombatant; step += 1) {
    const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
  }
  expect(combat.currentCombatant).toBe(heroCombatant);
  return { repo, campaign, heroActorId: hero.actorId };
}

describe("SRD 5.1 agent combat awareness", () => {
  it("advertises the full caller-planned action set to the player audience", () => {
    const { repo, campaign, heroActorId } = fixture();
    const snapshot = repo.getCampaignAgentContextSnapshot(OWNER, campaign.id, "aware-session", { kind: "player", actorId: heroActorId })!;
    const candidates = snapshot.encounter!.legalActionCandidates;
    const kinds = candidates.map((candidate) => candidate.kind);
    expect(new Set(kinds)).toEqual(new Set(["attack", "grapple", "shove", "dash", "disengage", "hide", "ready", "help", "flee", "end-turn"]));
    const labeled = (label: string) => candidates.find((candidate) => candidate.label === label);
    expect(labeled("Dash")).toMatchObject({ targetId: null });
    expect(labeled("Disengage")?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(labeled("Hide")?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(labeled("Ready an action")?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(candidates.filter((candidate) => candidate.kind === "grapple").every((candidate) => candidate.targetLabel)).toBe(true);
    expect(candidates.some((candidate) => candidate.label?.startsWith("Shove "))).toBe(true);
    expect(candidates.some((candidate) => candidate.label?.startsWith("Help "))).toBe(true);
    expect(snapshot.legalActions.some((line) => line.startsWith("Dash; consequence:"))).toBe(true);
    expect(candidates.every((candidate) => (candidate.label ?? "").length <= 200)).toBe(true);
    repo.close();
  });
});
