#!/usr/bin/env node
/**
 * Harvests reviewed System One shadow decisions into lane-tagged corpus proposals.
 * Read-only: it never mutates the database, and it never writes unless `--out` or
 * `--write-fixture` was requested.
 *
 * Usage:
 *   npx tsx scripts/harvest-system-one-negatives.ts [--lane <lane>] [--limit 1..1000]
 *     [--annotations <path.json>] [--disagreements] [--status confirmed|proposed|all]
 *     [--out <path>] [--write-fixture] [--summary]
 *
 * Env: VELVET_DATA_DIR overrides the resolved data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareDirectorAuthority } from "../server/src/agent/systemOneDisagreement.js";
import type { DirectorDisagreementRow } from "../server/src/agent/systemOneDisagreement.js";
import {
  buildHarvestProposals,
  confirmedHarvestProposals,
  summarizeHarvest,
} from "../server/src/agent/systemOneHarvest.js";
import type {
  HarvestAnnotation,
  HarvestProposal,
  HarvestSummary,
} from "../server/src/agent/systemOneHarvest.js";
import {
  closeRepo,
  listDirectorDecisionsWithAuthority,
  listSystemOneDecisionsByLane,
} from "../server/src/repo/index.js";
import type { SystemOneDecisionRecord } from "../server/src/repo/index.js";
import { resolveDataDir } from "../server/src/repo/db/connection.js";

/** Lanes the harvest loop can produce proposals for; every other lane yields nothing. */
export const HARVEST_LANES = ["director-selection", "adventure-selection", "guardrails"] as const;
export type HarvestLane = (typeof HARVEST_LANES)[number];

/** The `--status` filter values. `all` keeps confirmed and proposed proposals. */
export const HARVEST_STATUS_FILTERS = ["confirmed", "proposed", "all"] as const;
export type HarvestStatusFilter = (typeof HARVEST_STATUS_FILTERS)[number];

export const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1_000;
const SQLITE_FILENAME = "velvet.sqlite";
const FIXTURE_DIRECTORY = path.join("server", "test", "fixtures", "system-one-harvested");
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

export const USAGE =
  "usage: harvest-system-one-negatives.ts [--lane <lane>] [--limit 1..1000]"
  + " [--annotations <path.json>] [--disagreements] [--status confirmed|proposed|all]"
  + " [--out <path>] [--write-fixture] [--summary]\n"
  + "\n"
  + `harvestable lanes: ${HARVEST_LANES.join(", ")} (with --lane omitted, every lane is read)\n`
  + "--disagreements also reads Director authority rows (director-selection only)\n"
  + "--status defaults to all; --write-fixture forces confirmed and writes"
  + ` ${FIXTURE_DIRECTORY.replace(/\\/g, "/")}/<lane>.json (requires --lane)\n`
  + "the proposals JSON goes to --out, or to stdout when neither --out, --write-fixture nor --summary is set\n";

export interface HarvestCliOptions {
  lane: HarvestLane | null;
  limit: number;
  annotations: string | null;
  disagreements: boolean;
  status: HarvestStatusFilter;
  out: string | null;
  writeFixture: boolean;
  summary: boolean;
  /** Set only when `--help`/`-h` was requested; the pure parser never exits. */
  help?: boolean;
}

function isHarvestLane(value: string): value is HarvestLane {
  return (HARVEST_LANES as readonly string[]).includes(value);
}

function isHarvestStatusFilter(value: string): value is HarvestStatusFilter {
  return (HARVEST_STATUS_FILTERS as readonly string[]).includes(value);
}

export function parseHarvestArgs(argv: readonly string[]): HarvestCliOptions {
  let lane: HarvestLane | null = null;
  let limit = DEFAULT_LIMIT;
  let annotations: string | null = null;
  let disagreements = false;
  let status: HarvestStatusFilter = "all";
  let statusProvided = false;
  let out: string | null = null;
  let writeFixture = false;
  let summary = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--lane" || arg.startsWith("--lane=")) {
      const raw = arg === "--lane" ? argv[index += 1] : arg.slice("--lane=".length);
      if (raw === undefined || raw.trim() === "") throw new Error("--lane requires a lane id");
      if (!isHarvestLane(raw)) {
        throw new Error(`unknown lane: ${raw} (harvestable lanes: ${HARVEST_LANES.join(", ")})`);
      }
      lane = raw;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[index += 1] : arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--limit requires a number, received ${raw ?? "nothing"}`);
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(parsed)));
    } else if (arg === "--annotations" || arg.startsWith("--annotations=")) {
      const value = arg === "--annotations" ? argv[index += 1] : arg.slice("--annotations=".length);
      if (!value || value.trim() === "") throw new Error("--annotations requires a path");
      annotations = value;
    } else if (arg === "--disagreements") {
      disagreements = true;
    } else if (arg === "--status" || arg.startsWith("--status=")) {
      const raw = arg === "--status" ? argv[index += 1] : arg.slice("--status=".length);
      if (raw === undefined || !isHarvestStatusFilter(raw)) {
        throw new Error(`--status requires confirmed, proposed, or all, received ${raw ?? "nothing"}`);
      }
      status = raw;
      statusProvided = true;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (!value || value.trim() === "") throw new Error("--out requires a path");
      out = path.resolve(value);
    } else if (arg === "--write-fixture") {
      writeFixture = true;
    } else if (arg === "--summary") {
      summary = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (help) {
    return { lane, limit, annotations, disagreements, status, out, writeFixture, summary, help: true };
  }
  if (writeFixture && lane === null) throw new Error("--write-fixture requires --lane <lane>");
  if (writeFixture && statusProvided && status !== "confirmed") {
    throw new Error(`--write-fixture requires a confirmed-only filter, received --status ${status}`);
  }
  if (writeFixture) status = "confirmed";
  return { lane, limit, annotations, disagreements, status, out, writeFixture, summary };
}

export interface ParsedAnnotations {
  annotations: Record<string, HarvestAnnotation>;
  /** Entries that parsed into a usable annotation. */
  applied: number;
  /** Entries that were ignored because their shape was invalid. */
  skipped: number;
}

/**
 * Reads a JSON file holding review annotations and parses its entries. Missing or malformed
 * files throw (a wrong path should be loud); invalid entries inside a valid document are
 * counted as skipped instead of failing.
 */
export function readAnnotationsFile(filePath: string): ParsedAnnotations {
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
  return parseAnnotationEntries(parsed);
}

/**
 * Parses one annotation entry. Accepts the review CLI shorthand (`"correct"` / `"incorrect"`)
 * and the extended form (`{ verdict, expected?, note? }`). Anything else is ignored (null).
 */
export function harvestAnnotationFromEntry(entry: unknown): HarvestAnnotation | null {
  if (entry === "correct" || entry === "incorrect") return { verdict: entry };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  const verdict = value.verdict;
  if (verdict !== "correct" && verdict !== "incorrect") return null;
  const annotation: HarvestAnnotation = { verdict };
  if (value.expected !== undefined) annotation.expected = value.expected;
  if (typeof value.note === "string") annotation.note = value.note;
  return annotation;
}

/** Pure entry-wise parse of an already-decoded annotations document. */
export function parseAnnotationEntries(document: unknown): ParsedAnnotations {
  const result: ParsedAnnotations = { annotations: {}, applied: 0, skipped: 0 };
  if (document === null || typeof document !== "object" || Array.isArray(document)) return result;
  for (const [decisionId, entry] of Object.entries(document)) {
    const annotation = harvestAnnotationFromEntry(entry);
    if (annotation === null) {
      result.skipped += 1;
      continue;
    }
    result.annotations[decisionId] = annotation;
    result.applied += 1;
  }
  return result;
}

/** Applies the `--status` filter. `all` returns a copy in the harvested order. */
export function filterProposalsByStatus(
  proposals: readonly HarvestProposal[],
  status: HarvestStatusFilter,
): HarvestProposal[] {
  return status === "all" ? [...proposals] : proposals.filter((proposal) => proposal.status === status);
}

export interface HarvestOutputDocument {
  version: 1;
  generatedAt: string;
  lanes: string[];
  proposals: HarvestProposal[];
}

/** The full proposals document: lanes read plus every proposal surviving the status filter. */
export function buildHarvestOutput(input: {
  lanes: readonly string[];
  proposals: readonly HarvestProposal[];
  generatedAt: string;
}): HarvestOutputDocument {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    lanes: [...input.lanes],
    proposals: [...input.proposals],
  };
}

export function serializeHarvestOutput(document: HarvestOutputDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface HarvestFixtureDocument {
  version: 1;
  lane: string;
  generatedAt: string;
  proposals: HarvestProposal[];
}

/**
 * The fixture a lane eval merges as reviewed corpus cases: confirmed proposals only for one
 * lane, sorted by proposalId so the same inputs always serialize in the same order.
 */
export function buildFixtureDocument(
  lane: string,
  proposals: readonly HarvestProposal[],
  generatedAt: string,
): HarvestFixtureDocument {
  const confirmed = confirmedHarvestProposals(proposals, lane)
    .slice()
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  return { version: 1, lane, generatedAt, proposals: confirmed };
}

export function serializeFixture(document: HarvestFixtureDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Absolute path of the harvested fixture for one lane; `repoRoot` is a test seam. */
export function fixtureFilePath(lane: string, repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, FIXTURE_DIRECTORY, `${lane}.json`);
}

export interface HarvestAuthorityStats {
  rowsRead: number;
  disagreements: number;
}

/** Keys compared Director rows by decision id so `buildHarvestProposals` can consume them. */
export function authorityByDecisionId(
  rows: readonly DirectorDisagreementRow[],
): Record<string, Pick<DirectorDisagreementRow, "agreement" | "authoritativeCandidateIds">> {
  const byId: Record<string, Pick<DirectorDisagreementRow, "agreement" | "authoritativeCandidateIds">> = {};
  for (const row of rows) {
    byId[row.decisionId] = { agreement: row.agreement, authoritativeCandidateIds: row.authoritativeCandidateIds };
  }
  return byId;
}

export interface HarvestSummaryReportInput {
  summary: HarvestSummary;
  generatedAt: string;
  source?: string;
  /** Lanes that were read, so a lane with zero proposals still appears in the table. */
  lanes?: readonly string[];
  annotationCounts?: { applied: number; skipped: number } | null;
  annotationsSource?: string | null;
  authority?: HarvestAuthorityStats | null;
  notices?: readonly string[];
}

/** Human-readable `--summary` table: per-lane confirmed/proposed totals plus harvest metadata. */
export function renderHarvestSummary(input: HarvestSummaryReportInput): string {
  const lines: string[] = [];
  lines.push("System One harvest summary");
  lines.push(`Generated ${input.generatedAt}${input.source ? ` from ${input.source}` : ""}`);
  if (input.lanes && input.lanes.length > 0) lines.push(`Lanes read: ${input.lanes.join(", ")}`);
  lines.push("");

  const laneMap = new Map(input.summary.byLane.map((entry) => [entry.lane, entry]));
  for (const lane of input.lanes ?? []) {
    if (!laneMap.has(lane)) laneMap.set(lane, { lane, confirmed: 0, proposed: 0 });
  }
  const entries = [...laneMap.values()].sort((left, right) => left.lane.localeCompare(right.lane));
  const totals = entries.map((entry) => entry.confirmed + entry.proposed);

  const laneWidth = Math.max("Lane".length, "Total".length, ...entries.map((entry) => entry.lane.length));
  const confirmedWidth = Math.max("Confirmed".length, ...entries.map((entry) => String(entry.confirmed).length));
  const proposedWidth = Math.max("Proposed".length, ...entries.map((entry) => String(entry.proposed).length));
  const totalWidth = Math.max("Total".length, ...totals.map((total) => String(total).length));
  const row = (lane: string, confirmed: number, proposed: number, total: number): string =>
    `${lane.padEnd(laneWidth)}  ${String(confirmed).padStart(confirmedWidth)}`
    + `  ${String(proposed).padStart(proposedWidth)}  ${String(total).padStart(totalWidth)}`;
  lines.push(`${"Lane".padEnd(laneWidth)}  ${"Confirmed".padStart(confirmedWidth)}  ${"Proposed".padStart(proposedWidth)}  ${"Total".padStart(totalWidth)}`);
  lines.push(`${"-".repeat(laneWidth)}  ${"-".repeat(confirmedWidth)}  ${"-".repeat(proposedWidth)}  ${"-".repeat(totalWidth)}`);
  for (const entry of entries) {
    lines.push(row(entry.lane, entry.confirmed, entry.proposed, entry.confirmed + entry.proposed));
  }
  lines.push(row("Total", input.summary.confirmed, input.summary.proposed, input.summary.total));
  lines.push("");

  if (input.summary.byProvenance.length > 0) {
    lines.push(`By provenance: ${input.summary.byProvenance.map((entry) => `${entry.provenance} ${entry.count}`).join(", ")}`);
    lines.push("");
  }

  const annotationCounts = input.annotationCounts ?? null;
  lines.push(annotationCounts === null
    ? "Annotations: none"
    : `Annotations: applied ${annotationCounts.applied}, skipped ${annotationCounts.skipped}`
      + (input.annotationsSource ? ` (${input.annotationsSource})` : ""));
  const authority = input.authority ?? null;
  lines.push(authority === null
    ? "Authority: not read"
    : `Authority: read ${authority.rowsRead} Director decision${authority.rowsRead === 1 ? "" : "s"}`
      + ` (${authority.disagreements} disagreement${authority.disagreements === 1 ? "" : "s"})`);

  if (input.notices && input.notices.length > 0) {
    lines.push("");
    lines.push("Notices:");
    for (const notice of input.notices) lines.push(`- ${notice}`);
  }
  lines.push("");
  return lines.join("\n");
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

/** Reads the requested lanes, tolerating an absent decision table as "no decisions". */
function readLaneRecords(lanes: readonly HarvestLane[], limit: number, notices: string[]): SystemOneDecisionRecord[] {
  const records: SystemOneDecisionRecord[] = [];
  for (const lane of lanes) {
    try {
      records.push(...listSystemOneDecisionsByLane(lane, limit));
    } catch (error) {
      if (isMissingTableError(error)) {
        notices.push(`system one decision table is absent; treating the ${lane} lane as having no decisions`);
        continue;
      }
      throw error;
    }
  }
  return records;
}

async function main(): Promise<void> {
  const options = parseHarvestArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const lanes: HarvestLane[] = options.lane === null ? [...HARVEST_LANES] : [options.lane];
  const dataDir = resolveDataDir();
  const databasePath = path.join(dataDir, SQLITE_FILENAME);
  // A reviewed fixture is a committed corpus; never overwrite one from a data directory that
  // holds no decision log at all (a common symptom of a wrong VELVET_DATA_DIR).
  if (options.writeFixture && !existsSync(databasePath)) {
    throw new Error(`refusing to write a fixture: no Velvet database found at ${databasePath}`);
  }
  const notices: string[] = [];
  let records: SystemOneDecisionRecord[] = [];
  let authority: ReturnType<typeof authorityByDecisionId> | undefined;
  let authorityStats: HarvestAuthorityStats | null = null;
  try {
    if (!existsSync(databasePath)) {
      notices.push(`no Velvet database found at ${databasePath}; harvesting zero decisions`);
    } else {
      records = readLaneRecords(lanes, options.limit, notices);
      if (options.disagreements && lanes.includes("director-selection")) {
        const compared = compareDirectorAuthority(listDirectorDecisionsWithAuthority(options.limit));
        authority = authorityByDecisionId(compared);
        authorityStats = {
          rowsRead: compared.length,
          disagreements: compared.filter((row) => row.agreement === "disagree").length,
        };
      } else if (options.disagreements) {
        notices.push("--disagreements only affects director-selection; skipping the authority read");
      }
    }
  } finally {
    closeRepo();
  }

  let parsedAnnotations: ParsedAnnotations = { annotations: {}, applied: 0, skipped: 0 };
  if (options.annotations !== null) parsedAnnotations = readAnnotationsFile(options.annotations);

  const built = buildHarvestProposals({
    records,
    annotations: parsedAnnotations.annotations,
    ...(authority === undefined ? {} : { authority }),
  });
  const proposals = filterProposalsByStatus(built, options.status);
  const generatedAt = new Date().toISOString();
  const renderedOutput = serializeHarvestOutput(buildHarvestOutput({ lanes, proposals, generatedAt }));

  if (options.writeFixture) {
    const lane = lanes[0]!;
    const fixture = buildFixtureDocument(lane, built, generatedAt);
    const filePath = fixtureFilePath(lane);
    // Do not let a valid-but-wrong data directory replace a reviewed corpus with an empty one.
    if (fixture.proposals.length === 0 && existsSync(filePath)) {
      let existing = 0;
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { proposals?: unknown };
        existing = Array.isArray(parsed.proposals) ? parsed.proposals.length : 0;
      } catch {
        existing = 0;
      }
      if (existing > 0) {
        throw new Error(`refusing to replace ${filePath} (${existing} confirmed proposal(s)) with an empty fixture; remove the file deliberately or fix the data directory`);
      }
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, serializeFixture(fixture), "utf8");
    const excluded = built.length - fixture.proposals.length;
    process.stdout.write(
      `wrote ${filePath} (${fixture.proposals.length} confirmed proposals`
      + `${excluded > 0 ? `, ${excluded} not confirmed` : ""})\n`,
    );
  }
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, renderedOutput, "utf8");
    process.stdout.write(`wrote ${options.out}\n`);
  } else if (!options.summary && !options.writeFixture) {
    process.stdout.write(renderedOutput);
  }

  if (options.summary) {
    process.stdout.write(renderHarvestSummary({
      summary: summarizeHarvest(proposals),
      generatedAt,
      source: databasePath,
      lanes,
      annotationCounts: options.annotations === null
        ? null
        : { applied: parsedAnnotations.applied, skipped: parsedAnnotations.skipped },
      annotationsSource: options.annotations,
      authority: authorityStats,
      notices,
    }));
  } else {
    for (const notice of notices) process.stderr.write(`note: ${notice}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
