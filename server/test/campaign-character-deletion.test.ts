import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository, deleteCharacter } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const characterInput = {
  name: "Linked persona",
  age: 30,
  archetype: "guide",
  boundaries: "fictional",
  safeWord: "anchor",
  fictionalConfirmed: true,
};

function databasePath(): string {
  return path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
}

function linkToCampaign(characterId: string): void {
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  const at = "2030-04-05T06:07:08.009Z";
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign', 'Campaign', 'timeline', 'local-owner', ?, ?)`).run(at, at);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline', 'campaign', ?)`).run(at);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign', 'local-owner', 'owner', ?)").run(at);
  })();
  db.prepare("INSERT INTO campaign_characters VALUES ('campaign-character', 'campaign', ?, ?, ?)")
    .run(characterId, at, at);
  db.close();
}

describe("campaign-linked legacy character deletion", () => {
  it("refuses a legacy direct session reference when its junction row is absent", async () => {
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const character = repository.createCharacter(characterInput);
    repository.close();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO sessions
      (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
      VALUES ('legacy-session', ?, 'Legacy', 'active', 'default', NULL, ?, NULL, NULL)`)
      .run(character.id, "2030-04-05T06:07:08.009Z");
    db.close();

    await expect(deleteCharacter(character.id)).resolves.toBe("in-use");
    const persisted = new DatabaseDriver(databasePath(), { readonly: true });
    expect(persisted.prepare("SELECT character_id FROM sessions WHERE id = 'legacy-session'").get())
      .toEqual({ character_id: character.id });
    expect(persisted.prepare("SELECT id FROM characters WHERE id = ?").get(character.id)).toEqual({ id: character.id });
    expect(persisted.prepare("SELECT * FROM session_characters WHERE session_id = 'legacy-session'").all()).toEqual([]);
    persisted.close();
  });

  it("keeps returning in-use because campaigns and linked personas are retained", async () => {
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const character = repository.createCharacter(characterInput);
    repository.close();
    linkToCampaign(character.id);

    await expect(deleteCharacter(character.id)).resolves.toBe("in-use");
    const db=new DatabaseDriver(databasePath());
    expect(()=>db.prepare("DELETE FROM campaigns WHERE id='campaign'").run()).toThrow(/archived, not physically deleted|no such function/);db.close();
    await expect(deleteCharacter(character.id)).resolves.toBe("in-use");
  });

  it("preserves the API 409 body while the retained campaign remains", async () => {
    const app = buildApp();
    const created = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput })).json() as { id: string };
    linkToCampaign(created.id);

    const guarded = await app.inject({ method: "DELETE", url: `/api/characters/${created.id}` });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toEqual({ error: "character is used by a session; delete the session history first" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/characters/${created.id}` });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual(guarded.json());
    await app.close();
  });
});
