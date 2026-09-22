import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { utcIsoTimestampSchema } from "@velvet/contracts";
import { generateTacticalMap, type MapGeneratorKind } from "../map/generation.js";
import { footprintCells, hasLineOfSight } from "../map/geometry.js";
import { pointKey, tileIndex, type MapPoint } from "../map/types.js";
import type { Clock } from "../runtime.js";

/**
 * Repo-level helper that guarantees one active combat tactical map for an
 * encounter. Encounter start runs it inside the start transaction, so the map,
 * its combatant tokens and the activated encounter commit or roll back together.
 *
 * The helper deliberately does not go through the HTTP-facing map repository:
 * it reuses the persisted map row verbatim when one is already bound to the
 * encounter, and otherwise generates a v1 layout with a deterministic seed and
 * a deterministic map id, so a retried start can never create a second map.
 */

export interface EnsureCombatTacticalMapDependencies {
  readonly clock: Clock;
}

export interface EnsureCombatTacticalMapContext {
  /** Location or scene text used only to infer the layout kind. It is never persisted. */
  readonly text?: string | null;
  /** Explicit layout kind; wins over keyword inference. */
  readonly kind?: MapGeneratorKind;
}

export interface EnsureCombatTacticalMapInput {
  readonly principalId: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly encounterId: string;
  readonly context?: EnsureCombatTacticalMapContext | null;
}

export interface EnsureCombatTacticalMapResult {
  readonly mapId: string;
  readonly created: boolean;
  readonly kind: MapGeneratorKind;
  readonly seed: string;
}

const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 12;

/**
 * Keyword sets are intentionally narrow and ordered from the most specific
 * environment to the least. Anything else falls back to the neutral arena.
 */
const KIND_KEYWORDS: ReadonlyArray<readonly [MapGeneratorKind, RegExp]> = [
  ["underwater", /\b(underwater|under\s+water|submerged|subaquatic|oceans?|seas?|lakes?|rivers?|floods?|flooded|water)\b/i],
  ["cave", /\b(caves?|caverns?|grottos?|tunnels?|underground|burrows?|mines?)\b/i],
  ["dungeon", /\b(dungeons?|castles?|citadels?|ruins?|tombs?|crypts?|vaults?|fortresses?|catacombs?|temples?|shrines?|prisons?|strongholds?)\b/i],
];

/** Infers the combat layout kind from optional location or scene prose. */
export function inferCombatMapKind(text?: string | null): MapGeneratorKind {
  if (typeof text !== "string") return "arena";
  for (const [kind, pattern] of KIND_KEYWORDS) if (pattern.test(text)) return kind;
  return "arena";
}

/** Deterministic encounter-derived seed, stable across retries. */
export function combatMapSeed(encounterId: string): string {
  return `combat:${encounterId}`;
}

/** Deterministic map id derived from the encounter id only. */
function combatMapId(encounterId: string): string {
  return `combat-map:${createHash("sha256").update(encounterId).digest("hex").slice(0, 32)}`;
}

function mapKind(algorithm: string): MapGeneratorKind {
  const kind = algorithm.split("-v")[0];
  return kind === "dungeon" || kind === "cave" || kind === "underwater" ? kind : "arena";
}

type CombatantRow = { combatant_id: string; actor_id: string | null; team: string };

type MapIdRow = { map_id: string; seed: string; algorithm: string };
type PriorRow = { map_id: string; map_revision: number };

function combatantOrder(width: number, height: number, team: string): MapPoint[] {
  const centerY = (height - 1) / 2;
  const columns: number[] = [];
  for (let x = 1; x < width - 1; x += 1) columns.push(x);
  if (team === "enemies") columns.reverse();
  const rows = Array.from({ length: height - 2 }, (_, index) => index + 1)
    .sort((a, b) => Math.abs(a - centerY) - Math.abs(b - centerY) || a - b);
  const result: MapPoint[] = [];
  for (const x of columns) for (const y of rows) result.push({ x, y });
  return result;
}

/**
 * Places all active combatants on distinct open cells, allies from the left and
 * enemies from the right. Throws when the generated layout cannot hold them.
 */
function placeCombatants(tiles: ReturnType<typeof generateTacticalMap>["tiles"], width: number, height: number,
  combatants: readonly CombatantRow[]): Array<{ combatant: CombatantRow; position: MapPoint }> {
  const index = tileIndex({ tiles });
  const open = (position: MapPoint) => footprintCells(position, { width: 1, height: 1 })
    .every((cell) => index.get(pointKey(cell))?.blocksMovement === false);
  const occupied = new Set<string>();
  const placed: Array<{ combatant: CombatantRow; position: MapPoint }> = [];
  for (const combatant of combatants) {
    const primary = combatantOrder(width, height, combatant.team);
    const fallback = combatantOrder(width, height, combatant.team === "enemies" ? "allies" : "enemies");
    const position = [...primary, ...fallback].find((candidate) => !occupied.has(pointKey(candidate)) && open(candidate));
    if (!position) throw new Error("combat map has no room for its combatant tokens");
    occupied.add(pointKey(position));
    placed.push({ combatant, position });
  }
  return placed;
}

function actorLabel(db: DatabaseDriver.Database, campaignId: string, actorId: string): string | null {
  const row = db.prepare(`SELECT persona.name
    FROM campaign_actors actor
    JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
    JOIN characters persona ON persona.id=character.character_id
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as { name: string } | undefined;
  return row?.name?.trim() ? row.name : null;
}

function enemyLabel(db: DatabaseDriver.Database, encounterId: string, combatantId: string): string | null {
  // A target-initiated NPC label names the specific NPC; the enemy-template
  // name is only the fallback for GM-created encounters.
  const stored = db.prepare(`SELECT label FROM encounter_combatant_label_v67
    WHERE encounter_id=? AND combatant_id=?`).get(encounterId, combatantId) as { label: string } | undefined;
  if (stored?.label?.trim()) return stored.label;
  const row = db.prepare(`SELECT visibility.public_definition_json
    FROM encounter_enemy_provenance_v31 provenance
    JOIN rpg_catalog_definition_visibility visibility
      ON visibility.pack_id=provenance.pack_id AND visibility.pack_version=provenance.pack_version
      AND visibility.kind=provenance.kind AND visibility.definition_id=provenance.definition_id
    WHERE provenance.encounter_id=? AND provenance.combatant_id=? AND visibility.publicly_reachable=1`)
    .get(encounterId, combatantId) as { public_definition_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.public_definition_json) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Ensures an active combat map bound to `encounterId` exists, reusing the
 * persisted map and its tokens when one is already active for the encounter.
 */
export function ensureCombatTacticalMap(
  db: DatabaseDriver.Database,
  deps: EnsureCombatTacticalMapDependencies,
  input: EnsureCombatTacticalMapInput,
): EnsureCombatTacticalMapResult {
  const run = (): EnsureCombatTacticalMapResult => {
    const { principalId, campaignId, sessionId, encounterId } = input;
    const role = (db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined)?.role;
    if (role !== "owner" && role !== "gm") throw new Error("combat map generation requires GM authority");
    if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, sessionId)) {
      throw new Error("combat map session binding is unavailable");
    }
    const encounter = db.prepare("SELECT campaign_id,session_id FROM encounter WHERE encounter_id=?")
      .get(encounterId) as { campaign_id: string; session_id: string } | undefined;
    if (!encounter || encounter.campaign_id !== campaignId || encounter.session_id !== sessionId) {
      throw new Error("combat map encounter binding is unavailable");
    }
    const existing = db.prepare(`SELECT map_id,seed,algorithm FROM tactical_maps_v58
      WHERE campaign_id=? AND session_id=? AND mode='combat' AND encounter_id=? AND active=1`)
      .get(campaignId, sessionId, encounterId) as MapIdRow | undefined;
    if (existing) return { mapId: existing.map_id, created: false, kind: mapKind(existing.algorithm), seed: existing.seed };

    const combatants = db.prepare(`SELECT combatant_id,actor_id,team FROM combatant
      WHERE encounter_id=? AND status='active'
      ORDER BY initiative DESC,initiative_tiebreaker,combatant_id`).all(encounterId) as CombatantRow[];
    const kind = input.context?.kind ?? inferCombatMapKind(input.context?.text);
    const seed = combatMapSeed(encounterId);
    const width = DEFAULT_WIDTH;
    const height = Math.min(40, Math.max(DEFAULT_HEIGHT, 8 + combatants.length));
    const generated = generateTacticalMap({ kind, algorithm: `${kind}-v1`, seed, width, height });
    const placed = placeCombatants(generated.tiles, width, height, combatants);

    const prior = db.prepare("SELECT map_id,map_revision FROM tactical_maps_v58 WHERE campaign_id=? AND session_id=? AND mode='combat' AND active=1")
      .get(campaignId, sessionId) as PriorRow | undefined;
    const mapRevision = (prior?.map_revision ?? -1) + 1;
    const now = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
    const mapId = combatMapId(encounterId);
    if (prior) db.prepare("UPDATE tactical_maps_v58 SET active=0 WHERE map_id=?").run(prior.map_id);
    db.prepare(`INSERT INTO tactical_maps_v58(map_id,campaign_id,session_id,mode,encounter_id,active,map_revision,token_revision,
      width,height,algorithm,seed,provenance_hash,tiles_json,created_at) VALUES(?,?,?,?,?,1,?,0,?,?,?,?,?,?,?)`)
      .run(mapId, campaignId, sessionId, "combat", encounterId, mapRevision, generated.width, generated.height,
        generated.provenance!.algorithm, generated.provenance!.seed, generated.provenance!.hash, JSON.stringify(generated.tiles), now);
    const insertToken = db.prepare(`INSERT INTO tactical_map_tokens_v58(map_id,token_id,actor_id,combatant_id,label,x,y,width,height,
      disposition,hidden,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`);
    for (const { combatant, position } of placed) {
      const hostile = combatant.team === "enemies";
      const label = combatant.actor_id
        ? actorLabel(db, campaignId, combatant.actor_id) ?? "Combatant"
        : enemyLabel(db, encounterId, combatant.combatant_id) ?? "Enemy";
      insertToken.run(mapId, combatant.combatant_id, combatant.actor_id, combatant.combatant_id, label, position.x, position.y, 1, 1,
        hostile ? "hostile" : "friendly", 0);
    }
    // Parity with the manual generation flow: reveal the starting surroundings
    // of each actor-owned token without ever storing prose or provenance.
    const index = tileIndex({ tiles: generated.tiles });
    const explore = db.prepare("INSERT OR IGNORE INTO tactical_map_exploration_v58(map_id,actor_id,x,y,explored_at) VALUES(?,?,?,?,?)");
    for (const { combatant, position } of placed) {
      if (!combatant.actor_id) continue;
      for (const tile of generated.tiles) {
        if (Math.max(Math.abs(tile.position.x - position.x), Math.abs(tile.position.y - position.y)) <= 6
          && hasLineOfSight(position, tile.position, index)) {
          explore.run(mapId, combatant.actor_id, tile.position.x, tile.position.y, now);
        }
      }
    }
    return { mapId, created: true, kind, seed };
  };
  return db.inTransaction ? run() : db.transaction(run).immediate();
}
