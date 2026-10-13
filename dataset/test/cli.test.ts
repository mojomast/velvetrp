import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliDependencies } from "../src/cli.js";
import type { TeacherClient } from "../src/teacher.js";

async function invoke(argv: string[], dependencies: CliDependencies = {}) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    env: {},
    ...dependencies,
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  return { code, out, err };
}

test("help works outside the repository without importing verifier side effects", () => {
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "help"], {
    cwd: "/tmp/opencode", encoding: "utf8",
    env: { ...process.env, NODE_PATH: undefined },
  });
  // Resolve the loader through the current project even though the command's cwd
  // has no corpus. This is also a regression for accidentally verifying on import.
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Velvet training-data foundry/);
  assert.doesNotMatch(child.stdout, /"problems"|"corpusVersion"/);
  assert.doesNotMatch(child.stderr, /missing.*fingerprint|corpus.*FAILED|foundry command failed/);
});

test("plan is deterministic, provider-free, and supports the 175-unit pilot", async () => {
  const args = ["plan", "--units", "175", "--seed", "cli-pilot"];
  const first = await invoke(args);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(await invoke(args), first);
  const plan = JSON.parse(first.out) as { units: { spec: { family: string } }[] };
  assert.equal(plan.units.length, 175);
  assert.ok(plan.units.some((unit) => unit.spec.family === "roleplay-conversation"));
});

test("verify reports the frozen dev corpus", async () => {
  const result = await invoke(["verify"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /verified \(106 dev cases\)/);
});

for (const args of [
  ["generate"], ["generate", "--execute"],
]) {
  test(`${args.join(" ")} refuses before credential resolution without measured tokens`, async () => {
    const result = await invoke(args);
    assert.equal(result.code, 1);
    assert.match(result.err, /no measured tokenizer/);
    assert.match(result.err, /No teacher calls/);
    assert.equal(result.out, "");
  });
}

for (const args of [
  ["generate", "--seed", "--execute"], ["plan", "--execute"],
  ["generate", "--units", "0"], ["generate", "--max-repairs", "-1"],
  ["generate", "--families", ","], ["generate", "--families", "invalid"],
  ["generate", "--seed", "one", "--seed", "two"], ["generate", "extra"],
  ["generate", "--units", "Infinity"], ["verify", "--sealed-source"],
]) {
  test(`invalid CLI arguments refuse: ${args.join(" ")}`, async () => {
    const result = await invoke(args);
    assert.equal(result.code, 2);
    assert.match(result.err, /usage error/);
    assert.equal(result.out, "");
  });
}

test("an injected dry run makes no teacher or reviewer calls", async () => {
  let calls = 0;
  const client = (model: string): TeacherClient => ({
    model, baseUrlDigest: "digest",
    identity: { provider: "test", model, baseUrlDigest: "digest", credentialSource: "env" },
    complete: async () => { calls += 1; throw new Error("unexpected provider call"); },
  });
  const result = await invoke(["generate", "--units", "3"], {
    tokenizer: { name: "test-only counter", countSupervisedTokens: () => 1 },
    generator: client("teacher"), reviewer: client("reviewer"),
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls, 0);
  assert.equal((JSON.parse(result.out) as { executed: boolean }).executed, false);
});

test("execute with a tokenizer still refuses before clients without a run store", async () => {
  const result = await invoke(["generate", "--execute"], {
    tokenizer: { name: "test-only counter", countSupervisedTokens: () => 1 },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /configured run store/);
});
