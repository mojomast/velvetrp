import type DatabaseDriver from "better-sqlite3";
import {
  campaignDmReadinessCoverageCaps,
  campaignDmReadinessResponseSchema,
  resourceIdSchema,
  type CampaignDmReadinessResponse,
  type CampaignRoomActivationReadiness,
} from "@velvet/contracts";
import { publicStorySourceSql } from "./storyDisclosure.js";
import { checkCampaignDmReadiness, type CampaignDmReadinessCheckFacts } from "./campaignDmReadinessChecks.js";

export class CampaignDmReadinessUnavailableError extends Error {}

export type CampaignDmReadinessActivationReader =
  (principalId: string, campaignId: string, sessionId: string) => CampaignRoomActivationReadiness;

export interface CampaignDmReadinessRepository {
  getCampaignDmPreparationReadiness(principalId: string, campaignId: string, sessionId: string): CampaignDmReadinessResponse;
}

type RefKind = "campaign" | "room" | "timeline" | "location" | "artifact" | "encounter" | "story-node" | "clue" | "binding" | "evidence" | "quest-objective" | "npc" | "catalog-enemy";
type Ref = { kind: RefKind; id: string };
type ArtifactRow = { artifact_key: string; artifact_kind: string; visibility: "public" | "gm"; server_resource_id: string | null; canonical_json: string };
const families = Object.keys(campaignDmReadinessCoverageCaps) as Array<keyof typeof campaignDmReadinessCoverageCaps>;

const reference = (kind: RefKind, id: string): Ref => ({ kind, id });
const stable = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
const artifactRef = (row: Pick<ArtifactRow, "artifact_kind" | "artifact_key" | "server_resource_id">): Ref => {
  const kind: RefKind = row.artifact_kind === "location" ? "location"
    : row.artifact_kind === "connection" ? "location"
      : row.artifact_kind === "npc" ? "npc"
        : row.artifact_kind === "encounter" ? "encounter"
          : row.artifact_kind === "story-node" ? "story-node"
            : row.artifact_kind === "clue" ? "clue"
              : "artifact";
  return reference(kind, row.server_resource_id ?? row.artifact_key);
};

function jsonObject(value: string): Record<string, any> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

export function createCampaignDmReadinessRepository(
  db: DatabaseDriver.Database,
  activationReadiness: CampaignDmReadinessActivationReader,
  guard: () => void,
): CampaignDmReadinessRepository {
  return {
    getCampaignDmPreparationReadiness(principalId, campaignId, sessionId) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId);
      return db.transaction(() => {
        // This is deliberately one authorization join. No private row is read before it succeeds.
        const identity = db.prepare(`SELECT campaign.active_timeline_id, campaign.administration_revision,
            timeline.revision AS timeline_revision, control.mode
          FROM campaigns campaign
          JOIN campaign_memberships member ON member.campaign_id=campaign.id AND member.principal_id=?
            AND (member.role='gm' OR (member.role='owner' AND campaign.owner_principal_id=member.principal_id))
          JOIN campaign_sessions room ON room.campaign_id=campaign.id AND room.session_id=?
          JOIN campaign_timelines timeline ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id
          JOIN dm_control control ON control.campaign_id=campaign.id
          WHERE campaign.id=?`).get(principalId, sessionId, campaignId) as {
            active_timeline_id: string; administration_revision: number; timeline_revision: number; mode: "human" | "ai";
          } | undefined;
        if (!identity) throw new CampaignDmReadinessUnavailableError();

        // The callback is supplied by the integration owner and must use this transaction's snapshot.
        const activation = activationReadiness(principalId, campaignId, sessionId);
        if (activation.campaignId !== campaignId || activation.sessionId !== sessionId)
          throw new CampaignDmReadinessUnavailableError();

        const artifacts = db.prepare(`SELECT artifact_key,artifact_kind,visibility,server_resource_id,canonical_json
          FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=?
          ORDER BY artifact_kind,artifact_key`).all(campaignId) as ArtifactRow[];
        const publicArtifacts = artifacts.filter(row => row.visibility === "public");
        const artifactByResource = new Map(artifacts.filter(row => row.server_resource_id).map(row => [row.server_resource_id!, row]));
        const currentLocations = new Set((db.prepare(`SELECT location_id FROM campaign_actor_locations_v28
          WHERE campaign_id=? AND session_id=? ORDER BY actor_id`).all(campaignId, sessionId) as Array<{ location_id: string }>).map(row => row.location_id));
        const start = (db.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?").get(campaignId) as { location_id: string } | undefined)?.location_id;
         const currentLocation = [...currentLocations][0] ?? start;
         const locationScope = (id: string): "current-room" | "later-location" => currentLocations.size > 0
           ? currentLocations.has(id) ? "current-room" : "later-location"
           : currentLocation === id ? "current-room" : "later-location";

         const nodeRows = db.prepare(`SELECT node.node_id,node.reveal_threshold,state.status,
            CASE WHEN ${publicStorySourceSql("node", "node_id")} THEN 'public' ELSE 'private' END visibility
          FROM story_nodes_v34 node JOIN story_node_state_v34 state
            ON state.campaign_id=node.campaign_id AND state.storyline_id=node.storyline_id AND state.node_id=node.node_id
          WHERE node.campaign_id=? ORDER BY node.node_id`).all(campaignId) as Array<{ node_id: string; reveal_threshold: number; status: "hidden" | "revealed" | "resolved"; visibility: "public" | "private" }>;
        const edgeRows = db.prepare("SELECT edge_id,kind,from_node_id,to_node_id FROM story_edges_v34 WHERE campaign_id=? ORDER BY edge_id").all(campaignId) as Array<{ edge_id: string; kind: "sequence" | "requires"; from_node_id: string; to_node_id: string }>;
         const clueRows = db.prepare(`SELECT clue.clue_id,clue.reveal_threshold,
            (SELECT count(*) FROM story_clue_sources_v34 source
              WHERE source.campaign_id=clue.campaign_id AND source.storyline_id=clue.storyline_id AND source.clue_id=clue.clue_id
                AND (source.source_kind<>'node' OR NOT EXISTS (SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden
                  WHERE hidden.campaign_id=source.campaign_id AND hidden.visibility='gm' AND hidden.server_resource_id=source.target_id))) available_source_count,
            CASE WHEN ${publicStorySourceSql("clue", "clue_id")} THEN 'public' ELSE 'private' END visibility
           FROM story_clues_v34 clue WHERE clue.campaign_id=? ORDER BY clue.clue_id`).all(campaignId) as Array<{ clue_id: string; reveal_threshold: number; available_source_count: number; visibility: "public" | "private" }>;

         const publicRendering = [
           ...artifacts.map(row => ({
             id: row.server_resource_id ?? row.artifact_key,
             kind: artifactRef(row).kind,
             visibility: row.visibility === "gm" ? "private" as const : "public" as const,
             rendered: row.visibility === "public" && (row.artifact_kind !== "story-node" && row.artifact_kind !== "clue"
               || Boolean(db.prepare(`SELECT 1 FROM campaign_generation_accepted_artifacts_v52 source
                 WHERE source.campaign_id=? AND source.server_resource_id=? AND source.visibility='public'`).get(campaignId, row.server_resource_id))),
             ...(row.artifact_kind === "location" && row.server_resource_id ? { locationScope: locationScope(row.server_resource_id) } : {}),
             optional: Boolean(jsonObject(row.canonical_json).optional),
             privateCompanion: row.visibility === "gm",
           })),
           ...nodeRows.map(row => ({ id: row.node_id, kind: "story-node" as const, visibility: row.visibility,
             rendered: row.visibility === "public", privateCompanion: row.visibility === "private" })),
           ...clueRows.map(row => ({ id: row.clue_id, kind: "clue" as const, visibility: row.visibility,
             rendered: row.visibility === "public" })),
         ];

         const bindings = db.prepare(`SELECT node_id,evidence_kind,target_id FROM dm_review_scene_bindings
           WHERE campaign_id=? ORDER BY node_id,evidence_kind,target_id`).all(campaignId) as Array<{ node_id: string; evidence_kind: string; target_id: string }>;
         const committedBindings = new Set((db.prepare(`SELECT DISTINCT binding.node_id,binding.evidence_kind,binding.target_id
           FROM dm_review_scene_bindings binding
           JOIN dm_runs run ON run.campaign_id=binding.campaign_id
           JOIN dm_story_evidence evidence ON evidence.campaign_id=run.campaign_id AND evidence.run_id=run.run_id
           JOIN json_each(json_extract(run.context_json,'$.evidence.sources')) source
           WHERE binding.campaign_id=? AND json_extract(source.value,'$.kind')=binding.evidence_kind
             AND json_extract(source.value,'$.targetId')=binding.target_id
           ORDER BY binding.node_id,binding.evidence_kind,binding.target_id`).all(campaignId) as Array<{ node_id: string; evidence_kind: string; target_id: string }>).map(row => `${row.node_id}:${row.evidence_kind}:${row.target_id}`));
         const encounterBindings = new Set((db.prepare("SELECT artifact_key FROM dm_encounter_bindings WHERE campaign_id=? ORDER BY artifact_key").all(campaignId) as Array<{ artifact_key: string }>).map(row => row.artifact_key));
         const pinned = new Set((db.prepare(`SELECT definition.kind,definition.pack_id,definition.pack_version,definition.definition_id
           FROM campaign_catalog_current_pins pin JOIN rpg_campaign_catalog_definitions_v25 definition
            ON definition.campaign_id=pin.campaign_id AND definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
           WHERE pin.campaign_id=?`).all(campaignId) as Array<{ kind: string; pack_id: string; pack_version: string; definition_id: string }>).map(row => `${row.kind}:${row.pack_id}:${row.pack_version}:${row.definition_id}`));

        const encounterFacts = publicArtifacts.filter(row => row.artifact_kind === "encounter").map(row => {
          const value = jsonObject(row.canonical_json);
          const refs = Array.isArray(value.enemyReferences) ? value.enemyReferences : [];
           const exact = refs.map((item: any) => item?.kind === "enemy-template"
             ? `${item.kind}:${item.packId}:${item.packVersion}:${item.definitionId}` : null)
             .filter((item: unknown): item is string => typeof item === "string");
          const locationId = typeof value.locationKey === "string" ? (artifacts.find(item => item.artifact_key === value.locationKey)?.server_resource_id ?? value.locationKey) : undefined;
           return { id: row.server_resource_id ?? row.artifact_key, bound: encounterBindings.has(row.artifact_key), exactPinnedEnemyReferences: exact,
             conceptOnly: Array.isArray(value.monsterConceptIds) && value.monsterConceptIds.length > 0,
             unsupportedRoster: refs.some((item: any) => item?.kind !== "enemy-template") || exact.some(item => !pinned.has(item)),
             optional: Boolean(value.optional), ...(locationId ? { locationId, locationScope: locationScope(locationId) } : {}) };
        });
        const locations = db.prepare("SELECT location_id,visibility FROM campaign_locations_v28 WHERE campaign_id=? ORDER BY location_id").all(campaignId) as Array<{ location_id: string; visibility: string }>;
        const connections = db.prepare("SELECT connection_id,from_location_id,to_location_id,visibility FROM campaign_location_connections_v28 WHERE campaign_id=? AND route_state='open' ORDER BY connection_id").all(campaignId) as Array<{ connection_id: string; from_location_id: string; to_location_id: string; visibility: string }>;
        const facts: CampaignDmReadinessCheckFacts = {
          publicRendering,
          story: { nodes: nodeRows.map(row => ({ id: row.node_id, status: row.status, revealThreshold: row.reveal_threshold, visibility: row.visibility, privateCompanion: row.visibility === "private" })),
            edges: edgeRows.map(row => ({ id: row.edge_id, kind: row.kind, fromId: row.from_node_id, toId: row.to_node_id })),
            clues: clueRows.map(row => ({ id: row.clue_id, revealThreshold: row.reveal_threshold, availableSourceCount: row.available_source_count, visibility: row.visibility, optional: false })) },
          bindings: [
             ...bindings.map(row => ({ id: `${row.node_id}:${row.evidence_kind}:${row.target_id}`,
               targetKind: row.evidence_kind === "encounter" ? "encounter" as const
                 : row.evidence_kind === "check-turn" ? "evidence" as const : "quest-objective" as const,
               targetId: row.target_id,
               state: committedBindings.has(`${row.node_id}:${row.evidence_kind}:${row.target_id}`) ? "evidence-committed" as const : "prepared" as const })),
           ],
          encounters: encounterFacts,
          ...(currentLocation ? { connectivity: { startLocationId: currentLocation, locations: locations.map(row => ({ id: row.location_id, visibility: row.visibility === "gm" ? "private" as const : "public" as const })), connections: connections.map(row => ({ id: row.connection_id, fromId: row.from_location_id, toId: row.to_location_id, visibility: row.visibility === "gm" ? "private" as const : "public" as const })) } } : {}),
        };
        const checked = checkCampaignDmReadiness(facts);
        const coverage = new Map(families.map(family => [family, publicArtifacts.length ? [] as Ref[] : [] as Ref[]]));
        const add = (family: keyof typeof campaignDmReadinessCoverageCaps, refs: Ref[]) => coverage.set(family, [...coverage.get(family)!, ...refs].sort((a, b) => stable(a.kind, b.kind) || stable(a.id, b.id)));
        add("locations", locations.map(row => reference("location", row.location_id)));
        add("connections", connections.map(row => reference("location", row.connection_id)));
        add("actors", [...new Set((db.prepare("SELECT npc_id FROM campaign_npcs_v28 WHERE campaign_id=? ORDER BY npc_id").all(campaignId) as Array<{ npc_id: string }>).map(row => reference("npc", row.npc_id)))]);
        add("quests", (db.prepare("SELECT id FROM quests WHERE campaign_id=? ORDER BY id").all(campaignId) as Array<{ id: string }>).map(row => reference("quest-objective", row.id)));
        add("encounters", encounterFacts.map(row => reference("encounter", row.id)));
        add("story", nodeRows.map(row => reference("story-node", row.node_id)));
        add("clues", clueRows.map(row => reference("clue", row.clue_id)));
        add("artifacts", artifacts.map(row => artifactRef(row)));
        add("bindings", [...bindings.map(row => reference("binding", `${row.node_id}:${row.evidence_kind}:${row.target_id}`)), ...encounterFacts.filter(row => encounterBindings.has(row.id)).map(row => reference("binding", row.id))]);
        add("evidence", (db.prepare("SELECT turn_id FROM dm_story_evidence WHERE campaign_id=? ORDER BY turn_id").all(campaignId) as Array<{ turn_id: string }>).map(row => reference("evidence", row.turn_id)));
        const coverageEntries = families.map(family => { const refs = coverage.get(family)!; const cap = campaignDmReadinessCoverageCaps[family]; const truncated = refs.length > cap; return { family, state: truncated ? "partial" as const : "complete" as const, inspected: refs.slice(0, cap), omitted: truncated ? refs.slice(cap, cap * 2) : [] }; });
        const truncated = coverageEntries.filter(entry => entry.state === "partial");
        const coverageState = truncated.length ? "partial" as const : "complete" as const;
        const coverageIssues = truncated.length ? [{ code: "coverage-truncated" as const, severity: "review" as const, scope: "campaign-level" as const, reference: null, label: "Coverage truncated", explanation: "Inspection bounds omitted preparation resources from this report.", remediation: "coverage" as const }] : [];
        const orderedIssues = [...checked.issues, ...coverageIssues].sort((a, b) => ({ "room-obstacle": 0, "private-artifact": 1, "missing-binding": 2, "awaiting-play-evidence": 3, "optional-disconnected-content": 4, "missing-public-rendering": 5, "unbound-encounter": 6, "unsupported-encounter-roster": 7, "coverage-truncated": 8, "manual-review-required": 9 }[a.code] - ({ "room-obstacle": 0, "private-artifact": 1, "missing-binding": 2, "awaiting-play-evidence": 3, "optional-disconnected-content": 4, "missing-public-rendering": 5, "unbound-encounter": 6, "unsupported-encounter-roster": 7, "coverage-truncated": 8, "manual-review-required": 9 }[b.code]) || stable(a.reference?.id ?? "", b.reference?.id ?? "")));
        const issues = [...orderedIssues.filter(issue => issue.code !== "coverage-truncated").slice(0, Math.max(0, 128 - coverageIssues.length)), ...coverageIssues];
        const report = { version: "1.0" as const, identity: { campaignId, sessionId, timelineId: identity.active_timeline_id, campaignRevision: identity.administration_revision, timelineRevision: identity.timeline_revision }, activationReadiness: activation, mode: identity.mode, issues, coverage: { state: coverageState, families: coverageEntries }, manualReviewLimitations: [...checked.manualReviewLimitations, ...(coverageState === "partial" ? ["Inspection coverage reached a family bound." as const] : [])] };
        return campaignDmReadinessResponseSchema.parse(report);
      })();
    },
  };
}
