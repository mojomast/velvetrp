#!/usr/bin/env node
/**
 * Prints or writes a human-readable System One shadow decision report from the
 * recorded decision log. Read-only: it never mutates the database.
 *
 * Usage:
 *   npx tsx scripts/report-system-one-decisions.ts [--limit <n>] [--out <path>]
 *
 * Env: VELVET_DATA_DIR overrides the resolved data directory.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemOneShadowReport } from "../server/src/agent/systemOneReport.js";
import { closeRepo, listRecentSystemOneDecisions, summarizeSystemOneDecisions } from "../server/src/repo/index.js";
import type { SystemOneDecisionRecord, SystemOneDecisionSummary } from "../server/src/repo/index.js";
import { resolveDataDir } from "../server/src/repo/db/connection.js";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const SQLITE_FILENAME = "velvet.sqlite";

export interface ReportCliOptions {
  limit: number;
  out: string | null;
}

export function parseReportArgs(argv: readonly string[]): ReportCliOptions {
  let limit = DEFAULT_LIMIT;
  let out: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[index += 1] : arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--limit requires a number, received ${raw ?? "nothing"}`);
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(parsed)));
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (!value || value.trim() === "") throw new Error("--out requires a path");
      out = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: report-system-one-decisions.ts [--limit 1..200] [--out <path>]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { limit, out };
}

function readDecisions(limit: number, databasePath: string): { summary: SystemOneDecisionSummary; recent: SystemOneDecisionRecord[] } {
  try {
    return {
      summary: summarizeSystemOneDecisions(limit),
      recent: listRecentSystemOneDecisions(limit),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      throw new Error(`system one decision table is absent from ${databasePath}: ${message}`);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseReportArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  const databasePath = path.join(dataDir, SQLITE_FILENAME);
  if (!existsSync(databasePath)) {
    throw new Error(`no Velvet database found at ${databasePath}; set VELVET_DATA_DIR or run the server once to create it`);
  }
  try {
    const { summary, recent } = readDecisions(options.limit, databasePath);
    const report = buildSystemOneShadowReport(summary, recent);
    const rendered = report.endsWith("\n") ? report : `${report}\n`;
    if (options.out) {
      mkdirSync(path.dirname(options.out), { recursive: true });
      writeFileSync(options.out, rendered, "utf8");
      process.stdout.write(`wrote ${options.out}\n`);
    } else {
      process.stdout.write(rendered);
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
