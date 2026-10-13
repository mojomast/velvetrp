/**
 * Reproducible caller for a creative character-roleplay calibration run.
 *
 * This is the ONLY entry point that dispatches the creative stream. It contains
 * NO credentials: the teacher and reviewer clients resolve keys from the
 * environment exactly as `npm run foundry` does.
 *
 * Modes
 *   --freeze            Print and persist the frozen plan identity. No provider call.
 *   --preflight <pin>   Re-derive and verify the plan against the pin, then run with
 *                       zero provider requests.
 *   --execute  <pin>    Require the externally supplied plan pin, then dispatch.
 *
 * The pin is supplied by the caller, not re-derived from the plan it validates.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/runCreativeCalibration.ts --freeze
 *   FOUNDRY_TOKENIZER_PYTHON=... VELVET_REVIEWER_MODEL=kimi:k3 \
 *     npx tsx dataset/scripts/runCreativeCalibration.ts --execute <pin>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOKEN_BUDGET, planRun, runPipeline } from "../src/generate.js";
import { loadGenerationPolicy } from "../src/generationPolicy.js";
import { openRunStore, sourceTreeDigest } from "../src/runstore.js";
import { createTeacherClient, requireTeacherCredentials, requireReviewerCredentials } from "../src/teacher.js";
import { loadTeacherRights } from "../src/teacherRights.js";
import { createTokenizerBridge } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

/** Frozen preregistration identity. Changing any value here is a protocol change. */
export const CREATIVE_RUN_ID = "creative-2026-10-13-v4";
export const CREATIVE_SEED = "creative-2026-10-13-4";
export const CREATIVE_UNITS = 10;
export const CREATIVE_MAX_REPAIRS = 2;
/** Multi-turn conversations need far more output room than a single narration.
 * The provider advertises a 128k output ceiling; 16384 gives an 8-exchange
 * conversation ample room and avoids the truncation that produced
 * transcript-not-json refusals at 4096.
 * The CLI default of 2048 is consumed by longer plans before any content is
 * emitted, which showed up live as empty completions. */
export const CREATIVE_MAX_COMPLETION_TOKENS = 16384;

const datasetRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(datasetRoot, "..");
const measurements = join(repositoryRoot, ".dataset", "measurements", CREATIVE_RUN_ID);
const registrationPath = join(measurements, "preregistration.json");

const creativeStream = { units: CREATIVE_UNITS } as const;

function frozenPlan() {
  return planRun({
    seed: CREATIVE_SEED,
    units: CREATIVE_UNITS,
    generationPolicy: loadGenerationPolicy(),
    creativeStream,
  });
}

function freeze(): void {
  const plan = frozenPlan();
  if (plan.units.length !== CREATIVE_UNITS) throw new Error(`expected ${CREATIVE_UNITS} creative units, got ${plan.units.length}`);
  if (!plan.units.every((unit) => unit.creative)) throw new Error("a scheduled creative unit has no creative binding");
  mkdirSync(measurements, { recursive: true });
  if (existsSync(registrationPath)) throw new Error("creative registration already exists; refusing to rebuild it");
  const registration = {
    runId: CREATIVE_RUN_ID, seed: CREATIVE_SEED, units: CREATIVE_UNITS,
    planDigest: plan.digest, splitCounts: plan.splitCounts,
    scenarioCount: plan.scenarioCount, realizationsPerScenario: plan.realizationsPerScenario,
  };
  writeFileSync(registrationPath, stableStringify(registration, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${stableStringify(registration, 2)}\n`);
}

async function dispatch(command: "--preflight" | "--execute", expectedPlanDigest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) throw new Error("expected frozen plan pin required");
  const plan = frozenPlan();
  if (plan.digest !== expectedPlanDigest) throw new Error("frozen creative plan drift");
  if (!existsSync(registrationPath)) throw new Error(`creative registration is missing: ${registrationPath}`);
  const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as { planDigest: string; units: number };
  if (registration.planDigest !== expectedPlanDigest) throw new Error("frozen plan pin disagrees with retained preregistration");
  if (registration.units !== plan.units.length) throw new Error("frozen creative unit-count drift");

  const python = process.env.FOUNDRY_TOKENIZER_PYTHON;
  if (!python) throw new Error("FOUNDRY_TOKENIZER_PYTHON is required; see dataset/tokenizer/README.md");
  const tokenizer = createTokenizerBridge({ python,
    assetsDir: process.env.FOUNDRY_TOKENIZER_ASSETS ?? join(repositoryRoot, ".dataset", "tokenizer", "qwen3-8b") });

  // Construction performs no network call; only execute:true dispatches.
  const generator = createTeacherClient({ credentials: requireTeacherCredentials() });
  const reviewer = createTeacherClient({ credentials: requireReviewerCredentials(generator.model) });
  if (generator.model !== "deepseek-v4-flash") throw new Error(`preregistered generator is deepseek-v4-flash, got "${generator.model}"`);
  if (!["kimi:k3", "kimi-k3"].includes(reviewer.model)) {
    throw new Error(`preregistered reviewer is Kimi K3, got "${reviewer.model}"; set VELVET_REVIEWER_MODEL=kimi:k3`);
  }

  const execute = command === "--execute";
  const store = execute
    ? openRunStore({
      runId: CREATIVE_RUN_ID, seed: CREATIVE_SEED,
      sourceDigest: sourceTreeDigest(datasetRoot, { skip: ["__pycache__"] }),
      splitAssignmentDigest: plan.splitAssignmentDigest,
      corpusFreezeDigest: loadGenerationPolicy().corpusDigest,
      totalUnits: plan.units.length,
      generator: { provider: generator.identity.provider, model: generator.model,
        baseUrlDigest: generator.baseUrlDigest, temperature: 0.7 },
      artifactRoot: join(repositoryRoot, ".dataset"), durability: "fsync",
    })
    : undefined;
  try {
    const report = await runPipeline({
      runId: CREATIVE_RUN_ID, seed: CREATIVE_SEED, units: CREATIVE_UNITS,
      creativeStream, execute, maxRepairs: CREATIVE_MAX_REPAIRS,
      maxCompletionTokens: CREATIVE_MAX_COMPLETION_TOKENS, teacherThinking: "disabled", temperature: 0.7,
      reviewerTemperature: null, reviewerReasoningEffort: "low", reviewerMaxCompletionTokens: 4096,
      tokenizer, generator, reviewer,
      generationPolicy: loadGenerationPolicy(),
      selectionPolicy: { maxRecordsPerCluster: 8 },
      budget: DEFAULT_TOKEN_BUDGET, teacherRights: loadTeacherRights(),
      ...(store ? { store } : {}),
    });
    process.stdout.write(`${stableStringify(report, 2)}\n`);
  } finally {
    store?.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === "--freeze") { freeze(); return; }
  if (command === "--preflight" || command === "--execute") { await dispatch(command, argv[1] ?? ""); return; }
  throw new Error("usage: runCreativeCalibration.ts --freeze | --preflight <pin> | --execute <pin>");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Provider errors can embed untrusted response text; never echo them.
  process.stderr.write(`creative calibration refused: ${error instanceof Error ? error.message : "see retained local diagnostics"}\n`);
  process.exitCode = 1;
});