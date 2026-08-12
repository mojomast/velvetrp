import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";

const TABLES = [
  "exact_candidate_batches_v46", "exact_candidates_v46", "exact_candidate_supersessions_v46",
  "exact_candidate_expirations_v46", "exact_candidate_layout_attestation_v46",
] as const;
const INDEXES = ["idx_exact_candidates_scope_v46", "idx_exact_candidates_batch_v46"] as const;
const TRIGGERS = TABLES.flatMap((table) => [`${table}_immutable_update_v46`, `${table}_immutable_delete_v46`] as const);
export const EXACT_CANDIDATE_V46_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const), ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
] as const;

/** Reviewed, static v46 DDL. Do not derive this layout from an earlier schema at runtime. */
export const EXACT_CANDIDATE_V46_DDL = `
CREATE TABLE exact_candidate_batches_v46(
 batch_id TEXT PRIMARY KEY CHECK(length(batch_id) BETWEEN 1 AND 128 AND batch_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
 connection_id TEXT NOT NULL,candidate_count INTEGER NOT NULL CHECK(typeof(candidate_count)='integer' AND candidate_count BETWEEN 0 AND 32),
 world_revision INTEGER NOT NULL CHECK(typeof(world_revision)='integer' AND world_revision BETWEEN 0 AND 9007199254740990),
 issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(turn_id,principal_id,idempotency_key),
 UNIQUE(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at),
 FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
 CHECK(connection_id='adventure-turn:'||turn_id),
 CHECK(issued_at=strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) AND expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)
  AND substr(issued_at,12,2) BETWEEN '00' AND '23' AND substr(expires_at,12,2) BETWEEN '00' AND '23'
  AND expires_at>issued_at AND (julianday(expires_at)-julianday(issued_at))*86400000<=300001)
);
CREATE TABLE exact_candidates_v46(
 candidate_id TEXT PRIMARY KEY CHECK(length(candidate_id) BETWEEN 1 AND 128 AND candidate_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 batch_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 1 AND 32),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),world_revision INTEGER NOT NULL,
 issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 policy_result TEXT NOT NULL CHECK(policy_result='allowed'),policy_reason TEXT NOT NULL CHECK(policy_reason='legal-visible-connection'),
 confirmation_requirement TEXT NOT NULL CHECK(confirmation_requirement='not-required'),quote_kind TEXT NOT NULL CHECK(quote_kind='not-applicable'),
 supersession_state TEXT NOT NULL CHECK(supersession_state='current'),execution_state TEXT NOT NULL CHECK(execution_state='unexecuted'),
 action_frame TEXT NOT NULL,action_digest TEXT NOT NULL CHECK(length(action_digest)=64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
 envelope_frame TEXT NOT NULL,envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
 envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND json_type(envelope_json)='object'),
 UNIQUE(batch_id,position),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,issued_at,expires_at),
 FOREIGN KEY(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at)
  REFERENCES exact_candidate_batches_v46(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at) ON DELETE RESTRICT
);
CREATE TABLE exact_candidate_supersessions_v46(
 source_candidate_id TEXT PRIMARY KEY,replacement_candidate_id TEXT NOT NULL UNIQUE,
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),superseded_at TEXT NOT NULL,
 FOREIGN KEY(source_candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 FOREIGN KEY(replacement_candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 CHECK(source_candidate_id<>replacement_candidate_id),
 CHECK(superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ',superseded_at) AND substr(superseded_at,12,2) BETWEEN '00' AND '23')
);
CREATE TABLE exact_candidate_expirations_v46(
 expiration_id TEXT PRIMARY KEY CHECK(length(expiration_id) BETWEEN 1 AND 128 AND expiration_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 candidate_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),
 expires_at TEXT NOT NULL,observed_at TEXT NOT NULL,
 FOREIGN KEY(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at) ON DELETE RESTRICT,
 CHECK(observed_at=strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) AND substr(observed_at,12,2) BETWEEN '00' AND '23' AND observed_at>=expires_at)
);
CREATE TABLE exact_candidate_layout_attestation_v46(singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX idx_exact_candidates_scope_v46 ON exact_candidates_v46(campaign_id,turn_id,actor_id,principal_id,connection_id,kind,version);
CREATE INDEX idx_exact_candidates_batch_v46 ON exact_candidates_v46(batch_id,position);
CREATE TRIGGER exact_candidate_batches_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_batches_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_batches_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_batches_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidates_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidates_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidates_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidates_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_supersessions_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_supersessions_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_supersessions_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_supersessions_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_expirations_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_expirations_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_expirations_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_expirations_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_layout_attestation_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_layout_attestation_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_layout_attestation_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_layout_attestation_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;`;

function layoutDigest(db: DatabaseDriver.Database): string {
  const names=EXACT_CANDIDATE_V46_MANAGED_OBJECTS.map(([,name])=>name);
  const rows=(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN (${names.map(()=>"?").join(",")}) ORDER BY type,name`).all(...names) as any[])
    .map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()??null}));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// Updated only after explicit DDL review; assertion never trusts the persisted attestation alone.
export const EXACT_CANDIDATE_V46_LAYOUT_DIGEST="91a6283cc58cf0b9130feb52c5dca977e043951f36fd971a5bf51248bba9e902";

export function createExactCandidatesV46(db:DatabaseDriver.Database):void {
  db.exec(EXACT_CANDIDATE_V46_DDL);
  db.prepare("INSERT INTO exact_candidate_layout_attestation_v46 VALUES(1,?)").run(EXACT_CANDIDATE_V46_LAYOUT_DIGEST);
}
export function assertExactCandidatesLayoutV46(db:DatabaseDriver.Database):void {
  const expected=new Set(EXACT_CANDIDATE_V46_MANAGED_OBJECTS.map(([type,name])=>`${type}:${name}`));
  const rows=db.prepare(`SELECT type,name FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB '*v46*' OR tbl_name IN (${TABLES.map(()=>"?").join(",")})) ORDER BY type,name`).all(...TABLES) as Array<{type:string;name:string}>;
  if(rows.length!==expected.size||rows.some(({type,name})=>!expected.has(`${type}:${name}`)))throw new Error("schema v46 exact-candidate inventory is incompatible");
  const actual=layoutDigest(db),attestation=db.prepare("SELECT layout_digest FROM exact_candidate_layout_attestation_v46 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  if(actual!==EXACT_CANDIDATE_V46_LAYOUT_DIGEST||attestation?.layout_digest!==EXACT_CANDIDATE_V46_LAYOUT_DIGEST)
    throw new Error(`schema v46 exact-candidate layout attestation is incompatible (${actual})`);
}
export function migrate45to46(db:DatabaseDriver.Database):void {db.transaction(()=>{createExactCandidatesV46(db);db.prepare("UPDATE meta SET value='46' WHERE key='schemaVersion'").run();})();}
