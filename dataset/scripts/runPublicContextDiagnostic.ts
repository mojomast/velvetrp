/**
 * Reproducible caller for the frozen six-surface public-context diagnostic.
 *
 * This is the ONLY entry point that dispatches `calibration-public-context-2026-10-13-v8`.
 * It contains NO credentials: the teacher and reviewer clients resolve keys from
 * the environment exactly as `npm run foundry` does (see dataset/teacher.ts).
 *
 * Modes
 *   --freeze       Build and write the source manifest and pre-dispatch plan. Refuses
 *                  if the manifest already exists. No provider call.
 *   --preflight <pin>
 *   --execute  <pin>   Require the externally supplied frozen manifest pin, verify the
 *                  frozen manifest AND plan identity, then either run with zero
 *                  provider requests (preflight) or dispatch (execute).
 *
 * The pin is deliberately NOT re-derived from the manifest's own declared digest.
 * A caller that recomputes the pin from the same bytes it is validating would
 * validate nothing; the pin must come from independently retained preregistration.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/runPublicContextDiagnostic.ts --preflight c07754537a920d4a7acbb09fd5951ee4974273224f1925fa845f6d38647d6c58
 *   VELVET_REVIEWER_MODEL=kimi:k3 npx tsx dataset/scripts/runPublicContextDiagnostic.ts --execute  c07754537a920d4a7acbb09fd5951ee4974273224f1925fa845f6d38647d6c58
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicContextDiagnosticManifest, DEFAULT_TOKEN_BUDGET, planRun, runPipeline,
} from "../src/generate.js";
import {
  loadPublicSceneAuthority, publicContextDiagnosticManifestDigest,
  type PublicContextDiagnosticManifest,
} from "../src/publicSceneFacts.js";
import { loadGenerationPolicy } from "../src/generationPolicy.js";
import { openRunStore, sourceTreeDigest } from "../src/runstore.js";
import { createTeacherClient, requireTeacherCredentials, requireReviewerCredentials } from "../src/teacher.js";
import { loadTeacherRights } from "../src/teacherRights.js";
import { createTokenizerBridge } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

/** Frozen preregistration identity. Changing any value here is a protocol change. */
export const PUBLIC_CONTEXT_RUN_ID = "calibration-public-context-2026-10-13-v8";
export const PUBLIC_CONTEXT_SEED = "calibration-public-context-2026-10-13-8";
export const PUBLIC_CONTEXT_BASE_UNITS = 3;
export const PUBLIC_CONTEXT_MAX_REPAIRS = 2;

/**
 * The repository root is resolved from this file's location, not from the shell's
 * working directory, so an audit reproduces identically from any directory.
 */
const datasetRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(datasetRoot, "..");
const measurements = join(repositoryRoot, ".dataset", "measurements", PUBLIC_CONTEXT_RUN_ID);
const manifestPath = join(measurements, "public-context-manifest.json");
const registrationPath = join(measurements, "preregistration.json");

function tokenizerAssets(): string {
  return process.env.FOUNDRY_TOKENIZER_ASSETS ?? join(repositoryRoot, ".dataset", "tokenizer", "qwen3-8b");
}

function diagnosticPlan(manifest: PublicContextDiagnosticManifest, expectedManifestDigest: string) {
  const policy = loadGenerationPolicy();
  return planRun({
    seed: PUBLIC_CONTEXT_SEED,
    units: PUBLIC_CONTEXT_BASE_UNITS,
    realizationsPerScenario: 1,
    families: ["grounded-narration"],
    generationPolicy: policy,
    publicContextDiagnostic: { manifest, expectedManifestDigest },
  });
}

function freeze(): void {
  if (existsSync(manifestPath)) throw new Error("source manifest is already frozen; refusing to rebuild it");
  const manifest = createPublicContextDiagnosticManifest(PUBLIC_CONTEXT_SEED);
  const expectedManifestDigest = publicContextDiagnosticManifestDigest(manifest);
  loadPublicSceneAuthority({ manifest, expectedManifestDigest });
  const plan = diagnosticPlan(manifest, expectedManifestDigest);

  // The selected bases must reproduce the retained public v6 plan entries exactly:
  // this is a comparison against public planning metadata, never against answers.
  const historicalPath = join(repositoryRoot, ".dataset", "measurements",
    "calibration-2026-10-13-v6", "independent-grounding-audit.json");
  if (existsSync(historicalPath)) {
    const historical = JSON.parse(readFileSync(historicalPath, "utf8")) as {
      plan: { units: Array<{ unitId: string; spec: { oracle: { receipts: unknown }; lineage: unknown; split: string }; realization: { slots: unknown; clusterId: string } }> };
    };
    for (const base of manifest.bases) {
      const previous = historical.plan.units.find((unit) => unit.unitId === base.baseUnitId);
      const arms = plan.units.filter((unit) => unit.publicContext?.baseUnitId === base.baseUnitId);
      if (!previous || arms.length !== 2) throw new Error("missing frozen matched base");
      for (const arm of arms) {
        if (stableStringify(arm.spec.oracle.receipts) !== stableStringify(previous.spec.oracle.receipts)
          || stableStringify(arm.realization.slots) !== stableStringify(previous.realization.slots)
          || stableStringify(arm.spec.lineage) !== stableStringify(previous.spec.lineage)
          || arm.spec.split !== previous.spec.split
          || arm.realization.clusterId !== previous.realization.clusterId) {
          throw new Error("matched public challenge drift");
        }
      }
    }
  } else {
    throw new Error(`retained public v6 plan artifact is required to freeze the matched challenge: ${historicalPath}`);
  }

  mkdirSync(measurements, { recursive: true });
  writeFileSync(manifestPath, stableStringify(manifest, 2) + "\n", { flag: "wx" });
  writeFileSync(join(measurements, "pre-dispatch-plan.json"), stableStringify(plan, 2) + "\n", { flag: "wx" });
  const registration = {
    runId: PUBLIC_CONTEXT_RUN_ID, seed: PUBLIC_CONTEXT_SEED,
    manifestDigest: expectedManifestDigest, planDigest: plan.digest,
    bases: plan.scenarioCount, initialTasks: plan.units.length,
    k: plan.realizationsPerScenario, splitCounts: plan.splitCounts, manifestPath,
  };
  writeFileSync(registrationPath, stableStringify(registration, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${stableStringify(registration, 2)}\n`);
}

async function dispatch(command: "--preflight" | "--execute", expectedManifestDigest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestDigest)) {
    throw new Error("expected frozen source-manifest pin required");
  }
  if (!existsSync(manifestPath)) throw new Error(`frozen manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublicContextDiagnosticManifest;
  // Fails closed on a declared digest that does not reproduce the canonical body,
  // and on any authority/projection violation.
  loadPublicSceneAuthority({ manifest, expectedManifestDigest });
  const publicContextDiagnostic = { manifest, expectedManifestDigest };
  const plan = diagnosticPlan(manifest, expectedManifestDigest);

  const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as {
    manifestDigest: string; planDigest: string; initialTasks: number;
  };
  if (registration.manifestDigest !== expectedManifestDigest) throw new Error("frozen manifest pin disagrees with retained preregistration");
  if (registration.planDigest !== plan.digest) throw new Error("frozen diagnostic plan drift");
  if (registration.initialTasks !== plan.units.length) throw new Error("frozen diagnostic task-count drift");
  if (plan.units.length !== 6 || plan.scenarioCount !== PUBLIC_CONTEXT_BASE_UNITS) {
    throw new Error(`expected six units across three bases, got ${plan.units.length}/${plan.scenarioCount}`);
  }

  const python = process.env.FOUNDRY_TOKENIZER_PYTHON;
  if (!python) throw new Error("FOUNDRY_TOKENIZER_PYTHON is required; see dataset/tokenizer/README.md");
  const tokenizer = createTokenizerBridge({ python, assetsDir: tokenizerAssets() });

  // The clients are constructed in both modes. Construction performs NO network
  // call; only runPipeline with execute:true dispatches. runPipeline dereferences
  // both identities immediately, so preflight without them would crash before it
  // could prove anything. Requiring the exact preregistered pair here means
  // preflight also proves the environment selects the right route, and it refuses
  // an environment whose default reviewer is not the frozen independent one.
  const generator = createTeacherClient({ credentials: requireTeacherCredentials() });
  const reviewer = createTeacherClient({ credentials: requireReviewerCredentials(generator.model) });
  if (generator.model !== "deepseek-v4-flash") {
    throw new Error(`preregistered generator is deepseek-v4-flash, got "${generator.model}"`);
  }
  // Accept only the preregistered independent reviewer identity. Both spellings
  // the CLI accepts are allowed; anything else refuses before a store is opened.
  if (!["kimi:k3", "kimi-k3"].includes(reviewer.model)) {
    throw new Error(`preregistered reviewer is Kimi K3, got "${reviewer.model}"; set VELVET_REVIEWER_MODEL=kimi:k3`);
  }
  if (reviewer.model === generator.model) throw new Error("reviewer must be an independent model");

  const execute = command === "--execute";
  const store = execute
    ? openRunStore({
      runId: PUBLIC_CONTEXT_RUN_ID, seed: PUBLIC_CONTEXT_SEED,
      sourceDigest: sourceTreeDigest(datasetRoot, { skip: ["__pycache__"] }),
      splitAssignmentDigest: plan.splitAssignmentDigest,
      corpusFreezeDigest: loadGenerationPolicy().corpusDigest,
      totalUnits: plan.units.length,
      generator: {
        provider: generator.identity.provider, model: generator.model,
        baseUrlDigest: generator.baseUrlDigest, temperature: 0.7,
      },
      artifactRoot: join(repositoryRoot, ".dataset"), durability: "fsync",
    })
    : undefined;

  try {
    const report = await runPipeline({
      runId: PUBLIC_CONTEXT_RUN_ID, seed: PUBLIC_CONTEXT_SEED,
      units: PUBLIC_CONTEXT_BASE_UNITS, realizationsPerScenario: 1,
      families: ["grounded-narration"], publicContextDiagnostic, execute,
      maxRepairs: PUBLIC_CONTEXT_MAX_REPAIRS,
      maxCompletionTokens: 2048, teacherThinking: "disabled", temperature: 0.7,
      reviewerTemperature: null, reviewerReasoningEffort: "low", reviewerMaxCompletionTokens: 4096,
      // The frozen protocol forbids style-driven regeneration: only a typed
      // functional failure may authorize a repair in this diagnostic.
      repairPolicy: "functional-only",
      tokenizer, generator, reviewer,
      generationPolicy: loadGenerationPolicy(),
      selectionPolicy: { maxRecordsPerCluster: 8 },
      budget: DEFAULT_TOKEN_BUDGET,
      teacherRights: loadTeacherRights(),
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
  if (command === "--preflight" || command === "--execute") {
    await dispatch(command, argv[1] ?? ""); return;
  }
  throw new Error(
    "usage: runPublicContextDiagnostic.ts --freeze | --preflight <pin> | --execute <pin>",
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Provider errors can embed untrusted response text; never echo them.
  process.stderr.write(`context diagnostic refused: ${error instanceof Error ? error.message : "see retained local diagnostics"}\n`);
  process.exitCode = 1;
});

