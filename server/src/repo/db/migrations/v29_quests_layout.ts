// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { assertWorldTravelNpcFactionLayoutV28 } from "./v27_v28_combat_world.js";

const V29_CHARACTER_COLUMNS = ["id", "name", "age", "archetype", "boundaries", "fictional_confirmed", "is_real_person", "created_at"];
const V29_CHARACTER_LAYOUT_DIGEST = "bcca64e4206ed0db503cbea137334ae9f92fa6050537e3a950630b00b37bc25d";

function characterLayoutDigestV29(db: DatabaseDriver.Database): string {
  const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
  return createHash("sha256").update(JSON.stringify(columns)).digest("hex");
}

export function createCharacterLayoutV29(db: DatabaseDriver.Database): void {
  db.exec(`CREATE TABLE character_layout_attestation_v29 (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64)
  );
  CREATE TRIGGER character_layout_attestation_v29_immutable_update BEFORE UPDATE ON character_layout_attestation_v29 BEGIN SELECT RAISE(ABORT,'v29 character layout attestation is immutable'); END;
  CREATE TRIGGER character_layout_attestation_v29_immutable_delete BEFORE DELETE ON character_layout_attestation_v29 BEGIN SELECT RAISE(ABORT,'v29 character layout attestation is immutable'); END;`);
  db.prepare("INSERT INTO character_layout_attestation_v29(singleton,layout_digest) VALUES(1,?)").run(characterLayoutDigestV29(db));
}

export function assertCharacterLayoutV29(db: DatabaseDriver.Database): void {
  const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
  const row = db.prepare("SELECT layout_digest FROM character_layout_attestation_v29 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  const actual = characterLayoutDigestV29(db);
  if (JSON.stringify(columns) !== JSON.stringify(V29_CHARACTER_COLUMNS) || !row || row.layout_digest !== actual || actual !== V29_CHARACTER_LAYOUT_DIGEST) {
    throw new Error(`schema v29 character layout is incompatible (${actual})`);
  }
}

export function migrate28to29(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertWorldTravelNpcFactionLayoutV28(db);
    const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
    if (columns.includes("safe_word")) db.exec("ALTER TABLE characters DROP COLUMN safe_word");
    createCharacterLayoutV29(db);
    db.prepare("UPDATE meta SET value='29' WHERE key='schemaVersion'").run();
  })();
}

export function createQuestsV29r2(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE quest_storylines (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE quests (
      id TEXT PRIMARY KEY,
      storyline_id TEXT NOT NULL REFERENCES quest_storylines(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE quest_clues (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      discovered_by_character_id TEXT REFERENCES characters(id),
      discovered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE quest_rewards (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount INTEGER,
      label TEXT NOT NULL,
      granted_to_character_id TEXT REFERENCES characters(id),
      granted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE quest_objective_completions (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      completed_by_character_id TEXT REFERENCES characters(id),
      completed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_quest_clues_quest ON quest_clues(quest_id);
    CREATE INDEX IF NOT EXISTS idx_quest_rewards_quest ON quest_rewards(quest_id);
    CREATE INDEX IF NOT EXISTS idx_storylines_campaign ON quest_storylines(campaign_id);
  `);
}
