import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  authoritativeTacticalMapSchema,
  tacticalMapGenerateRequestSchema,
  tacticalMapMoveReceiptSchema,
  tacticalMapMoveRequestSchema,
  tacticalMapMoveResponseSchema,
  tacticalMapPreviewRequestSchema,
  tacticalMapPreviewResponseSchema,
  tacticalMapSnapshotSchema,
  utcIsoTimestampSchema,
  resourceIdSchema,
  type AuthoritativeTacticalMap,
  type MapPoint,
  type TacticalMapGenerateRequest,
  type TacticalMapMoveRequest,
  type TacticalMapMoveResponse,
  type TacticalMapPreviewRequest,
  type TacticalMapPreviewResponse,
  type TacticalMapSnapshot,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import { generateTacticalMap } from "../map/generation.js";
import { footprintCells, hasLineOfSight } from "../map/geometry.js";
import { findPath, reachableCells } from "../map/pathfinding.js";
import { projectTacticalMap } from "../map/projection.js";
import { pointKey, tileIndex } from "../map/types.js";
import { resolveCampaignRuleset } from "../rulesets/campaignBinding.js";
import { readCombatTurnEconomy } from "./encounter/combatActionPlan.js";

export class TacticalMapAuthorizationError extends Error {}
export class TacticalMapUnavailableError extends Error {}
export class TacticalMapStaleError extends Error {}
export class TacticalMapConflictError extends Error {}

type Mode = "exploration" | "combat";
type MapRow = { map_id: string; campaign_id: string; session_id: string; mode: Mode; encounter_id: string | null; map_revision: number;
  token_revision: number; width: number; height: number; algorithm: "dungeon-v1" | "cave-v1" | "arena-v1"; seed: string; provenance_hash: string; tiles_json: string; created_at: string };
type TokenRow = { token_id: string; actor_id: string | null; combatant_id: string | null; label: string; x: number; y: number; width: number; height: number;
  disposition: "friendly" | "neutral" | "hostile"; hidden: number; state_revision: number };

function canonical(value: unknown): string { return JSON.stringify(value); }

export interface TacticalMapRepository {
  generateTacticalMapForSession(principalId: string, campaignId: string, sessionId: string, input: TacticalMapGenerateRequest): TacticalMapSnapshot;
  getTacticalMap(principalId: string, campaignId: string, sessionId: string, mode: Mode, actorId: string): TacticalMapSnapshot | null;
  previewTacticalMapMove(principalId: string, campaignId: string, sessionId: string, mode: Mode, input: TacticalMapPreviewRequest): TacticalMapPreviewResponse;
  moveTacticalMapToken(principalId: string, campaignId: string, sessionId: string, mode: Mode, input: TacticalMapMoveRequest): TacticalMapMoveResponse;
}

export function createTacticalMapRepository(db: DatabaseDriver.Database, dependencies: RepositoryDependencies, guard: () => void): TacticalMapRepository {
  const role = (principalId: string, campaignId: string) => (db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId) as { role: string } | undefined)?.role;
  const attached = (campaignId: string, sessionId: string) => Boolean(db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, sessionId));
  const activeRow = (campaignId: string, sessionId: string, mode: Mode) => db.prepare("SELECT * FROM tactical_maps_v58 WHERE campaign_id=? AND session_id=? AND mode=? AND active=1").get(campaignId, sessionId, mode) as MapRow | undefined;
  const rowById = (mapId: string) => db.prepare("SELECT * FROM tactical_maps_v58 WHERE map_id=?").get(mapId) as MapRow | undefined;
  const tokenRows = (mapId: string) => db.prepare("SELECT * FROM tactical_map_tokens_v58 WHERE map_id=? ORDER BY token_id").all(mapId) as TokenRow[];
  const mayControl = (principalId: string, campaignId: string, actorId: string, actorRole: string) => actorRole === "owner" || actorRole === "gm" || Boolean(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(campaignId, actorId, principalId));

  function load(row: MapRow): { map: AuthoritativeTacticalMap; tokens: TokenRow[] } {
    const tokens = tokenRows(row.map_id);
    const map = authoritativeTacticalMapSchema.parse({ mapId: row.map_id, width: row.width, height: row.height,
      grid: { kind: "square", feetPerCell: 5 }, tiles: JSON.parse(row.tiles_json), tokens: tokens.map((token) => ({ tokenId: token.token_id, label: token.label,
        position: { x: token.x, y: token.y }, footprint: { width: token.width, height: token.height }, disposition: token.disposition, hidden: token.hidden === 1 })),
      provenance: { algorithm: row.algorithm, seed: row.seed, parameters: { width: row.width, height: row.height }, hash: row.provenance_hash } });
    const generated = generateTacticalMap({ kind: row.algorithm.replace("-v1", "") as "dungeon" | "cave" | "arena", seed: row.seed, width: row.width, height: row.height });
    if (generated.provenance?.hash !== row.provenance_hash || canonical(generated.tiles) !== canonical(map.tiles)) throw new Error("tactical map provenance verification failed");
    return { map, tokens };
  }

  function movement(row: MapRow, actorId: string, requireAvailable = false): { policy: "exploration-60-feet" | "combat-current-turn-speed"; budgetFeet: number; economy?: NonNullable<ReturnType<typeof readCombatTurnEconomy>> } {
    if (!attached(row.campaign_id, row.session_id) || !db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(row.campaign_id, actorId)) throw new TacticalMapConflictError("movement binding is unavailable");
    let binding: ReturnType<typeof resolveCampaignRuleset>;
    try { binding = resolveCampaignRuleset(db, row.campaign_id); } catch { throw new TacticalMapConflictError("campaign ruleset binding is unavailable"); }
    if (row.mode === "exploration") {
      const inCombat = binding.rulesetId === "dnd-5e" && Boolean(db.prepare(`SELECT 1 FROM combatant participant JOIN encounter combat USING(encounter_id)
        WHERE combat.campaign_id=? AND combat.status='active' AND participant.actor_id=?`).get(row.campaign_id, actorId));
      if (inCombat && requireAvailable) throw new TacticalMapConflictError("exploration movement is unavailable during D&D combat");
      return { policy: "exploration-60-feet", budgetFeet: inCombat ? 0 : 60 };
    }
    const encounter = db.prepare("SELECT round_number,current_turn_combatant_id,status FROM encounter WHERE encounter_id=? AND campaign_id=? AND session_id=?").get(row.encounter_id, row.campaign_id, row.session_id) as { round_number: number; current_turn_combatant_id: string | null; status: string } | undefined;
    const token = tokenRows(row.map_id).find((value) => value.actor_id === actorId);
    if (binding.rulesetId === "dnd-5e") {
      const participant = db.prepare("SELECT status FROM combatant WHERE campaign_id=? AND encounter_id=? AND combatant_id=? AND actor_id=?").get(row.campaign_id, row.encounter_id, token?.combatant_id ?? null, actorId) as { status: string } | undefined;
      if (!encounter || !participant) throw new TacticalMapConflictError("combat movement binding is unavailable");
      const economy = readCombatTurnEconomy(db, row.encounter_id!);
      if (encounter.status === "active" ? !economy || economy.combatantId !== encounter.current_turn_combatant_id || economy.round !== encounter.round_number
        || !db.prepare("SELECT 1 FROM combatant WHERE campaign_id=? AND encounter_id=? AND combatant_id=? AND status='active'").get(row.campaign_id, row.encounter_id, economy.combatantId)
        : economy !== null) throw new TacticalMapConflictError("combat turn economy is contradictory or unavailable");
      if (economy && (!Number.isSafeInteger(economy.movement.allowanceFeet) || !Number.isSafeInteger(economy.movement.usedFeet) || economy.movement.usedFeet < 0 || economy.movement.remainingFeet < 0)) throw new TacticalMapConflictError("combat movement budget is invalid");
      if (encounter.status !== "active" || participant.status !== "active" || encounter.current_turn_combatant_id !== token!.combatant_id) {
        if (requireAvailable) throw new TacticalMapConflictError("combat movement is not available for this actor turn");
        return { policy: "combat-current-turn-speed", budgetFeet: 0 };
      }
      return { policy: "combat-current-turn-speed", budgetFeet: economy!.movement.remainingFeet, economy: economy! };
    }
    if (!encounter || encounter.status !== "active" || !token?.combatant_id || encounter.current_turn_combatant_id !== token.combatant_id) throw new TacticalMapConflictError("combat movement is not available for this actor turn");
    const derived = db.prepare("SELECT derived_json FROM character_progression_v23 WHERE campaign_id=? AND actor_id=?").get(row.campaign_id, actorId) as { derived_json: string } | undefined;
    let speed: unknown;
    try { speed = derived ? (JSON.parse(derived.derived_json) as { speed?: unknown }).speed : undefined; } catch { speed = undefined; }
    if (!Number.isInteger(speed) || (speed as number) < 0 || (speed as number) > 10_000) throw new TacticalMapConflictError("authoritative combat speed is unavailable");
    const used = (db.prepare("SELECT used_feet FROM tactical_map_combat_movement_v58 WHERE map_id=? AND encounter_id=? AND round_number=? AND actor_id=?").get(row.map_id, row.encounter_id, encounter.round_number, actorId) as { used_feet: number } | undefined)?.used_feet ?? 0;
    return { policy: "combat-current-turn-speed", budgetFeet: Math.max(0, (speed as number) - used) };
  }

  function movementAuthorityRevision(row: MapRow): number {
    if (row.mode === "exploration") return 0;
    const encounter = db.prepare("SELECT root.revision AS state_revision FROM encounter JOIN combat_mutation_revisions_v27 root USING(encounter_id) WHERE encounter_id=? AND campaign_id=? AND session_id=?").get(row.encounter_id, row.campaign_id, row.session_id) as { state_revision: number } | undefined;
    if (!encounter) throw new TacticalMapConflictError("combat movement authority is unavailable");
    return encounter.state_revision;
  }

  function visibility(row: MapRow, map: AuthoritativeTacticalMap, actorId: string, actorRole: string) {
    if (actorRole === "owner" || actorRole === "gm") {
      const all = new Set(map.tiles.map((tile) => pointKey(tile.position)));
      return { visible: all, explored: all, revealHiddenTokenIds: new Set(map.tokens.filter((token) => token.hidden).map((token) => token.tokenId)) };
    }
    const actorToken = tokenRows(row.map_id).find((token) => token.actor_id === actorId);
    if (!actorToken) throw new TacticalMapUnavailableError();
    const index = tileIndex(map); const visible = new Set<string>();
    for (const tile of map.tiles) if (Math.max(Math.abs(tile.position.x - actorToken.x), Math.abs(tile.position.y - actorToken.y)) <= 6
      && hasLineOfSight({ x: actorToken.x, y: actorToken.y }, tile.position, index)) visible.add(pointKey(tile.position));
    const exploredRows = db.prepare("SELECT x,y FROM tactical_map_exploration_v58 WHERE map_id=? AND actor_id=?").all(row.map_id, actorId) as Array<{ x: number; y: number }>;
    return { visible, explored: new Set(exploredRows.map(pointKey)), revealHiddenTokenIds: new Set<string>() };
  }

  function blocked(map: AuthoritativeTacticalMap, ownTokenId: string): Set<string> {
    return new Set(map.tokens.filter((token) => token.tokenId !== ownTokenId).flatMap((token) => footprintCells(token.position, token.footprint).map(pointKey)));
  }

  function snapshot(row: MapRow, principalId: string, actorId: string | null, path: MapPoint[] | null = null): TacticalMapSnapshot {
    const actorRole = role(principalId, row.campaign_id); if (!actorRole) throw new TacticalMapAuthorizationError();
    const { map, tokens } = load(row); const token = actorId ? tokens.find((value) => value.actor_id === actorId) : undefined;
    if (actorId && (!token || !mayControl(principalId, row.campaign_id, actorId, actorRole))) throw new TacticalMapAuthorizationError();
    const move = actorId ? movement(row, actorId) : null;
    const view = visibility(row, map, actorId ?? "", actorRole);
    const reachable = token && move ? reachableCells(map, { x: token.x, y: token.y }, Math.floor(move.budgetFeet / 5), { footprint: { width: token.width, height: token.height }, blocked: blocked(map, token.token_id) }) : [];
    return tacticalMapSnapshotSchema.parse({ campaignId: row.campaign_id, sessionId: row.session_id, encounterId: row.encounter_id, mode: row.mode,
      mapRevision: row.map_revision, tokenRevision: row.token_revision, controlledTokenId: token?.token_id ?? null, movement: move ? { policy: move.policy, budgetFeet: move.budgetFeet } : null,
      projection: projectTacticalMap(map, { ...view, authoritativePath: path, reachable }) });
  }

  function reveal(row: MapRow, actorId: string, now: string): void {
    const { map } = load(row); const token = tokenRows(row.map_id).find((value) => value.actor_id === actorId); if (!token) return;
    const index = tileIndex(map); const insert = db.prepare("INSERT OR IGNORE INTO tactical_map_exploration_v58(map_id,actor_id,x,y,explored_at) VALUES(?,?,?,?,?)");
    for (const tile of map.tiles) if (Math.max(Math.abs(tile.position.x - token.x), Math.abs(tile.position.y - token.y)) <= 6
      && hasLineOfSight({ x: token.x, y: token.y }, tile.position, index)) insert.run(row.map_id, actorId, tile.position.x, tile.position.y, now);
  }

  function pathCost(map: AuthoritativeTacticalMap, path: MapPoint[], width: number, height: number): number {
    const index = tileIndex(map); let units = 0;
    for (const point of path.slice(1)) { let step = 1; for (const cell of footprintCells(point, { width, height })) { const tile = index.get(pointKey(cell)); if (!tile) throw new TacticalMapConflictError(); step = Math.max(step, tile.movementCost * (tile.difficult ? 2 : 1)); } units += step; }
    return units * 5;
  }

  return {
    generateTacticalMapForSession(principalId, campaignId, sessionId, inputValue) {
      guard(); const input = tacticalMapGenerateRequestSchema.parse(inputValue); const actorRole = role(principalId, campaignId);
      if (!actorRole || !["owner", "gm"].includes(actorRole) || !attached(campaignId, sessionId)) throw new TacticalMapAuthorizationError();
      const requestJson = canonical(input);
      return db.transaction(() => {
        const retry = db.prepare("SELECT request_json,map_id FROM tactical_map_generation_keys_v58 WHERE campaign_id=? AND session_id=? AND mode=? AND idempotency_key=?").get(campaignId, sessionId, input.mode, input.idempotencyKey) as { request_json: string; map_id: string } | undefined;
        if (retry) { if (retry.request_json !== requestJson) throw new TacticalMapConflictError("idempotency key was reused"); const existing = rowById(retry.map_id); if (!existing) throw new Error("map generation receipt is corrupt"); return snapshot(existing, principalId, null); }
        if (input.mode === "combat") { const encounter = db.prepare("SELECT 1 FROM encounter WHERE encounter_id=? AND campaign_id=? AND session_id=? AND status='active'").get(input.encounterId, campaignId, sessionId); if (!encounter) throw new TacticalMapConflictError("active encounter is unavailable"); }
        const generated = generateTacticalMap(input); const parsed = authoritativeTacticalMapSchema.parse({ ...generated, mapId: resourceIdSchema.parse(dependencies.ids.nextId()), tokens: input.tokens.map(({ actorId: _actor, combatantId: _combatant, ...token }) => token) });
        const occupied = new Set<string>();
        for (const token of input.tokens) {
          if (token.actorId && !db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId, token.actorId)) throw new TacticalMapConflictError("token actor binding is unavailable");
          if (input.mode === "combat" && (!token.combatantId || !db.prepare("SELECT 1 FROM combatant WHERE encounter_id=? AND combatant_id=? AND actor_id IS ?").get(input.encounterId, token.combatantId, token.actorId))) throw new TacticalMapConflictError("combat token binding is unavailable");
          for (const cell of footprintCells(token.position, token.footprint)) { const tile = tileIndex(parsed).get(pointKey(cell)); if (!tile || tile.blocksMovement || occupied.has(pointKey(cell))) throw new TacticalMapConflictError("token placement is illegal"); occupied.add(pointKey(cell)); }
        }
        const prior = activeRow(campaignId, sessionId, input.mode); const mapRevision = (prior?.map_revision ?? -1) + 1; const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        if (prior) db.prepare("UPDATE tactical_maps_v58 SET active=0 WHERE map_id=?").run(prior.map_id);
        db.prepare("INSERT INTO tactical_maps_v58(map_id,campaign_id,session_id,mode,encounter_id,active,map_revision,token_revision,width,height,algorithm,seed,provenance_hash,tiles_json,created_at) VALUES(?,?,?,?,?,1,?,0,?,?,?,?,?,?,?)")
          .run(parsed.mapId, campaignId, sessionId, input.mode, input.encounterId, mapRevision, parsed.width, parsed.height, parsed.provenance!.algorithm, parsed.provenance!.seed, parsed.provenance!.hash, canonical(parsed.tiles), now);
        const insertToken = db.prepare("INSERT INTO tactical_map_tokens_v58(map_id,token_id,actor_id,combatant_id,label,x,y,width,height,disposition,hidden,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)");
        for (const token of input.tokens) insertToken.run(parsed.mapId, token.tokenId, token.actorId, token.combatantId, token.label, token.position.x, token.position.y, token.footprint.width, token.footprint.height, token.disposition, token.hidden ? 1 : 0);
        db.prepare("INSERT INTO tactical_map_generation_keys_v58 VALUES(?,?,?,?,?,?)").run(campaignId, sessionId, input.mode, input.idempotencyKey, requestJson, parsed.mapId);
        db.prepare("INSERT INTO tactical_map_commands_v58 VALUES(?,?,?,?,'generate',?,?,?,?)").run(parsed.mapId, resourceIdSchema.parse(dependencies.ids.nextId()), principalId, null, input.idempotencyKey, requestJson, canonical({ mapId: parsed.mapId, mapRevision }), now);
        for (const token of input.tokens) if (token.actorId) reveal(rowById(parsed.mapId)!, token.actorId, now);
        return snapshot(rowById(parsed.mapId)!, principalId, null);
      }).immediate();
    },
    getTacticalMap(principalId, campaignId, sessionId, mode, actorId) {
      guard(); if (!attached(campaignId, sessionId)) return null; const row = activeRow(campaignId, sessionId, mode); if (!row) return null;
      try { return snapshot(row, principalId, actorId); } catch (error) { if (error instanceof TacticalMapAuthorizationError || error instanceof TacticalMapUnavailableError) return null; throw error; }
    },
    previewTacticalMapMove(principalId, campaignId, sessionId, mode, inputValue) {
      guard(); const input = tacticalMapPreviewRequestSchema.parse(inputValue); return db.transaction(() => {
      const row = activeRow(campaignId, sessionId, mode); if (!row) throw new TacticalMapUnavailableError();
      if (row.map_revision !== input.expectedMapRevision || row.token_revision !== input.expectedTokenRevision) throw new TacticalMapStaleError();
      const actorRole = role(principalId, campaignId); if (!actorRole || !mayControl(principalId, campaignId, input.actorId, actorRole)) throw new TacticalMapAuthorizationError();
      const { map, tokens } = load(row); const token = tokens.find((value) => value.actor_id === input.actorId); if (!token) throw new TacticalMapUnavailableError();
      const budget = movement(row, input.actorId, true); const path = findPath(map, { x: token.x, y: token.y }, input.destination, { footprint: { width: token.width, height: token.height }, blocked: blocked(map, token.token_id) });
      if (!path) throw new TacticalMapConflictError("destination is unreachable"); const cost = pathCost(map, path, token.width, token.height); if (cost > budget.budgetFeet) throw new TacticalMapConflictError("destination exceeds movement budget");
      const authorityRevision = movementAuthorityRevision(row);
      const turnId = budget.economy?.turnId ?? null;
      const previewId = `map-preview-${createHash("sha256").update(canonical({ mapId: row.map_id, actorId: input.actorId, destination: input.destination, mapRevision: row.map_revision, tokenRevision: row.token_revision, authorityRevision, turnId, path, cost, budget: budget.budgetFeet })).digest("hex").slice(0, 48)}`;
      const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
      db.prepare("INSERT OR REPLACE INTO tactical_map_previews_v58 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(previewId, row.map_id, input.actorId, token.token_id, input.destination.x, input.destination.y, row.map_revision, row.token_revision, authorityRevision, canonical(path), cost, budget.budgetFeet, now, turnId);
      return tacticalMapPreviewResponseSchema.parse({ ...snapshot(row, principalId, input.actorId, path), previewId, pathCostFeet: cost });
      }).immediate();
    },
    moveTacticalMapToken(principalId, campaignId, sessionId, mode, inputValue) {
      guard(); const input = tacticalMapMoveRequestSchema.parse(inputValue); return db.transaction(() => {
        const row = activeRow(campaignId, sessionId, mode); if (!row) throw new TacticalMapUnavailableError(); const actorRole = role(principalId, campaignId);
        if (!actorRole || !mayControl(principalId, campaignId, input.actorId, actorRole)) throw new TacticalMapAuthorizationError();
        const requestJson = canonical(input); const retry = db.prepare("SELECT request_json,result_json FROM tactical_map_commands_v58 WHERE map_id=? AND idempotency_key=?").get(row.map_id, input.idempotencyKey) as { request_json: string; result_json: string } | undefined;
        if (retry) { if (retry.request_json !== requestJson) throw new TacticalMapConflictError("idempotency key was reused"); const receipt = tacticalMapMoveReceiptSchema.parse(JSON.parse(retry.result_json)); return tacticalMapMoveResponseSchema.parse({ receipt, snapshot: snapshot(row, principalId, input.actorId) }); }
        if (row.map_revision !== input.expectedMapRevision || row.token_revision !== input.expectedTokenRevision) throw new TacticalMapStaleError();
        const token = tokenRows(row.map_id).find((value) => value.actor_id === input.actorId); if (!token) throw new TacticalMapUnavailableError();
        const budget = movement(row, input.actorId, true);
        const preview = db.prepare("SELECT * FROM tactical_map_previews_v58 WHERE preview_id=? AND map_id=? AND actor_id=? AND token_id=?").get(input.previewId, row.map_id, input.actorId, token.token_id) as { destination_x: number; destination_y: number; map_revision: number; token_revision: number; authority_revision: number; path_cost_feet: number; budget_feet: number; turn_id: string | null } | undefined;
        if (!preview || preview.destination_x !== input.destination.x || preview.destination_y !== input.destination.y || preview.map_revision !== row.map_revision || preview.token_revision !== row.token_revision || preview.authority_revision !== movementAuthorityRevision(row)) throw new TacticalMapConflictError("an exact current preview is required");
        if (preview.turn_id !== (budget.economy?.turnId ?? null) || !Number.isSafeInteger(preview.path_cost_feet) || preview.path_cost_feet < 0 || preview.path_cost_feet > budget.budgetFeet || preview.budget_feet !== budget.budgetFeet) throw new TacticalMapConflictError("movement authority changed after preview");
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString()); const after = row.token_revision + 1;
        if (budget.economy) {
          const economy = budget.economy;
          const spent = db.prepare(`UPDATE combat_turn_economy_v60 SET movement_used_feet=movement_used_feet+?
            WHERE turn_id=? AND encounter_id=? AND combatant_id=? AND round_number=? AND ended_at IS NULL
              AND movement_used_feet=? AND movement_allowance_feet=? AND movement_allowance_feet-movement_used_feet>=?
              AND EXISTS(SELECT 1 FROM encounter JOIN combat_mutation_revisions_v27 root USING(encounter_id) WHERE encounter_id=? AND campaign_id=? AND session_id=? AND status='active'
                AND current_turn_combatant_id=? AND round_number=? AND root.revision=?)`)
            .run(preview.path_cost_feet, economy.turnId, row.encounter_id, token.combatant_id, economy.round,
              economy.movement.usedFeet, economy.movement.allowanceFeet, preview.path_cost_feet,
              row.encounter_id, campaignId, sessionId, token.combatant_id, economy.round, preview.authority_revision);
          if (spent.changes !== 1) throw new TacticalMapConflictError("combat movement authority changed");
          const revised = db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=revision+1,updated_at=? WHERE encounter_id=? AND revision=?").run(now, row.encounter_id, preview.authority_revision);
          if (revised.changes !== 1) throw new TacticalMapConflictError("combat movement authority changed");
        }
        db.prepare("UPDATE tactical_map_tokens_v58 SET x=?,y=?,state_revision=state_revision+1 WHERE map_id=? AND token_id=?").run(input.destination.x, input.destination.y, row.map_id, token.token_id);
        db.prepare("UPDATE tactical_maps_v58 SET token_revision=token_revision+1 WHERE map_id=?").run(row.map_id);
        if (row.mode === "combat" && !budget.economy) { const round = (db.prepare("SELECT round_number FROM encounter WHERE encounter_id=?").get(row.encounter_id) as { round_number: number }).round_number;
          db.prepare("INSERT INTO tactical_map_combat_movement_v58 VALUES(?,?,?,?,?) ON CONFLICT(map_id,encounter_id,round_number,actor_id) DO UPDATE SET used_feet=used_feet+excluded.used_feet").run(row.map_id, row.encounter_id, round, input.actorId, preview.path_cost_feet); }
        const receipt = tacticalMapMoveReceiptSchema.parse({ mapId: row.map_id, tokenId: token.token_id, previewId: input.previewId, idempotencyKey: input.idempotencyKey,
          mapRevision: row.map_revision, tokenRevisionBefore: row.token_revision, tokenRevisionAfter: after, destination: input.destination, occurredAt: now });
        db.prepare("INSERT INTO tactical_map_commands_v58 VALUES(?,?,?,?,'move',?,?,?,?)").run(row.map_id, resourceIdSchema.parse(dependencies.ids.nextId()), principalId, input.actorId, input.idempotencyKey, requestJson, canonical(receipt), now);
        const updated = rowById(row.map_id)!; reveal(updated, input.actorId, now);
        return tacticalMapMoveResponseSchema.parse({ receipt, snapshot: snapshot(updated, principalId, input.actorId) });
      }).immediate();
    },
  };
}
