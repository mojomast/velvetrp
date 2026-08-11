import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";

const TABLES = [
  "companion_commands_v44",
  "companion_receipts_v44",
  "campaign_companions_v44",
  "companion_presence_links_v44",
  "companion_proposals_v44",
  "companion_decisions_v44",
  "companion_decision_receipts_v44",
  "companion_grants_v44",
  "companion_grant_command_families_v44",
  "companion_grant_revocations_v44",
  "companion_audit_events_v44",
  "companion_layout_attestation_v44",
] as const;
const INDEXES = [
  "idx_companion_commands_principal_v44",
  "idx_companion_receipts_revision_v44",
  "idx_companion_presence_session_v44",
  "idx_companion_proposals_companion_v44",
  "idx_companion_decisions_companion_v44",
  "idx_companion_grants_grantee_v44",
  "idx_companion_grants_actor_v44",
  "idx_companion_audit_companion_v44",
] as const;
const IMMUTABLE_TABLES = [
  "companion_commands_v44",
  "companion_receipts_v44",
  "companion_presence_links_v44",
  "companion_proposals_v44",
  "companion_decisions_v44",
  "companion_decision_receipts_v44",
  "companion_grants_v44",
  "companion_grant_command_families_v44",
  "companion_grant_revocations_v44",
  "companion_audit_events_v44",
  "companion_layout_attestation_v44",
] as const;
const TRIGGERS = [
  ...IMMUTABLE_TABLES.flatMap((table) => [
    `${table}_immutable_update_v44`, `${table}_immutable_delete_v44`,
  ]),
  "campaign_companions_v44_structural_update_v44",
] as const;

export const COMPANION_CORE_V44_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const),
  ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
] as const;

const inventorySql = `SELECT type,name,tbl_name FROM sqlite_master
  WHERE type IN ('table','index','trigger') AND sql IS NOT NULL
    AND (name GLOB '*v44*' OR tbl_name IN (${TABLES.map(() => "?").join(",")}))
  ORDER BY type,name`;

function layoutDigest(db: DatabaseDriver.Database): string {
  const names = COMPANION_CORE_V44_MANAGED_OBJECTS.map(([, name]) => name);
  const rows = (db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`).all(...names) as Array<{
      type: string; name: string; tbl_name: string; sql: string | null;
    }>).map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export const COMPANION_CORE_V44_LAYOUT_DIGEST = "eb3af7cb737d3222df3589bc190f5163f4d988a57f5cfc4c1520c516f6db0676";

export function assertCompanionCoreLayoutV44(db: DatabaseDriver.Database): void {
  const expected = new Set(COMPANION_CORE_V44_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const artifacts = db.prepare(inventorySql).all(...TABLES) as Array<{ type: string; name: string }>;
  const unknown = artifacts.find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (unknown || artifacts.length !== expected.size) throw new Error("schema v44 companion-core inventory is incompatible");
  const attestation = db.prepare("SELECT layout_digest FROM companion_layout_attestation_v44 WHERE singleton=1")
    .get() as { layout_digest: string } | undefined;
  const actual = layoutDigest(db);
  if (!attestation || attestation.layout_digest !== actual || actual !== COMPANION_CORE_V44_LAYOUT_DIGEST) {
    throw new Error(`schema v44 companion-core layout attestation is incompatible (${actual})`);
  }
}

export function createCompanionCoreV44(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE companion_commands_v44 (
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('companion-create','grant-create','grant-revoke')),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 32768 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,npc_id,command_id),
      UNIQUE(campaign_id,npc_id,idempotency_key),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      UNIQUE(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest),
      UNIQUE(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );

    CREATE TABLE companion_receipts_v44 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      command_payload_digest TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK(length(outcome_json) BETWEEN 2 AND 262144 AND json_valid(outcome_json) AND json_type(outcome_json)='object'),
      outcome_digest TEXT NOT NULL CHECK(length(outcome_digest)=64 AND outcome_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id,command_id),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      UNIQUE(receipt_id,campaign_id,npc_id,command_id,resulting_revision),
      UNIQUE(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest),
      FOREIGN KEY(campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,idempotency_key) REFERENCES companion_commands_v44(campaign_id,npc_id,idempotency_key) ON DELETE RESTRICT
    );

    CREATE TABLE campaign_companions_v44 (
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      initial_session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','dismissed')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL
        AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND updated_at>=created_at),
      create_command_id TEXT NOT NULL,
      create_receipt_id TEXT NOT NULL,
      create_revision INTEGER NOT NULL CHECK(create_revision=1),
      create_command_kind TEXT NOT NULL CHECK(create_command_kind='companion-create'),
      create_payload_digest TEXT NOT NULL,
      last_command_id TEXT NOT NULL,
      last_receipt_id TEXT NOT NULL,
      last_command_kind TEXT NOT NULL,
      last_payload_digest TEXT NOT NULL,
      PRIMARY KEY(campaign_id,npc_id),
      UNIQUE(campaign_id,initial_session_id,npc_id),
      FOREIGN KEY(campaign_id,initial_session_id,npc_id) REFERENCES campaign_npc_presence_v43(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(create_receipt_id,campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,last_command_id,revision,last_command_kind,last_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(last_receipt_id,campaign_id,npc_id,last_command_id,revision,last_command_kind,last_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );

    CREATE TABLE companion_presence_links_v44 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      create_command_id TEXT NOT NULL,
      create_receipt_id TEXT NOT NULL,
      create_revision INTEGER NOT NULL CHECK(create_revision=1),
      create_command_kind TEXT NOT NULL CHECK(create_command_kind='companion-create'),
      create_payload_digest TEXT NOT NULL,
      linked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) IS NOT NULL
        AND linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v44(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,session_id,npc_id) REFERENCES campaign_npc_presence_v43(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(create_receipt_id,campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );

    CREATE TABLE companion_proposals_v44 (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) BETWEEN 1 AND 128 AND proposal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      proposer_kind TEXT NOT NULL CHECK(proposer_kind IN ('campaign-principal','companion','provider','system')),
      proposer_principal_id TEXT,
      proposer_npc_id TEXT,
      provider_call_id TEXT,
      system_source TEXT,
      command_family TEXT NOT NULL CHECK(command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      actor_scope_kind TEXT NOT NULL CHECK(actor_scope_kind IN ('none','campaign-actor')),
      actor_id TEXT,
      resource_scope_kind TEXT NOT NULL CHECK(resource_scope_kind IN ('none','actor-resources','wallet','inventory','powers')),
      exact_command_json TEXT NOT NULL CHECK(length(exact_command_json) BETWEEN 2 AND 32768 AND json_valid(exact_command_json) AND json_type(exact_command_json)='object'),
      command_digest TEXT NOT NULL CHECK(length(command_digest)=64 AND command_digest NOT GLOB '*[^0-9a-f]*'),
      policy_json TEXT NOT NULL CHECK(length(policy_json) BETWEEN 2 AND 32768 AND json_valid(policy_json) AND json_type(policy_json)='object'),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('not-required','pending','approved','rejected','expired','cancelled')),
      proposed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) IS NOT NULL
        AND proposed_at=strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) AND substr(proposed_at,12,2) BETWEEN '00' AND '23'),
      CHECK((actor_scope_kind='none' AND actor_id IS NULL) OR (actor_scope_kind='campaign-actor' AND actor_id IS NOT NULL)),
      CHECK((proposer_kind='campaign-principal' AND proposer_principal_id IS NOT NULL AND proposer_npc_id IS NULL AND provider_call_id IS NULL AND system_source IS NULL)
        OR (proposer_kind='companion' AND proposer_principal_id IS NULL AND proposer_npc_id IS NOT NULL AND provider_call_id IS NULL AND system_source IS NULL)
        OR (proposer_kind='provider' AND proposer_principal_id IS NULL AND proposer_npc_id IS NULL AND provider_call_id IS NOT NULL AND system_source IS NULL)
        OR (proposer_kind='system' AND proposer_principal_id IS NULL AND proposer_npc_id IS NULL AND provider_call_id IS NULL AND system_source IS NOT NULL)),
      UNIQUE(proposal_id,campaign_id,npc_id),
      UNIQUE(proposal_id,campaign_id,npc_id,command_family,command_digest,policy_digest),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v44(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,session_id,npc_id) REFERENCES companion_presence_links_v44(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,proposer_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,proposer_npc_id) REFERENCES campaign_companions_v44(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );

    CREATE TABLE companion_decisions_v44 (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      proposal_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      decided_by_principal_id TEXT NOT NULL,
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('approved','rejected','expired','cancelled')),
      reviewed_command_family TEXT NOT NULL,
      reviewed_command_digest TEXT NOT NULL,
      reviewed_policy_digest TEXT NOT NULL,
      decided_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL
        AND decided_at=strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) AND substr(decided_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(decision_id,campaign_id,npc_id,proposal_id,reviewed_command_family,confirmation_state),
      FOREIGN KEY(proposal_id,campaign_id,npc_id,reviewed_command_family,reviewed_command_digest,reviewed_policy_digest)
        REFERENCES companion_proposals_v44(proposal_id,campaign_id,npc_id,command_family,command_digest,policy_digest) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,decided_by_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );

    CREATE TABLE companion_decision_receipts_v44 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      decision_id TEXT NOT NULL UNIQUE,
      proposal_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_family TEXT NOT NULL,
      confirmation_state TEXT NOT NULL CHECK(confirmation_state='approved'),
      authoritative_command_id TEXT NOT NULL CHECK(length(authoritative_command_id) BETWEEN 1 AND 128 AND authoritative_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(decision_id,campaign_id,npc_id,proposal_id,command_family,confirmation_state)
        REFERENCES companion_decisions_v44(decision_id,campaign_id,npc_id,proposal_id,reviewed_command_family,confirmation_state) ON DELETE RESTRICT
    );

    CREATE TABLE companion_grants_v44 (
      grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128 AND grant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      granted_by_principal_id TEXT NOT NULL,
      grantee_principal_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      resource_scope_kind TEXT NOT NULL CHECK(resource_scope_kind IN ('none','actor-resources','wallet','inventory','powers')),
      confirmation_policy TEXT NOT NULL CHECK(confirmation_policy IN ('always','domain-policy')),
      primary_command_family TEXT NOT NULL CHECK(primary_command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      max_spend INTEGER CHECK(max_spend IS NULL OR (typeof(max_spend)='integer' AND max_spend BETWEEN 0 AND 9007199254740991)),
      max_uses INTEGER CHECK(max_uses IS NULL OR (typeof(max_uses)='integer' AND max_uses BETWEEN 1 AND 9007199254740991)),
      starts_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',starts_at) IS NOT NULL
        AND starts_at=strftime('%Y-%m-%dT%H:%M:%fZ',starts_at) AND substr(starts_at,12,2) BETWEEN '00' AND '23'),
      expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL
        AND expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) AND substr(expires_at,12,2) BETWEEN '00' AND '23' AND expires_at>starts_at),
      created_command_id TEXT NOT NULL,
      created_receipt_id TEXT NOT NULL,
      created_revision INTEGER NOT NULL,
      created_command_kind TEXT NOT NULL CHECK(created_command_kind='grant-create'),
      created_payload_digest TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      CHECK(granted_by_principal_id<>grantee_principal_id),
      UNIQUE(grant_id,campaign_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v44(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,granted_by_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,grantee_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,created_command_id,created_revision,created_command_kind,granted_by_principal_id,created_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(created_receipt_id,campaign_id,npc_id,created_command_id,created_revision,created_command_kind,created_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(grant_id,campaign_id,npc_id,primary_command_family)
        REFERENCES companion_grant_command_families_v44(grant_id,campaign_id,npc_id,command_family) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE companion_grant_command_families_v44 (
      grant_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_family TEXT NOT NULL CHECK(command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      PRIMARY KEY(grant_id,command_family),
      UNIQUE(grant_id,campaign_id,npc_id,command_family),
      FOREIGN KEY(grant_id,campaign_id,npc_id) REFERENCES companion_grants_v44(grant_id,campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE companion_grant_revocations_v44 (
      grant_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      revoked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS NOT NULL
        AND revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) AND substr(revoked_at,12,2) BETWEEN '00' AND '23'),
      revocation_reason TEXT NOT NULL CHECK(length(trim(revocation_reason)) BETWEEN 1 AND 500),
      revoked_by_principal_id TEXT NOT NULL,
      revoked_command_id TEXT NOT NULL,
      revoked_receipt_id TEXT NOT NULL,
      revoked_revision INTEGER NOT NULL,
      revoked_command_kind TEXT NOT NULL CHECK(revoked_command_kind='grant-revoke'),
      revoked_payload_digest TEXT NOT NULL,
      FOREIGN KEY(grant_id,campaign_id,npc_id) REFERENCES companion_grants_v44(grant_id,campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,revoked_by_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,revoked_command_id,revoked_revision,revoked_command_kind,revoked_by_principal_id,revoked_payload_digest)
        REFERENCES companion_commands_v44(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(revoked_receipt_id,campaign_id,npc_id,revoked_command_id,revoked_revision,revoked_command_kind,revoked_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );

    CREATE TABLE companion_audit_events_v44 (
      audit_id TEXT PRIMARY KEY CHECK(length(audit_id) BETWEEN 1 AND 128 AND audit_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('companion-created','grant-created','grant-revoked')),
      command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('companion-create','grant-create','grant-revoke')),
      command_payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      CHECK((event_kind='companion-created' AND command_kind='companion-create')
        OR (event_kind='grant-created' AND command_kind='grant-create')
        OR (event_kind='grant-revoked' AND command_kind='grant-revoke')),
      FOREIGN KEY(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest)
        REFERENCES companion_receipts_v44(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );

    CREATE TABLE companion_layout_attestation_v44 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*')
    );

    CREATE INDEX idx_companion_commands_principal_v44 ON companion_commands_v44(campaign_id,principal_id,created_at);
    CREATE INDEX idx_companion_receipts_revision_v44 ON companion_receipts_v44(campaign_id,npc_id,resulting_revision);
    CREATE INDEX idx_companion_presence_session_v44 ON companion_presence_links_v44(campaign_id,session_id);
    CREATE INDEX idx_companion_proposals_companion_v44 ON companion_proposals_v44(campaign_id,npc_id,proposed_at);
    CREATE INDEX idx_companion_decisions_companion_v44 ON companion_decisions_v44(campaign_id,npc_id,decided_at);
    CREATE INDEX idx_companion_grants_grantee_v44 ON companion_grants_v44(campaign_id,grantee_principal_id,expires_at);
    CREATE INDEX idx_companion_grants_actor_v44 ON companion_grants_v44(campaign_id,actor_id,expires_at);
    CREATE INDEX idx_companion_audit_companion_v44 ON companion_audit_events_v44(campaign_id,npc_id,occurred_at);

    CREATE TRIGGER campaign_companions_v44_structural_update_v44
      BEFORE UPDATE ON campaign_companions_v44
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.npc_id<>OLD.npc_id
        OR NEW.initial_session_id<>OLD.initial_session_id OR NEW.created_at<>OLD.created_at
        OR NEW.create_command_id<>OLD.create_command_id OR NEW.create_receipt_id<>OLD.create_receipt_id
        OR NEW.create_revision<>OLD.create_revision OR NEW.create_command_kind<>OLD.create_command_kind
        OR NEW.create_payload_digest<>OLD.create_payload_digest
        OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      BEGIN SELECT RAISE(ABORT,'v44 companion projection must preserve creation anchors and advance exactly once'); END;
  `);
  for (const table of IMMUTABLE_TABLES) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update_v44 BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v44 companion history is immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete_v44 BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v44 companion history is immutable'); END;`);
  }
  db.prepare("INSERT INTO companion_layout_attestation_v44 VALUES(1,?)").run(layoutDigest(db));
}

export function migrate43to44(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createCompanionCoreV44(db);
    db.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();
  })();
}
