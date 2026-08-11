import type DatabaseDriver from "better-sqlite3";
import {
  npcCastHttpSchema,
  npcPrivateStateHttpSchema,
  npcPublicStateHttpSchema,
  type GmHistoricalNpcHttp,
  type GmPresentNpcHttp,
  type NpcCastHttp,
  type PlayerHistoricalNpcHttp,
  type PlayerPresentNpcHttp,
} from "@velvet/contracts";
import { createCampaignRoomSessionLifecycleRepository } from "../campaign/campaignRoomSessionLifecycleRepo.js";

/** Read operations for the session-scoped NPC cast. */
export interface NpcPresenceReadRepository {
  getNpcCast(principalId: string, campaignId: string, sessionId: string): NpcCastHttp | null;
}

export interface NpcPresenceReadContext { guard(): void }

export interface NpcPresenceReadInternals extends NpcPresenceReadRepository {
  assertScopedIntegrity(campaignId: string, sessionId: string): void;
  projectNpcCast(principalId: string, campaignId: string, sessionId: string, revision: number): NpcCastHttp | null;
}

type EventRow = {
  resulting_revision: number;
  npc_id: string;
  state: "present" | "left";
  location_id: string | null;
  occurred_at: string;
  principal_id: string;
};

type IntegrityRow = {
  command_id: string;
  expected_revision: number;
  command_resulting_revision: number;
  command_npc_id: string;
  command_state: "present" | "left";
  command_location_id: string | null;
  created_at: string;
  event_id: string | null;
  event_command_id: string | null;
  event_resulting_revision: number | null;
  event_npc_id: string | null;
  event_state: "present" | "left" | null;
  event_location_id: string | null;
  event_occurred_at: string | null;
  receipt_command_id: string | null;
  receipt_resulting_revision: number | null;
  receipt_event_id: string | null;
  receipt_npc_id: string | null;
  receipt_state: "present" | "left" | null;
  receipt_location_id: string | null;
  receipt_occurred_at: string | null;
  principal_id: string;
  principal_exists: number;
  npc_exists: number;
  location_exists: number;
};

type MaterializedRow = PresenceRow & { npc_id: string };
type PresenceRow = {
  state: "present" | "left";
  location_id: string | null;
  state_revision: number;
  state_entered_at: string;
  updated_at: string;
  last_command_id: string;
};

type NpcRow = {
  persona_id: string;
  public_name: string;
  public_state_json: string | null;
  private_state_json: string | null;
  private_goals: string | null;
  gm_notes: string | null;
  merchant_state_json: string | null;
};

type ProjectedNpc = GmPresentNpcHttp | PlayerPresentNpcHttp | GmHistoricalNpcHttp | PlayerHistoricalNpcHttp;

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

/** Creates role-safe cast projections from immutable presence events. */
export function createNpcPresenceReadRepository(
  db: DatabaseDriver.Database,
  context: NpcPresenceReadContext,
): NpcPresenceReadInternals {
  const lifecycleRepository = createCampaignRoomSessionLifecycleRepository(db);
  const membership = (principalId: string, campaignId: string) => db.prepare(
    "SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?",
  ).get(campaignId, principalId) as { role: string } | undefined;

  const isAttached = (campaignId: string, sessionId: string) => db.prepare(
    "SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?",
  ).get(campaignId, sessionId) !== undefined;

  const assertScopedIntegrity = (campaignId: string, sessionId: string): void => {
    const root = db.prepare("SELECT revision,updated_at FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
      .get(campaignId, sessionId) as { revision: number; updated_at: string } | undefined;
    const scopedCounts = db.prepare(`SELECT
        (SELECT count(*) FROM npc_presence_commands_v43 WHERE campaign_id=? AND session_id=?) commands,
        (SELECT count(*) FROM npc_presence_events_v43 WHERE campaign_id=? AND session_id=?) events,
        (SELECT count(*) FROM npc_presence_receipts_v43 WHERE campaign_id=? AND session_id=?) receipts,
        (SELECT count(*) FROM campaign_npc_presence_v43 WHERE campaign_id=? AND session_id=?) states`)
      .get(campaignId, sessionId, campaignId, sessionId, campaignId, sessionId, campaignId, sessionId) as {
        commands: number; events: number; receipts: number; states: number;
      };
    const malformed = () => { throw new Error("NPC presence scoped graph integrity is inconsistent"); };
    if (!root) {
      if (scopedCounts.commands || scopedCounts.events || scopedCounts.receipts || scopedCounts.states) malformed();
      return;
    }
    if (root.revision !== scopedCounts.commands || root.revision !== scopedCounts.events
      || root.revision !== scopedCounts.receipts) malformed();

    const rows = db.prepare(`SELECT command.command_id,command.expected_revision,
        command.resulting_revision command_resulting_revision,
        command.npc_id command_npc_id,command.state command_state,command.location_id command_location_id,
        command.created_at,command.principal_id,
        event.event_id,event.command_id event_command_id,event.resulting_revision event_resulting_revision,
        event.npc_id event_npc_id,event.state event_state,event.location_id event_location_id,
        event.occurred_at event_occurred_at,
        receipt.command_id receipt_command_id,receipt.resulting_revision receipt_resulting_revision,
        receipt.event_id receipt_event_id,receipt.npc_id receipt_npc_id,receipt.state receipt_state,
        receipt.location_id receipt_location_id,receipt.occurred_at receipt_occurred_at,
        EXISTS(SELECT 1 FROM principals principal WHERE principal.id=command.principal_id) principal_exists,
        EXISTS(SELECT 1 FROM campaign_npcs_v28 npc
          WHERE npc.campaign_id=command.campaign_id AND npc.npc_id=command.npc_id) npc_exists,
        CASE WHEN command.location_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM campaign_locations_v28 location
          WHERE location.campaign_id=command.campaign_id AND location.location_id=command.location_id) END location_exists
      FROM npc_presence_commands_v43 command
      LEFT JOIN npc_presence_events_v43 event ON event.campaign_id=command.campaign_id
        AND event.session_id=command.session_id AND event.command_id=command.command_id
      LEFT JOIN npc_presence_receipts_v43 receipt ON receipt.campaign_id=command.campaign_id
        AND receipt.session_id=command.session_id AND receipt.command_id=command.command_id
      WHERE command.campaign_id=? AND command.session_id=? ORDER BY command.resulting_revision`)
      .all(campaignId, sessionId) as IntegrityRow[];
    let previousAt: string | undefined;
    const reconstructed = new Map<string, PresenceRow>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const revision = index + 1;
      if (row.expected_revision !== revision - 1 || row.command_resulting_revision !== revision
        || row.event_resulting_revision !== revision || row.receipt_resulting_revision !== revision
        || !row.principal_exists || !row.npc_exists || !row.location_exists
        || row.event_id === null || row.event_command_id !== row.command_id
        || row.receipt_command_id !== row.command_id || row.receipt_event_id !== row.event_id
        || row.command_npc_id !== row.event_npc_id || row.command_npc_id !== row.receipt_npc_id
        || row.command_state !== row.event_state || row.command_state !== row.receipt_state
        || row.command_location_id !== row.event_location_id || row.command_location_id !== row.receipt_location_id
        || row.created_at !== row.event_occurred_at || row.created_at !== row.receipt_occurred_at
        || (previousAt !== undefined && row.created_at < previousAt)) malformed();

      const prior = reconstructed.get(row.command_npc_id);
      let enteredAt = row.created_at;
      if (!prior) {
        if (row.command_state !== "present") malformed();
      } else if (prior.state === "present" && row.command_state === "present") {
        if (prior.location_id === row.command_location_id) malformed();
        enteredAt = prior.state_entered_at;
      } else if (prior.state === "present" && row.command_state === "left") {
        if (prior.location_id !== row.command_location_id) malformed();
        enteredAt = prior.state_entered_at;
      } else if (prior.state === "left" && row.command_state === "left") {
        malformed();
      }
      reconstructed.set(row.command_npc_id, {
        state: row.command_state,
        location_id: row.command_location_id,
        state_revision: revision,
        state_entered_at: enteredAt,
        updated_at: row.created_at,
        last_command_id: row.command_id,
      });
      previousAt = row.created_at;
    }
    if (rows.length > 0 && root.updated_at !== rows.at(-1)!.created_at) malformed();

    const states = db.prepare(`SELECT npc_id,state,location_id,state_revision,state_entered_at,updated_at,last_command_id
      FROM campaign_npc_presence_v43 WHERE campaign_id=? AND session_id=?`).all(campaignId, sessionId) as MaterializedRow[];
    if (states.length !== reconstructed.size) malformed();
    for (const state of states) {
      const expected = reconstructed.get(state.npc_id);
      if (!expected || state.last_command_id !== expected.last_command_id
        || state.state_revision !== expected.state_revision || state.state !== expected.state
        || state.location_id !== expected.location_id || state.state_entered_at !== expected.state_entered_at
        || state.updated_at !== expected.updated_at) malformed();
    }
  };

  const projectNpcCast = (principalId: string, campaignId: string, sessionId: string, revision: number): NpcCastHttp | null => {
    const authority = membership(principalId, campaignId);
    if (!authority) return null;
    assertScopedIntegrity(campaignId, sessionId);
    const lifecycle = lifecycleRepository.getCampaignRoomSessionLifecycle(sessionId);
    const root = db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
      .get(campaignId, sessionId) as { revision: number } | undefined;
    if (!lifecycle || (!isAttached(campaignId, sessionId) && !root)
      || revision < 0 || revision > (root?.revision ?? 0)) return null;

    const isGm = authority.role === "owner" || authority.role === "gm";
    const running = lifecycle === "running";
    const rows = db.prepare(`SELECT event.resulting_revision,event.npc_id,event.state,event.location_id,
        event.occurred_at,command.principal_id
      FROM npc_presence_events_v43 event JOIN npc_presence_commands_v43 command
        USING(campaign_id,session_id,command_id)
      WHERE event.campaign_id=? AND event.session_id=? AND event.resulting_revision<=?
      ORDER BY event.resulting_revision`).all(campaignId, sessionId, revision) as EventRow[];

    const histories = new Map<string, EventRow[]>();
    for (const row of rows) {
      const history = histories.get(row.npc_id) ?? [];
      history.push(row);
      histories.set(row.npc_id, history);
    }
    const knownLocations = isGm ? new Set<string>() : new Set((db.prepare(`SELECT DISTINCT discovery.location_id
      FROM campaign_location_discoveries_v28 discovery JOIN campaign_actor_private_state actor
        ON actor.campaign_id=discovery.campaign_id AND actor.actor_id=discovery.actor_id
      WHERE discovery.campaign_id=? AND actor.controller_principal_id=?`)
      .all(campaignId, principalId) as Array<{ location_id: string }>).map((row) => row.location_id));

    const cast = [...histories.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([npcId, history]): ProjectedNpc[] => {
      const latest = history.at(-1)!;
      if (running && latest.state === "left") return [];
      const npc = db.prepare(`SELECT npc.persona_id,npc.public_name,metadata.public_state_json,metadata.private_state_json,
          private.private_goals,private.gm_notes,private.merchant_state_json
        FROM campaign_npcs_v28 npc LEFT JOIN campaign_npc_metadata_v32 metadata ON metadata.npc_id=npc.npc_id
        LEFT JOIN campaign_npc_private_state_v28 private
          ON private.campaign_id=npc.campaign_id AND private.npc_id=npc.npc_id
        WHERE npc.campaign_id=? AND npc.npc_id=?`).get(campaignId, npcId) as NpcRow | undefined;
      if (!npc) return [];

      let latestPresentIndex = history.length - 1;
      while (latestPresentIndex >= 0 && history[latestPresentIndex]!.state !== "present") latestPresentIndex -= 1;
      if (latestPresentIndex < 0) throw new Error("NPC presence scoped graph integrity is inconsistent");
      let presentAt = history[latestPresentIndex]!.occurred_at;
      const updatedAt = latest.occurred_at;
      for (let index = latestPresentIndex; index > 0 && history[index - 1]!.state === "present"; index -= 1) {
        presentAt = history[index - 1]!.occurred_at;
      }
      const publicState = npcPublicStateHttpSchema.parse(
        npc.public_state_json ? parseJson(npc.public_state_json) : { name: npc.public_name },
      );
      const locationRow = latest.location_id === null ? undefined : db.prepare(
        "SELECT public_name,visibility FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?",
      ).get(campaignId, latest.location_id) as { public_name: string; visibility: string } | undefined;
      const locationVisible = Boolean(locationRow && (isGm
        || (locationRow.visibility !== "gm" && knownLocations.has(latest.location_id!))));
      const base = { npcId, publicState, revision: latest.resulting_revision, presentAt, updatedAt };
      // Stopped player history is a frozen conservative view: locations remain hidden even after later discovery.
      if (!isGm) {
        const location = locationVisible ? { label: locationRow!.public_name } : null;
        return [running
        ? { ...base, location }
         : { ...base, leftAt: latest.state === "left" ? latest.occurred_at : null, lastLocation: null }];
      }
      const privateState = npcPrivateStateHttpSchema.parse(npc.private_state_json ? parseJson(npc.private_state_json) : {
        goals: npc.private_goals ?? "", gmNotes: npc.gm_notes ?? "",
        merchantState: npc.merchant_state_json ? parseJson(npc.merchant_state_json) : null,
      });
      const location = locationVisible
        ? { locationId: latest.location_id!, label: locationRow!.public_name }
        : null;
      const principals = [...new Set(history.map((event) => event.principal_id))].sort();
      return [running
        ? { ...base, location, personaId: npc.persona_id, principals, privateState }
        : { ...base, leftAt: latest.state === "left" ? latest.occurred_at : null, lastLocation: location,
          personaId: npc.persona_id, principals, privateState }];
    });

    return npcCastHttpSchema.parse(running
      ? { audience: isGm ? "gm" : "player", state: "running", sessionRevision: revision, presentCast: cast }
      : { audience: isGm ? "gm" : "player", state: "stopped", sessionRevision: revision, castHistory: cast });
  };

  return {
    assertScopedIntegrity,
    projectNpcCast,
    getNpcCast(principalId, campaignId, sessionId) {
      context.guard();
      return db.transaction(() => {
        const revision = (db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
          .get(campaignId, sessionId) as { revision: number } | undefined)?.revision ?? 0;
        return projectNpcCast(principalId, campaignId, sessionId, revision);
      })();
    },
  };
}
