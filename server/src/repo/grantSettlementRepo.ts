import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import type { IdGenerator } from "../runtime.js";

type StarterGrant =
  | { kind: "item"; reference: { packId: string; packVersion: string; definitionId: string }; quantity: number }
  | { kind: "currency"; reference: { packId: string; packVersion: string; definitionId: string }; amount: number };

function ensurePinnedDefinition(db: DatabaseDriver.Database, campaignId: string, reference: StarterGrant["reference"], kind: "item" | "currency"): void {
  db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM campaign_catalog_current_pins
      WHERE campaign_id=? AND pack_id=? AND pack_version=?)`)
    .run(campaignId, reference.packId, reference.packVersion, kind, reference.definitionId,
      campaignId, reference.packId, reference.packVersion);
}

function currencyCode(db: DatabaseDriver.Database, campaignId: string, reference: StarterGrant["reference"]): string {
  ensurePinnedDefinition(db, campaignId, reference, "currency");
  const existing = db.prepare(`SELECT currency_code FROM rpg_currency_references_v25 WHERE campaign_id=?
    AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
    .get(campaignId, reference.packId, reference.packVersion, reference.definitionId) as { currency_code: string } | undefined;
  if (existing) return existing.currency_code;
  const code = `CUR${createHash("sha256").update(`${reference.packId}\0${reference.packVersion}\0${reference.definitionId}`).digest("hex").slice(0,13)}`.toUpperCase();
  db.prepare(`INSERT INTO rpg_currency_references_v25(campaign_id,currency_code,pack_id,pack_version,kind,definition_id)
    VALUES(?,?,?,?,'currency',?)`).run(campaignId, code, reference.packId, reference.packVersion, reference.definitionId);
  return code;
}

/** Materializes each finalized starter grant in the same surrounding transaction. */
export function materializeStarterGrantsV51(db: DatabaseDriver.Database, ids: IdGenerator, input: {
  draftId: string; campaignId: string; actorId: string; grants: StarterGrant[]; occurredAt: string;
}): void {
  input.grants.forEach((grant, position) => {
    if (grant.kind === "item") {
      ensurePinnedDefinition(db, input.campaignId, grant.reference, "item");
      const entryId = ids.nextId();
      db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,
        item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
        VALUES(?,?,?,?,?,'item',?,'stackable',?,NULL,NULL,0,?)`)
        .run(entryId, input.campaignId, input.actorId, grant.reference.packId, grant.reference.packVersion,
          grant.reference.definitionId, grant.quantity, input.occurredAt);
      db.prepare("INSERT INTO character_starter_materializations_v51 VALUES(?,?,?,?,?,?,?)")
        .run(input.draftId, position, input.campaignId, input.actorId, "inventory", entryId, input.occurredAt);
      return;
    }
    const code = currencyCode(db, input.campaignId, grant.reference);
    db.prepare(`INSERT INTO rpg_wallets_v25(campaign_id,actor_id,currency_code,balance_minor,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(campaign_id,actor_id,currency_code) DO UPDATE SET balance_minor=balance_minor+excluded.balance_minor,
      updated_at=excluded.updated_at`).run(input.campaignId, input.actorId, code, grant.amount, input.occurredAt);
    if (grant.amount > 0) db.prepare(`INSERT INTO rpg_currency_ledger_v25(entry_id,campaign_id,actor_id,currency_code,delta_minor,
      reason,reference_type,reference_id,occurred_at) VALUES(?,?,?,?,?,'character starter grant','character-draft',?,?)`)
      .run(ids.nextId(), input.campaignId, input.actorId, code, grant.amount, input.draftId, input.occurredAt);
    db.prepare("INSERT INTO character_starter_materializations_v51 VALUES(?,?,?,?,?,?,?)")
      .run(input.draftId, position, input.campaignId, input.actorId, "wallet", `${input.campaignId}:${input.actorId}:${code}`, input.occurredAt);
  });
}

/** Places a new actor only when the campaign has one explicit starting location and one live session. */
export function placeFinalizedActorAtCampaignStartV51(db: DatabaseDriver.Database, input: {
  campaignId: string; actorId: string; occurredAt: string;
}): void {
  const start = db.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?")
    .get(input.campaignId) as { location_id: string } | undefined;
  if (!start) return;
  const sessions = db.prepare(`SELECT attached.session_id FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
    WHERE attached.campaign_id=? AND session.state='active' AND session.stopped_at IS NULL ORDER BY attached.session_id`)
    .all(input.campaignId) as Array<{ session_id: string }>;
  if (sessions.length !== 1) return;
  db.prepare("INSERT INTO campaign_actor_locations_v28(campaign_id,actor_id,location_id,session_id,state_revision,updated_at) VALUES(?,?,?,?,0,?)")
    .run(input.campaignId, input.actorId, start.location_id, sessions[0]!.session_id, input.occurredAt);
  db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28(campaign_id,actor_id,location_id,discovered_at) VALUES(?,?,?,?)")
    .run(input.campaignId, input.actorId, start.location_id, input.occurredAt);
}

/** Atomically credits every immutable currency entry in one reward bundle. */
export function settleCombatRewardV51(db: DatabaseDriver.Database, ids: IdGenerator, input: {
  campaignId: string; encounterId: string; rewardBundleId: string; recipientActorId: string;
  rewardClaimId: string; occurredAt: string;
}): void {
  const entries = db.prepare(`SELECT currency_code,amount_minor FROM reward_entry_v27
    WHERE campaign_id=? AND reward_bundle_id=? ORDER BY entry_ordinal`).all(input.campaignId, input.rewardBundleId) as Array<{ currency_code: string; amount_minor: number }>;
  if (entries.length === 0) throw new Error("reward bundle has no settleable entries");
  for (const entry of entries) {
    db.prepare(`INSERT INTO rpg_wallets_v25(campaign_id,actor_id,currency_code,balance_minor,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(campaign_id,actor_id,currency_code) DO UPDATE SET balance_minor=balance_minor+excluded.balance_minor,
      updated_at=excluded.updated_at`).run(input.campaignId, input.recipientActorId, entry.currency_code, entry.amount_minor, input.occurredAt);
    db.prepare(`INSERT INTO rpg_currency_ledger_v25(entry_id,campaign_id,actor_id,currency_code,delta_minor,reason,reference_type,reference_id,occurred_at)
      VALUES(?,?,?,?,?,'combat reward','reward-bundle',?,?)`).run(ids.nextId(), input.campaignId, input.recipientActorId,
      entry.currency_code, entry.amount_minor, input.rewardBundleId, input.occurredAt);
  }
  db.prepare("INSERT INTO combat_reward_settlements_v51 VALUES(?,?,?,?,?,?)").run(input.rewardBundleId, input.campaignId,
    input.encounterId, input.recipientActorId, input.rewardClaimId, input.occurredAt);
}
