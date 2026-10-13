/** Foundry commands. Planning and corpus verification are provider-free. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planRun, requireTokenizer, runPipeline, type PipelineOptions } from "./generate.js";
import { createTeacherClient, requireTeacherCredentials, requireReviewerCredentials } from "./teacher.js";
import { verifyCorpus } from "./verifyCorpus.js";
import { isTrainingFamily, TRAINING_FAMILIES, type TrainingFamily } from "./spec.js";

const USAGE = `Velvet training-data foundry

Usage: npm run foundry -- <command> [options]

Commands:
  help       Show this message.
  verify     Verify frozen corpus hashes, identity, and lineage.
             Optional: --sealed-source <directory>
  plan       Print a deterministic, provider-free scenario plan.
  generate   Run pipeline preflight; dry run unless --execute is supplied.

Plan/generate options:
  --units <n>          Logical units (default 12; pilot target 150–200).
  --seed <s>           Deterministic seed (default pilot-0).
  --families <a,b>     Restrict to the listed training families.

Generate options:
  --execute           Explicitly permit teacher calls.
  --max-repairs <n>   Repair attempts per unit (default 2).

Examples:
  npm run foundry -- verify
  npm run foundry -- plan --units 175 --seed pilot-1
  npm run foundry -- generate --execute --units 175 --seed pilot-1

Generation currently refuses before credential resolution or teacher calls:
the production tokenizer port is awaiting measured TRL/Transformers evidence.
Use plan to inspect scenarios while that gate is closed.
`;

interface Arguments {
  command: "help" | "verify" | "plan" | "generate";
  execute: boolean;
  units: number;
  seed: string;
  families?: TrainingFamily[];
  maxRepairs: number;
  sealedSource?: string;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Arguments {
  const command = argv[0] ?? "help";
  if (!["help", "verify", "plan", "generate"].includes(command)) {
    throw new UsageError("unknown command; use help for available commands");
  }
  const args: Arguments = {
    command: command as Arguments["command"], execute: false,
    units: 12, seed: "pilot-0", maxRepairs: 2,
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
    const allowed = (planning && ["--units", "--seed", "--families"].includes(flag))
      || (command === "generate" && flag === "--max-repairs")
      || (command === "verify" && flag === "--sealed-source");
    if (!allowed) throw new UsageError("unexpected argument; use help for available options");
    if (!value?.trim() || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    index += 1;
    switch (flag) {
      case "--units":
      case "--max-repairs": {
        const number = Number(value);
        const minimum = flag === "--units" ? 1 : 0;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
          throw new UsageError(`${flag} needs an integer >= ${minimum}`);
        }
        if (flag === "--units") args.units = number;
        else args.maxRepairs = number;
        break;
      }
      case "--seed": args.seed = value; break;
      case "--sealed-source": args.sealedSource = value; break;
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
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  tokenizer?: PipelineOptions["tokenizer"];
  generator?: PipelineOptions["generator"];
  reviewer?: PipelineOptions["reviewer"];
  store?: PipelineOptions["store"];
}

export async function main(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
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
    const plan = planRun({ seed: args.seed, units: args.units, ...(args.families ? { families: args.families } : {}) });
    stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  // This preflight precedes even credential resolution. The shipped CLI has no
  // production tokenizer; an embedding application must supply a measured port.
  if (!dependencies.tokenizer) {
    stderr("REFUSED: no measured tokenizer port is available. Budgets require supervised assistant tokens after masking.\n"
      + "Supply TRL/Transformers-backed measurements before generation. No teacher calls were made.\n");
    return 1;
  }
  const tokenizer = requireTokenizer(dependencies.tokenizer);
  if (args.execute && !dependencies.store) {
    stderr("REFUSED: execution requires a configured run store. No teacher calls were made.\n");
    return 1;
  }
  const generator = dependencies.generator ?? createTeacherClient({ credentials: requireTeacherCredentials() });
  const reviewer = dependencies.reviewer ?? createTeacherClient({ credentials: requireReviewerCredentials(generator.model) });
  const report = await runPipeline({
    runId: `foundry-${args.seed}`, seed: args.seed, units: args.units,
    execute: args.execute, maxRepairs: args.maxRepairs, tokenizer, generator, reviewer,
    ...(args.families ? { families: args.families } : {}),
    ...(dependencies.store ? { store: dependencies.store } : {}),
  });
  stdout(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    // Provider errors may contain untrusted response text; do not echo them.
    process.stderr.write("foundry command failed; inspect local validation diagnostics\n");
    process.exitCode = 1;
  });
}
