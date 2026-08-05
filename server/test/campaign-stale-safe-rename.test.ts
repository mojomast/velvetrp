import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  createRepository,
} from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const initialAt = "2030-04-05T06:07:08.009Z";
const firstRenameAt = "2030-04-05T06:07:09.010Z";
const secondRenameAt = "2030-04-05T06:07:10.011Z";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function dbPath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seed(): void {
  const ids = ["campaign-one", "timeline-one"];
  const repository = createRepository({
    dataDir: dataDir(),
    ids: { nextId: () => ids.shift() ?? "unexpected-id" },
    clock: { now: () => new Date(initialAt) },
  });
  repository.createCampaign("local-owner", { name: "Original" });
  repository.close();
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('other-owner', 'Other', 0)").run();
  db.close();
}

function storedCampaign(): Record<string, unknown> {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const row = db.prepare("SELECT * FROM campaigns WHERE id = 'campaign-one'").get() as Record<string, unknown>;
  db.close();
  return row;
}

describe("factory stale-safe campaign rename", () => {
  it("writes and validates a complete Campaign after exact precondition and one clock", () => {
    seed();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const nextId = vi.fn(() => "unused");
    const rng = vi.fn(() => 1);
    const repository = createRepository({
      dataDir: dataDir(), clock: { now: clockNow }, ids: { nextId }, rng: { integer: rng },
    });

    expect(repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "  Renamed  ", expectedUpdatedAt: initialAt,
    })).toEqual({
      id: "campaign-one",
      name: "Renamed",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt: initialAt,
      updatedAt: firstRenameAt,
    });
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    expect(rng).not.toHaveBeenCalled();
    repository.close();
  });

  it("advances same-name writes beyond an equal clock and invalidates the old token", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(initialAt) } });
    const renamed = repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: " Original ", expectedUpdatedAt: initialAt,
    });
    expect(renamed.name).toBe("Original");
    expect(renamed.updatedAt).toBe("2030-04-05T06:07:08.010Z");
    expect(() => repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Original", expectedUpdatedAt: initialAt,
    })).toThrow(CampaignRenameStaleError);
    repository.close();
  });

  it("serializes two successful renames under one equal clock with strictly increasing tokens", () => {
    seed();
    const clockNow = vi.fn(() => new Date(initialAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    const first = repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "First", expectedUpdatedAt: initialAt,
    });
    const second = repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Second", expectedUpdatedAt: first.updatedAt,
    });
    expect([first.updatedAt, second.updatedAt]).toEqual([
      "2030-04-05T06:07:08.010Z", "2030-04-05T06:07:08.011Z",
    ]);
    expect(() => repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Stale", expectedUpdatedAt: first.updatedAt,
    })).toThrow(CampaignRenameStaleError);
    expect(clockNow).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it("makes the second of two writers stale before its clock and never retries", () => {
    seed();
    const firstClock = vi.fn(() => new Date(firstRenameAt));
    const secondClock = vi.fn(() => new Date(secondRenameAt));
    const first = createRepository({ dataDir: dataDir(), clock: { now: firstClock } });
    const second = createRepository({ dataDir: dataDir(), clock: { now: secondClock } });

    first.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "First", expectedUpdatedAt: initialAt,
    });
    expect(() => second.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Second", expectedUpdatedAt: initialAt,
    })).toThrow(CampaignRenameStaleError);
    expect(firstClock).toHaveBeenCalledOnce();
    expect(secondClock).not.toHaveBeenCalled();
    first.close();
    second.close();
    expect(storedCampaign()).toMatchObject({ name: "First", updated_at: firstRenameAt });
  });

  it("uses the same typed unavailable result for missing and intact denied campaigns", () => {
    seed();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    for (const [actor, campaign] of [["local-owner", "campaign-missing"], ["other-owner", "campaign-one"]]) {
      expect(() => repository.renameCampaignIfUnchanged(actor!, campaign!, {
        name: "Denied", expectedUpdatedAt: initialAt,
      })).toThrow(CampaignRenameUnavailableError);
    }
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it.each(["missing", "orphaned"] as const)("treats %s owner integrity as generic internal failure for the purported owner", (kind) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    if (kind === "missing") {
      db.prepare("DELETE FROM campaign_memberships WHERE campaign_id = 'campaign-one' AND role = 'owner'").run();
    } else {
      db.prepare("DELETE FROM principals WHERE id = 'local-owner'").run();
    }
    db.close();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    let failure: unknown;
    try {
      repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
        name: "No", expectedUpdatedAt: initialAt,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CampaignRenameUnavailableError);
    expect(failure).not.toBeInstanceOf(CampaignRenameStaleError);
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it.each(["missing", "orphaned"] as const)("masks %s owner corruption from a denied actor", (kind) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    if (kind === "missing") db.prepare("DELETE FROM campaign_memberships WHERE campaign_id = 'campaign-one' AND role = 'owner'").run();
    else db.prepare("DELETE FROM principals WHERE id = 'local-owner'").run();
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    expect(() => repository.renameCampaignIfUnchanged("other-owner", "campaign-one", {
      name: "Denied", expectedUpdatedAt: initialAt,
    })).toThrow(CampaignRenameUnavailableError);
    repository.close();
  });

  it.each([
    ["actor", "bad actor", "campaign-one", { name: "Valid", expectedUpdatedAt: initialAt }],
    ["campaign", "local-owner", "bad campaign", { name: "Valid", expectedUpdatedAt: initialAt }],
    ["name", "local-owner", "campaign-one", { name: " ", expectedUpdatedAt: initialAt }],
    ["timestamp", "local-owner", "campaign-one", { name: "Valid", expectedUpdatedAt: "not-a-time" }],
    ["extra", "local-owner", "campaign-one", { name: "Valid", expectedUpdatedAt: initialAt, extra: true }],
  ])("rejects malformed %s inside the transaction before dependencies or writes", (_label, actor, campaign, input) => {
    seed();
    const before = storedCampaign();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    expect(() => repository.renameCampaignIfUnchanged(actor as string, campaign as string, input as never)).toThrow();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(storedCampaign()).toEqual(before);
  });

  it("clamps a backward clock forward and rolls back SQL failure without retry", () => {
    seed();
    const backwardClock = vi.fn(() => new Date("2030-04-05T06:07:08.008Z"));
    const backward = createRepository({ dataDir: dataDir(), clock: { now: backwardClock } });
    expect(backward.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Forward", expectedUpdatedAt: initialAt,
    }).updatedAt).toBe("2030-04-05T06:07:08.010Z");
    backward.close();
    expect(storedCampaign()).toMatchObject({ name: "Forward", updated_at: "2030-04-05T06:07:08.010Z" });

    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_stale_safe_rename BEFORE UPDATE OF name ON campaigns
      BEGIN SELECT RAISE(ABORT, 'rename rejected'); END;`);
    db.close();
    const sqlClock = vi.fn(() => new Date(firstRenameAt));
    const failing = createRepository({ dataDir: dataDir(), clock: { now: sqlClock } });
    expect(() => failing.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "No", expectedUpdatedAt: "2030-04-05T06:07:08.010Z",
    })).toThrow("rename rejected");
    expect(sqlClock).toHaveBeenCalledOnce();
    failing.close();
    expect(storedCampaign()).toMatchObject({ name: "Forward", updated_at: "2030-04-05T06:07:08.010Z" });
  });

  it("classifies a zero-change conditional loss as stale and rolls back", () => {
    seed();
    const before = storedCampaign();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER ignore_stale_safe_rename BEFORE UPDATE OF name ON campaigns
      BEGIN SELECT RAISE(IGNORE); END;`);
    db.close();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    expect(() => repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
      name: "Lost", expectedUpdatedAt: initialAt,
    })).toThrow(CampaignRenameStaleError);
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(storedCampaign()).toEqual(before);
  });

  it("is factory-only and preserves the existing renameCampaign behavior and signature", () => {
    seed();
    const clockNow = vi.fn(() => new Date(firstRenameAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    repository.transaction((unit) => {
      expect("renameCampaignIfUnchanged" in unit).toBe(false);
      expect(() => repository.renameCampaignIfUnchanged("local-owner", "campaign-one", {
        name: "Nested", expectedUpdatedAt: initialAt,
      })).toThrow("cannot run inside a repository transaction");
      return null;
    });
    expect(repository.renameCampaign("local-owner", "campaign-one", { name: "Legacy" }).name).toBe("Legacy");
    repository.close();
  });
});
