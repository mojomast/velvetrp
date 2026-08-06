// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, type CampaignAdministrationEvent, type CampaignAdministrationReceipt } from "@velvet/contracts";

type Role = "owner" | "gm" | "player" | "observer";

export interface AdministrationReceiptAuthority {
  role: Role;
}

export interface AdministrationReceiptDependencies {
  db: DatabaseDriver.Database;
  event: (value: unknown) => CampaignAdministrationEvent;
  getAuthority: (actor: string, campaignId: string) => AdministrationReceiptAuthority | null;
  receipt: (value: unknown) => CampaignAdministrationReceipt;
}

export function createAdministrationReceiptRepo(deps: AdministrationReceiptDependencies) {
  const { db, event, getAuthority, receipt } = deps;
  const catalogAdministrationReceipts = (campaignId: string): Array<{
    commandId: string; type: "catalog_configured"; revisionBefore: number; revisionAfter: number; occurredAt: string;
  }> => {
    return (db.prepare(`SELECT receipt.command_id,receipt.revision_before,receipt.revision_after,event.occurred_at
    FROM campaign_catalog_receipts receipt JOIN campaign_catalog_events event ON event.campaign_id=receipt.campaign_id
      AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
    WHERE receipt.campaign_id=? ORDER BY receipt.revision_after`).all(campaignId) as any[]).map((row) => ({
        commandId: row.command_id, type: "catalog_configured" as const, revisionBefore: row.revision_before,
        revisionAfter: row.revision_after, occurredAt: row.occurred_at,
      }));
  };
  const getCampaignAdministrationReceipt = (actor: string, campaignIdRaw: string, commandIdRaw: string): CampaignAdministrationReceipt | null => {
    const campaignId = resourceIdSchema.parse(campaignIdRaw), commandId = resourceIdSchema.parse(commandIdRaw);
    const auth = getAuthority(resourceIdSchema.parse(actor), campaignId); if (!auth) return null;
    const row = db.prepare(`SELECT receipt.*,command.created_at,event.occurred_at,event.public_data,event.private_data
        FROM campaign_administration_receipts receipt
        JOIN campaign_administration_commands command ON command.campaign_id=receipt.campaign_id
          AND command.command_id=receipt.command_id AND command.type=receipt.type
          AND command.expected_revision=receipt.revision_before
        JOIN campaign_administration_events event ON event.campaign_id=receipt.campaign_id
          AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
          AND event.type=receipt.type AND event.revision_before=receipt.revision_before
          AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.command_id=?`).get(campaignId, commandId) as any;
    if (row) {
      const administrationEvent = event({ eventId: row.event_id, commandId, campaignId,
        type: row.type, revision: row.revision_after, occurredAt: row.occurred_at,
        data: JSON.parse(auth.role === "owner" ? row.private_data : row.public_data) });
      return receipt({ commandId, campaignId, type: row.type,
        revisionBefore: row.revision_before, revisionAfter: row.revision_after,
        occurredAt: row.created_at, events: [administrationEvent] });
    }
    const catalogReceipt=db.prepare(`SELECT receipt.*,event.occurred_at,event.public_data FROM campaign_catalog_receipts receipt
        JOIN campaign_catalog_events event ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id
          AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.command_id=?`).get(campaignId,commandId) as any;
    if(catalogReceipt){
      const administrationEvent=event({eventId:catalogReceipt.event_id,commandId,campaignId,
        type:"catalog_configured",revision:catalogReceipt.revision_after,occurredAt:catalogReceipt.occurred_at,
        data:JSON.parse(catalogReceipt.public_data)});
      return receipt({commandId,campaignId,type:"catalog_configured",
        revisionBefore:catalogReceipt.revision_before,revisionAfter:catalogReceipt.revision_after,
        occurredAt:catalogReceipt.occurred_at,events:[administrationEvent]});
    }
    const imported = db.prepare(`SELECT receipt.*,event.source_event_id,event.public_data,event.occurred_at
        FROM campaign_imported_administration_receipts receipt
        JOIN campaign_imported_administration_events event ON event.campaign_id=receipt.campaign_id
          AND event.source_command_id=receipt.source_command_id AND event.type=receipt.type
          AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.source_command_id=?`).get(campaignId, commandId) as any;
    if (!imported) return null;
    const administrationEvent = event({ eventId: imported.source_event_id, commandId,
      campaignId, type: imported.type, revision: imported.revision_after,
      occurredAt: imported.occurred_at, data: JSON.parse(imported.public_data) });
    return receipt({ commandId, campaignId, type: imported.type,
      revisionBefore: imported.revision_before, revisionAfter: imported.revision_after,
      occurredAt: imported.occurred_at, events: [administrationEvent] });
  };
  return { catalogAdministrationReceipts, getCampaignAdministrationReceipt };
}
