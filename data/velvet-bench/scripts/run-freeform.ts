#!/usr/bin/env node
/**
 * Windows entry point for VelvetRP's 18-turn free-form evaluator.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/freeform-fun-eval.ts` guards its CLI with:
 *
 *     if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
 *
 * and defines fileURLToPath as `new URL(url).pathname`. On Windows that yields
 * "/C:/Users/.../freeform-fun-eval.ts" while path.resolve yields
 * "C:\Users\...\freeform-fun-eval.ts", so the comparison is ALWAYS false. Running the
 * committed script on Windows therefore exits 0 silently and produces no artifact.
 *
 * This wrapper imports the real evaluator and calls the exported
 * `runFreeformFunEval` directly, so the benchmark runs the repository's actual code
 * unchanged. The repository is NOT modified and the pinned commit is preserved.
 *
 * Usage (same flags as the original):
 *   npx tsx data/velvet-bench/scripts/run-freeform.ts \
 *     --data-dir=<dir> --turns=18 --seed=11 --out=<path.json> [--quiet] [--keep]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFreeformFunEval, argValue, validateTurnCount } from "../../../scripts/freeform-fun-eval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// data/velvet-bench/scripts -> repository root is two levels up.
const repoRoot = path.resolve(here, "..", "..", "..");

const args = process.argv.slice(2);
const turns = Number(argValue(args, "turns") ?? 18);
const quiet = args.includes("--quiet");
const out = argValue(args, "out") ?? path.join(here, "..", "reports", "freeform-fun-eval.json");

async function main() {
  validateTurnCount(turns);
  process.stderr.write(
    `[wrapper] running the repository evaluator from ${path.join(repoRoot, "scripts", "freeform-fun-eval.ts")}\n` +
    `[wrapper] the script's own CLI guard does not match on Windows; this calls the exported function instead\n`,
  );

  const result = await runFreeformFunEval({
    dataDir: argValue(args, "data-dir"),
    turns,
    seed: Number(argValue(args, "seed") ?? 11),
    port: Number(argValue(args, "port") ?? 18814),
    out,
    baseline: argValue(args, "baseline") ?? null,
    keep: args.includes("--keep"),
    quiet,
  });

  const m = result.artifact.metrics as Record<string, number>;
  process.stdout.write("\n=== free-form evaluator metrics ===\n");
  for (const k of Object.keys(m)) {
    if (typeof m[k] === "number") process.stdout.write(`  ${k.padEnd(28)} ${m[k]}\n`);
  }
  const v = result.artifact.verdict as { passed?: boolean; failures?: unknown[]; skipped?: unknown[] };
  process.stdout.write(`\nverdict passed : ${v?.passed ?? "n/a"}\n`);
  if (v?.failures?.length) process.stdout.write(`failures      : ${JSON.stringify(v.failures).slice(0, 2000)}\n`);
  if (v?.skipped?.length) process.stdout.write(`skipped       : ${JSON.stringify(v.skipped).slice(0, 1000)}\n`);
  process.stdout.write(`\njson      : ${result.output}\nmarkdown  : ${result.markdownPath}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});