import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { removeFutureCharacterProgressionIntegrityV24 } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v24-"));
const databaseFile = (dir: string) => path.join(dir, "velvet.sqlite");
const scores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"]
    .map((attribute, index) => [attribute, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as {might:number;agility:number;resolve:number;insight:number;presence:number;craft:number};

function schema(dir: string): unknown[] {
  const db = new DatabaseDriver(databaseFile(dir), { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function populatedProgression(dir: string): { characterId: string; commandIds: string[] } {
  const repo = createRepository({ dataDir: dir, clock: { now: () => new Date("2034-01-01T00:00:00.000Z") } });
  const persona = repo.createCharacter({
    name: "V24 progression", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true,
  });
  const campaign = repo.createCampaign("local-owner", { name: "V24" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "v24-pins" });
  const created = repo.createCharacterDraft("local-owner", campaign.id, {
    personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
    allocation: { method: "standard-array", scores }, idempotencyKey: "v24-draft",
  });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft("local-owner", created.draft.id, {
    expectedRevision: 0, idempotencyKey: "v24-select", selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
      starterGrant: "kit",
    },
  } as never);
  const finalized = repo.finalizeCharacterDraft("local-owner", created.draft.id, {
    expectedRevision: selected.draft.revision, idempotencyKey: "v24-finalize",
  });
  const characterId = finalized.receipt.campaignCharacterId;
  const grant = repo.grantCharacterXp("local-owner", characterId, {
    amount: 300, reason: "Reached level two", expectedRevision: 0, idempotencyKey: "v24-xp",
  });
  const preview = repo.previewCharacterProgression("local-owner", characterId)!;
  const choice = preview.pendingChoices[0]!;
  const applied = repo.applyCharacterProgression("local-owner", characterId, {
    previewRevision: preview.revision, previewToken: preview.token,
    selections: [{ choiceId: choice.choiceId, ability: choice.options[0]! }], idempotencyKey: "v24-apply",
  });
  repo.close();
  return { characterId, commandIds: [grant.receipt.commandId, applied.receipt.commandId] };
}

function rewindToV23(dir: string): void {
  const db = new DatabaseDriver(databaseFile(dir));
  removeFutureCharacterProgressionIntegrityV24(db);
  db.prepare("UPDATE meta SET value='23' WHERE key='schemaVersion'").run();
  db.close();
}

describe("additive schema v24r1 progression-integrity migration", () => {
  it("backfills bootstrap, pending, proposals, events, and exact known-power sources with fresh DDL parity", () => {
    const migratedDir = makeDir();
    const { characterId, commandIds } = populatedProgression(migratedDir);
    rewindToV23(migratedDir);
    createRepository({ dataDir: migratedDir }).close();

    const db = new DatabaseDriver(databaseFile(migratedDir), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "29" });
    expect(db.prepare("SELECT prior_layout_digest,current_layout_digest FROM character_progression_layout_attestation_v24").get()).toEqual({
      prior_layout_digest: "f68e713487a2e7a56f12781c30362bc710b14858b086bda543bd3184b0745a73",
      current_layout_digest: "e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8",
    });
    expect(db.prepare("SELECT COUNT(*) count FROM character_progression_bootstrap_v24 WHERE campaign_character_id=?").get(characterId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT revision,command_id FROM character_progression_pending_snapshots_v24 WHERE campaign_character_id=? ORDER BY revision").all(characterId))
      .toEqual([{ revision: 0, command_id: null }, { revision: 1, command_id: commandIds[0] }, { revision: 2, command_id: commandIds[1] }]);
    expect(db.prepare("SELECT COUNT(*) count FROM character_progression_command_proposals_v24 WHERE campaign_character_id=?").get(characterId)).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) count FROM character_progression_events_v24 WHERE campaign_character_id=?").get(characterId)).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) count FROM character_known_power_sources_v24 WHERE campaign_character_id=?").get(characterId))
      .toEqual(db.prepare("SELECT COUNT(*) count FROM character_known_powers_v23 WHERE campaign_character_id=?").get(characterId));
    db.close();

    const freshDir = makeDir();
    createRepository({ dataDir: freshDir }).close();
    expect(schema(migratedDir)).toEqual(schema(freshDir));
  });

  it("rolls the whole migration back when the late v24 marker fails, then retries", () => {
    const dir = makeDir();
    populatedProgression(dir);
    rewindToV23(dir);
    const blocker = new DatabaseDriver(databaseFile(dir));
    blocker.exec("CREATE TRIGGER reject_progression_integrity_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='24' BEGIN SELECT RAISE(ABORT,'reject v24 marker'); END;");
    blocker.close();

    expect(() => createRepository({ dataDir: dir })).toThrow("reject v24 marker");
    const rolledBack = new DatabaseDriver(databaseFile(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "23" });
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='character_progression_bootstrap_v24'").get()).toBeUndefined();
    rolledBack.exec("DROP TRIGGER reject_progression_integrity_marker");
    rolledBack.close();
    createRepository({ dataDir: dir }).close();
  });

  it("rejects canonical DDL drift and pending provenance drift at startup", () => {
    const ddlDir = makeDir();
    populatedProgression(ddlDir);
    const forged = new DatabaseDriver(databaseFile(ddlDir));
    forged.exec("DROP TRIGGER character_progression_events_v24_immutable_update; CREATE TRIGGER character_progression_events_v24_immutable_update BEFORE UPDATE ON character_progression_events_v24 BEGIN SELECT 1; END;");
    forged.close();
    expect(() => createRepository({ dataDir: ddlDir })).toThrow("schema v24 progression canonical SQL is incompatible");

    const dataDir = makeDir();
    const { characterId } = populatedProgression(dataDir);
    const corrupt = new DatabaseDriver(databaseFile(dataDir));
    const immutableTrigger = corrupt.prepare("SELECT sql FROM sqlite_master WHERE name='character_progression_pending_snapshots_v24_immutable_update'").get() as { sql:string };
    corrupt.exec("DROP TRIGGER character_progression_pending_snapshots_v24_immutable_update");
    corrupt.prepare("UPDATE character_progression_pending_snapshots_v24 SET pending_digest=? WHERE campaign_character_id=?")
      .run("0".repeat(64), characterId);
    corrupt.exec(immutableTrigger.sql);
    corrupt.close();
    expect(() => createRepository({ dataDir })).toThrow("progression pending choice provenance is inconsistent");
  });
});
