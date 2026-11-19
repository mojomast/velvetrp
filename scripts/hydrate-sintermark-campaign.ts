#!/usr/bin/env node
/**
 * Provider-free CLI for the original "Sintermark" SRD 5.1 campaign.
 *
 * The reviewed world and builder live in the server (`server/src/quickstart`).
 * This wrapper keeps the dedicated-directory workflow: it targets an empty or
 * sentinel store, refuses unrelated storage, writes `sintermark-report.json`,
 * and validates an existing store read-only.
 *
 * Usage:
 *   npx tsx scripts/hydrate-sintermark-campaign.ts [--data-dir DIR] [--validate-only]
 *
 * The default target is `.velvet/sintermark-game`.
 *
 * Programmatic entry points for focused tests:
 *   hydrateSintermarkCampaign(dataDir): Promise<SintermarkSummary>
 *   validateSintermarkCampaign(dataDir): Promise<SintermarkSummary>
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SRD_5_1_STARTER_RULES_PROFILE_ID } from "@velvet/contracts";
import { closeRepo, createRepository } from "../server/src/repo/index.js";
import {
  assertSintermarkSummary,
  createSintermarkWorld,
  prepareSintermarkRecipe,
  readSintermarkActiveSessionId,
  readSintermarkRecipe,
  summarizeSintermarkCampaign,
  type ShopLike,
  type SintermarkRecipe,
  type SintermarkSummary,
} from "../server/src/quickstart/sintermarkBuilder.js";

export type {
  SintermarkCounts,
  SintermarkHeroSummary,
  SintermarkSummary,
} from "../server/src/quickstart/sintermarkBuilder.js";

const OWNER = "local-owner";
const SEED_KEY = "sintermark-v1";
const DATABASE_FILE = "velvet.sqlite";
const REPORT_FILE = "sintermark-report.json";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DATA_DIR = resolve(PROJECT_ROOT, ".velvet", "sintermark-game");

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIntegrity(dataDir: string): { quickCheck: string; foreignKeyFindings: number } {
  const db = new Database(join(dataDir, DATABASE_FILE), { readonly: true, fileMustExist: true });
  try {
    return {
      quickCheck: (db.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check ?? "unknown",
      foreignKeyFindings: (db.pragma("foreign_key_check") as unknown[]).length,
    };
  } finally {
    db.close();
  }
}

function detectTargetState(dataDir: string, campaignName: string): "absent" | "empty" | "sentinel" | "foreign" {
  const databasePath = join(dataDir, DATABASE_FILE);
  if (!existsSync(databasePath)) return "absent";
  if (statSync(databasePath).size === 0) return "empty";
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasCampaigns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
    if (!hasCampaigns) return "empty";
    const names = (db.prepare("SELECT name FROM campaigns ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (names.length === 0) return "empty";
    if (names.length === 1 && names[0] === campaignName) return "sentinel";
    return "foreign";
  } finally {
    db.close();
  }
}

export async function hydrateSintermarkCampaign(dataDirInput: string): Promise<SintermarkSummary> {
  const dataDir = resolve(dataDirInput);
  const recipe = readSintermarkRecipe();
  const state = detectTargetState(dataDir, recipe.name);
  if (state === "foreign")
    fail(`target ${dataDir} already contains a different campaign; refusing to repair existing storage`);
  if (state === "sentinel") return validateInternal(dataDir, recipe, "existing");

  mkdirSync(dataDir, { recursive: true });
  process.env.VELVET_DATA_DIR = dataDir;
  closeRepo();
  const repository = createRepository({ dataDir });
  try {
    const result = await createSintermarkWorld({ repository, ownerId: OWNER, keyPrefix: SEED_KEY, recipe });
    const summary = summarizeSintermarkCampaign(
      repository,
      OWNER,
      dataDir,
      result.recipe,
      result.campaignId,
      result.sessionId,
      result.appliedArtifactKeys,
      result.encounterIds,
      result.warnings,
      "created",
    );
    assertSintermarkSummary(summary);
    writeReport(summary, result.recipe, result.appliedArtifactKeys, result.encounterIds, result.shops);
    return summary;
  } finally {
    repository.close();
    closeRepo();
  }
}

interface StoredReport {
  campaignId?: string;
  sessionId?: string;
  appliedArtifactKeys?: string[];
  encounterIds?: string[];
  shopIds?: string[];
}

function readStoredReport(dataDir: string): StoredReport | null {
  const path = join(dataDir, REPORT_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as StoredReport) : null;
  } catch {
    return null;
  }
}

export async function validateSintermarkCampaign(dataDirInput: string): Promise<SintermarkSummary> {
  const dataDir = resolve(dataDirInput);
  const recipe = readSintermarkRecipe();
  return validateInternal(dataDir, recipe, "validated");
}

async function validateInternal(
  dataDir: string,
  recipe: SintermarkRecipe,
  status: "existing" | "validated",
): Promise<SintermarkSummary> {
  const state = detectTargetState(dataDir, recipe.name);
  if (state === "absent" || state === "empty") fail(`no Sintermark campaign is present in ${dataDir}`);
  if (state === "foreign") fail(`target ${dataDir} does not contain the Sintermark sentinel campaign`);

  const prepared = prepareSintermarkRecipe(recipe);
  const report = readStoredReport(dataDir);

  process.env.VELVET_DATA_DIR = dataDir;
  closeRepo();
  const repository = createRepository({ dataDir });
  try {
    const campaign = repository.listCampaigns(OWNER).find((candidate) => candidate.name === recipe.name);
    if (!campaign) fail(`Sintermark campaign is not present in ${dataDir}`);
    const sessionId = report?.sessionId ?? readSintermarkActiveSessionId(repository, OWNER, campaign.id);
    if (!sessionId) fail("Sintermark campaign has no attached room");
    const appliedArtifactKeys = report?.appliedArtifactKeys ?? collectWaveKeys(prepared.content);
    const encounterIds = report?.encounterIds ?? [];

    const summary = summarizeSintermarkCampaign(
      repository,
      OWNER,
      dataDir,
      prepared.recipe,
      campaign.id,
      sessionId,
      appliedArtifactKeys,
      encounterIds,
      prepared.warnings,
      status,
    );
    const integrity = readIntegrity(dataDir);
    if (integrity.quickCheck !== "ok") fail(`Sintermark integrity quick_check failed: ${integrity.quickCheck}`);
    if (integrity.foreignKeyFindings !== 0)
      fail(`Sintermark has ${integrity.foreignKeyFindings} foreign-key finding(s)`);
    const configuration = repository.getCampaignContentConfiguration(OWNER, campaign.id);
    if (configuration?.rulesProfileId !== SRD_5_1_STARTER_RULES_PROFILE_ID)
      fail("Sintermark campaign is not configured with the SRD 5.1 starter rules profile");
    const administration = repository.getCampaignAdministration(OWNER, campaign.id);
    if (administration?.status !== "published") fail("Sintermark campaign is not published");
    const readiness = repository.getCampaignRoomActivationReadiness(OWNER, campaign.id, sessionId);
    if (!readiness.active) fail("Sintermark room is not active");
    assertSintermarkSummary(summary);
    return summary;
  } finally {
    repository.close();
    closeRepo();
  }
}

function collectWaveKeys(content: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const items of Object.values(content)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isRecord(item) || typeof item.key !== "string" || seen.has(item.key)) continue;
      seen.add(item.key);
      keys.push(item.key);
    }
  }
  return keys;
}

function writeReport(
  summary: SintermarkSummary,
  recipe: SintermarkRecipe,
  appliedArtifactKeys: string[],
  encounterIds: string[],
  shops: ShopLike[],
): void {
  const report = {
    version: recipe.version,
    seed: SEED_KEY,
    createdAt: new Date().toISOString(),
    campaignId: summary.campaignId,
    sessionId: summary.sessionId,
    campaignName: summary.campaignName,
    heroNames: summary.heroes.map((hero) => hero.name),
    heroes: summary.heroes,
    appliedArtifactKeys,
    encounterIds,
    shopIds: shops.map((shop) => shop.shopId),
    counts: summary.counts,
    publicGraph: summary.publicGraph,
    integrity: readIntegrity(summary.dataDir),
    warnings: summary.warnings,
  };
  writeFileSync(join(summary.dataDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

interface CliOptions {
  dataDir: string;
  validateOnly: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dataDir = DEFAULT_DATA_DIR;
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--validate-only") {
      validateOnly = true;
      continue;
    }
    if (argument === "--data-dir") {
      const value = argv[++index];
      if (!value) fail("--data-dir requires a path");
      dataDir = resolve(value);
      continue;
    }
    if (argument.startsWith("--data-dir=")) {
      const value = argument.slice("--data-dir=".length);
      if (!value) fail("--data-dir requires a path");
      dataDir = resolve(value);
      continue;
    }
    fail(`unknown argument: ${argument}`);
  }
  return { dataDir, validateOnly };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = options.validateOnly
    ? await validateSintermarkCampaign(options.dataDir)
    : await hydrateSintermarkCampaign(options.dataDir);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
