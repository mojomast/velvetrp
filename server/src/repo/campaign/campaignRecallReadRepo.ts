import { createHash } from "node:crypto";
import { canonicalAgentJson } from "@velvet/contracts";
import type DatabaseDriver from "better-sqlite3";
import type { CampaignAgentAudience, CampaignAgentContextSnapshot } from "../../context.js";
import { publicStoryResourceSql } from "../storyDisclosure.js";

export interface CampaignRecallQuery {
  campaignId: string;
  sessionId: string;
  audience: CampaignAgentAudience;
  query: string;
  purpose: "adventure-planning" | "public-narration" | "dm-planning" | "dm-narration";
  excludeRootTurnId?: string;
}
export interface CampaignRecallHit {
  sourceKind: "declaration" | "presentation" | "recap" | "director-receipt" | "check-receipt" | "inventory-receipt" | "commerce-receipt" | "action-receipt" | "travel-receipt" | "mechanic-receipt" | "combat-receipt" | "quest-receipt";
  authority: "intent" | "noncanonical-presentation" | "authored-recap" | "committed-outcome";
  sourceId: string;
  digest: string;
  sessionId: string | null;
  timelineId: string;
  rootTurnId: string | null;
  actorId: string | null;
  text: string;
}
export interface CampaignRecallResult {
  version: "recall-v1";
  query: string;
  scopeDigest: string;
  hits: CampaignRecallHit[];
  /** Direct SQL scans are not work-bounded; only matching materialized records and output are bounded. */
  scan: "direct-sql-unbounded";
  /** Sources over 2048 bytes and unproven inherited domain/message history are not searched in v1. */
  coverage: "bounded-records-active-timeline";
  incomplete: boolean;
}
export interface CampaignRecallReadRepository {
  getCampaignRecall(principalId: string, input: CampaignRecallQuery): CampaignRecallResult | null;
}
export const CAMPAIGN_RECALL_MAX_BYTES = 6_144;
const sha = (value: unknown) => createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stop = new Set("a an and are as at be been did do does for from had has have how i in is it me my of on or our recall remember said say that the their them then there these they this to us was we were what when where which who why with you your happened about tell please before after".split(" "));

/** Read-time authorization precedes ranking. The index-free v1 deliberately makes no SQL scan-cost guarantee. */
export function createCampaignRecallReadRepository(db: DatabaseDriver.Database, services: {
  getCampaignAgentContextSnapshot(principal: string, campaign: string, session: string, audience: CampaignAgentAudience): CampaignAgentContextSnapshot | null;
  getAdventureCheckPublicReceipt(principal: string, campaign: string, command: string): unknown;
  getAdventureReceipt(principal: string, turn: string, command: string, kind: CampaignRecallHit["sourceKind"]): unknown;
  getMechanicReceipt(principal: string, campaign: string, command: string): unknown;
}): CampaignRecallReadRepository {
  return { getCampaignRecall(principal, input) {
    return db.transaction(() => {
      if (input.purpose === "public-narration" && input.audience.kind !== "player") return null;
      if (input.purpose.startsWith("dm-") && input.audience.kind !== "dm") return null;
      const snapshot = services.getCampaignAgentContextSnapshot(principal, input.campaignId, input.sessionId, input.audience);
      if (!snapshot) return null;
      let query = "";
      for (const character of normalize(input.query.slice(0, 512))) {
        if (query.length + character.length > 512 || Buffer.byteLength(query + character) > 1_024) break;
        query += character;
      }
      const terms = [...new Set(query.split(" ").filter(term => term.length > 1 && !stop.has(term) && Buffer.byteLength(term) <= 64))].slice(0, 12);
      const result: CampaignRecallResult = { version: "recall-v1", query,
        scopeDigest: sha([input.campaignId, input.sessionId, input.audience, input.purpose, snapshot.authority,
          snapshot.timelineId, snapshot.timelineRevision, snapshot.campaignRevision]), hits: [], scan: "direct-sql-unbounded",
        coverage: "bounded-records-active-timeline", incomplete: false };
      if (!terms.length) return result;
      // Literal word/phrase matching, never caller-supplied SQL or FTS syntax.
      db.function("velvet_recall_score", { deterministic: true }, (value: unknown) => {
        if (typeof value !== "string") return 0;
        const text = ` ${normalize(value)} `;
        const count = terms.filter(term => text.includes(` ${term} `)
          || (term === "now" && text.includes(" current "))).length;
        return count ? count * 10 + (text.includes(` ${terms.join(" ")} `) ? 20 : 0) : 0;
      });
      const dm = input.audience.kind === "dm";
      const actor = input.audience.kind === "player" ? input.audience.actorId : null;
      const publicOnly = input.purpose === "dm-narration";
      const rows = db.prepare(`WITH RECURSIVE eligible AS (
        SELECT turn.* FROM adventure_turns turn
        JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
        WHERE turn.campaign_id=@campaign AND turn.timeline_id=@timeline AND turn.mode='original'
          AND turn.id<>@excluded AND (@dm OR turn.actor_id=@actor)
      ), ancestry(root,id,depth) AS (
        SELECT id,id,0 FROM eligible UNION ALL
        SELECT ancestry.root,child.id,ancestry.depth+1 FROM ancestry JOIN adventure_turns child ON child.prior_turn_id=ancestry.id
          AND child.campaign_id=@campaign AND child.timeline_id=@timeline AND child.mode<>'original' WHERE ancestry.depth<32
      ), presentations AS (
        SELECT turn.id root,command.command_id, json_extract(command.request_json,'$.fallbackNarration') text,
          row_number() OVER(PARTITION BY turn.id ORDER BY ancestry.depth DESC,command.created_at DESC,command.command_id) position
        FROM eligible turn JOIN ancestry ON ancestry.root=turn.id JOIN adventure_coordination_commands_v36 command
          ON command.campaign_id=turn.campaign_id AND command.aggregate_id=ancestry.id AND command.aggregate_kind='turn'
          AND command.mutation_type='narration-update'
        WHERE json_type(command.request_json,'$.fallbackNarration')='text' AND EXISTS (
          SELECT 1 FROM adventure_coordination_events_v36 event WHERE event.campaign_id=turn.campaign_id
            AND event.aggregate_id=ancestry.id AND event.aggregate_kind='turn' AND event.resulting_state='completed'
            AND event.resulting_revision=(SELECT max(latest.resulting_revision) FROM adventure_coordination_events_v36 latest
              WHERE latest.campaign_id=turn.campaign_id AND latest.aggregate_kind='turn' AND latest.aggregate_id=ancestry.id))
      ), sources AS (
        SELECT 'declaration' sourceKind,'intent' authority,id sourceId,session_id sessionId,timeline_id timelineId,
          id rootTurnId,actor_id actorId,declaration text FROM eligible WHERE NOT @publicOnly
        UNION ALL
        SELECT 'presentation','noncanonical-presentation',presentation.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          presentation.text FROM eligible turn JOIN presentations presentation ON presentation.root=turn.id
        WHERE NOT @dm AND presentation.position=1
        UNION ALL
        SELECT 'check-receipt','committed-outcome',execution.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          execution.public_result_json FROM eligible turn JOIN adventure_check_executions_v54 execution
          ON execution.campaign_id=turn.campaign_id AND execution.turn_id=turn.id WHERE NOT @publicOnly
        UNION ALL
        SELECT 'inventory-receipt','committed-outcome',execution.inventory_command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          execution.public_result_json FROM eligible turn JOIN adventure_inventory_executions_v55 execution
          ON execution.campaign_id=turn.campaign_id AND execution.turn_id=turn.id WHERE NOT @publicOnly
        UNION ALL
        SELECT 'commerce-receipt','committed-outcome',execution.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          execution.public_result_json FROM eligible turn JOIN adventure_commerce_executions_v57 execution
          ON execution.campaign_id=turn.campaign_id AND execution.turn_id=turn.id WHERE NOT @publicOnly
        UNION ALL
        SELECT 'action-receipt','committed-outcome',execution.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          execution.public_result_json FROM eligible turn JOIN adventure_exact_action_executions_v56 execution
          ON execution.campaign_id=turn.campaign_id AND execution.turn_id=turn.id
        JOIN adventure_exact_action_candidates_v56 candidate ON candidate.candidate_id=execution.candidate_id
          AND candidate.campaign_id=turn.campaign_id AND candidate.turn_id=turn.id
        WHERE NOT @publicOnly AND (@dm OR execution.action_kind NOT LIKE 'quest-%' OR EXISTS(
          SELECT 1 FROM quest_definitions_v33 definition WHERE definition.campaign_id=turn.campaign_id
            AND definition.quest_id=json_extract(candidate.private_json,'$.questId') AND definition.visibility='public'
            AND (execution.action_kind<>'quest-reward' OR EXISTS(SELECT 1 FROM quest_reward_definitions_v33 reward
              WHERE reward.campaign_id=definition.campaign_id AND reward.quest_id=definition.quest_id
                AND reward.reward_id=json_extract(candidate.private_json,'$.rewardId') AND reward.visibility='public'))))
        UNION ALL
        SELECT 'combat-receipt','committed-outcome',link.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          json_extract(receipt.canonical_result_json,'$.resolution') FROM eligible turn JOIN agent_generalized_receipts_v39 link
          ON link.campaign_id=turn.campaign_id AND link.turn_id=turn.id AND link.receipt_family='combat'
        JOIN combat_receipts_v27 receipt ON receipt.encounter_id=link.encounter_id AND receipt.command_id=link.command_id
          AND receipt.resulting_revision=link.revision_after WHERE NOT @publicOnly
        UNION ALL
        SELECT 'quest-receipt','committed-outcome',command.command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          json_object('questTitle',json_extract(candidate.value,'$.questTitle'),'objectiveDescription',objective.description)
        FROM eligible turn JOIN agent_provider_responses_v39 response ON response.campaign_id=turn.campaign_id AND response.turn_id=turn.id
          AND response.status='succeeded' AND json_array_length(response.response_json,'$.calls')=1
          AND json_extract(response.response_json,'$.calls[0].toolName')='exact_quest_objective.select'
        JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
        JOIN quest_domain_commands_v33 command ON command.campaign_id=turn.campaign_id AND command.principal_id=turn.principal_id
          AND command.command_type='advance-objective' AND command.idempotency_key='adventure-quest:'||substr(response.provider_call_id,-32)||':'
            ||substr(json_extract(response.response_json,'$.calls[0].arguments.candidateId'),-32)
        JOIN quest_definitions_v33 definition ON definition.campaign_id=command.campaign_id AND definition.quest_id=command.quest_id AND definition.visibility='public'
        JOIN quest_objectives_v33 objective ON objective.campaign_id=command.campaign_id AND objective.quest_id=command.quest_id
          AND objective.objective_id=json_extract(command.canonical_request_json,'$.objectiveId') AND objective.visibility='public'
        JOIN json_each(context.request_json,'$.questCandidateProjection.candidates') candidate
          ON json_extract(candidate.value,'$.candidateId')=json_extract(response.response_json,'$.calls[0].arguments.candidateId')
        WHERE NOT @publicOnly
        UNION ALL
        SELECT 'travel-receipt','committed-outcome',binding.world_command_id,turn.session_id,turn.timeline_id,turn.id,turn.actor_id,
          location.public_name FROM eligible turn JOIN exact_candidate_provider_bindings_v48 binding
          ON binding.campaign_id=turn.campaign_id AND binding.turn_id=turn.id
        JOIN exact_candidate_executions_v47 execution ON execution.execution_id=binding.execution_id AND execution.turn_id=turn.id
        JOIN world_travel_destinations_v28 destination ON destination.campaign_id=binding.campaign_id AND destination.command_id=binding.world_command_id
        JOIN campaign_location_connections_v28 connection ON connection.campaign_id=binding.campaign_id AND connection.connection_id=destination.connection_id
        JOIN campaign_locations_v28 location ON location.campaign_id=binding.campaign_id AND location.location_id=execution.destination_location_id
        WHERE NOT @publicOnly AND turn.principal_id=@principal AND connection.visibility IN('public','discovered')
          AND location.visibility IN('public','discovered') AND ((connection.visibility='public' AND location.visibility='public')
            OR EXISTS(SELECT 1 FROM campaign_location_discoveries_v28 discovery WHERE discovery.campaign_id=binding.campaign_id
              AND discovery.actor_id=turn.actor_id AND discovery.location_id=location.location_id))
        UNION ALL
        SELECT 'mechanic-receipt','committed-outcome',event.command_id,turn.session_id,event.timeline_id,event.source_turn_id,event.actor_id,
          json_object('type',event.type,'attribute',event.attribute_id,'resource',event.resource_name,
            'before',event.value_before,'after',event.value_after,'current',event.resource_current,'max',event.resource_max)
        FROM campaign_timeline_events included JOIN campaign_events event ON event.campaign_id=included.campaign_id AND event.event_id=included.event_id
        LEFT JOIN adventure_turns turn ON turn.campaign_id=event.campaign_id AND turn.id=event.source_turn_id
        WHERE NOT @publicOnly AND included.campaign_id=@campaign AND included.timeline_id=@timeline
          AND included.revision<=@revision AND (@dm OR event.actor_id=@actor)
          AND (event.source_turn_id IS NULL OR event.source_turn_id<>@excluded)
        UNION ALL
        SELECT 'recap','authored-recap',recap.id,NULL,recap.timeline_id,NULL,NULL,recap.text FROM campaign_recaps recap
        WHERE NOT @publicOnly AND recap.campaign_id=@campaign AND recap.timeline_id=@timeline AND recap.through_revision<=@revision
          AND (@dm OR recap.visibility='members') AND (json_array_length(recap.selected_session_ids)=0
            OR EXISTS(SELECT 1 FROM json_each(recap.selected_session_ids) selected WHERE selected.value=@session))
        UNION ALL
        SELECT 'director-receipt','committed-outcome',run.run_id,run.session_id,run.timeline_id,NULL,NULL,
          json_extract(receipt.public_json,'$.summary') FROM dm_runs run JOIN dm_receipts receipt USING(run_id)
        WHERE run.campaign_id=@campaign AND run.timeline_id=@timeline
          AND NOT EXISTS(SELECT 1 FROM json_each(run.candidates_json) binding
            WHERE json_extract(binding.value,'$.candidate.candidateId')=json_extract(run.proposal_json,'$.candidateId')
              AND json_extract(binding.value,'$.candidate.action') IN ('reveal-node','resolve-node','reveal-clue')
              AND NOT (${publicStoryResourceSql("run.campaign_id", "json_extract(binding.value,'$.target')")}))
      ) SELECT sources.* FROM sources
        LEFT JOIN campaign_actors actor ON actor.campaign_id=@campaign AND actor.id=sources.actorId
        LEFT JOIN campaign_characters persona ON persona.campaign_id=actor.campaign_id AND persona.id=actor.campaign_character_id
        LEFT JOIN characters character ON character.id=persona.character_id
        WHERE typeof(text)='text' AND length(CAST(text AS BLOB))<=2048
        AND velvet_recall_score(text || ' ' || coalesce(character.name,''))>0 ORDER BY velvet_recall_score(text || ' ' || coalesce(character.name,'')) DESC,
        CASE authority WHEN 'committed-outcome' THEN 0 WHEN 'intent' THEN 1 ELSE 2 END,sourceKind,sourceId COLLATE BINARY LIMIT 64`)
        .all({ campaign: input.campaignId, timeline: snapshot.timelineId, revision: snapshot.timelineRevision,
          session: input.sessionId, excluded: input.excludeRootTurnId ?? "", dm: Number(dm), actor, principal, publicOnly: Number(publicOnly) }) as Omit<CampaignRecallHit, "digest">[];
      result.incomplete = rows.length === 64;
      for (const row of rows) {
        if (result.hits.length === 8) { result.incomplete = true; break; }
        if (row.sourceKind === "check-receipt") {
          const receipt = services.getAdventureCheckPublicReceipt(principal, input.campaignId, row.sourceId);
          if (!receipt) continue;
          row.text = JSON.stringify(receipt);
        } else if (row.sourceKind === "mechanic-receipt") {
          const receipt = services.getMechanicReceipt(principal, input.campaignId, row.sourceId);
          if (!receipt) continue;
          row.text = JSON.stringify(receipt);
        } else if (["inventory-receipt", "commerce-receipt", "action-receipt", "travel-receipt", "combat-receipt", "quest-receipt"].includes(row.sourceKind)) {
          const receipt = services.getAdventureReceipt(principal, row.rootTurnId!, row.sourceId, row.sourceKind);
          if (!receipt) continue;
          row.text = JSON.stringify(receipt);
        }
        const hit = { ...row, digest: sha(row) };
        if (Buffer.byteLength(hit.text) > 2_048) { result.incomplete = true; continue; }
        result.hits.push(hit);
        // Reserve the longer boolean spelling so toggling metadata never exceeds the packet limit.
        if (Buffer.byteLength(JSON.stringify({ ...result, incomplete: false })) > CAMPAIGN_RECALL_MAX_BYTES) {
          result.hits.pop(); result.incomplete = true;
        }
      }
      return result;
    }).deferred();
  } };
}
