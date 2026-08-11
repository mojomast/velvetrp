// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignCheckpointSchema,
  campaignTimelineHistorySchema,
  createCampaignCheckpointInputSchema,
  forkCampaignTimelineInputSchema,
  resourceIdSchema,
  type CampaignAdministrationReceipt,
  type CampaignCheckpoint,
  type CampaignTimelineHistory,
} from "@velvet/contracts";

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
interface MutationContext { commandId: string; at: string; auth: { activeTimelineId: string } }

export interface CampaignCheckpointRepoDependencies {
  db: DatabaseDriver.Database;
  nextId: () => string;
  runMutation: <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object, apply: (context: MutationContext) => T,
    retry: (commandId: string, stored: unknown) => T) => MutationResult<T>;
  conflict: (message: string) => Error;
  checkpoint: (row: any) => CampaignCheckpoint;
  timeline: (row: any, activeId: string) => CampaignTimelineHistory;
  getAuthority: (actor: string, campaignId: string) => { role: "owner" | "gm" | "player" | "observer" } | null;
}

export function createCampaignCheckpointRepo(deps: CampaignCheckpointRepoDependencies) {
  const { db, nextId, runMutation, conflict, checkpoint, timeline, getAuthority } = deps;
  return {
    createCampaignCheckpoint: (actor: string, campaignId: string, raw: unknown) => {
      const input = createCampaignCheckpointInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "checkpoint_created",
        { timelineId: input.timelineId, timelineRevision: input.timelineRevision, label: input.label }, ({ commandId, at }) => {
          const t = db.prepare(`SELECT timeline.revision FROM campaigns campaign JOIN campaign_timelines timeline
            ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id WHERE campaign.id=? AND timeline.id=?`).get(campaignId, input.timelineId) as any;
          if (!t || t.revision !== input.timelineRevision) throw conflict("checkpoint revision is not current");
          const id = resourceIdSchema.parse(nextId());
          db.prepare(`INSERT INTO campaign_checkpoints (id,campaign_id,timeline_id,timeline_revision,label,created_at,command_id)
            VALUES (?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.timelineRevision, input.label, at, commandId);
          db.prepare(`INSERT INTO campaign_checkpoint_attribute_snapshots (checkpoint_id,actor_id,attribute_id,value)
            SELECT ?,actor.id,attribute.attribute_id,attribute.value FROM campaign_actors actor
            JOIN rpg_character_attributes attribute ON attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id
            WHERE actor.campaign_id=? ORDER BY actor.id,attribute.attribute_id`).run(id, campaignId);
          db.prepare(`INSERT INTO campaign_checkpoint_resource_snapshots (checkpoint_id,actor_id,name,current,max)
            SELECT ?,actor_id,name,current,max FROM rpg_actor_resources WHERE campaign_id=? ORDER BY actor_id,name`).run(id, campaignId);
          return checkpoint({ id, campaign_id: campaignId, timeline_id: input.timelineId, timeline_revision: input.timelineRevision, label: input.label, created_at: at });
        }, (_commandId, stored) => campaignCheckpointSchema.parse(stored));
    },
    forkCampaignTimeline: (actor: string, campaignId: string, raw: unknown) => {
      const input = forkCampaignTimelineInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "timeline_forked", { checkpointId: input.checkpointId }, ({ commandId, at, auth }) => {
        const cp = db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? AND id=?").get(campaignId, input.checkpointId) as any;
        if (!cp) throw conflict("checkpoint not found");
        if (db.prepare(`SELECT 1 FROM combatant JOIN encounter ON encounter.encounter_id=combatant.encounter_id
          JOIN rpg_actor_resources health ON health.campaign_id=combatant.campaign_id
            AND health.actor_id=combatant.actor_id AND health.name='health'
          WHERE encounter.campaign_id=? AND encounter.status='active' LIMIT 1`).get(campaignId)) {
          throw conflict("active encounter health is authoritative");
        }
        const id = resourceIdSchema.parse(nextId());
        db.prepare("INSERT INTO campaign_timelines (id,campaign_id,revision,created_at) VALUES (?,?,?,?)").run(id, campaignId, cp.timeline_revision, at);
        db.prepare(`INSERT INTO campaign_timeline_history
          (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision) VALUES (?,?,NULL,?,?,?)`).run(campaignId, id, cp.timeline_id, commandId, cp.timeline_revision);
        db.prepare(`INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
          SELECT campaign_id,?,revision,event_id,1 FROM campaign_timeline_events WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`).run(id, campaignId, cp.timeline_id, cp.timeline_revision);
        db.prepare(`INSERT INTO campaign_imported_timeline_events
          (campaign_id,timeline_id,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data)
          SELECT campaign_id,?,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data
          FROM campaign_imported_timeline_events WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`).run(id, campaignId, cp.timeline_id, cp.timeline_revision);
        db.prepare(`UPDATE rpg_character_attributes SET value=(SELECT snapshot.value FROM campaign_checkpoint_attribute_snapshots snapshot JOIN campaign_actors actor
            ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)
          WHERE campaign_id=? AND EXISTS (SELECT 1 FROM campaign_checkpoint_attribute_snapshots snapshot JOIN campaign_actors actor
            ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)`).run(cp.id, campaignId, cp.id);
        db.prepare("DELETE FROM rpg_actor_resources WHERE campaign_id=?").run(campaignId);
        db.prepare(`INSERT INTO rpg_actor_resources (campaign_id,actor_id,name,current,max)
          SELECT ?,actor_id,name,current,max FROM campaign_checkpoint_resource_snapshots WHERE checkpoint_id=?`).run(campaignId, cp.id);
        db.prepare("UPDATE campaigns SET active_timeline_id=? WHERE id=? AND active_timeline_id=?").run(id, campaignId, auth.activeTimelineId);
        return timeline({ id, campaign_id: campaignId, revision: cp.timeline_revision, created_at: at,
          parent_timeline_id: cp.timeline_id, forked_from_revision: cp.timeline_revision }, id);
      }, (_commandId, stored) => campaignTimelineHistorySchema.parse(stored));
    },
    listCampaignCheckpoints: (actor: string, campaignId: string) => getAuthority(resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId))
      ? (db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(checkpoint) : [],
  };
}
