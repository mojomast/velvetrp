// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignAdministrationEventSchema, resourceIdSchema,
  type CampaignAdministrationEvent, type CampaignAdministrationReceipt,
} from "@velvet/contracts";

type Role = "owner" | "gm" | "player" | "observer";

export interface AdministrationEventAuthority {
  role: Role;
  revision: number;
}

export interface AdministrationEventDependencies {
  db: DatabaseDriver.Database;
  getAuthority: (actor: string, campaignId: string) => AdministrationEventAuthority | null;
}

export function publicAdministrationPayload(type: CampaignAdministrationReceipt["type"], payload: object): object {
  const value = payload as Record<string, unknown>;
  if (type === "administration_updated" && value.settings && typeof value.settings === "object") {
    const { gmNotes: _privateNotes, ...publicSettings } = value.settings as Record<string, unknown>;
    return { ...value, settings: publicSettings };
  }
  if (type === "recap_created") {
    const { text: _privateText, ...metadata } = value;
    return metadata;
  }
  return payload;
}

export function createAdministrationEventRepo(deps: AdministrationEventDependencies) {
  const { db, getAuthority } = deps;
  const catalogAdministrationEvents = (campaignId: string): CampaignAdministrationEvent[] => {
    return (db.prepare(`SELECT event_id,command_id,revision,occurred_at,public_data FROM campaign_catalog_events
      WHERE campaign_id=? ORDER BY revision`).all(campaignId) as any[]).map((row) => campaignAdministrationEventSchema.parse({
        eventId: row.event_id, commandId: row.command_id, campaignId, type: "catalog_configured",
        revision: row.revision, occurredAt: row.occurred_at, data: JSON.parse(row.public_data),
      }));
  };
  const assertContiguousAdministrationHistory = (events: Array<{ revision: number }>, revision: number): void => {
    if (events.length !== revision || events.some((event, index) => event.revision !== index + 1)) {
      throw new Error("campaign administration history is incomplete");
    }
  };
  const listCampaignAdministrationEvents = (actor: string, campaignId: string): CampaignAdministrationEvent[] => {
    const auth = getAuthority(resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
    const imported = (db.prepare("SELECT * FROM campaign_imported_administration_events WHERE campaign_id=? ORDER BY revision")
      .all(campaignId) as any[]).map((row) => campaignAdministrationEventSchema.parse({ eventId: row.source_event_id,
        commandId: row.source_command_id, campaignId, revision: row.revision, type: row.type,
        data: JSON.parse(row.public_data), occurredAt: row.occurred_at }));
    const current = (db.prepare(`SELECT event.* FROM campaign_administration_events event
      JOIN campaign_administration_commands command ON command.campaign_id=event.campaign_id
        AND command.command_id=event.command_id AND command.type=event.type
        AND command.expected_revision=event.revision_before
      JOIN campaign_administration_receipts receipt ON receipt.campaign_id=event.campaign_id
        AND receipt.command_id=event.command_id AND receipt.event_id=event.event_id
        AND receipt.type=event.type AND receipt.revision_before=event.revision_before
        AND receipt.revision_after=event.revision
      WHERE event.campaign_id=? ORDER BY event.revision`).all(campaignId) as any[]).map((row) =>
        campaignAdministrationEventSchema.parse({ eventId: row.event_id, commandId: row.command_id,
          campaignId, revision: row.revision, type: row.type,
          // GM receives exactly the public event projection; only the owner may inspect bounded private event details.
          data: JSON.parse(auth.role === "owner" ? row.private_data : row.public_data), occurredAt: row.occurred_at }));
    const catalog = catalogAdministrationEvents(campaignId);
    const merged = [...imported, ...current, ...catalog].sort((left, right) => left.revision - right.revision);
    assertContiguousAdministrationHistory(merged, auth.revision);
    return merged;
  };
  return { catalogAdministrationEvents, assertContiguousAdministrationHistory, listCampaignAdministrationEvents };
}
