/** Foundry commands. Planning and corpus verification are provider-free. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOKEN_BUDGET, PipelineRefusal, planRun, requireTokenizer, runPipeline, type PipelineOptions } from "./generate.js";
import { createTeacherClient, requireTeacherCredentials, requireReviewerCredentials } from "./teacher.js";
import { verifyCorpus } from "./verifyCorpus.js";
import { isTrainingFamily, stableStringify, TRAINING_FAMILIES, type TrainingFamily } from "./spec.js";
import { createTokenizerBridge, TokenizerBridgeError } from "./tokenizer.js";
import { loadGenerationPolicy } from "./generationPolicy.js";
import { openRunStore, sourceTreeDigest } from "./runstore.js";
import { UncertainDispatchError } from "./pipelineJournal.js";

const USAGE = `Velvet training-data foundry

Usage: npm run foundry -- <command> [options]

Commands:
  help       Show this message.
  verify     Verify frozen corpus hashes, identity, and lineage.
             Optional: --sealed-source <directory>
  plan       Print a deterministic, provider-free scenario plan.
  tokenizer-check  Reproduce the pinned CPU tokenizer evidence locally.
  generate   Run pipeline preflight; dry run unless --execute is supplied.

Plan/generate options:
  --units <n>          Logical units (default 12; pilot target 150–200).
  --seed <s>           Deterministic seed (default pilot-0).
  --families <a,b>     Restrict to the listed training families.
  --k <n>              Realizations per scenario (default 1).

Generate options:
  --execute           Explicitly permit teacher calls.
  --max-repairs <n>   Repair attempts per unit (default 2).
  --run-id <s>         Stable run identity (default foundry-<seed>).
  --artifact-root <dir> Run storage root (default .dataset).
  --cluster-cap <n>    Selected records per cluster (default 8; twins consume 2).
  --max-supervised-tokens <n> Total measured token cap (default 4000000).

Tokenizer-check/generate options:
  --python <path>     Pinned Python environment (or FOUNDRY_TOKENIZER_PYTHON).
  --assets <dir>      Local tokenizer assets (default .dataset/tokenizer/qwen3-8b).

Examples:
  npm run foundry -- verify
  npm run foundry -- plan --units 175 --seed pilot-1
  npm run foundry -- generate --execute --units 175 --seed pilot-1

Generation requires the configured measured tokenizer runtime. The evidence is
committed; prepare the local CPU environment and assets as described in
dataset/tokenizer/README.md. Use plan for planning without a Python runtime.
`;

interface Arguments {
  command: "help" | "verify" | "plan" | "generate" | "tokenizer-check";
  execute: boolean;
  units: number;
  seed: string;
  families?: TrainingFamily[];
  maxRepairs: number;
  sealedSource?: string;
  python?: string;
  assets?: string;
  k: number;
  runId?: string;
  artifactRoot?: string;
  clusterCap: number;
  maxSupervisedTokens: number;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Arguments {
  const command = argv[0] ?? "help";
  if (!["help", "verify", "plan", "generate", "tokenizer-check"].includes(command)) {
    throw new UsageError("unknown command; use help for available commands");
  }
  const args: Arguments = {
    command: command as Arguments["command"], execute: false,
    units: 12, seed: "pilot-0", maxRepairs: 2, k: 1, clusterCap: 8, maxSupervisedTokens: 4_000_000,
  };
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new UsageError(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === "--execute") {
      if (command !== "generate") throw new UsageError("--execute belongs to generate");
      args.execute = true;
      continue;
    }
    const value = argv[index + 1];
    const planning = command === "plan" || command === "generate";
    const allowed = (planning && ["--units", "--seed", "--families", "--k"].includes(flag))
      || (command === "generate" && ["--max-repairs", "--run-id", "--artifact-root", "--cluster-cap", "--max-supervised-tokens"].includes(flag))
      || (["generate", "tokenizer-check"].includes(command) && ["--python", "--assets"].includes(flag))
      || (command === "verify" && flag === "--sealed-source");
    if (!allowed) throw new UsageError("unexpected argument; use help for available options");
    if (!value?.trim() || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    index += 1;
    switch (flag) {
      case "--units":
      case "--max-repairs":
      case "--k":
      case "--cluster-cap":
      case "--max-supervised-tokens": {
        const number = Number(value);
        const minimum = ["--max-repairs", "--max-supervised-tokens"].includes(flag) ? 0 : 1;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
          throw new UsageError(`${flag} needs an integer >= ${minimum}`);
        }
        if (flag === "--units") args.units = number;
        else if (flag === "--max-repairs") args.maxRepairs = number;
        else if (flag === "--k") args.k = number;
        else if (flag === "--cluster-cap") args.clusterCap = number;
        else args.maxSupervisedTokens = number;
        break;
      }
      case "--seed": args.seed = value; break;
      case "--sealed-source": args.sealedSource = value; break;
      case "--python": args.python = value; break;
      case "--assets": args.assets = value; break;
      case "--run-id": args.runId = value; break;
      case "--artifact-root": args.artifactRoot = value; break;
      case "--families": {
        const requested = value.split(",").map((family) => family.trim());
        if (!requested.every(isTrainingFamily)) {
          throw new UsageError(`--families must contain only: ${TRAINING_FAMILIES.join(", ")}`);
        }
        args.families = [...new Set(requested.filter(isTrainingFamily))];
        break;
      }
    }
  }
  return args;
}

/** Ports can be supplied by an embedding application. No test tokenizer ships in the CLI. */
export interface CliDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  tokenizer?: PipelineOptions["tokenizer"];
  generator?: PipelineOptions["generator"];
  reviewer?: PipelineOptions["reviewer"];
  store?: PipelineOptions["store"];
}

export async function main(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });
  let args: Arguments;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`usage error: ${error instanceof UsageError ? error.message : "invalid arguments"}\n`);
    return 2;
  }
  if (args.command === "help") {
    stdout(USAGE);
    return 0;
  }
  if (args.command === "verify") {
    const report = verifyCorpus(args.sealedSource ? { sealedSource: args.sealedSource } : {});
    for (const problem of report.problems) stderr(`${problem.check}: ${problem.detail}\n`);
    stdout(`corpus: ${report.ok ? "verified" : "FAILED"} (${report.devCaseCount} dev cases)\n`);
    return report.ok ? 0 : 1;
  }
  if (args.command === "plan") {
    const plan = planRun({ seed: args.seed, units: args.units, realizationsPerScenario: args.k, ...(args.families ? { families: args.families } : {}) });
    stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  const python = args.python ?? env.FOUNDRY_TOKENIZER_PYTHON;
  let configured = dependencies.tokenizer;
  if (!configured && python) {
    try {
      configured = createTokenizerBridge({ python, assetsDir: args.assets ?? env.FOUNDRY_TOKENIZER_ASSETS ?? ".dataset/tokenizer/qwen3-8b" });
    } catch (error) {
      stderr(`REFUSED: ${error instanceof TokenizerBridgeError ? error.message : "measured tokenizer evidence or local assets are unavailable"}. No teacher calls were made.\n`);
      return 1;
    }
  }
  if (!configured) {
    stderr("REFUSED: no measured tokenizer runtime is configured. Budgets require supervised assistant tokens after masking.\n"
      + "Set --python or FOUNDRY_TOKENIZER_PYTHON using dataset/tokenizer/README.md. No teacher calls were made.\n");
    return 1;
  }
  const tokenizer = requireTokenizer(configured);
  if (args.command === "tokenizer-check") {
    stdout(`tokenizer: verified (${tokenizer.name})\n`);
    return 0;
  }
  const generator = dependencies.generator ?? createTeacherClient({ credentials: requireTeacherCredentials({ env }) });
  const reviewer = dependencies.reviewer ?? createTeacherClient({ credentials: requireReviewerCredentials(generator.model, { env }) });
  const policy = loadGenerationPolicy();
  const plan = planRun({ seed: args.seed, units: args.units, realizationsPerScenario: args.k, generationPolicy: policy,
    ...(args.families ? { families: args.families } : {}) });
  const runId = args.runId ?? `foundry-${args.seed}`;
  const store = args.execute ? dependencies.store ?? openRunStore({ runId, seed: args.seed,
    sourceDigest: sourceTreeDigest(fileURLToPath(new URL("..", import.meta.url)), { skip: ["__pycache__"] }),
    splitAssignmentDigest: plan.splitAssignmentDigest, corpusFreezeDigest: policy.corpusDigest, totalUnits: plan.units.length,
    generator: { provider: generator.identity.provider, model: generator.model, baseUrlDigest: generator.baseUrlDigest, temperature: 0.7 },
    ...(args.artifactRoot ? { artifactRoot: args.artifactRoot } : {}), durability: "fsync" }) : undefined;
  try {
    const report = await runPipeline({
      runId, seed: args.seed, units: args.units, realizationsPerScenario: args.k,
      execute: args.execute, maxRepairs: args.maxRepairs, tokenizer, generator, reviewer,
      generationPolicy: policy, selectionPolicy: { maxRecordsPerCluster: args.clusterCap },
      budget: { ...DEFAULT_TOKEN_BUDGET, maxSupervisedAssistantTokens: args.maxSupervisedTokens },
      ...(args.families ? { families: args.families } : {}),
      ...(store ? { store } : {}),
    });
    stdout(`${stableStringify(report, 2)}\n`);
    return 0;
  } finally {
    if (store && !dependencies.store) store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    // Provider errors may contain untrusted response text; do not echo them.
    process.stderr.write(error instanceof PipelineRefusal || error instanceof UncertainDispatchError
      ? `REFUSED: ${error.message}\n` : "foundry command failed; inspect local validation diagnostics\n");
    process.exitCode = 1;
  });
}
