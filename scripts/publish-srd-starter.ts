#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildStarterCatalog } from "../server/src/content/srdStarter/index.js";
import { calculateCatalogDigest } from "../server/src/repo/contentCatalog/index.js";

type Mode = "check" | "write";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_FILE = path.join(ROOT, "packages/contracts/src/srd-starter.ts");
const CONTRACTS_INDEX = path.join(ROOT, "packages/contracts/src/index.ts");
const FIXTURE_TEST_FILE = path.join(ROOT, "server/test/reviewed-adventure-fixture.test.ts");
const REVIEWED_FIXTURE_FILE = path.join(ROOT, "server/test/fixtures/reviewedAdventure.ts");
const CLIENT_TEST_FILE = path.join(ROOT, "client/src/api.test.ts");
const HYDRATE_SCRIPT_FILE = path.join(ROOT, "scripts/hydrate-campaign.ts");
const VERSION_REFERENCE_FILES = [CLIENT_TEST_FILE, HYDRATE_SCRIPT_FILE] as const;

const VERSION_LITERAL = /(export const SRD_5_1_STARTER_PACK_VERSION = ")([^"]+)(" as const;)/;
const PINNED_MANIFEST_DIGEST = /(expect\(REVIEWED_ADVENTURE_MANIFEST_DIGEST\)\.toBe\(")([0-9a-f]{64})("\))/;

function literalValue(source: string, name: string): string {
  const match = new RegExp(`export const ${name} = "([^"]+)" as const;`).exec(source);
  if (!match) throw new Error(`cannot locate ${name} literal`);
  return match[1]!;
}

function currentCatalogDigest(): string {
  return calculateCatalogDigest(buildStarterCatalog("1.0.0+000000000000", "0".repeat(64)));
}

function reviewedManifestDigest(version: string, packId: string, rulesProfileId: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "srd-starter-publish-"));
  try {
    const shim = path.join(directory, "contracts-shim.mts");
    const tsconfig = path.join(directory, "tsconfig.json");
    const probe = path.join(directory, "probe.mts");
    writeFileSync(shim, [
      `export * from ${JSON.stringify(pathToFileURL(CONTRACTS_INDEX).href)};`,
      `export const SRD_5_1_STARTER_PACK_VERSION = ${JSON.stringify(version)} as const;`,
      `export const SRD_5_1_STARTER_ID = ${JSON.stringify(`${packId}@${version}`)} as const;`,
      `export const SRD_5_1_STARTER_IDENTITY = Object.freeze({ starterId: SRD_5_1_STARTER_ID, rulesProfileId: ${JSON.stringify(rulesProfileId)}, packId: ${JSON.stringify(packId)}, packVersion: SRD_5_1_STARTER_PACK_VERSION, rulesetId: "dnd-5e", rulesetVersion: "1.0.0" });`,
      "",
    ].join("\n"));
    writeFileSync(tsconfig, `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        baseUrl: ROOT,
        paths: { "@velvet/contracts": [shim] },
        skipLibCheck: true,
      },
    }, null, 2)}\n`);
    writeFileSync(probe, [
      `const fixture = await import(${JSON.stringify(pathToFileURL(REVIEWED_FIXTURE_FILE).href)});`,
      "process.stdout.write(fixture.REVIEWED_ADVENTURE_MANIFEST_DIGEST);",
      "",
    ].join("\n"));
    const output = execFileSync(process.execPath, ["--import", "tsx", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const digest = output.trim();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`unexpected reviewed manifest digest ${JSON.stringify(output)}`);
    return digest;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(mode: Mode): number {
  const catalogDigest = currentCatalogDigest();
  const digestPrefix = catalogDigest.slice(0, 12);
  const contractSource = readFileSync(CONTRACT_FILE, "utf8");
  const versionMatch = VERSION_LITERAL.exec(contractSource);
  if (!versionMatch) throw new Error(`cannot locate SRD_5_1_STARTER_PACK_VERSION in ${path.relative(ROOT, CONTRACT_FILE)}`);
  const oldVersion = versionMatch[2]!;
  const [base, currentSuffix = ""] = oldVersion.split("+");
  const newVersion = `${base}+${digestPrefix}`;
  const inSync = currentSuffix === digestPrefix;

  if (mode === "check") {
    if (inSync) {
      console.log(`SRD 5.1 starter pack in sync: ${oldVersion} (catalog digest ${catalogDigest})`);
      return 0;
    }
    console.error(`SRD 5.1 starter pack out of sync: ${path.relative(ROOT, CONTRACT_FILE)} pins "${oldVersion}" but the canonical digest requires "+${digestPrefix}" (expected ${newVersion})`);
    return 1;
  }

  const packId = literalValue(contractSource, "SRD_5_1_STARTER_PACK_ID");
  const rulesProfileId = literalValue(contractSource, "SRD_5_1_STARTER_RULES_PROFILE_ID");
  const manifestDigest = reviewedManifestDigest(inSync ? oldVersion : newVersion, packId, rulesProfileId);
  const changed: string[] = [];

  if (!inSync) {
    writeFileSync(CONTRACT_FILE, contractSource.replace(VERSION_LITERAL, `$1${newVersion}$3`));
    changed.push(path.relative(ROOT, CONTRACT_FILE));
  }

  const fixtureSource = readFileSync(FIXTURE_TEST_FILE, "utf8");
  const pinned = PINNED_MANIFEST_DIGEST.exec(fixtureSource);
  if (!pinned) throw new Error(`cannot locate pinned manifest digest in ${path.relative(ROOT, FIXTURE_TEST_FILE)}`);
  if (pinned[2] !== manifestDigest) {
    writeFileSync(FIXTURE_TEST_FILE, fixtureSource.replace(PINNED_MANIFEST_DIGEST, `$1${manifestDigest}$3`));
    changed.push(path.relative(ROOT, FIXTURE_TEST_FILE));
  }

  if (!inSync) {
    for (const file of VERSION_REFERENCE_FILES) {
      const source = readFileSync(file, "utf8");
      const updated = source.replaceAll(oldVersion, newVersion);
      if (updated !== source) {
        writeFileSync(file, updated);
        changed.push(path.relative(ROOT, file));
      }
    }
  }

  if (changed.length === 0) {
    console.log(`SRD 5.1 starter pack already in sync: ${oldVersion} (catalog digest ${catalogDigest})`);
    return 0;
  }
  console.log(`SRD 5.1 starter pack ${oldVersion} -> ${newVersion}`);
  console.log(`reviewed manifest digest: ${manifestDigest}`);
  console.log(`files changed:\n  ${changed.join("\n  ")}`);
  return 0;
}

function parseMode(args: readonly string[]): Mode {
  const flags = args.filter((value) => value.startsWith("--"));
  if (args.length !== flags.length || flags.some((flag) => flag !== "--check" && flag !== "--write")) {
    throw new Error("usage: publish-srd-starter [--check|--write]");
  }
  if (flags.includes("--write") && flags.includes("--check")) throw new Error("usage: publish-srd-starter [--check|--write]");
  return flags.includes("--write") ? "write" : "check";
}

function main(): void {
  try {
    process.exitCode = run(parseMode(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
