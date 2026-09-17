#!/usr/bin/env node
/**
 * Renders a read-only System One decision review sheet from the recorded decision
 * log, optionally applying human verdict annotations. Read-only: it never mutates
 * the database.
 *
 * Usage:
 *   npx tsx scripts/review-system-one-decisions.ts [--lane <lane-id>] [--limit 1..200]
 *     [--max-signal 0..1] [--include-flagged] [--annotations <path.json>] [--out <path>]
 *
 * Env: VELVET_DATA_DIR overrides the resolved data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyReviewAnnotations,
  renderReviewSheet,
  reviewCandidates,
} from "../server/src/agent/systemOneReview.js";
import type { ReviewQueueOptions, ReviewVerdict } from "../server/src/agent/systemOneReview.js";
import {
  closeRepo,
  listRecentSystemOneDecisions,
  listSystemOneDecisionsByLane,
} from "../server/src/repo/index.js";
import { resolveDataDir } from "../server/src/repo/db/connection.js";
import { SYSTEM_ONE_LANES } from "../server/src/types.js";
import type { SystemOneLane } from "../server/src/types.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const SQLITE_FILENAME = "velvet.sqlite";

export interface ReviewCliOptions {
  lane: string | null;
  limit: number;
  maxSignal: number | null;
  includeFlaggedFallbacks: boolean;
  annotations: string | null;
  out: string | null;
}

function isSystemOneLane(value: string): value is SystemOneLane {
  return (SYSTEM_ONE_LANES as readonly string[]).includes(value);
}

export function parseReviewArgs(argv: readonly string[]): ReviewCliOptions {
  let lane: string | null = null;
  let limit = DEFAULT_LIMIT;
  let maxSignal: number | null = null;
  let includeFlaggedFallbacks = false;
  let annotations: string | null = null;
  let out: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--lane" || arg.startsWith("--lane=")) {
      const raw = arg === "--lane" ? argv[index += 1] : arg.slice("--lane=".length);
      if (raw === undefined || !isSystemOneLane(raw)) throw new Error(`unknown lane: ${raw}`);
      lane = raw;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[index += 1] : arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--limit requires a number, received ${raw ?? "nothing"}`);
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(parsed)));
    } else if (arg === "--max-signal" || arg.startsWith("--max-signal=")) {
      const raw = arg === "--max-signal" ? argv[index += 1] : arg.slice("--max-signal=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`--max-signal requires a number in [0,1], received ${raw ?? "nothing"}`);
      }
      maxSignal = parsed;
    } else if (arg === "--include-flagged") {
      includeFlaggedFallbacks = true;
    } else if (arg === "--annotations" || arg.startsWith("--annotations=")) {
      const value = arg === "--annotations" ? argv[index += 1] : arg.slice("--annotations=".length);
      if (!value || value.trim() === "") throw new Error("--annotations requires a path");
      annotations = value;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (!value || value.trim() === "") throw new Error("--out requires a path");
      out = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: review-system-one-decisions.ts [--lane <lane-id>] [--limit 1..200]"
        + " [--max-signal 0..1] [--include-flagged] [--annotations <path.json>] [--out <path>]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { lane, limit, maxSignal, includeFlaggedFallbacks, annotations, out };
}

function readAnnotations(filePath: string): Record<string, ReviewVerdict> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read annotations file ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse annotations file ${filePath}: ${message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`annotations file ${filePath} must contain a JSON object`);
  }
  const annotations: Record<string, ReviewVerdict> = {};
  for (const [decisionId, value] of Object.entries(parsed)) {
    if (value === "correct" || value === "incorrect") annotations[decisionId] = value;
  }
  return annotations;
}

async function main(): Promise<void> {
  const options = parseReviewArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  const databasePath = path.join(dataDir, SQLITE_FILENAME);
  if (!existsSync(databasePath)) {
    throw new Error(`no Velvet database found at ${databasePath}; set VELVET_DATA_DIR or run the server once to create it`);
  }
  try {
    const queryLimit = Math.min(1_000, Math.max(options.limit * 5, 50));
    const records = options.lane !== null
      ? listSystemOneDecisionsByLane(options.lane, queryLimit)
      : listRecentSystemOneDecisions(queryLimit);

    const reviewOptions: ReviewQueueOptions = {
      limit: options.limit,
      includeFlaggedFallbacks: options.includeFlaggedFallbacks,
    };
    if (options.lane !== null) reviewOptions.lane = options.lane;
    if (options.maxSignal !== null) reviewOptions.maxSignal = options.maxSignal;

    const candidates = reviewCandidates(records, reviewOptions);
    const annotations = options.annotations === null ? {} : readAnnotations(options.annotations);
    const annotated = applyReviewAnnotations(candidates, annotations);
    const rendered = renderReviewSheet(annotated, {
      generatedAt: new Date().toISOString(),
      source: databasePath,
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
