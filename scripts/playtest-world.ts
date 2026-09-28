#!/usr/bin/env node
/**
 * Materialize the provider-free Hollowford Reach playtest world and (optionally)
 * start a live server against it.
 *
 *   npx tsx scripts/playtest-world.ts --data-dir /tmp/velvet-playtest --port 8790
 *   npx tsx scripts/playtest-world.ts --data-dir /tmp/velvet-playtest --validate-only
 *
 * The world build never calls a model provider. Starting the server is the only
 * step that can talk to a provider, and only when live DM beats run. Set the
 * provider env (for example OPENROUTER_API_KEY / OPENROUTER_MODEL) before serving
 * if you want AI-DM turns; the seed itself is complete without it.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAYTEST_WORLD_DM_MODE,
  buildPlaytestWorld,
  summarizePlaytestWorld,
} from "../server/test/fixtures/playtestWorld.js";
import { PLAYTEST_WORLD_CAMPAIGN_NAME } from "../server/test/fixtures/playtestWorld.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface CliOptions {
  dataDir: string;
  host: string;
  port: number;
  serve: boolean;
  validateOnly: boolean;
}

function usage(): never {
  throw new Error([
    "usage: npx tsx scripts/playtest-world.ts --data-dir DIR [options]",
    "",
    "  --data-dir DIR    Target VELVET_DATA_DIR (required; use an empty directory)",
    "  --host HOST       Server bind host (default 127.0.0.1)",
    "  --port N          Server bind port (default 8787; pick a free port if busy)",
    "  --no-serve        Materialize only; never start a server",
    "  --validate-only   Read back the existing world without writing",
    "",
    "The world fixture is provider-free. Serving uses FEATURE_RPG_* and inherits",
    "provider env (OPENROUTER_*) for live AI DM beats.",
  ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) usage();
    const name = argument.slice(2);
    if (["no-serve", "validate-only"].includes(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage();
    args[name] = value;
  }
  if (typeof args["data-dir"] !== "string") usage();
  const port = args.port === undefined ? 8787 : Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid TCP port");
  return {
    dataDir: resolve(args["data-dir"]),
    host: typeof args.host === "string" ? args.host : "127.0.0.1",
    port,
    serve: args["no-serve"] !== true,
    validateOnly: args["validate-only"] === true,
  };
}

const FEATURE_ENV = {
  FEATURE_RPG_CAMPAIGN: "true",
  FEATURE_RPG_MECHANICS: "true",
  FEATURE_RPG_COMBAT: "true",
  FEATURE_RPG_STUDIO: "true",
} as const;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = options.validateOnly
    ? summarizePlaytestWorld(options.dataDir, await discoverCampaignId(options.dataDir))
    : await buildPlaytestWorld({ dataDir: options.dataDir });

  console.log(JSON.stringify({
    ...result,
    dmMode: PLAYTEST_WORLD_DM_MODE,
    campaign: PLAYTEST_WORLD_CAMPAIGN_NAME,
  }, null, 2));

  if (!options.serve) return;

  console.log(`\nStarting Velvet server for the playtest world:
  VELVET_DATA_DIR=${options.dataDir}
  HOST=${options.host} PORT=${options.port}
  ${Object.entries(FEATURE_ENV).map(([key, value]) => `${key}=${value}`).join(" ")}
  provider env: inherited (OPENROUTER_* or a local key)\n`);

  const child = spawn("npm", ["run", "dev:server"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, VELVET_DATA_DIR: options.dataDir, HOST: options.host, PORT: String(options.port), ...FEATURE_ENV },
  });
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  const code = await new Promise<number>((resolveExit) => child.on("exit", (value) => resolveExit(value ?? 0)));
  process.exitCode = code;
}

/** Reads the sentinel campaign id without writing anything. */
async function discoverCampaignId(dataDir: string): Promise<string> {
  const { default: DatabaseDriver } = await import("better-sqlite3");
  const path = await import("node:path");
  const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT id FROM campaigns WHERE name=?").get(PLAYTEST_WORLD_CAMPAIGN_NAME) as { id: string } | undefined;
    if (!row) throw new Error(`playtest campaign is absent in ${dataDir}; run without --validate-only to build it`);
    return row.id;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
