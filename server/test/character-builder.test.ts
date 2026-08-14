import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type PublishContentCatalogInput } from "@velvet/contracts";
import { calculateCatalogDigest, closeRepo, createRepository, deleteCharacter, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const dataDir = () => process.env.VELVET_DATA_DIR as string;
const dbPath = () => path.join(dataDir(), "velvet.sqlite");
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as {
  might: number; agility: number; resolve: number; insight: number; presence: number; craft: number;
};

function setup(options: { now?: () => Date; rng?: { integer(min: number, max: number): number } } = {}) {
  const repo = createRepository({ dataDir: dataDir(), clock: { now: options.now ?? (() => new Date("2031-01-01T00:00:00.000Z")) },
    ...(options.rng ? { rng: options.rng } : {}) });
  const persona = repo.createCharacter({ name: "Builder Persona", age: 25, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const campaign = repo.createCampaign("local-owner", { name: "Builder campaign" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "configure-builder" });
  return { repo, persona, campaign };
}

function complete(repo: ReturnType<typeof createRepository>, campaignId: string, personaId: string, grant: "kit" | "currency" = "kit") {
  const created = repo.createCharacterDraft("local-owner", campaignId, { personaId, controllerPrincipalId: "local-owner", durability: "durable",
    allocation: { method: "standard-array", scores }, idempotencyKey: `create-${grant}` });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const race = { ...definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" as const };
  const background = { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" as const };
  const klass = { ...definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" as const };
  return repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: `select-${grant}`,
    selections: { race, background, class: klass, starterGrant: grant } });
}

function alternateCatalog(mutator?: (catalog: PublishContentCatalogInput) => void): PublishContentCatalogInput {
  const value = structuredClone(MECHANICS_STARTER_CATALOG) as PublishContentCatalogInput;
  const replace = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(replace); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("packId" in record) record.packId = "velvet:mechanics-starter-alt";
    if ("packVersion" in record) record.packVersion = "1.0.0+000000000000";
    Object.values(record).forEach(replace);
  };
  replace(value); value.idempotencyKey = "alternate-publication"; value.manifest.digest = "0".repeat(64); mutator?.(value);
  const digest = calculateCatalogDigest(value); replace(value);
  const setVersion = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(setVersion); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("packVersion" in record) record.packVersion = `1.0.0+${digest.slice(0, 12)}`;
    Object.values(record).forEach(setVersion);
  };
  setVersion(value); value.manifest.digest = digest; return value;
}

describe("character builder repository", () => {
  it.each(["kit", "currency"] as const)("finalizes a complete %s draft once with aggregate, health, snapshot, and exact grant ledger", (grant) => {
    const { repo, persona, campaign } = setup();
    const updated = complete(repo, campaign.id, persona.id, grant);
    expect(updated.draft.completion.complete).toBe(true);
    const finalized = repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: `finalize-${grant}` });
    expect(finalized.draft.status).toBe("finalized");
    expect(finalized.receipt.startingGrants.map((value) => value.kind)).toEqual([grant === "kit" ? "item" : "currency"]);
    const retry = repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: `finalize-${grant}` });
    expect(retry).toEqual(finalized);
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_characters WHERE campaign_id=?").get(campaign.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='health'").get(finalized.receipt.actorId))
      .toEqual({ current: finalized.receipt.derived.maxHp, max: finalized.receipt.derived.maxHp });
    expect(db.prepare("SELECT COUNT(*) count FROM character_derived_snapshots_v19 WHERE draft_id=?").get(updated.draft.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) count FROM character_starting_grants_v19 WHERE draft_id=?").get(updated.draft.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT materialization_kind FROM character_starter_materializations_v51 WHERE draft_id=?").get(updated.draft.id))
      .toEqual({materialization_kind:grant==="kit"?"inventory":"wallet"});
    if(grant==="kit")expect((db.prepare("SELECT sum(quantity) quantity FROM rpg_inventory_entries_v25 WHERE actor_id=?").get(finalized.receipt.actorId) as {quantity:number}).quantity).toBeGreaterThan(0);
    else expect((db.prepare("SELECT sum(balance_minor) balance FROM rpg_wallets_v25 WHERE actor_id=?").get(finalized.receipt.actorId) as {balance:number}).balance).toBeGreaterThanOrEqual(0);
    db.close(); repo.close();
  });

  it("keeps incomplete and abandoned drafts non-playable and private state absent", () => {
    const { repo, persona, campaign } = setup();
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "manual", scores }, idempotencyKey: "incomplete-create" });
    expect(created.draft.completion.complete).toBe(false);
    expect(JSON.stringify(created)).not.toContain("privateNotes");
    expect(() => repo.finalizeCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "incomplete-finalize" })).toThrow("incomplete");
    const abandoned = repo.abandonCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "abandon" });
    expect(abandoned.draft.status).toBe("abandoned");
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_characters").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_actors").get()).toEqual({ count: 0 });
    db.close(); repo.close();
  });

  it("rolls once, exact-retries without rerolling, and writes nothing when RNG fails", () => {
    const integer = vi.fn(() => 4);
    const { repo, persona, campaign } = setup({ rng: { integer } });
    const input = { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable" as const,
      allocation: { method: "server-roll" as const }, idempotencyKey: "rolled-create" };
    const created = repo.createCharacterDraft("local-owner", campaign.id, input);
    expect(integer).toHaveBeenCalledTimes(24);
    expect(repo.createCharacterDraft("local-owner", campaign.id, input)).toEqual(created);
    expect(integer).toHaveBeenCalledTimes(24); repo.close();

    const other = setup({ rng: { integer: () => { throw new Error("rng failure"); } } });
    expect(() => other.repo.createCharacterDraft("local-owner", other.campaign.id, { personaId: other.persona.id,
      controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: "failed-roll" })).toThrow("rng failure");
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM character_drafts_v19 WHERE campaign_id=?").get(other.campaign.id)).toEqual({ count: 0 });
    db.close(); other.repo.close();
  });

  it("rerolls all server stats once and retains immutable roll history", () => {
    let die = 3; const integer = vi.fn(() => die);
    const { repo, persona, campaign } = setup({ rng: { integer } });
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: "roll-create" });
    die = 5;
    const rerolled = repo.rerollCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "roll-again" });
    expect(rerolled.draft.revision).toBe(1); expect(rerolled.draft.allocation.scores.might).toBe(15); expect(integer).toHaveBeenCalledTimes(48);
    expect(repo.rerollCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "roll-again" })).toEqual(rerolled);
    expect(integer).toHaveBeenCalledTimes(48);
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT revision,json_extract(allocation_json,'$.scores.might') might FROM character_draft_rerolls_v49 WHERE draft_id=?").get(created.draft.id)).toEqual({ revision: 1, might: 15 });
    expect(JSON.parse((db.prepare("SELECT snapshot_json FROM character_draft_revisions_v19 WHERE draft_id=? AND revision=0").get(created.draft.id) as { snapshot_json: string }).snapshot_json).allocation.scores.might).toBe(9);
    db.close(); repo.close();
  });

  it("rolls back an invalid midstream die without hidden RNG retry or audit rows", () => {
    let calls = 0;
    const { repo, persona, campaign } = setup({ rng: { integer: () => { calls += 1; return calls === 12 ? 7 : 4; } } });
    expect(() => repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
      durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: "midstream-invalid" })).toThrow("out-of-range");
    expect(calls).toBe(12);
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM character_drafts_v19 WHERE campaign_id=?").get(campaign.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_commands_v19 WHERE campaign_id=?").get(campaign.id)).toEqual({ count: 0 });
    db.close(); repo.close();
  });

  it("enforces stale, changed-key, effective-expiry, role control, and exact current pins", () => {
    let instant = new Date("2031-01-01T00:00:00.000Z");
    const { repo, persona, campaign } = setup({ now: () => instant });
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "expiring",
      allocation: { method: "point-buy", scores: { might: 15, agility: 15, resolve: 13, insight: 10, presence: 10, craft: 8 } }, idempotencyKey: "expiring" });
    expect(() => repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 1, idempotencyKey: "stale", selections: { starterGrant: "kit" } })).toThrow("stale");
    expect(() => repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "manual", scores }, idempotencyKey: "expiring" })).toThrow("idempotency");
    instant = new Date("2031-01-08T00:00:00.001Z");
    expect(repo.getCharacterDraft("local-owner", created.draft.id)?.effectivelyExpired).toBe(true);
    expect(() => repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "expired-update", selections: { starterGrant: "kit" } })).toThrow("expired");
    repo.close();
  });

  it.each([
    ["aggregate root", "campaign_characters"],
    ["initial health", "rpg_actor_resources"],
    ["derived snapshot", "character_derived_snapshots_v19"],
    ["progression root", "character_progression_v23"],
    ["progression initial snapshot", "character_progression_snapshots_v23"],
    ["progression known powers", "character_known_powers_v23"],
    ["starting grant", "character_starting_grants_v19"],
  ])("rolls back a failure at the %s stage and can retry with a fresh command", (_label, table) => {
    const { repo, persona, campaign } = setup();
    const updated = complete(repo, campaign.id, persona.id);
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER fail_final_stage BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'injected finalization failure'); END;`); db.close();
    expect(() => repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: "failed-final" })).toThrow("injected finalization failure");
    const verify = new DatabaseDriver(dbPath());
    expect(verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get()).toEqual({ count: 0 });
    expect(verify.prepare("SELECT revision,status FROM character_drafts_v19 WHERE id=?").get(updated.draft.id)).toEqual({ revision: 1, status: "active" });
    expect(verify.prepare("SELECT COUNT(*) count FROM character_draft_commands_v19 WHERE idempotency_key='failed-final'").get()).toEqual({ count: 0 });
    verify.exec("DROP TRIGGER fail_final_stage"); verify.close();
    expect(repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: "retry-final" }).draft.status).toBe("finalized");
    repo.close();
  });

  it("marks pin drift incomplete and rejects finalization against anything but the exact current validated-v1 pins", () => {
    const { repo, persona, campaign } = setup();
    const updated = complete(repo, campaign.id, persona.id);
    const alternate = alternateCatalog(); repo.publishContentCatalog("local-owner", alternate);
    repo.configureCampaignCatalog("local-owner", campaign.id, { rulesProfileId: alternate.manifest.compatibility.rulesProfileId,
      contentPacks: [{ packId: alternate.manifest.packId, packVersion: alternate.manifest.packVersion }],
      expectedRevision: 1, idempotencyKey: "change-pins" });
    const drifted = repo.getCharacterDraft("local-owner", updated.draft.id)!;
    expect(drifted.completion.complete).toBe(false);
    expect(drifted.completion.issues.map((value) => value.code)).toContain("pins-changed");
    expect(() => repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: "drift-final" })).toThrow("pins changed");
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_characters").get()).toEqual({ count: 0 }); db.close(); repo.close();
  });

  it("selects exact class level one independently of levelRefs ordering", () => {
    const { repo, persona, campaign } = setup();
    const catalog = alternateCatalog((value) => {
      const klass = value.definitions.find((definition) => definition.reference.kind === "class") as any;
      const levelOne = value.definitions.find((definition) => definition.reference.kind === "class-level") as any;
      const levelTwo = structuredClone(levelOne);
      levelTwo.reference.definitionId = "velvet:mechanics:class-level:lantern-warden-4";
      levelTwo.name = "Lantern Warden Level 4"; levelTwo.mechanics.level = 4; levelTwo.mechanics.hpGain = 99;
      klass.mechanics.levelRefs = [levelTwo.reference, ...klass.mechanics.levelRefs]; value.definitions.push(levelTwo);
    });
    expect(repo.validateContentCatalog(catalog).valid).toBe(true); repo.publishContentCatalog("local-owner", catalog);
    repo.configureCampaignCatalog("local-owner", campaign.id, { rulesProfileId: catalog.manifest.compatibility.rulesProfileId,
      contentPacks: [{ packId: catalog.manifest.packId, packVersion: catalog.manifest.packVersion }], expectedRevision: 1, idempotencyKey: "reordered-pins" });
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
      durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "reordered-create" });
    const race = { ...catalog.definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" as const };
    const background = { ...catalog.definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" as const };
    const klass = { ...catalog.definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" as const };
    const updated = repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "reordered-select",
      selections: { race, background, class: klass, starterGrant: "kit" } });
    expect(updated.draft.derivedPreview?.maxHp).toBeLessThan(99);
    expect(repo.finalizeCharacterDraft("local-owner", created.draft.id, { expectedRevision: 1, idempotencyKey: "reordered-final" })
      .receipt.derived.maxHp).toBe(updated.draft.derivedPreview?.maxHp); repo.close();
  });

  it("limits reads and factory mutations to owner, GM, or the eligible controller and rejects nesting", () => {
    const { repo, persona, campaign } = setup();
    const db = new DatabaseDriver(dbPath());
    for (const [id, role] of [["builder-player", "player"], ["other-player", "player"], ["builder-gm", "gm"], ["builder-observer", "observer"]] as const) {
      db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES (?,?,0)").run(id, id);
      db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
        .run(campaign.id, id, role, "2031-01-01T00:00:00.000Z");
    }
    db.close();
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "builder-player", durability: "durable",
      allocation: { method: "manual", scores }, idempotencyKey: "controlled-create" });
    expect(repo.getCharacterDraft("builder-player", created.draft.id)?.role).toBe("player");
    expect(repo.getCharacterDraft("builder-gm", created.draft.id)?.role).toBe("gm");
    expect(repo.getCharacterDraft("other-player", created.draft.id)).toBeNull();
    expect(repo.getCharacterDraft("builder-observer", created.draft.id)).toBeNull();
    expect(() => repo.updateCharacterDraft("other-player", created.draft.id, { expectedRevision: 0, idempotencyKey: "other-update", selections: { starterGrant: "kit" } })).toThrow("unavailable");
    expect(() => repo.transaction(() => repo.abandonCharacterDraft("builder-player", created.draft.id,
      { expectedRevision: 0, idempotencyKey: "nested-abandon" }))).toThrow("cannot run inside");
    expect(repo.abandonCharacterDraft("builder-player", created.draft.id, { expectedRevision: 0, idempotencyKey: "controller-abandon" }).draft.status).toBe("abandoned");
    repo.close();
  });

  it.each(["active", "abandoned", "finalized"] as const)("retains personas and audit for %s drafts", async (status) => {
    const { repo, persona, campaign } = setup();
    const created = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "manual", scores }, idempotencyKey: `delete-${status}-create` });
    if (status === "abandoned") repo.abandonCharacterDraft("local-owner", created.draft.id,
      { expectedRevision: 0, idempotencyKey: "delete-abandon" });
    if (status === "finalized") {
      const definitions = MECHANICS_STARTER_CATALOG.definitions;
      const race = { ...definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" as const };
      const background = { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" as const };
      const klass = { ...definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" as const };
      repo.updateCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "delete-select",
        selections: { race, background, class: klass, starterGrant: "kit" } });
      repo.finalizeCharacterDraft("local-owner", created.draft.id, { expectedRevision: 1, idempotencyKey: "delete-finalize" });
    }
    repo.close(); closeRepo();
    await expect(deleteCharacter(persona.id)).resolves.toBe("in-use"); closeRepo();
    const db = new DatabaseDriver(dbPath()); db.pragma("foreign_keys = ON");
    expect(()=>db.prepare("DELETE FROM campaigns WHERE id=?").run(campaign.id)).toThrow(/archived, not physically deleted|no such function/);
    for (const table of ["character_drafts_v19", "character_draft_pins_v19", "character_draft_commands_v19", "character_draft_events_v19",
      "character_draft_receipts_v19", "character_draft_revisions_v19", "character_draft_command_provenance_v20"]) {
      expect((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {count:number}).count).toBeGreaterThan(0);
    }
    for(const table of ["character_derived_snapshots_v19","character_starting_grants_v19"]){
      expect((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {count:number}).count).toBe(status==="finalized"?1:0);
    }
    db.close(); await expect(deleteCharacter(persona.id)).resolves.toBe("in-use");
  });

  it("rejects every direct retained-draft child deletion outside campaign cascade", () => {
    const { repo, persona, campaign } = setup();
    const updated = complete(repo, campaign.id, persona.id);
    repo.finalizeCharacterDraft("local-owner", updated.draft.id, { expectedRevision: 1, idempotencyKey: "guard-finalize" }); repo.close();
    const db = new DatabaseDriver(dbPath()); db.pragma("foreign_keys = ON");
    expect(()=>db.prepare("INSERT INTO character_draft_campaign_deletions_v20(campaign_id) VALUES (?)").run(campaign.id)).toThrow(/marker is inert|no such function/);
    expect(()=>db.prepare("DELETE FROM campaigns WHERE id=?").run(campaign.id)).toThrow(/archived, not physically deleted|no such function/);
    const statements = [
      "DELETE FROM character_starting_grants_v19", "DELETE FROM character_derived_snapshots_v19",
      "DELETE FROM character_draft_revisions_v19", "DELETE FROM character_draft_receipts_v19",
      "DELETE FROM character_draft_events_v19", "DELETE FROM character_draft_command_provenance_v20",
      "DELETE FROM character_draft_commands_v19", "DELETE FROM character_draft_pins_v19", "DELETE FROM character_drafts_v19",
    ];
    for (const statement of statements) expect(() => db.prepare(statement).run()).toThrow(/immutable|retained|velvet_campaign_delete_authorized/);
    expect(db.prepare("SELECT COUNT(*) count FROM character_drafts_v19").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_commands_v19").get()).toEqual({ count: 3 });
    db.close();
  });

  it("keeps deletion inert even when a hostile connection registers the legacy UDF name",()=>{
    const {repo,persona,campaign}=setup();complete(repo,campaign.id,persona.id);repo.close();
    const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys = ON");
    db.function("velvet_campaign_delete_authorized",(_campaignId:unknown)=>1);
    expect(()=>db.prepare("DELETE FROM campaigns WHERE id=?").run(campaign.id)).toThrow("archived, not physically deleted");
    expect(()=>db.prepare("INSERT INTO character_draft_campaign_deletions_v20 VALUES (?)").run(campaign.id)).toThrow("marker is inert");
    expect(()=>db.prepare("DELETE FROM character_draft_commands_v19").run()).toThrow("immutable");
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_campaign_deletions_v20").get()).toEqual({count:0});
    expect(db.prepare("SELECT id FROM campaigns WHERE id=?").get(campaign.id)).toEqual({id:campaign.id});
    db.close();
  });
});
