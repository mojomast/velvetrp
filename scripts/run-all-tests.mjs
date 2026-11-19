#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const DEFAULT_STEPS = [
  { name: "contracts", command: NPM, args: ["run", "test", "--workspace", "@velvet/contracts"] },
  { name: "server", command: NPM, args: ["--workspace", "velvet-mvp-server", "run", "test"] },
  { name: "client", command: NPM, args: ["--workspace", "velvet-mvp-client", "run", "test"] },
];

function stepsFromEnv() {
  const raw = process.env.RUN_ALL_TESTS_STEPS;
  if (!raw) return DEFAULT_STEPS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("RUN_ALL_TESTS_STEPS must be a JSON array of steps");
  }
  return parsed.map((step) => ({
    name: String(step.name),
    command: String(step.command),
    args: Array.isArray(step.args) ? step.args.map(String) : [],
  }));
}

if (process.argv.includes("--list")) {
  for (const step of DEFAULT_STEPS) console.log(step.name);
  process.exit(0);
}

const steps = stepsFromEnv();
const results = [];

for (const step of steps) {
  const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: "inherit" });
  const failed = Boolean(result.error) || result.status !== 0;
  results.push({ name: step.name, failed });
}

for (const result of results) {
  console.log(`${result.failed ? "FAIL" : "PASS"} ${result.name}`);
}

process.exit(results.some((result) => result.failed) ? 1 : 0);
