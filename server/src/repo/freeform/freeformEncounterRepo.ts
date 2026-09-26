/**
 * Phase 3 free-form hostiles: bounded, exact-catalog encounter materialization.
 *
 * When the players provoke a fight the prepared campaign never defined, the
 * server — never the model — decides whether that needs a durable encounter and
 * what the closed candidate roster is. This module:
 *
 * 1. Classifies one hostile declaration deterministically (`classifyFreeformEncounter`)
 *    against public canon (the actor's public name/location and the campaign's
 *    pinned, publicly reachable `enemy-template` catalog). It returns either no
 *    intent or a bounded candidate list (currently exactly one candidate) whose
 *    identity is a deterministic digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformEncounter`):
 *    it builds one `encounterCreateRequestSchema` whose enemies are the candidate's
 *    exact pinned references, then calls the existing GM encounter lifecycle
 *    (`createEncounter` + `startEncounter`) in one caller-owned immediate
 *    transaction. The start command emits the deterministic tactical map. A
 *    failure in either half rolls back both.
 *
 * Hard invariants:
 * - **No invented stat blocks.** Every enemy combatant is an exact pinned
 *   `enemyReferences` reference read from the campaign's `campaign_catalog_current_pins`
 *   + `rpg_catalog_definition_visibility` (`kind='enemy-template'`,
 *   `publicly_reachable=1`). The embedded `reference` is re-parsed and must match
 *   the pinned row identity, so a drifted catalog fails closed. Enemy stats come
 *   only from the pinned catalog at create time (`enemyDefinition`).
 *   `monsterConceptKeys`/`participantNpcKeys` never appear here and can never
 *   satisfy the roster.
 * - **Atomic + receipted.** Creation and start go through the existing encounter
 *   command/receipt paths (`encounter_lifecycle_v31` / `combat_commands_v27` /
 *   `combat_receipts_v27`), and the start path generates the deterministic tactical
 *   map inside the same transaction. This module never writes a domain table
 *   directly. The exact-pinned create request sealed in
 *   `encounter_lifecycle_v31.canonical_create_request_json` is the durable plan
 *   record, so no separate generation draft or sidecar is required.
 * - **Idempotent via durable identities.** Both lifecycle keys are derived from
 *   `campaignId:sessionId:actorId:<normalized declaration>` plus the exact pinned
 *   roster, so a replayed attempt converges on the same encounter, combat and map
 *   through the lifecycle's own replay instead of creating a second encounter.
 * - **Public only.** The candidate roster is public catalog content; no GM-only
 *   plan data is written or exposed.
 */
import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  encounterCreateRequestSchema,
  encounterStartCommandRequestSchema,
  enemyTemplateCatalogDefinitionSchema,
  enemyTemplateCatalogReferenceSchema,
  resourceIdSchema,
  type EncounterCreateRequest,
  type EncounterStartCommandRequest,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import type {
  EncounterCombatSnapshot,
  EncounterLifecycleSnapshot,
  EncounterReceipt,
  EncounterResult,
} from "../encounter/index.js";
import { EncounterConflictError, EncounterStaleError } from "../encounter/encounterErrors.js";

/** Upper bound on combatants in one free-form hostile encounter. */
export const MAX_FREEFORM_ENCOUNTER_ENEMIES = 4;
export const MIN_FREEFORM_ENCOUNTER_ENEMIES = 1;

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformEncounterNoneReason =
  | "no-hostile-intent"
  | "no-compatible-enemy";

/** A hostile declaration's deterministic intensity band; it selects the pinned template. */
export type FreeformEncounterIntensity = "minion" | "standard" | "elite";

/** Exact pinned enemy-template reference used as an encounter combatant. */
export interface FreeformEncounterEnemyReference {
  kind: "enemy-template";
  packId: string;
  packVersion: string;
  definitionId: string;
}

/** One publicly reachable, pinned enemy template offered to the pure classifier. */
export interface FreeformEncounterEnemyTemplate {
  reference: FreeformEncounterEnemyReference;
  name: string;
  challengeRating: number;
}

/** One server-authored materialization candidate. */
export interface FreeformEncounterCandidate {
  /** Stable candidate identity derived from durable ids and the normalized declaration. */
  candidateId: string;
  /** Bounded encounter name; never model-authored. */
  encounterName: string;
  /** The initiating actor, who fights on the allies team. */
  actorId: string;
  /** The exact pinned enemy roster in deterministic order; every entry is a pinned reference. */
  enemies: readonly FreeformEncounterEnemyReference[];
  visibility: "public";
}

export type FreeformEncounterClassification =
  | { intent: "none"; reason: FreeformEncounterNoneReason }
  | { intent: "materialize-encounter"; candidates: readonly FreeformEncounterCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformEncounterMaterializedCandidate {
  candidateId: string;
  encounterName: string;
  actorId: string;
  enemies: readonly FreeformEncounterEnemyReference[];
  visibility: "public";
}

export type FreeformEncounterMaterialization =
  | { status: "declined"; reason: FreeformEncounterNoneReason }
  | {
    status: "materialized";
    candidate: FreeformEncounterMaterializedCandidate;
    encounterId: string;
    combatId: string;
    /** Deterministic combat tactical map generated by the start command. */
    tacticalMapId: string;
    /** Durable `combat_receipts_v27` receipt for encounter creation. */
    createReceipt: EncounterReceipt;
    /** Durable `combat_receipts_v27` receipt for encounter start (and map generation). */
    startReceipt: EncounterReceipt;
  };

export class FreeformEncounterAuthorizationError extends Error {}
export class FreeformEncounterConflictError extends Error {}
export class FreeformEncounterUnavailableError extends Error {}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Draws a weapon or opens a fight; used to detect a hostile declaration. */
const PROVOKE_PATTERN = /\b(?:attack|attacks|attacking|strike|strikes|striking|swing|swings|swinging|slash|slashes|slashing|stab|stabs|stabbing|charge|charges|charging|lunge|lunges|lunging|assault|assaults|assaulting|ambush|ambushes|ambushing|brawl|brawls|brawling|provoke|provokes|provoking|threaten|threatens|threatening|fight|fights|fighting|assail|assails|assailing|fire|fires|firing|shoot|shoots|shooting|open\s+fire)\b/i;
const DRAW_PATTERN = /\bdraw(?:s|ing)?\b[^.!?;]*\b(?:weapon|blade|sword|axe|bow|dagger|spear|mace|hammer|wand)\b/i;
const ELITE_PATTERN = /\b(?:elite|boss|leader|champion|chieftain|warlord|brute|veteran|giant|dragon|troll|ogre|demon|devil|drake|wyrm|lich|mastermind)\b/i;
const MINION_PATTERN = /\b(?:minion|minions|weak|weakened|vermin|swarm|swarms|rat|rats|goblin|goblins|imp|imps|drone|drones|thug|thugs|skeleton|skeletons|zombie|zombies|bat|bats|spider|spiders|kobold|kobolds)\b/i;

/** Pure, deterministic hostile-declaration detector. */
export function isFreeformEncounterProvocation(text: string): boolean {
  return PROVOKE_PATTERN.test(text) || DRAW_PATTERN.test(text);
}

/** Pure, deterministic intensity band used to pick one pinned template. */
export function deriveFreeformEncounterIntensity(text: string): FreeformEncounterIntensity {
  if (ELITE_PATTERN.test(text)) return "elite";
  if (MINION_PATTERN.test(text)) return "minion";
  return "standard";
}

function normalizeProvocation(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function encounterName(actorName: string, locationName: string | null): string {
  const subject = actorName.trim() ? actorName.trim() : "the party";
  const place = locationName && locationName.trim() ? ` at ${locationName.trim()}` : "";
  const name = `Hostile encounter for ${subject}${place}`.trim();
  return (name || "Hostile encounter").slice(0, 200);
}

/** The public projection of an enemy definition omits GM-only `private` fields. */
const publicEnemyTemplateSchema = enemyTemplateCatalogDefinitionSchema.omit({ private: true });

/** True when a supplied enemy offering is a valid, exact pinned reference. */
function isValidEnemyTemplate(enemy: FreeformEncounterEnemyTemplate): boolean {
  return enemyTemplateCatalogReferenceSchema.safeParse(enemy.reference).success
    && Number.isFinite(enemy.challengeRating) && enemy.challengeRating >= 0;
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced for a hostile declaration when the
 * campaign's pinned public catalog offers at least one exact enemy template. The
 * chosen roster is a bounded repetition of exactly one pinned reference; callers
 * cannot inject a template or a stat.
 */
export function classifyFreeformEncounter(input: {
  identity: string;
  actorId: string;
  actorName: string;
  locationName: string | null;
  text: string;
  enemies: ReadonlyArray<FreeformEncounterEnemyTemplate>;
}): FreeformEncounterClassification {
  if (!isFreeformEncounterProvocation(input.text)) return { intent: "none", reason: "no-hostile-intent" };

  const available = input.enemies
    .filter(isValidEnemyTemplate)
    .slice()
    .sort((left, right) => left.challengeRating - right.challengeRating
      || left.reference.packId.localeCompare(right.reference.packId)
      || left.reference.packVersion.localeCompare(right.reference.packVersion)
      || left.reference.definitionId.localeCompare(right.reference.definitionId));
  if (available.length === 0) return { intent: "none", reason: "no-compatible-enemy" };

  const intensity = deriveFreeformEncounterIntensity(input.text);
  const chosen = intensity === "minion"
    ? available[0]!
    : intensity === "elite"
      ? available[available.length - 1]!
      : available[Math.floor((available.length - 1) / 2)]!;

  const digest = sha256(`${input.identity}:${normalizeProvocation(input.text)}`);
  const span = MAX_FREEFORM_ENCOUNTER_ENEMIES - MIN_FREEFORM_ENCOUNTER_ENEMIES + 1;
  const count = MIN_FREEFORM_ENCOUNTER_ENEMIES + (Number.parseInt(digest.slice(0, 8), 16) % span);
  const candidate: FreeformEncounterCandidate = {
    candidateId: `ffe-${digest.slice(0, 40)}`,
    encounterName: encounterName(input.actorName, input.locationName),
    actorId: input.actorId,
    enemies: Array.from({ length: count }, () => chosen.reference),
    visibility: "public",
  };
  return { intent: "materialize-encounter", candidates: [candidate] };
}

/** Narrow ports so the module reuses existing encounter commands without importing their full surface. */
export interface FreeformEncounterPorts {
  createEncounter(principalId: string, campaignId: string, input: EncounterCreateRequest):
    EncounterResult<{ campaignId: string; encounter: EncounterLifecycleSnapshot }>;
  startEncounter(principalId: string, encounterId: string, input: EncounterStartCommandRequest):
    EncounterResult<{ campaignId: string; encounterId: string; combat: EncounterCombatSnapshot }>;
}

export interface FreeformEncounterRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformEncounterIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformEncounterClassification;
  /** Creates and starts the exact server-authored candidate atomically. */
  materializeFreeformEncounter(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformEncounterMaterialization;
}

type EnemyVisibilityRow = { pack_id: string; pack_version: string; definition_id: string; public_definition_json: string };

export function createFreeformEncounterRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformEncounterPorts,
  guard: () => void,
): FreeformEncounterRepository {
  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformEncounterAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformEncounterAuthorizationError("principal cannot act for the actor");
  }

  /** Resolves GM materialization authority exactly as `initiateCombat` does. */
  function gmAuthorityPrincipal(principalId: string, campaignId: string): string | null {
    if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')")
      .get(campaignId, principalId)) return principalId;
    const row = db.prepare(`SELECT membership.principal_id principal_id FROM campaign_memberships membership
      JOIN campaigns campaign ON campaign.id=membership.campaign_id
      WHERE membership.campaign_id=? AND membership.role IN ('owner','gm')
      ORDER BY CASE WHEN membership.principal_id=campaign.owner_principal_id THEN 0 ELSE 1 END,membership.principal_id
      LIMIT 1`).get(campaignId) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
  }

  function actorName(campaignId: string, actorId: string): string | null {
    const row = db.prepare(`SELECT persona.name name FROM campaign_actors actor
      JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
      JOIN characters persona ON persona.id=character.character_id
      WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as { name: string } | undefined;
    return row?.name?.trim() ? row.name : null;
  }

  function currentLocationName(campaignId: string, sessionId: string, actorId: string): string | null {
    const row = db.prepare(`SELECT location.public_name name FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * Reads the closed, public, pinned enemy-template set. The embedded `reference`
   * must match the pinned row identity, so a drifted catalog row is dropped.
   */
  function readCatalogEnemies(campaignId: string): FreeformEncounterEnemyTemplate[] {
    const rows = db.prepare(`SELECT visibility.pack_id,visibility.pack_version,visibility.definition_id,visibility.public_definition_json
      FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND visibility.kind='enemy-template' AND visibility.publicly_reachable=1
      ORDER BY visibility.pack_id,visibility.pack_version,visibility.definition_id`).all(campaignId) as EnemyVisibilityRow[];
    const enemies: FreeformEncounterEnemyTemplate[] = [];
    for (const row of rows) {
      let parsed: ReturnType<typeof publicEnemyTemplateSchema.parse>;
      try {
        parsed = publicEnemyTemplateSchema.parse(JSON.parse(row.public_definition_json));
      } catch {
        continue;
      }
      const reference = parsed.reference;
      if (reference.packId !== row.pack_id || reference.packVersion !== row.pack_version
        || reference.definitionId !== row.definition_id) continue;
      const challengeRating = typeof parsed.mechanics.challengeRating === "number"
        ? parsed.mechanics.challengeRating
        : parsed.mechanics.tier;
      enemies.push({ reference, name: parsed.name, challengeRating });
    }
    return enemies;
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformEncounterClassification {
    return classifyFreeformEncounter({
      identity, actorId,
      actorName: actorName(campaignId, actorId) ?? "the party",
      locationName: currentLocationName(campaignId, sessionId, actorId),
      text,
      enemies: readCatalogEnemies(campaignId),
    });
  }

  function readTacticalMapId(campaignId: string, sessionId: string, encounterId: string): string {
    const row = db.prepare(`SELECT map_id FROM tactical_maps_v58
      WHERE campaign_id=? AND session_id=? AND mode='combat' AND encounter_id=? AND active=1`)
      .get(campaignId, sessionId, encounterId) as { map_id: string } | undefined;
    if (!row) throw new FreeformEncounterConflictError("started encounter has no tactical map");
    return row.map_id;
  }

  return {
    classifyFreeformEncounterIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformEncounter(principalId, campaignId, sessionId, actorId, text, options): FreeformEncounterMaterialization {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      if (!isFreeformEncounterProvocation(text)) return { status: "declined" as const, reason: "no-hostile-intent" };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${normalizeProvocation(text)}`);

      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformEncounterUnavailableError("campaign has no GM authority to materialize an encounter");

      return db.transaction((): FreeformEncounterMaterialization => {
        // Freshness re-check: only materialize a roster the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidateId = `ffe-${digest.slice(0, 40)}`;
        if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
          throw new FreeformEncounterConflictError("the chosen candidate is not in the server-authored set");
        }
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) return { status: "declined" as const, reason: "no-compatible-enemy" };

        // Both keys are derived from durable identities plus the freshly read exact roster.
        const rosterDigest = sha256(canonical({ kind: "freeform-materialize-encounter", campaignId, sessionId, actorId, enemies: candidate.enemies })).slice(0, 40);
        const createKey = `freeform-encounter:create:${rosterDigest}`;
        const startKey = `freeform-encounter:start:${rosterDigest}`;

        const createRequest = encounterCreateRequestSchema.parse({
          sessionId,
          name: candidate.encounterName,
          combatants: [
            { kind: "actor", actorId, team: "allies" },
            ...candidate.enemies.map((template) => ({ kind: "enemy" as const, template, team: "enemies" as const })),
          ],
          idempotencyKey: createKey,
        });
        // The encounter lifecycle requires GM authority; the player intent was authorized above.
        // A session that already has an open encounter (or a stale create) is a bounded conflict,
        // never an unexpected 500: translate the engine's own conflict/stale errors.
        let created: ReturnType<FreeformEncounterPorts["createEncounter"]>;
        let started: ReturnType<FreeformEncounterPorts["startEncounter"]>;
        try {
          created = ports.createEncounter(authority, campaignId, createRequest);
          started = ports.startEncounter(authority, created.encounter.encounterId, encounterStartCommandRequestSchema.parse({
            expectedRevision: created.encounter.revision,
            idempotencyKey: startKey,
          }));
        } catch (error) {
          if (error instanceof EncounterConflictError || error instanceof EncounterStaleError) {
            throw new FreeformEncounterConflictError("the session already has an open encounter or cannot start another right now");
          }
          throw error;
        }

        return {
          status: "materialized" as const,
          candidate: { candidateId, encounterName: candidate.encounterName, actorId,
            enemies: candidate.enemies, visibility: "public" as const },
          encounterId: started.encounterId,
          combatId: started.combat.combatId,
          tacticalMapId: readTacticalMapId(campaignId, sessionId, started.encounterId),
          createReceipt: created.receipt,
          startReceipt: started.receipt,
        };
      }).immediate();
    },
  };
}
