/**
 * Reproducible caller for the re-weighted structured corpus campaign.
 *
 * Contains NO credentials: the teacher and reviewer clients resolve keys from the
 * environment exactly as `npm run foundry` does.
 *
 * Weights differ from the module default because the research found the default
 * mix was tuned for measured stock weaknesses rather than for a training corpus:
 * roleplay is a primary goal, and grounded narration is mechanically correct but
 * style-weak, so it is capped rather than doubled. `roleplay-conversation` is the
 * LEGACY three-message scaffold and is excluded here; the creative stream is a
 * separate campaign and its own opt-in path.
 *
 * Modes
 *   --freeze            Print and persist the frozen plan identity. No provider call.
 *   --preflight <pin>   Verify the plan against the pin, then run with zero requests.
 *   --execute  <pin>    Require the externally supplied plan pin, then dispatch.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/runCorpusCampaign.ts --freeze
 *   FOUNDRY_TOKENIZER_PYTHON=... VELVET_REVIEWER_MODEL=kimi:k3 \
 *     npx tsx dataset/scripts/runCorpusCampaign.ts --execute <pin>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOKEN_BUDGET, planRun, runPipeline, type WeightTarget } from "../src/generate.js";
import { loadGenerationPolicy } from "../src/generationPolicy.js";
import { openRunStore, sourceTreeDigest } from "../src/runstore.js";
import { createTeacherClient, requireTeacherCredentials, requireReviewerCredentials } from "../src/teacher.js";
import { loadTeacherRights } from "../src/teacherRights.js";
import { createTokenizerBridge } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

/** Frozen preregistration identity. Changing any value here is a protocol change. */
export const CORPUS_RUN_ID = "corpus-structured-2026-10-13-v1";
export const CORPUS_SEED = "corpus-structured-2026-10-13-1";
export const CORPUS_UNITS = 60;
export const CORPUS_MAX_REPAIRS = 2;
export const CORPUS_MAX_COMPLETION_TOKENS = 2048;

/**
 * Re-weighted family allocation. Deliberately NOT the module default, and scoped
 * to this plan so the frozen pilot is untouched.
 *
 * world-generation carries the largest share because structured world content is
 * the most reusable RPG capability and was independently approved. Grounded
 * narration is capped at 0.15: it is mechanically sound but fails the prose
 * floor, so it belongs in the structured arm in limited proportion rather than
 * dominating. roleplay-conversation is 0 here because the legacy scaffold is
 * superseded by the creative stream.
 */
export const CORPUS_FAMILY_WEIGHTS: Readonly<Record<WeightTarget, number>> = Object.freeze({
  "world-generation": 0.35,
  "tool-selection:argument-binding": 0.20,
  "tool-selection:initiation": 0.10,
  "boundary-recovery": 0.20,
  "grounded-narration": 0.15,
  "roleplay-conversation": 0,
});

const datasetRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(datasetRoot, "..");
const measurements = join(repositoryRoot, ".dataset", "measurements", CORPUS_RUN_ID);
const registrationPath = join(measurements, "preregistration.json");

function frozenPlan() {
  return planRun({
    seed: CORPUS_SEED,
    units: CORPUS_UNITS,
    generationPolicy: loadGenerationPolicy(),
    familyWeights: CORPUS_FAMILY_WEIGHTS,
  });
}

function freeze(): void {
  const plan = frozenPlan();
  if (plan.units.length !== CORPUS_UNITS) throw new Error(`expected ${CORPUS_UNITS} units, got ${plan.units.length}`);
  const families: Record<string, number> = {};
  for (const unit of plan.units) families[unit.spec.family] = (families[unit.spec.family] ?? 0) + 1;
  if ((families["roleplay-conversation"] ?? 0) !== 0) throw new Error("the legacy roleplay scaffold must not be scheduled here");
  mkdirSync(measurements, { recursive: true });
  if (existsSync(registrationPath)) throw new Error("corpus registration already exists; refusing to rebuild it");
  const registration = {
    runId: CORPUS_RUN_ID, seed: CORPUS_SEED, units: CORPUS_UNITS, planDigest: plan.digest,
    splitCounts: plan.splitCounts, familyCounts: families, familyWeights: CORPUS_FAMILY_WEIGHTS,
    scenarioCount: plan.scenarioCount, realizationsPerScenario: plan.realizationsPerScenario,
  };
  writeFileSync(registrationPath, stableStringify(registration, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${stableStringify(registration, 2)}\n`);
}

async function dispatch(command: "--preflight" | "--execute", expectedPlanDigest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) throw new Error("expected frozen plan pin required");
  const plan = frozenPlan();
  if (plan.digest !== expectedPlanDigest) throw new Error("frozen corpus plan drift");
  if (!existsSync(registrationPath)) throw new Error(`corpus registration is missing: ${registrationPath}`);
  const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as { planDigest: string; units: number };
  if (registration.planDigest !== expectedPlanDigest) throw new Error("frozen plan pin disagrees with retained preregistration");
  if (registration.units !== plan.units.length) throw new Error("frozen corpus unit-count drift");

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
      runId: CORPUS_RUN_ID, seed: CORPUS_SEED,
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
      runId: CORPUS_RUN_ID, seed: CORPUS_SEED, units: CORPUS_UNITS,
      familyWeights: CORPUS_FAMILY_WEIGHTS,
      execute, maxRepairs: CORPUS_MAX_REPAIRS,
      maxCompletionTokens: CORPUS_MAX_COMPLETION_TOKENS, teacherThinking: "disabled", temperature: 0.7,
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
  throw new Error("usage: runCorpusCampaign.ts --freeze | --preflight <pin> | --execute <pin>");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Provider errors can embed untrusted response text; never echo them.
  process.stderr.write(`corpus campaign refused: ${error instanceof Error ? error.message : "see retained local diagnostics"}\n`);
  process.exitCode = 1;
});