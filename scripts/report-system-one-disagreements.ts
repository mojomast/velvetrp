#!/usr/bin/env node
/**
 * Prints or writes a human-readable report of where the Director lane's would-be
 * selections diverged from the authoritative provider composition. Read-only: it
 * never mutates the database.
 *
 * Usage:
 *   npx tsx scripts/report-system-one-disagreements.ts [--limit <n>] [--all] [--out <path>]
 *
 * Env: VELVET_DATA_DIR overrides the resolved data directory.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareDirectorAuthority,
  renderDirectorDisagreementReport,
} from "../server/src/agent/systemOneDisagreement.js";
import { closeRepo, listDirectorDecisionsWithAuthority } from "../server/src/repo/index.js";
import { resolveDataDir } from "../server/src/repo/db/connection.js";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const SQLITE_FILENAME = "velvet.sqlite";

const USAGE =
  "usage: report-system-one-disagreements.ts [--limit 1..200] [--all] [--out <path>]\n";

export interface DisagreementCliOptions {
  limit: number;
  includeAgreements: boolean;
  out: string | null;
  /** Set only when `--help`/`-h` was requested; the pure parser never exits. */
  help?: boolean;
}

export function parseDisagreementArgs(argv: readonly string[]): DisagreementCliOptions {
  let limit = DEFAULT_LIMIT;
  let includeAgreements = false;
  let out: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[index += 1] : arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--limit requires a number, received ${raw ?? "nothing"}`);
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(parsed)));
    } else if (arg === "--all") {
      includeAgreements = true;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (!value || value.trim() === "") throw new Error("--out requires a path");
      out = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      return { limit, includeAgreements, out, help: true };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { limit, includeAgreements, out };
}

async function main(): Promise<void> {
  const options = parseDisagreementArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const dataDir = resolveDataDir();
  const databasePath = path.join(dataDir, SQLITE_FILENAME);
  if (!existsSync(databasePath)) {
    throw new Error(`no Velvet database found at ${databasePath}; set VELVET_DATA_DIR or run the server once to create it`);
  }
  try {
    const rows = listDirectorDecisionsWithAuthority(options.limit);
    const compared = compareDirectorAuthority(rows);
    const rendered = renderDirectorDisagreementReport(compared, {
      generatedAt: new Date().toISOString(),
      source: path.join(dataDir, SQLITE_FILENAME),
      includeAgreements: options.includeAgreements,
    });
    const output = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
    if (options.out) {
      mkdirSync(path.dirname(options.out), { recursive: true });
      writeFileSync(options.out, output, "utf8");
      process.stdout.write(`wrote ${options.out}\n`);
    } else {
      process.stdout.write(output);
    }
  } finally {
    closeRepo();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
