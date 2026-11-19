import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEnvFileCandidates, loadDotEnv } from "../src/env.js";
import { applyDefaultRpgFlags, readRpgFeatureFlags } from "../src/features.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-env-"));
  dirs.push(dir);
  return dir;
}

describe(".env loading", () => {
  it("loads the first existing candidate and never overrides values already set", () => {
    const dir = tempDir();
    const file = path.join(dir, ".env");
    writeFileSync(file, '# comment\nPORT=9999\nVELVET_TEST_ONLY=from-file\nQUOTED="a b"\n');
    const env: Record<string, string | undefined> = { PORT: "8787" };
    expect(loadDotEnv(env, [path.join(dir, "missing.env"), file])).toBe(file);
    expect(env).toMatchObject({ PORT: "8787", VELVET_TEST_ONLY: "from-file", QUOTED: "a b" });
  });

  it("does nothing when no candidate exists", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadDotEnv(env, [path.join(tempDir(), ".env")])).toBeNull();
    expect(env).toEqual({});
  });

  it("uses VELVET_ENV_FILE alone when set, otherwise the working directory then the repository root", () => {
    expect(defaultEnvFileCandidates({ VELVET_ENV_FILE: "/tmp/x.env" }, "/srv/velvet/server")).toEqual([
      path.resolve("/tmp/x.env"),
    ]);
    const candidates = defaultEnvFileCandidates({}, "/srv/elsewhere");
    expect(candidates[0]).toBe(path.resolve("/srv/elsewhere", ".env"));
    expect(candidates).toHaveLength(2);
    expect(path.basename(candidates[1]!)).toBe(".env");
    expect(new Set(candidates).size).toBe(2);
  });
});

describe("RPG feature defaults", () => {
  it("turns the four RPG flags on unless set to false and leaves opt-in flags off", () => {
    const env: Record<string, string | undefined> = { FEATURE_RPG_COMBAT: "false" };
    applyDefaultRpgFlags(env);
    expect(env).toMatchObject({
      FEATURE_RPG_CAMPAIGN: "true",
      FEATURE_RPG_MECHANICS: "true",
      FEATURE_RPG_COMBAT: "false",
      FEATURE_RPG_STUDIO: "true",
    });
    expect(env.FEATURE_SYSTEM_ONE).toBeUndefined();
    expect(env.FEATURE_REMOTE_AUTHENTICATION).toBeUndefined();
    expect(readRpgFeatureFlags(env as NodeJS.ProcessEnv)).toMatchObject({
      campaign: true,
      mechanics: true,
      combat: false,
      studio: true,
      systemOne: false,
      remoteAuthentication: false,
    });
  });

  it("keeps readRpgFeatureFlags strict for callers that do not apply defaults", () => {
    expect(readRpgFeatureFlags({} as NodeJS.ProcessEnv)).toMatchObject({
      campaign: false,
      mechanics: false,
      combat: false,
      studio: false,
    });
  });
});
