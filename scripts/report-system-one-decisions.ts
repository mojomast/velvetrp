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
import {
  evaluatePromotionGate,
  isLanePromoted,
  promotionRecord,
} from "../server/src/agent/systemOnePromotion.js";
import type {
  SystemOnePromotionRecord,
  SystemOnePromotionResult,
} from "../server/src/agent/systemOnePromotion.js";
import { closeRepo, listRecentSystemOneDecisions, summarizeSystemOneDecisions } from "../server/src/repo/index.js";
import type { SystemOneDecisionRecord, SystemOneDecisionSummary } from "../server/src/repo/index.js";
import { resolveDataDir } from "../server/src/repo/db/connection.js";
import { SYSTEM_ONE_LANES } from "../server/src/types.js";
import type { SystemOneLane } from "../server/src/types.js";

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

const NONE = "—";
const NOT_RECORDED = "not recorded";

/** One lane's promotion state, flattened so it can be rendered without touching a database. */
export interface LanePromotionStatus {
  lane: SystemOneLane;
  /** Whether the lane may leave shadow mode right now (`isLanePromoted`). */
  promoted: boolean;
  /** The frozen promotion record, or null when the lane has never been promoted. */
  record: SystemOnePromotionRecord | null;
  /** The gate verdict for the record's metrics, or null when there is no record. */
  gate: SystemOnePromotionResult | null;
}

/**
 * Pure promotion lookup for one lane. Reads only the static promotion registry, so it is
 * fully offline and deterministic: no database, no network, no environment.
 */
export function lanePromotionStatus(lane: SystemOneLane): LanePromotionStatus {
  const record = promotionRecord(lane) ?? null;
  return {
    lane,
    promoted: isLanePromoted(lane),
    record,
    gate: record ? evaluatePromotionGate(lane, record.metrics) : null,
  };
}

/** Pure promotion lookup for every lane in `SYSTEM_ONE_LANES`, in canonical order. */
export function allLanePromotionStatuses(): LanePromotionStatus[] {
  return SYSTEM_ONE_LANES.map(lanePromotionStatus);
}

function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : NONE;
}

function formatCalibration(record: SystemOnePromotionRecord): string {
  const calibration = record.calibration;
  if (!calibration) return "none (identity)";
  return `a=${formatRate(calibration.a)}, b=${formatRate(calibration.b)}`;
}

/**
 * Pure rendering of the promotion section. Every lane appears exactly once; a lane with no
 * record reads as unpromoted/not-recorded rather than being omitted.
 */
export function buildPromotionSection(statuses: readonly LanePromotionStatus[]): string {
  const lines: string[] = [];
  lines.push("## Promotion status");
  lines.push("");
  lines.push("| Lane | Promoted | Promoted at | Evidence | Gate |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const status of statuses) {
    lines.push(
      `| ${status.lane} | ${status.promoted ? "yes" : "no"}`
      + ` | ${status.record?.promotedAt ?? NONE}`
      + ` | ${status.record?.evidence ?? NOT_RECORDED}`
      + ` | ${status.record ? (status.gate?.promoted ? "pass" : "fail") : NOT_RECORDED} |`,
    );
  }
  lines.push("");
  for (const status of statuses) {
    lines.push(`### ${status.lane}`);
    lines.push("");
    lines.push(`- Promoted: ${status.promoted ? "yes" : "no"}`);
    if (!status.record) {
      lines.push(`- Promoted at: ${NONE}`);
      lines.push(`- Evidence: ${NOT_RECORDED}`);
      lines.push(`- Metrics: ${NONE}`);
      lines.push(`- Calibration: ${NONE}`);
      lines.push(`- Gate: ${NOT_RECORDED} (unpromoted)`);
    } else {
      const metrics = status.record.metrics;
      lines.push(`- Promoted at: ${status.record.promotedAt}`);
      lines.push(`- Evidence: ${status.record.evidence}`);
      lines.push(
        `- Metrics: samples=${metrics.samples}, accuracy=${formatRate(metrics.accuracy)}`
        + `, brier=${formatRate(metrics.brier)}, ece=${formatRate(metrics.expectedCalibrationError)}`,
      );
      lines.push(`- Calibration: ${formatCalibration(status.record)}`);
      lines.push(`- Gate: ${status.gate?.promoted ? "pass" : "fail"}`);
      for (const reason of status.gate?.reasons ?? []) lines.push(`  - ${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Convenience wrapper: renders the promotion section from the static registry alone. */
export function buildPromotionReport(): string {
  return buildPromotionSection(allLanePromotionStatuses());
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
    const decisionReport = buildSystemOneShadowReport(summary, recent);
    const report = `${decisionReport}\n${buildPromotionReport()}`;
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
