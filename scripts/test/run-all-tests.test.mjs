// Approved test for Phase 0.2b: one failing workspace must not hide the others.
// Run with: node --test scripts/test/run-all-tests.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = path.join(ROOT, "scripts", "run-all-tests.mjs");

function step(name, dir, exitCode) {
  const marker = path.join(dir, `${name}.ran`);
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(${exitCode});`;
  return { name, command: process.execPath, args: ["-e", code] };
}

function runWith(steps) {
  return spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    env: { ...process.env, RUN_ALL_TESTS_STEPS: JSON.stringify(steps) },
    encoding: "utf8",
    timeout: 60000,
  });
}

describe("RunAllTests", () => {
  it("test_failing_first_step_does_not_stop_later_steps", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-all-tests-"));
    try {
      const result = runWith([step("contracts", dir, 1), step("server", dir, 0), step("client", dir, 0)]);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, "runner must exit non-zero when any step fails");
      for (const name of ["contracts", "server", "client"]) {
        assert.ok(existsSync(path.join(dir, `${name}.ran`)), `${name} step must still run`);
      }
      const out = `${result.stdout}\n${result.stderr}`;
      assert.match(out, /FAIL\s+contracts/);
      assert.match(out, /PASS\s+server/);
      assert.match(out, /PASS\s+client/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_failure_in_middle_step_still_runs_last_and_fails_overall", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-all-tests-"));
    try {
      const result = runWith([step("contracts", dir, 0), step("server", dir, 3), step("client", dir, 0)]);
      assert.notEqual(result.status, 0);
      assert.ok(existsSync(path.join(dir, "client.ran")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_all_steps_passing_exits_zero", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-all-tests-"));
    try {
      const result = runWith([step("contracts", dir, 0), step("server", dir, 0), step("client", dir, 0)]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_default_steps_cover_every_workspace_in_order", () => {
    const result = spawnSync(process.execPath, [RUNNER, "--list"], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const names = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(names, ["contracts", "server", "client"]);
  });

  it("test_root_test_script_uses_the_runner", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, "node scripts/run-all-tests.mjs");
    assert.equal(pkg.scripts.pretest, "npm run build --workspace @velvet/contracts");
    assert.doesNotMatch(pkg.scripts.test, /&&/);
  });
});

function ciSteps() {
  const text = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const blocks = text.split(/\n(?=\s*- (?:name|run|uses):)/);
  return blocks
    .map((block) => {
      const run = block.match(/^\s*(?:- )?run:\s*(.+)$/m)?.[1]?.trim();
      const cond = block.match(/^\s*(?:- )?if:\s*(.+)$/m)?.[1]?.trim();
      return { run, cond };
    })
    .filter((s) => s.run);
}

describe("CiWorkflow", () => {
  it("test_each_workspace_and_e2e_has_its_own_step_that_runs_after_failures", () => {
    const steps = ciSteps();
    const required = [
      "npm run build",
      "npm run test --workspace @velvet/contracts",
      "npm --workspace velvet-mvp-server run test",
      "npm --workspace velvet-mvp-client run test",
      "npm run test:e2e",
    ];
    for (const command of required) {
      const found = steps.find((s) => s.run === command);
      assert.ok(found, `ci.yml must have a step running: ${command}`);
      assert.equal(found.cond, "${{ !cancelled() }}", `step '${command}' must use if: \${{ !cancelled() }}`);
    }
  });

  it("test_ci_no_longer_runs_the_chained_root_test", () => {
    const steps = ciSteps();
    assert.equal(
      steps.find((s) => s.run === "npm run test"),
      undefined,
    );
    assert.ok(steps.find((s) => s.run === "npm ci"));
    assert.ok(steps.find((s) => s.run === "npm run typecheck"));
  });
});
