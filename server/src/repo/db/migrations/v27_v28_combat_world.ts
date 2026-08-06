// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalV17 } from "./v16_v18_catalog.js";
import { V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST, assertChecksPowersEffectsLayoutV26, validateM16PersistenceV26 } from "./v25_v26_resources.js";

/** Additive v27r1 foundation for session-scoped, deterministic turn combat. */
export function createCombatFoundationV27(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE encounter (
      encounter_id TEXT PRIMARY KEY CHECK(length(encounter_id) BETWEEN 1 AND 128 AND encounter_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL,
      encounter_kind TEXT NOT NULL CHECK(encounter_kind IN ('prepared','improvised')),
      -- These values are the public EncounterStatus contract.  Creation may
      -- immediately activate an encounter, but it must not invent a private
      -- terminal vocabulary that clients cannot represent.
      status TEXT NOT NULL CHECK(status IN ('preparing','active','completed','escaped')),
      round_number INTEGER NOT NULL DEFAULT 0 CHECK(typeof(round_number)='integer' AND round_number BETWEEN 0 AND 1000000),
      current_turn_combatant_id TEXT, state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK(updated_at>=created_at),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,current_turn_combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_encounter_active_session_v27 ON encounter(session_id) WHERE status='active';
    CREATE INDEX idx_encounter_campaign_session_v27 ON encounter(campaign_id,session_id,created_at);
    CREATE TABLE combat_mutation_revisions_v27 (
      encounter_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE combat_commands_v27 (
      encounter_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT, command_type TEXT NOT NULL CHECK(command_type IN ('start','advance_turn','resolve_action','flee','remove_combatant','grant_rewards','close')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(encounter_id,command_id), UNIQUE(encounter_id,idempotency_key), UNIQUE(encounter_id,resulting_revision), UNIQUE(encounter_id,command_id,resulting_revision),
      FOREIGN KEY(encounter_id) REFERENCES combat_mutation_revisions_v27(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE combat_receipts_v27 (
      encounter_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(encounter_id,command_id), UNIQUE(encounter_id,resulting_revision), UNIQUE(encounter_id,command_id,resulting_revision),
      FOREIGN KEY(encounter_id,command_id,resulting_revision) REFERENCES combat_commands_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE combat_events_v27 (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('encounter_state_changed','combatant_state_changed','combat_action_resolved','rewards_granted')),
      event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(encounter_id,event_id), UNIQUE(encounter_id,command_id,event_type),
      FOREIGN KEY(encounter_id,command_id,resulting_revision) REFERENCES combat_receipts_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE combatant (
      combatant_id TEXT PRIMARY KEY CHECK(length(combatant_id) BETWEEN 1 AND 128 AND combatant_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      actor_id TEXT, combatant_kind TEXT NOT NULL CHECK(combatant_kind IN ('actor','enemy')),
      -- Server-spawned enemies retain the historical insert shape; actor joins
      -- must provide their contract team explicitly.
      team TEXT NOT NULL DEFAULT 'enemies' CHECK(team IN ('allies','enemies')),
      enemy_pack_id TEXT, enemy_pack_version TEXT, enemy_kind TEXT CHECK(enemy_kind IS NULL OR enemy_kind='enemy'), enemy_definition_id TEXT,
      enemy_tactic TEXT NOT NULL DEFAULT 'basic_attack' CHECK(enemy_tactic IN ('basic_attack')),
      initiative INTEGER NOT NULL CHECK(typeof(initiative)='integer' AND initiative BETWEEN -1000000 AND 1000000), initiative_tiebreaker INTEGER NOT NULL CHECK(typeof(initiative_tiebreaker)='integer' AND initiative_tiebreaker BETWEEN 0 AND 1000000),
      hit_points INTEGER NOT NULL CHECK(typeof(hit_points)='integer' AND hit_points BETWEEN -1000000 AND 1000000), maximum_hit_points INTEGER NOT NULL CHECK(typeof(maximum_hit_points)='integer' AND maximum_hit_points BETWEEN 1 AND 1000000),
      status TEXT NOT NULL CHECK(status IN ('active','defeated','fled','removed')), state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK(updated_at>=created_at), CHECK((combatant_kind='actor' AND actor_id IS NOT NULL AND enemy_pack_id IS NULL AND enemy_pack_version IS NULL AND enemy_kind IS NULL AND enemy_definition_id IS NULL) OR (combatant_kind='enemy' AND actor_id IS NULL AND ((enemy_pack_id IS NULL AND enemy_pack_version IS NULL AND enemy_kind IS NULL AND enemy_definition_id IS NULL) OR (enemy_pack_id IS NOT NULL AND enemy_pack_version IS NOT NULL AND enemy_kind='enemy' AND enemy_definition_id IS NOT NULL)))),
      UNIQUE(encounter_id,combatant_id),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,enemy_pack_id,enemy_pack_version,enemy_kind,enemy_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_combatant_actor_encounter_v27 ON combatant(encounter_id,actor_id) WHERE actor_id IS NOT NULL;
    CREATE INDEX idx_combatant_turn_order_v27 ON combatant(encounter_id,status,initiative DESC,initiative_tiebreaker,combatant_id);
    CREATE TABLE combat_log (
      log_id TEXT PRIMARY KEY CHECK(length(log_id) BETWEEN 1 AND 128 AND log_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, combatant_id TEXT,
      event_id TEXT NOT NULL, log_ordinal INTEGER NOT NULL CHECK(typeof(log_ordinal)='integer' AND log_ordinal BETWEEN 0 AND 1000000),
      log_kind TEXT NOT NULL CHECK(log_kind IN ('encounter_state','turn','action','damage','defeat','flee','removal','reward')),
      log_json TEXT NOT NULL CHECK(length(log_json) BETWEEN 2 AND 32768 AND json_valid(log_json) AND json_type(log_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(encounter_id,event_id,log_ordinal),
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,event_id) REFERENCES combat_events_v27(encounter_id,event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    -- Rewards are server projections of an immutable lifecycle event, rather
    -- than a client-supplied JSON payload.  v27 has no atomic item or XP store,
    -- and its wallet command stream cannot safely be advanced from this stream;
    -- consequently the only offerable entry is an un-settled currency claim.
    CREATE TABLE reward_bundle (
      reward_bundle_id TEXT PRIMARY KEY CHECK(length(reward_bundle_id) BETWEEN 1 AND 128 AND reward_bundle_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, encounter_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,reward_bundle_id), UNIQUE(encounter_id,source_event_id,recipient_actor_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,source_event_id) REFERENCES combat_events_v27(encounter_id,event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE reward_entry_v27 (
      reward_entry_id TEXT PRIMARY KEY CHECK(length(reward_entry_id) BETWEEN 1 AND 128 AND reward_entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, reward_bundle_id TEXT NOT NULL, entry_ordinal INTEGER NOT NULL CHECK(typeof(entry_ordinal)='integer' AND entry_ordinal BETWEEN 0 AND 127),
      reward_kind TEXT NOT NULL CHECK(reward_kind='currency'), amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 1000000),
      currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 1 AND 128 AND currency_code NOT GLOB '*[^A-Za-z0-9._:-]*'),
      currency_pack_id TEXT NOT NULL, currency_pack_version TEXT NOT NULL, currency_kind TEXT NOT NULL CHECK(currency_kind='currency'), currency_definition_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(reward_bundle_id,entry_ordinal), UNIQUE(campaign_id,reward_entry_id),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_pack_id,currency_pack_version,currency_kind,currency_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE reward_claim_v27 (
      reward_claim_id TEXT PRIMARY KEY CHECK(length(reward_claim_id) BETWEEN 1 AND 128 AND reward_claim_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, reward_bundle_id TEXT NOT NULL, encounter_id TEXT NOT NULL, command_id TEXT NOT NULL,
      claim_state TEXT NOT NULL CHECK(claim_state='recorded'),
      claimed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at)=claimed_at AND substr(claimed_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(reward_bundle_id), UNIQUE(encounter_id,command_id),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,command_id) REFERENCES combat_commands_v27(encounter_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE combat_foundation_layout_attestation_v27 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64));
    CREATE TRIGGER encounter_campaign_session_ancestry_v27 BEFORE INSERT ON encounter WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions s WHERE s.session_id=NEW.session_id AND s.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'encounter session must belong to campaign'); END;
    CREATE TRIGGER combat_command_actor_ancestry_v27 BEFORE INSERT ON combat_commands_v27 WHEN NEW.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM encounter e JOIN campaign_actors a ON a.campaign_id=e.campaign_id AND a.id=NEW.actor_id WHERE e.encounter_id=NEW.encounter_id) BEGIN SELECT RAISE(ABORT,'combat command actor must belong to encounter campaign'); END;
    CREATE TRIGGER encounter_state_guard_v27 BEFORE UPDATE ON encounter WHEN NEW.encounter_id<>OLD.encounter_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.encounter_kind<>OLD.encounter_kind OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM combat_log l JOIN combat_events_v27 e ON e.event_id=l.event_id WHERE l.encounter_id=OLD.encounter_id AND l.log_kind='encounter_state' AND e.event_type='encounter_state_changed' AND e.occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'encounter state requires immutable combat event'); END;
    CREATE TRIGGER combatant_ancestry_v27 BEFORE INSERT ON combatant WHEN NOT EXISTS(SELECT 1 FROM encounter e WHERE e.encounter_id=NEW.encounter_id AND e.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'combatant must belong to encounter campaign'); END;
    CREATE TRIGGER combatant_state_guard_v27 BEFORE UPDATE ON combatant WHEN NEW.combatant_id<>OLD.combatant_id OR NEW.encounter_id<>OLD.encounter_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.combatant_kind<>OLD.combatant_kind OR NEW.team<>OLD.team OR NOT (NEW.actor_id IS OLD.actor_id) OR NOT (NEW.enemy_pack_id IS OLD.enemy_pack_id) OR NOT (NEW.enemy_pack_version IS OLD.enemy_pack_version) OR NOT (NEW.enemy_kind IS OLD.enemy_kind) OR NOT (NEW.enemy_definition_id IS OLD.enemy_definition_id) OR NEW.enemy_tactic<>OLD.enemy_tactic OR NEW.initiative<>OLD.initiative OR NEW.initiative_tiebreaker<>OLD.initiative_tiebreaker OR NEW.maximum_hit_points<>OLD.maximum_hit_points OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM combat_log l JOIN combat_events_v27 e ON e.event_id=l.event_id WHERE l.encounter_id=OLD.encounter_id AND l.combatant_id=OLD.combatant_id AND e.event_type='combatant_state_changed' AND e.occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'combatant state requires immutable combat event'); END;
    CREATE TRIGGER combat_mutation_revisions_v27_guard BEFORE UPDATE ON combat_mutation_revisions_v27 WHEN NEW.encounter_id<>OLD.encounter_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'combat mutation revision must advance exactly once'); END;
    CREATE TRIGGER combat_mutation_revisions_v27_retain BEFORE DELETE ON combat_mutation_revisions_v27 BEGIN SELECT RAISE(ABORT,'combat mutation revisions are retained'); END;
    CREATE TRIGGER combat_commands_v27_immutable_update BEFORE UPDATE ON combat_commands_v27 BEGIN SELECT RAISE(ABORT,'combat commands are immutable'); END;
    CREATE TRIGGER combat_commands_v27_immutable_delete BEFORE DELETE ON combat_commands_v27 BEGIN SELECT RAISE(ABORT,'combat commands are immutable'); END;
    CREATE TRIGGER combat_receipts_v27_immutable_update BEFORE UPDATE ON combat_receipts_v27 BEGIN SELECT RAISE(ABORT,'combat receipts are immutable'); END;
    CREATE TRIGGER combat_receipts_v27_immutable_delete BEFORE DELETE ON combat_receipts_v27 BEGIN SELECT RAISE(ABORT,'combat receipts are immutable'); END;
    CREATE TRIGGER combat_events_v27_immutable_update BEFORE UPDATE ON combat_events_v27 BEGIN SELECT RAISE(ABORT,'combat events are immutable'); END;
    CREATE TRIGGER combat_events_v27_immutable_delete BEFORE DELETE ON combat_events_v27 BEGIN SELECT RAISE(ABORT,'combat events are immutable'); END;
    CREATE TRIGGER combat_log_immutable_update_v27 BEFORE UPDATE ON combat_log BEGIN SELECT RAISE(ABORT,'combat logs are immutable'); END;
    CREATE TRIGGER combat_log_immutable_delete_v27 BEFORE DELETE ON combat_log BEGIN SELECT RAISE(ABORT,'combat logs are immutable'); END;
    CREATE TRIGGER reward_bundle_immutable_update_v27 BEFORE UPDATE ON reward_bundle BEGIN SELECT RAISE(ABORT,'reward bundles are immutable'); END;
    CREATE TRIGGER reward_bundle_immutable_delete_v27 BEFORE DELETE ON reward_bundle BEGIN SELECT RAISE(ABORT,'reward bundles are immutable'); END;
    CREATE TRIGGER reward_bundle_server_lifecycle_source_v27 BEFORE INSERT ON reward_bundle WHEN NOT EXISTS(SELECT 1 FROM encounter e JOIN combat_events_v27 event ON event.encounter_id=e.encounter_id AND event.event_id=NEW.source_event_id JOIN combat_commands_v27 command ON command.encounter_id=event.encounter_id AND command.command_id=event.command_id WHERE e.encounter_id=NEW.encounter_id AND e.campaign_id=NEW.campaign_id AND event.event_type='rewards_granted' AND command.command_type='grant_rewards' AND event.occurred_at=NEW.created_at) BEGIN SELECT RAISE(ABORT,'reward bundle requires server lifecycle reward event'); END;
    CREATE TRIGGER reward_entry_v27_immutable_update BEFORE UPDATE ON reward_entry_v27 BEGIN SELECT RAISE(ABORT,'reward entries are immutable'); END;
    CREATE TRIGGER reward_entry_v27_immutable_delete BEFORE DELETE ON reward_entry_v27 BEGIN SELECT RAISE(ABORT,'reward entries are immutable'); END;
    CREATE TRIGGER reward_entry_v27_bundle_timestamp BEFORE INSERT ON reward_entry_v27 WHEN NOT EXISTS(SELECT 1 FROM reward_bundle bundle WHERE bundle.campaign_id=NEW.campaign_id AND bundle.reward_bundle_id=NEW.reward_bundle_id AND bundle.created_at=NEW.created_at) BEGIN SELECT RAISE(ABORT,'reward entry must share immutable bundle timestamp'); END;
    CREATE TRIGGER reward_entry_v27_currency_identity BEFORE INSERT ON reward_entry_v27 WHEN NOT EXISTS(SELECT 1 FROM rpg_currency_references_v25 reference WHERE reference.campaign_id=NEW.campaign_id AND reference.currency_code=NEW.currency_code AND reference.pack_id=NEW.currency_pack_id AND reference.pack_version=NEW.currency_pack_version AND reference.kind=NEW.currency_kind AND reference.definition_id=NEW.currency_definition_id) BEGIN SELECT RAISE(ABORT,'reward currency must match its exact wallet reference'); END;
    CREATE TRIGGER reward_claim_v27_immutable_update BEFORE UPDATE ON reward_claim_v27 BEGIN SELECT RAISE(ABORT,'reward claims are immutable'); END;
    CREATE TRIGGER reward_claim_v27_immutable_delete BEFORE DELETE ON reward_claim_v27 BEGIN SELECT RAISE(ABORT,'reward claims are immutable'); END;
    CREATE TRIGGER reward_claim_v27_exact_command BEFORE INSERT ON reward_claim_v27 WHEN NOT EXISTS(SELECT 1 FROM reward_bundle bundle JOIN combat_commands_v27 command ON command.encounter_id=NEW.encounter_id AND command.command_id=NEW.command_id WHERE bundle.campaign_id=NEW.campaign_id AND bundle.reward_bundle_id=NEW.reward_bundle_id AND bundle.encounter_id=NEW.encounter_id AND command.command_type='grant_rewards' AND command.created_at=NEW.claimed_at AND json_extract(command.canonical_request_json,'$.type')='claim_reward_bundle' AND json_extract(command.canonical_request_json,'$.rewardClaimId')=NEW.reward_claim_id AND json_extract(command.canonical_request_json,'$.rewardBundleId')=NEW.reward_bundle_id AND json_extract(command.canonical_request_json,'$.recipientActorId')=bundle.recipient_actor_id) BEGIN SELECT RAISE(ABORT,'reward claim must match its exact server command'); END;
    CREATE TRIGGER combat_foundation_layout_attestation_v27_immutable_update BEFORE UPDATE ON combat_foundation_layout_attestation_v27 BEGIN SELECT RAISE(ABORT,'v27 layout attestation is immutable'); END;
    CREATE TRIGGER combat_foundation_layout_attestation_v27_immutable_delete BEFORE DELETE ON combat_foundation_layout_attestation_v27 BEGIN SELECT RAISE(ABORT,'v27 layout attestation is immutable'); END;
  `);
  const current=combatFoundationLayoutDigestV27(db);
  db.prepare("INSERT INTO combat_foundation_layout_attestation_v27(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST,current);
}
const V27_COMBAT_FOUNDATION_LAYOUT_DIGEST = "5ff782cab830d8c7e934edbae69fde1398b7482531d6b77c7ced8696798737be";
function combatFoundationLayoutRowsV27(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name IN ('encounter','combatant','combat_log','reward_bundle','reward_entry_v27','reward_claim_v27') OR name GLOB '*_v27' OR name GLOB '*_v27_*' OR tbl_name IN ('encounter','combatant','combat_log','reward_bundle','reward_entry_v27','reward_claim_v27') OR tbl_name GLOB '*_v27' OR tbl_name GLOB '*_v27_*') ORDER BY type,name`).all();}
function combatFoundationLayoutDigestV27(db:DatabaseDriver.Database):string{const rows=(combatFoundationLayoutRowsV27(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
export function assertCombatFoundationLayoutV27(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM combat_foundation_layout_attestation_v27 WHERE singleton=1").get() as any;const actual=combatFoundationLayoutDigestV27(db);if(!row||row.prior_layout_digest!==V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V27_COMBAT_FOUNDATION_LAYOUT_DIGEST)throw new Error(`schema v27 combat foundation canonical SQL is incompatible (${actual})`);}
export function validateCombatFoundationV27(db:DatabaseDriver.Database):void{const commands=db.prepare(`SELECT c.*,r.resulting_revision receipt_revision,r.occurred_at FROM combat_commands_v27 c LEFT JOIN combat_receipts_v27 r ON r.encounter_id=c.encounter_id AND r.command_id=c.command_id`).all() as Array<any>;if(commands.length!==(db.prepare("SELECT count(*) count FROM combat_receipts_v27").get() as {count:number}).count)throw new Error("M1.7 command receipt graph is incomplete");for(const c of commands){let request:any;try{request=JSON.parse(c.canonical_request_json);}catch{throw new Error("M1.7 command provenance is malformed");}if(c.canonical_request_json!==canonicalV17(request)||c.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex")||c.receipt_revision!==c.resulting_revision||c.occurred_at!==c.created_at)throw new Error("M1.7 command receipt provenance is inconsistent");}for(const root of db.prepare("SELECT * FROM combat_mutation_revisions_v27").all() as Array<any>){const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM combat_commands_v27 WHERE encounter_id=? ORDER BY resulting_revision").all(root.encounter_id) as Array<any>;if(history.length!==root.revision||history.some((r,i)=>r.expected_revision!==i||r.resulting_revision!==i+1)||(history.length>0&&root.updated_at!==history.at(-1)!.created_at))throw new Error("M1.7 revision root history is inconsistent");}const invalidReward=db.prepare(`SELECT 1 FROM reward_bundle bundle LEFT JOIN encounter encounter ON encounter.encounter_id=bundle.encounter_id AND encounter.campaign_id=bundle.campaign_id LEFT JOIN combat_events_v27 event ON event.encounter_id=bundle.encounter_id AND event.event_id=bundle.source_event_id LEFT JOIN combat_commands_v27 command ON command.encounter_id=event.encounter_id AND command.command_id=event.command_id WHERE encounter.encounter_id IS NULL OR event.event_type<>'rewards_granted' OR command.command_type<>'grant_rewards' OR event.occurred_at<>bundle.created_at UNION ALL SELECT 1 FROM reward_claim_v27 claim JOIN reward_bundle bundle ON bundle.campaign_id=claim.campaign_id AND bundle.reward_bundle_id=claim.reward_bundle_id LEFT JOIN combat_commands_v27 command ON command.encounter_id=claim.encounter_id AND command.command_id=claim.command_id WHERE bundle.encounter_id<>claim.encounter_id OR command.command_type<>'grant_rewards' OR command.created_at<>claim.claimed_at OR json_extract(command.canonical_request_json,'$.type')<>'claim_reward_bundle' OR json_extract(command.canonical_request_json,'$.rewardClaimId')<>claim.reward_claim_id OR json_extract(command.canonical_request_json,'$.rewardBundleId')<>claim.reward_bundle_id OR json_extract(command.canonical_request_json,'$.recipientActorId')<>bundle.recipient_actor_id LIMIT 1`).get();if(invalidReward)throw new Error("M1.7 reward provenance graph is inconsistent");}
export function migrate26to27(db:DatabaseDriver.Database):void{db.transaction(()=>{assertChecksPowersEffectsLayoutV26(db);validateM16PersistenceV26(db);createCombatFoundationV27(db);db.prepare("UPDATE meta SET value='27' WHERE key='schemaVersion'").run();})();}

/** Additive v28r1 persistence for the campaign world graph and its state. */
export function createWorldTravelNpcFactionV28(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_locations_v28 (
      location_id TEXT PRIMARY KEY CHECK(length(location_id) BETWEEN 1 AND 128 AND location_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      parent_location_id TEXT, public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)),
      public_description TEXT NOT NULL DEFAULT '' CHECK(length(public_description)<=4000), visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,location_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,parent_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(parent_location_id IS NULL OR parent_location_id<>location_id)
    );
    CREATE INDEX idx_campaign_locations_v28_hierarchy ON campaign_locations_v28(campaign_id,parent_location_id,location_id);
    -- GM-only text is intentionally separate from the player-safe location row.
    CREATE TABLE campaign_location_private_state_v28 (
      campaign_id TEXT NOT NULL, location_id TEXT NOT NULL, gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000),
      PRIMARY KEY(campaign_id,location_id), FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_location_connections_v28 (
      connection_id TEXT PRIMARY KEY CHECK(length(connection_id) BETWEEN 1 AND 128 AND connection_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      from_location_id TEXT NOT NULL, to_location_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      route_state TEXT NOT NULL CHECK(route_state IN ('open','closed')), requirement_kind TEXT NOT NULL CHECK(requirement_kind IN ('none','discovery','faction_reputation')),
      required_faction_id TEXT, minimum_reputation INTEGER,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,connection_id), UNIQUE(campaign_id,from_location_id,to_location_id),
      FOREIGN KEY(campaign_id,from_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,to_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,required_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(from_location_id<>to_location_id), CHECK((requirement_kind IN ('none','discovery') AND required_faction_id IS NULL AND minimum_reputation IS NULL) OR (requirement_kind='faction_reputation' AND required_faction_id IS NOT NULL AND minimum_reputation BETWEEN -1000000 AND 1000000))
    );
    CREATE INDEX idx_campaign_location_connections_v28_route ON campaign_location_connections_v28(campaign_id,from_location_id,route_state,to_location_id);
    CREATE TABLE campaign_location_discoveries_v28 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, location_id TEXT NOT NULL, discovered_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at)=discovered_at AND substr(discovered_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,location_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_npcs_v28 (
      npc_id TEXT PRIMARY KEY CHECK(length(npc_id) BETWEEN 1 AND 128 AND npc_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, persona_id TEXT NOT NULL,
      speech_control TEXT NOT NULL CHECK(speech_control IN ('manual','automated')), public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id), UNIQUE(campaign_id,persona_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(persona_id) REFERENCES characters(id) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_npc_private_state_v28 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, private_goals TEXT NOT NULL CHECK(length(private_goals)<=8000), gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000), merchant_state_json TEXT CHECK(merchant_state_json IS NULL OR (json_valid(merchant_state_json) AND json_type(merchant_state_json)='object' AND length(merchant_state_json)<=16000)),
      PRIMARY KEY(campaign_id,npc_id), FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_factions_v28 (
      faction_id TEXT PRIMARY KEY CHECK(length(faction_id) BETWEEN 1 AND 128 AND faction_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)), visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,faction_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_faction_private_state_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000), PRIMARY KEY(campaign_id,faction_id),
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_actor_faction_memberships_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, actor_id TEXT NOT NULL, membership_role TEXT NOT NULL CHECK(membership_role IN ('member','leader','ally','enemy')),
      joined_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',joined_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',joined_at)=joined_at AND substr(joined_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,faction_id,actor_id), FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_npc_faction_memberships_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, npc_id TEXT NOT NULL, membership_role TEXT NOT NULL CHECK(membership_role IN ('member','leader','ally','enemy')),
      joined_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',joined_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',joined_at)=joined_at AND substr(joined_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,faction_id,npc_id), FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_faction_relations_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, from_faction_id TEXT NOT NULL, to_faction_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('allied','neutral','hostile')), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,from_faction_id,to_faction_id), FOREIGN KEY(campaign_id,from_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,to_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, CHECK(from_faction_id<>to_faction_id)
    );
    CREATE TABLE campaign_npc_relationships_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, npc_id TEXT NOT NULL, disposition INTEGER NOT NULL CHECK(typeof(disposition)='integer' AND disposition BETWEEN -1000 AND 1000), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,npc_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_reputation_ledger_v28 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, actor_id TEXT NOT NULL, faction_id TEXT NOT NULL, delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta BETWEEN -1000000 AND 1000000), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500 AND reason=trim(reason)), command_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), UNIQUE(campaign_id,session_id,command_id,entry_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE world_mutation_revisions_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id), FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE world_commands_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'), actor_id TEXT NOT NULL, command_type TEXT NOT NULL CHECK(command_type IN ('travel','discover_location','set_npc_relationship','change_reputation','set_faction_relation','set_actor_location')), idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'), canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'), request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'), expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990), resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1), created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,command_id), UNIQUE(campaign_id,session_id,idempotency_key), UNIQUE(campaign_id,session_id,resulting_revision), UNIQUE(campaign_id,session_id,command_id,resulting_revision), FOREIGN KEY(campaign_id,session_id) REFERENCES world_mutation_revisions_v28(campaign_id,session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE world_receipts_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991), canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'), result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'), occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), PRIMARY KEY(campaign_id,session_id,command_id), UNIQUE(campaign_id,session_id,resulting_revision), UNIQUE(campaign_id,session_id,command_id,resulting_revision), FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision) REFERENCES world_commands_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE world_events_v28 (event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('travelled','location_discovered','actor_location_set','npc_relationship_changed','reputation_changed','faction_relation_changed')), event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), UNIQUE(campaign_id,session_id,event_id), UNIQUE(campaign_id,session_id,command_id,event_type), FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision) REFERENCES world_receipts_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE campaign_actor_locations_v28 (campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, location_id TEXT NOT NULL, session_id TEXT NOT NULL, state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'), PRIMARY KEY(campaign_id,actor_id,session_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE world_travel_party_members_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id,actor_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE world_travel_destinations_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, connection_id TEXT NOT NULL, destination_location_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,connection_id) REFERENCES campaign_location_connections_v28(campaign_id,connection_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,destination_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE world_travel_npc_party_members_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, npc_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id,npc_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE world_travel_layout_attestation_v28 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64));
    CREATE TRIGGER world_mutation_revisions_v28_campaign_session_ancestry BEFORE INSERT ON world_mutation_revisions_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world session must belong to campaign'); END;
    CREATE TRIGGER world_commands_v28_campaign_session_ancestry BEFORE INSERT ON world_commands_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world command session must belong to campaign'); END;
    CREATE TRIGGER world_mutation_revisions_v28_guard BEFORE UPDATE ON world_mutation_revisions_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'world mutation revision must advance exactly once'); END;
    CREATE TRIGGER world_commands_v28_immutable_update BEFORE UPDATE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END; CREATE TRIGGER world_commands_v28_immutable_delete BEFORE DELETE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END;
    CREATE TRIGGER world_receipts_v28_immutable_update BEFORE UPDATE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END; CREATE TRIGGER world_receipts_v28_immutable_delete BEFORE DELETE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END;
    CREATE TRIGGER world_events_v28_immutable_update BEFORE UPDATE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END; CREATE TRIGGER world_events_v28_immutable_delete BEFORE DELETE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END;
    CREATE TRIGGER campaign_reputation_ledger_v28_immutable_update BEFORE UPDATE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END; CREATE TRIGGER campaign_reputation_ledger_v28_immutable_delete BEFORE DELETE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END;
    CREATE TRIGGER campaign_actor_locations_v28_ancestry BEFORE INSERT ON campaign_actor_locations_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'actor location session must belong to campaign'); END;
    -- A persona is exclusively either a manually controlled campaign actor or an NPC.
    CREATE TRIGGER campaign_npcs_v28_persona_not_campaign_character BEFORE INSERT ON campaign_npcs_v28 WHEN EXISTS(SELECT 1 FROM campaign_actors a JOIN campaign_characters cc ON cc.id=a.campaign_character_id AND cc.campaign_id=a.campaign_id WHERE a.campaign_id=NEW.campaign_id AND cc.character_id=NEW.persona_id) BEGIN SELECT RAISE(ABORT,'campaign character persona cannot become NPC'); END;
    CREATE TRIGGER campaign_actors_v28_persona_not_npc BEFORE INSERT ON campaign_actors WHEN EXISTS(SELECT 1 FROM campaign_characters cc JOIN campaign_npcs_v28 n ON n.campaign_id=NEW.campaign_id AND n.persona_id=cc.character_id WHERE cc.id=NEW.campaign_character_id AND cc.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'NPC persona cannot become campaign character'); END;
    CREATE TRIGGER campaign_actor_locations_v28_guard BEFORE UPDATE ON campaign_actor_locations_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.session_id<>OLD.session_id OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM world_events_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND event_type IN ('travelled','actor_location_set') AND occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'actor location requires immutable world event'); END;
    CREATE TRIGGER world_travel_party_members_v28_command_type BEFORE INSERT ON world_travel_party_members_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel party member requires travel command'); END;
    CREATE TRIGGER world_travel_destinations_v28_command_type BEFORE INSERT ON world_travel_destinations_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel destination requires travel command'); END;
    CREATE TRIGGER world_travel_layout_attestation_v28_immutable_update BEFORE UPDATE ON world_travel_layout_attestation_v28 BEGIN SELECT RAISE(ABORT,'v28 layout attestation is immutable'); END; CREATE TRIGGER world_travel_layout_attestation_v28_immutable_delete BEFORE DELETE ON world_travel_layout_attestation_v28 BEGIN SELECT RAISE(ABORT,'v28 layout attestation is immutable'); END;
  `);
  const current=worldTravelNpcFactionLayoutDigestV28(db);
  db.prepare("INSERT INTO world_travel_layout_attestation_v28(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V27_COMBAT_FOUNDATION_LAYOUT_DIGEST,current);
}
const V28_WORLD_TRAVEL_NPC_FACTION_LAYOUT_DIGEST = "2f6001699f45ecc90c426e05065d0ef004196c4419a5fbe2a94cd7e3770688c7";
function worldTravelNpcFactionLayoutRowsV28(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v28' OR name GLOB '*_v28_*' OR tbl_name GLOB '*_v28' OR tbl_name GLOB '*_v28_*') ORDER BY type,name`).all();}
function worldTravelNpcFactionLayoutDigestV28(db:DatabaseDriver.Database):string{const rows=(worldTravelNpcFactionLayoutRowsV28(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
export function assertWorldTravelNpcFactionLayoutV28(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM world_travel_layout_attestation_v28 WHERE singleton=1").get() as any;const actual=worldTravelNpcFactionLayoutDigestV28(db);if(!row||row.prior_layout_digest!==V27_COMBAT_FOUNDATION_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V28_WORLD_TRAVEL_NPC_FACTION_LAYOUT_DIGEST)throw new Error(`schema v28 world/travel canonical SQL is incompatible (${actual})`);}
export function validateWorldTravelNpcFactionV28(db:DatabaseDriver.Database):void{const commands=db.prepare(`SELECT c.*,r.resulting_revision receipt_revision,r.occurred_at FROM world_commands_v28 c LEFT JOIN world_receipts_v28 r ON r.campaign_id=c.campaign_id AND r.session_id=c.session_id AND r.command_id=c.command_id`).all() as Array<any>;if(commands.length!==(db.prepare("SELECT count(*) count FROM world_receipts_v28").get() as {count:number}).count)throw new Error("M1.8 command receipt graph is incomplete");for(const c of commands){let request:any;try{request=JSON.parse(c.canonical_request_json);}catch{throw new Error("M1.8 command provenance is malformed");}if(c.canonical_request_json!==canonicalV17(request)||c.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex")||c.receipt_revision!==c.resulting_revision||c.occurred_at!==c.created_at)throw new Error("M1.8 command receipt provenance is inconsistent");}for(const root of db.prepare("SELECT * FROM world_mutation_revisions_v28").all() as Array<any>){const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM world_commands_v28 WHERE campaign_id=? AND session_id=? ORDER BY resulting_revision").all(root.campaign_id,root.session_id) as Array<any>;if(history.length!==root.revision||history.some((r,i)=>r.expected_revision!==i||r.resulting_revision!==i+1)||(history.length>0&&root.updated_at!==history.at(-1)!.created_at))throw new Error("M1.8 revision root history is inconsistent");}}
export function migrate27to28(db:DatabaseDriver.Database):void{db.transaction(()=>{assertCombatFoundationLayoutV27(db);validateCombatFoundationV27(db);createWorldTravelNpcFactionV28(db);db.prepare("UPDATE meta SET value='28' WHERE key='schemaVersion'").run();})();}
