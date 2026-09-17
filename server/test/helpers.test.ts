import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reapStaleTestDirectories } from "./helpers.js";

describe("test temp directory reaper", () => {
  it("removes directories owned by dead processes and keeps live or unrelated ones", () => {
    const root = mkdtempSync(path.join(tmpdir(), "velvet-reaper-"));
    try {
      const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
      const dead = path.join(root, `velvet-test-${deadPid}-aaaaaa`);
      const live = path.join(root, `velvet-test-${process.ppid}-bbbbbb`);
      const unrelated = path.join(root, "velvet-test-notowned");
      mkdirSync(dead);
      mkdirSync(live);
      mkdirSync(unrelated);

      expect(reapStaleTestDirectories(root)).toBe(1);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing when the temp root cannot be read", () => {
    expect(reapStaleTestDirectories(path.join(tmpdir(), "velvet-reaper-missing-root"))).toBe(0);
  });
});
