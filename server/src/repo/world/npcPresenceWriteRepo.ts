import type DatabaseDriver from "better-sqlite3";
import {
  npcPresenceCommandSchema,
  npcPresenceMutationHttpResponseSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type NpcPresenceCommand,
  type NpcPresenceMutationHttpResponse,
} from "@velvet/contracts";
import { createCampaignRoomSessionLifecycleRepository } from "../campaign/campaignRoomSessionLifecycleRepo.js";
import type { WorldDependencies } from "./worldWriteRepo.js";
import { WorldAuthorizationError, WorldConflictError, WorldStaleError, WorldUnavailableError } from "./worldErrors.js";
import type { NpcPresenceReadInternals } from "./npcPresenceReadRepo.js";

export interface NpcPresenceWriteRepository {
  mutateNpcPresence(principalId: string, command: NpcPresenceCommand): NpcPresenceMutationHttpResponse;
}

type PresenceRow = { state: "present" | "left"; location_id: string | null; state_entered_at: string; updated_at: string };

type ReplayRow = {
  npc_id: string;
  state: "present" | "left";
  location_id: string | null;
  expected_revision: number;
  resulting_revision: number;
  occurred_at: string;
};

/** Creates atomic GM/owner NPC-presence commands over the v43 protocol. */
export function createNpcPresenceWriteRepository(
  db: DatabaseDriver.Database,
  dependencies: WorldDependencies & { guard(): void },
  reads: NpcPresenceReadInternals,
): NpcPresenceWriteRepository {
  const impliedMutation = (campaignId: string, sessionId: string, command: ReplayRow): NpcPresenceCommand["mutation"] => {
    if (command.state === "left") return { kind: "remove" } as const;
    const prior = db.prepare(`SELECT state FROM npc_presence_events_v43 WHERE campaign_id=? AND session_id=?
      AND npc_id=? AND resulting_revision<? ORDER BY resulting_revision DESC LIMIT 1`)
      .get(campaignId, sessionId, command.npc_id, command.resulting_revision) as { state: string } | undefined;
    return { kind: prior?.state === "present" ? "move" : "place", locationId: command.location_id } as const;
  };
  return {
    mutateNpcPresence(principalId, raw) {
      dependencies.guard();
      const intent = npcPresenceCommandSchema.parse(raw);
      return db.transaction(() => {
        const membership = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
          .get(intent.campaignId, principalId) as { role: string } | undefined;
        if (!membership || !["owner", "gm"].includes(membership.role)) throw new WorldAuthorizationError("GM authority is required");
        reads.assertScopedIntegrity(intent.campaignId, intent.sessionId);
        const replay = db.prepare(`SELECT command.*,receipt.event_id,receipt.occurred_at FROM npc_presence_commands_v43 command
          JOIN npc_presence_receipts_v43 receipt ON receipt.campaign_id=command.campaign_id
            AND receipt.session_id=command.session_id AND receipt.command_id=command.command_id
            AND receipt.resulting_revision=command.resulting_revision AND receipt.npc_id=command.npc_id
            AND receipt.state=command.state AND receipt.location_id IS command.location_id
          WHERE command.campaign_id=? AND command.session_id=? AND command.idempotency_key=?`)
          .get(intent.campaignId, intent.sessionId, intent.idempotencyKey) as ReplayRow | undefined;
        if (replay) {
          const same = replay.npc_id === intent.npcId && replay.expected_revision === intent.expectedRevision
            && JSON.stringify(impliedMutation(intent.campaignId, intent.sessionId, replay)) === JSON.stringify(intent.mutation);
          if (!same) throw new WorldConflictError("idempotency key was reused");
          const receipt = { kind: intent.mutation.kind, revisionBefore: replay.expected_revision,
            revisionAfter: replay.resulting_revision, occurredAt: replay.occurred_at };
          return npcPresenceMutationHttpResponseSchema.parse({ receipt });
        }

        const attached = db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?")
          .get(intent.campaignId, intent.sessionId);
        if (!attached) throw new WorldUnavailableError("session does not belong to campaign");
        const lifecycle = createCampaignRoomSessionLifecycleRepository(db)
          .getCampaignRoomSessionLifecycle(intent.sessionId);
        if (lifecycle === null) throw new WorldUnavailableError("session does not belong to campaign");
        if (lifecycle === "stopped") throw new WorldUnavailableError("session is not running");

        const root = db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
          .get(intent.campaignId, intent.sessionId) as { revision: number } | undefined;
        const before = root?.revision ?? 0;
        if (before !== intent.expectedRevision) throw new WorldStaleError("NPC presence session revision is stale");
        if (!db.prepare("SELECT 1 FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?")
          .get(intent.campaignId, intent.npcId)) throw new WorldUnavailableError("NPC does not belong to campaign");
        const current = db.prepare(`SELECT state,location_id,state_entered_at,updated_at FROM campaign_npc_presence_v43
          WHERE campaign_id=? AND session_id=? AND npc_id=?`).get(intent.campaignId, intent.sessionId, intent.npcId) as PresenceRow | undefined;
        const locationId = intent.mutation.kind === "remove" ? current?.location_id ?? null : intent.mutation.locationId;
        if (locationId !== null && !db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
          .get(intent.campaignId, locationId)) throw new WorldUnavailableError("location does not belong to campaign");
        if (intent.mutation.kind === "place" && current?.state === "present") throw new WorldConflictError("NPC is already present");
        if (intent.mutation.kind === "move" && current?.state !== "present") throw new WorldConflictError("NPC is not present");
        if (intent.mutation.kind === "move" && current!.location_id === locationId) throw new WorldConflictError("NPC is already at that location");
        if (intent.mutation.kind === "remove" && current?.state !== "present") throw new WorldConflictError("NPC is not present");

        const at = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
        const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        const after = before + 1;
        const state = intent.mutation.kind === "remove" ? "left" : "present";
        if (!root) db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)")
          .run(intent.campaignId, intent.sessionId, at);
        db.prepare(`INSERT INTO npc_presence_commands_v43 VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(intent.campaignId, intent.sessionId, commandId, intent.idempotencyKey, principalId, intent.npcId,
            state, locationId, before, after, at);
        db.prepare("UPDATE npc_presence_session_revisions_v43 SET revision=?,updated_at=? WHERE campaign_id=? AND session_id=?")
          .run(after, at, intent.campaignId, intent.sessionId);
        db.prepare("INSERT INTO npc_presence_events_v43 VALUES(?,?,?,?,?,?,?,?,?)")
          .run(eventId, intent.campaignId, intent.sessionId, commandId, after, intent.npcId, state, locationId, at);
        db.prepare("INSERT INTO npc_presence_receipts_v43 VALUES(?,?,?,?,?,?,?,?,?)")
          .run(intent.campaignId, intent.sessionId, commandId, after, eventId, intent.npcId, state, locationId, at);
        if (!current) {
          db.prepare("INSERT INTO campaign_npc_presence_v43 VALUES(?,?,?,?,?,?,?,?,?)")
            .run(intent.campaignId, intent.sessionId, intent.npcId, state, locationId, after, at, at, commandId);
        } else if (intent.mutation.kind === "place") {
          db.prepare(`UPDATE campaign_npc_presence_v43 SET state=?,location_id=?,state_revision=?,state_entered_at=?,
            updated_at=?,last_command_id=? WHERE campaign_id=? AND session_id=? AND npc_id=?`)
            .run(state, locationId, after, at, at, commandId, intent.campaignId, intent.sessionId, intent.npcId);
        } else {
          db.prepare(`UPDATE campaign_npc_presence_v43 SET state=?,location_id=?,state_revision=?,updated_at=?,last_command_id=?
            WHERE campaign_id=? AND session_id=? AND npc_id=?`)
            .run(state, locationId, after, at, commandId,
              intent.campaignId, intent.sessionId, intent.npcId);
        }
        const receipt = { kind: intent.mutation.kind, revisionBefore: before, revisionAfter: after, occurredAt: at };
        return npcPresenceMutationHttpResponseSchema.parse({ receipt });
      }).immediate();
    },
  };
}
