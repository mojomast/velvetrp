import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MECHANICS_STARTER_CATALOG, createRepository } from "../src/repo/index.js";
import { combatMapSeed, ensureCombatTacticalMap, inferCombatMapKind } from "../src/repo/combatTacticalMap.js";
import { createSession, transitionSession } from "../src/repo/sessionRepo.js";
import { generateTacticalMap } from "../src/map/generation.js";
import { systemRuntime } from "../src/runtime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
const MITE = { kind: "enemy-template" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:enemy-template:gloam-mite" };

async function fixture() {
  const repo = createRepository({ rng: { integer: (minimum: number) => minimum } });
  const campaign = repo.createCampaign("local-owner", { name: "Combat map campaign" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "map-pins" });
  const persona = repo.createCharacter({ name: "Aster", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
    durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "map-draft" });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "map-select", selections: {
    race: definitions.find((value) => value.reference.kind === "race")!.reference,
    background: definitions.find((value) => value.reference.kind === "background")!.reference,
    class: definitions.find((value) => value.reference.kind === "class")!.reference,
    starterGrant: "kit",
  } } as never);
  const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "map-final" }).receipt.actorId;
  const session = await createSession({ characterId: persona.id, title: "Map room" });
  await transitionSession(session.id, "active", "test");
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id });
  return { repo, campaignId: campaign.id, sessionId: session.id, personaId: persona.id, actorId };
}

async function room(repo: ReturnType<typeof createRepository>, campaignId: string, personaId: string, title: string) {
  const session = await createSession({ characterId: personaId, title });
  await transitionSession(session.id, "active", "test");
  repo.attachCampaignSession("local-owner", { campaignId, sessionId: session.id });
  return session.id;
}

function open() {
  return new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
}

describe("automatic combat tactical maps", () => {
  it("creates exactly one bound map with a deterministic seed and combatant tokens when an encounter starts", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const db = open();
    try {
      const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Bridge skirmish",
        combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: MITE, team: "enemies" }], idempotencyKey: "prepare" });
      const encounterId = prepared.encounter.encounterId;
      expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE encounter_id=?").get(encounterId)).toEqual({ count: 0 });
      const started = repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start" });

      const maps = db.prepare("SELECT * FROM tactical_maps_v58 WHERE encounter_id=?").all(encounterId) as Array<{
        map_id: string; campaign_id: string; session_id: string; active: number; map_revision: number; width: number; height: number;
        algorithm: string; seed: string; provenance_hash: string; tiles_json: string }>;
      expect(maps).toHaveLength(1);
      const map = maps[0]!;
      expect(map).toMatchObject({ campaign_id: campaignId, session_id: sessionId, active: 1, map_revision: 0, algorithm: "arena-v1",
        seed: combatMapSeed(encounterId) });
      // The persisted row reproduces the same deterministic generation the repo verifies on load.
      const generated = generateTacticalMap({ kind: "arena", seed: combatMapSeed(encounterId), width: map.width, height: map.height });
      expect(map.provenance_hash).toBe(generated.provenance!.hash);
      expect(JSON.parse(map.tiles_json)).toEqual(generated.tiles);

      const tokens = db.prepare("SELECT * FROM tactical_map_tokens_v58 WHERE map_id=? ORDER BY token_id").all(map.map_id) as Array<{
        token_id: string; actor_id: string | null; combatant_id: string | null; x: number; y: number; width: number; height: number;
        disposition: string; hidden: number }>;
      expect(tokens).toHaveLength(started.combat.combatants.length);
      expect(new Set(tokens.map((token) => token.combatant_id)).size).toBe(tokens.length);
      expect(new Set(tokens.map((token) => token.combatant_id)))
        .toEqual(new Set(started.combat.combatants.map((combatant) => combatant.combatantId)));
      expect(tokens.map((token) => token.disposition).sort()).toEqual(["friendly", "hostile"]);
      const occupied = new Set(tokens.map((token) => `${token.x},${token.y}`));
      expect(occupied.size).toBe(tokens.length);
      for (const token of tokens) {
        expect(token.width).toBe(1); expect(token.height).toBe(1); expect(token.hidden).toBe(0);
        const tile = generated.tiles.find((candidate) => candidate.position.x === token.x && candidate.position.y === token.y)!;
        expect(tile.blocksMovement).toBe(false);
      }
      // A repeated ensure reuses the persisted map verbatim.
      expect(ensureCombatTacticalMap(db, systemRuntime, { principalId: "local-owner", campaignId, sessionId, encounterId }))
        .toEqual({ mapId: map.map_id, created: false, kind: "arena", seed: combatMapSeed(encounterId) });
    } finally { db.close(); repo.close(); }
  });

  it("replays a start without generating a second map and rejects a second start", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const db = open();
    try {
      const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Replay skirmish",
        combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: MITE, team: "enemies" }], idempotencyKey: "prepare" });
      const encounterId = prepared.encounter.encounterId;
      const started = repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start" });
      const before = db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE encounter_id=?").get(encounterId);
      expect(before).toEqual({ count: 1 });
      expect(repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start" })).toEqual(started);
      expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE encounter_id=?").get(encounterId)).toEqual({ count: 1 });
      expect(() => repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start-again" })).toThrow();
      expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE encounter_id=?").get(encounterId)).toEqual({ count: 1 });
    } finally { db.close(); repo.close(); }
  });

  it("reuses a pre-existing map bound to the encounter instead of regenerating on start", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    const db = open();
    try {
      const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Flooded approach",
        combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: MITE, team: "enemies" }], idempotencyKey: "prepare" });
      const encounterId = prepared.encounter.encounterId;
      const direct = ensureCombatTacticalMap(db, systemRuntime, { principalId: "local-owner", campaignId, sessionId, encounterId,
        context: { text: "A flooded sea cave beneath the cliffs" } });
      expect(direct).toMatchObject({ created: true, kind: "underwater", seed: combatMapSeed(encounterId) });

      repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start" });
      const maps = db.prepare("SELECT * FROM tactical_maps_v58 WHERE session_id=? AND mode='combat'").all(sessionId) as Array<{
        map_id: string; active: number; algorithm: string; seed: string }>;
      expect(maps).toHaveLength(1);
      expect(maps[0]).toMatchObject({ map_id: direct.mapId, active: 1, algorithm: "underwater-v1", seed: combatMapSeed(encounterId) });
      expect(db.prepare("SELECT count(*) count FROM tactical_map_tokens_v58 WHERE map_id=?").get(direct.mapId)).toEqual({ count: 2 });
    } finally { db.close(); repo.close(); }
  });

  it("infers cave, water and dungeon kinds from scene text and defaults to the neutral arena", async () => {
    expect(inferCombatMapKind("A flooded sea cave beneath the cliffs")).toBe("underwater");
    expect(inferCombatMapKind("Underwater ruins")).toBe("underwater");
    expect(inferCombatMapKind("A mossy cavern beneath the old mine")).toBe("cave");
    expect(inferCombatMapKind("The ancient dungeon vault")).toBe("dungeon");
    expect(inferCombatMapKind("A sunlit stone bridge")).toBe("arena");
    expect(inferCombatMapKind("")).toBe("arena");
    expect(inferCombatMapKind(undefined)).toBe("arena");
    expect(inferCombatMapKind(null)).toBe("arena");
  });

  it("persists the inferred kind for known and unknown context while keeping the encounter-derived seed", async () => {
    const { repo, campaignId, personaId, actorId } = await fixture();
    const cases: Array<[string | undefined, string]> = [
      ["A flooded sea cave", "underwater-v1"],
      ["A mossy cavern beneath the old mine", "cave-v1"],
      ["The ancient dungeon vault", "dungeon-v1"],
      ["A quiet crossroads", "arena-v1"],
      [undefined, "arena-v1"],
    ];
    try {
      for (const [index, [text, algorithm]] of cases.entries()) {
        const sessionId = await room(repo, campaignId, personaId, `Kind room ${index}`);
        const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: `Case ${index}`,
          combatants: [{ kind: "actor", actorId, team: "allies" }], idempotencyKey: `case-${index}` });
        const encounterId = prepared.encounter.encounterId;
        const db = open();
        try {
          const result = ensureCombatTacticalMap(db, systemRuntime, { principalId: "local-owner", campaignId, sessionId, encounterId,
            ...(text === undefined ? {} : { context: { text } }) });
          expect(result).toMatchObject({ created: true, seed: combatMapSeed(encounterId) });
          expect(db.prepare("SELECT algorithm,seed FROM tactical_maps_v58 WHERE map_id=?").get(result.mapId))
            .toEqual({ algorithm, seed: combatMapSeed(encounterId) });
          expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE session_id=?").get(sessionId)).toEqual({ count: 1 });
        } finally { db.close(); }
      }
    } finally { repo.close(); }
  });

  it("keeps manual generation idempotent and revision-monotonic after the automatic map", async () => {
    const { repo, campaignId, sessionId, actorId } = await fixture();
    try {
      const prepared = repo.createEncounter("local-owner", campaignId, { sessionId, name: "Manual follow-up",
        combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: MITE, team: "enemies" }], idempotencyKey: "prepare" });
      const encounterId = prepared.encounter.encounterId;
      const started = repo.startEncounter("local-owner", encounterId, { expectedRevision: 1, idempotencyKey: "start" });
      const actorCombatant = started.combat.combatants.find((combatant) => combatant.kind === "actor")!;
      const request = { mode: "combat" as const, encounterId, kind: "arena" as const, seed: "manual-seed", width: 12, height: 10,
        tokens: [{ tokenId: actorId, actorId, combatantId: actorCombatant.combatantId, label: "Aster", position: { x: 1, y: 1 },
          footprint: { width: 1, height: 1 }, disposition: "friendly" as const, hidden: false }], idempotencyKey: "manual-generate" };
      const manual = repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request);
      expect(manual.mapRevision).toBe(1);
      expect(repo.generateTacticalMapForSession("local-owner", campaignId, sessionId, request).projection.mapId).toBe(manual.projection.mapId);
      const db = open();
      try {
        expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE session_id=? AND mode='combat'").get(sessionId)).toEqual({ count: 2 });
        expect(db.prepare("SELECT count(*) count FROM tactical_maps_v58 WHERE session_id=? AND mode='combat' AND active=1").get(sessionId)).toEqual({ count: 1 });
      } finally { db.close(); }
    } finally { repo.close(); }
  });
});
