import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type {
  CampaignAgentAudience,
  CampaignAgentContextSnapshot,
} from "../../context.js";
import { CAMPAIGN_COMPANION_CONTEXT_SUPPORTED } from "../../context.js";
import { buildCombatActionPlans } from "../encounter/combatActionPlan.js";
import { createCampaignPlayReadRepository } from "./campaignPlayReadRepo.js";

const MAX_CAMPAIGN_CONTEXT_COMBATANTS = 32;

interface EncounterRow {
  encounter_id: string;
  name: string;
  status: string;
  round_number: number;
  current_turn_combatant_id: string | null;
  revision: number;
}

interface CombatantRow {
  combatant_id: string;
  actor_id: string | null;
  combatant_kind: "actor" | "enemy";
  team: "allies" | "enemies";
  hit_points: number;
  maximum_hit_points: number;
  status: string;
  enemy_tactic: string;
  name: string | null;
  definition_id: string | null;
}

/** Role-sensitive campaign context snapshot reads over a caller-owned connection. */
export interface CampaignAgentContextReadRepository {
  /** Returns null whenever membership, audience authority, target control, or ancestry is unavailable. */
  getCampaignAgentContextSnapshot(
    principalId: string,
    campaignId: string,
    sessionId: string,
    audience: CampaignAgentAudience,
  ): CampaignAgentContextSnapshot | null;
}

/** Creates the focused campaign-agent snapshot reader. Transaction ownership remains with the facade. */
export function createCampaignAgentContextReadRepository(
  db: DatabaseDriver.Database,
): CampaignAgentContextReadRepository {
  const campaignPlay = createCampaignPlayReadRepository(db);
  return {
    getCampaignAgentContextSnapshot(principalId, campaignId, sessionId, audience) {
      const principal = resourceIdSchema.parse(principalId);
      const campaign = resourceIdSchema.parse(campaignId);
      let play: ReturnType<typeof campaignPlay.getCampaignPlayBootstrap>;
      try {
        play = campaignPlay.getCampaignPlayBootstrap(principal, campaign, sessionId);
      } catch (error) {
        // Agent context is a disclosure boundary: malformed or downgraded
        // control ancestry fails closed rather than yielding a partial basket.
        if (error instanceof Error && error.message === "campaign play bootstrap is malformed") return null;
        throw error;
      }
      if (!play || play.principal.role === "observer") return null;
      const isGm = play.principal.role === "owner" || play.principal.role === "gm";
      let targetActorId: string | null = null;
      let targetNpcId: string | null = null;
      let targetEnemyId: string | null = null;
      let targetName = "Dungeon Master";
      let speakerPersona: CampaignAgentContextSnapshot["speakerPersona"] = null;

      if (audience.kind === "companion") {
        // There is no persisted companion aggregate or controller binding. A
        // superficially actor-shaped ID must never be treated as a companion.
        if (CAMPAIGN_COMPANION_CONTEXT_SUPPORTED) throw new Error("companion context capability is inconsistent");
        return null;
      }
      if (audience.kind === "dm") {
        if (!isGm) return null;
      } else if (audience.kind === "player") {
        targetActorId = resourceIdSchema.parse(audience.actorId);
        if (!play.playableActors.some((actor) => actor.actorId === targetActorId)) return null;
        const target = db.prepare(`SELECT character.id character_id,character.name FROM campaign_actors actor
          JOIN campaign_characters campaign_character ON campaign_character.campaign_id=actor.campaign_id
            AND campaign_character.id=actor.campaign_character_id
          JOIN characters character ON character.id=campaign_character.character_id
          JOIN campaign_actor_private_state private ON private.campaign_id=actor.campaign_id AND private.actor_id=actor.id
          WHERE actor.campaign_id=? AND actor.id=?`)
          .get(campaign, targetActorId) as { character_id: string; name: string } | undefined;
        if (!target) return null;
        targetName = target.name;
        speakerPersona = { characterId: target.character_id, displayName: target.name };
      } else if (audience.kind === "npc") {
        if (!isGm) return null;
        targetNpcId = resourceIdSchema.parse(audience.npcId);
        const target = db.prepare(`SELECT npc.persona_id,character.name persona_name,npc.public_name
          FROM campaign_npcs_v28 npc JOIN characters character ON character.id=npc.persona_id
          WHERE npc.campaign_id=? AND npc.npc_id=?`)
          .get(campaign, targetNpcId) as { persona_id: string; persona_name: string; public_name: string } | undefined;
        if (!target) return null;
        targetName = target.public_name;
        speakerPersona = { characterId: target.persona_id, displayName: target.persona_name };
      } else {
        if (!isGm) return null;
        targetEnemyId = resourceIdSchema.parse(audience.combatantId);
        const target = db.prepare(`SELECT combatant.combatant_id FROM combatant
          JOIN encounter ON encounter.encounter_id=combatant.encounter_id
          WHERE encounter.campaign_id=? AND encounter.session_id=? AND encounter.status='active'
            AND combatant.combatant_id=? AND combatant.combatant_kind='enemy' AND combatant.status='active'`)
          .get(campaign, sessionId, targetEnemyId) as { combatant_id: string } | undefined;
        if (!target) return null;
        targetName = `Enemy ${targetEnemyId}`;
      }

      const canon = db.prepare("SELECT source_of_truth,synthesized_source FROM session_context WHERE session_id=?")
        .get(sessionId) as { source_of_truth: string; synthesized_source: string } | undefined;
      const humanCanon = canon?.source_of_truth.trim() ? canon.source_of_truth.split(/\r?\n/) : [];
      const synthesizedSummaryFacts = canon?.synthesized_source.trim() ? canon.synthesized_source.split(/\r?\n/) : [];

      const encounter = db.prepare(`SELECT encounter.encounter_id,lifecycle.name,encounter.status,
          encounter.round_number,encounter.current_turn_combatant_id,revision.revision
        FROM encounter JOIN encounter_lifecycle_v31 lifecycle USING(encounter_id)
        JOIN combat_mutation_revisions_v27 revision USING(encounter_id)
        WHERE encounter.campaign_id=? AND encounter.session_id=? AND encounter.status='active'`)
        .get(campaign, sessionId) as EncounterRow | undefined;
      const combatants = encounter ? db.prepare(`SELECT combatant.combatant_id,combatant.actor_id,
          combatant.combatant_kind,combatant.team,combatant.hit_points,combatant.maximum_hit_points,
          combatant.status,combatant.enemy_tactic,character.name,provenance.definition_id
        FROM combatant
        LEFT JOIN campaign_actors actor ON actor.campaign_id=combatant.campaign_id AND actor.id=combatant.actor_id
        LEFT JOIN campaign_characters campaign_character ON campaign_character.campaign_id=actor.campaign_id
          AND campaign_character.id=actor.campaign_character_id
        LEFT JOIN characters character ON character.id=campaign_character.character_id
        LEFT JOIN encounter_enemy_provenance_v31 provenance ON provenance.encounter_id=combatant.encounter_id
          AND provenance.combatant_id=combatant.combatant_id
        WHERE combatant.encounter_id=? ORDER BY combatant.combatant_id COLLATE BINARY LIMIT ?`)
        .all(encounter.encounter_id, MAX_CAMPAIGN_CONTEXT_COMBATANTS + 1) as CombatantRow[] : [];
      if (combatants.length > MAX_CAMPAIGN_CONTEXT_COMBATANTS) return null;

      const committedMechanics: string[] = encounter ? [
        `Active encounter ${encounter.name}; revision ${encounter.revision}; round ${encounter.round_number}.`,
        `Current combatant: ${encounter.current_turn_combatant_id ?? "none"}.`,
        ...combatants.map((row) => `${row.name ?? `Enemy ${row.combatant_id}`}: HP ${row.hit_points}/${row.maximum_hit_points}; status ${row.status}; team ${row.team}.`),
      ] : ["No active encounter is committed for this session."];

      const castRows = db.prepare(`SELECT character.name,actor.id actor_id,location.public_name location_name,
          location.visibility location_visibility,discovery.actor_id discovered_actor_id
        FROM session_characters participant JOIN characters character ON character.id=participant.character_id
        LEFT JOIN campaign_characters campaign_character ON campaign_character.campaign_id=?
          AND campaign_character.character_id=participant.character_id
        LEFT JOIN campaign_actors actor ON actor.campaign_id=? AND actor.campaign_character_id=campaign_character.id
        LEFT JOIN campaign_actor_locations_v28 actor_location ON actor_location.campaign_id=?
          AND actor_location.session_id=? AND actor_location.actor_id=actor.id
        LEFT JOIN campaign_locations_v28 location ON location.campaign_id=actor_location.campaign_id
          AND location.location_id=actor_location.location_id
        LEFT JOIN campaign_location_discoveries_v28 discovery ON discovery.campaign_id=location.campaign_id
          AND discovery.location_id=location.location_id AND discovery.actor_id=actor.id
        WHERE participant.session_id=? ORDER BY participant.position,participant.character_id COLLATE BINARY LIMIT 12`)
        .all(campaign, campaign, campaign, sessionId, sessionId) as Array<{ name: string; actor_id: string | null;
          location_name: string | null; location_visibility: string | null; discovered_actor_id: string | null }>;
      const canSeeCastLocation = (row: typeof castRows[number]) => audience.kind === "dm"
        || (audience.kind === "player" && row.actor_id === targetActorId
          && (row.location_visibility === "public"
            || (row.location_visibility === "discovered" && row.discovered_actor_id === targetActorId)));
      const visibleCast = castRows.map((row) => `${row.name}${canSeeCastLocation(row) && row.location_name ? ` at ${row.location_name}` : ""}.`);

      const locationRows = audience.kind === "dm"
        ? db.prepare(`SELECT DISTINCT location.public_name,location.public_description FROM campaign_actor_locations_v28 actor_location
            JOIN campaign_locations_v28 location ON location.campaign_id=actor_location.campaign_id AND location.location_id=actor_location.location_id
            WHERE actor_location.campaign_id=? AND actor_location.session_id=?
            ORDER BY location.public_name COLLATE BINARY,location.location_id COLLATE BINARY LIMIT 12`).all(campaign, sessionId)
        : audience.kind === "player" && targetActorId
          ? db.prepare(`SELECT location.public_name,location.public_description FROM campaign_actor_locations_v28 current
              JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
              LEFT JOIN campaign_location_discoveries_v28 discovery ON discovery.campaign_id=location.campaign_id
                AND discovery.location_id=location.location_id AND discovery.actor_id=current.actor_id
              WHERE current.campaign_id=? AND current.session_id=? AND current.actor_id=?
                AND (location.visibility='public' OR (location.visibility='discovered' AND discovery.actor_id IS NOT NULL))
              ORDER BY location.location_id COLLATE BINARY LIMIT 1`).all(campaign, sessionId, targetActorId)
          : [];
      const visibleWorld = (locationRows as Array<{ public_name: string; public_description: string }>).map((row) =>
        `${row.public_name}${row.public_description.trim() ? ` — ${row.public_description}` : ""}`);

      const questRows = db.prepare(`SELECT quest.title,quest.description,quest.status FROM quests quest
        LEFT JOIN quest_definitions_v33 definition ON definition.campaign_id=quest.campaign_id AND definition.quest_id=quest.id
        WHERE quest.campaign_id=? AND quest.status IN ('open','active')
          AND (? OR definition.visibility='public')
        ORDER BY quest.sort_order,quest.id COLLATE BINARY LIMIT 32`).all(campaign, audience.kind === "dm" ? 1 : 0) as
        Array<{ title: string; description: string | null; status: string }>;
      const visibleQuests = questRows.map((row) => `${row.title} (${row.status})${row.description ? ` — ${row.description}` : ""}`);

      const recapRows = db.prepare(`SELECT recap.text FROM campaign_recaps recap
        WHERE recap.campaign_id=? AND (? OR recap.visibility='members')
          AND (json_array_length(recap.selected_session_ids)=0 OR EXISTS(
            SELECT 1 FROM json_each(recap.selected_session_ids) selected WHERE selected.value=?))
        ORDER BY recap.created_at DESC,recap.id COLLATE BINARY DESC LIMIT 3`).all(campaign, audience.kind === "dm" ? 1 : 0, sessionId) as Array<{ text: string }>;
      const recap = recapRows.reverse().flatMap((row) => row.text.split(/\r?\n/));

      let legalActions: string[] = [];
      if (encounter) {
        const current = combatants.find((row) => row.combatant_id === encounter.current_turn_combatant_id);
        const audienceOwnsCurrent = audience.kind === "dm"
          || (audience.kind === "player" && current?.actor_id === targetActorId)
          || (audience.kind === "enemy" && current?.combatant_id === targetEnemyId);
        if (audienceOwnsCurrent) {
          legalActions = buildCombatActionPlans(db, principal, campaign, encounter.encounter_id,
            encounter.current_turn_combatant_id).map((plan) =>
            `${plan.legalActionId}; acting combatant ${plan.actingCombatantId}; targets ${plan.targetIds.length ? plan.targetIds.join(", ") : "none"}.`);
        }
      }

      const privateTargetFacts: string[] = [];
      if (targetActorId) {
        const actor = db.prepare(`SELECT private.private_notes,actor.sheet_id FROM campaign_actors actor
          JOIN campaign_actor_private_state private ON private.campaign_id=actor.campaign_id AND private.actor_id=actor.id
          WHERE actor.campaign_id=? AND actor.id=?`)
          .get(campaign, targetActorId) as { private_notes: string | null; sheet_id: string };
        privateTargetFacts.push(`Target player: ${targetName}.`);
        if (actor.private_notes?.trim()) privateTargetFacts.push(`Target notes: ${actor.private_notes}`);
        const attributes = db.prepare(`SELECT attribute_id,value FROM rpg_character_attributes
          WHERE campaign_id=? AND sheet_id=? ORDER BY position LIMIT 64`).all(campaign, actor.sheet_id) as Array<{ attribute_id: string; value: number }>;
        privateTargetFacts.push(...attributes.map((row) => `Target attribute ${row.attribute_id}: ${row.value}.`));
      } else if (targetNpcId) {
        const npc = db.prepare(`SELECT private.private_goals
          FROM campaign_npcs_v28 npc
          LEFT JOIN campaign_npc_private_state_v28 private ON private.campaign_id=npc.campaign_id AND private.npc_id=npc.npc_id
          WHERE npc.campaign_id=? AND npc.npc_id=?`).get(campaign, targetNpcId) as
          { private_goals: string | null };
        privateTargetFacts.push(`Target NPC: ${targetName}.`);
        if (npc.private_goals?.trim()) privateTargetFacts.push(`Target goals: ${npc.private_goals}`);
      } else if (targetEnemyId) {
        const enemy = combatants.find((row) => row.combatant_id === targetEnemyId);
        if (!enemy) return null;
        privateTargetFacts.push(`Target enemy: ${targetName}.`, `Target tactic: ${enemy.enemy_tactic}.`);
        if (enemy.definition_id) privateTargetFacts.push(`Target template reference: ${enemy.definition_id}.`);
      }

      return {
        campaignId: campaign,
        sessionId,
        audience,
        authority: { role: play.principal.role, control: play.principal.control },
        speakerPersona,
        safetyControl: [
          `Audience is ${audience.kind}; campaign role is ${play.principal.role}; derived control is ${play.principal.control}.`,
          `Speak only for ${targetName}; never invent control, permissions, receipts, or committed outcomes.`,
          "Do not reveal controller identities, hidden routes, unrelated NPC secrets, catalogs, inventories, or story graphs.",
        ],
        humanCanon,
        committedMechanics,
        visibleWorld,
        visibleCast,
        visibleQuests,
        legalActions,
        privateTargetFacts,
        synthesizedSummaryFacts,
        recap,
      };
    },
  };
}
