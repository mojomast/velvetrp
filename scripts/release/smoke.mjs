#!/usr/bin/env node
// Boots a staged runtime directory against an empty data directory and checks that the one
// process serves the UI and the API: GET / is HTML, a deep link falls back to the UI, an
// unknown API path is 404, and RPG features default on. Exits non-zero on any failure.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60000);

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-release-smoke-"));
const env = {
  ...process.env,
  PORT: String(port),
  HOST: "127.0.0.1",
  VELVET_DATA_DIR: dataDir,
  VELVET_ENV_FILE: path.join(dataDir, "no-such.env"),
};
for (const key of Object.keys(env)) if (key.startsWith("FEATURE_RPG_") || key.endsWith("_API_KEY")) delete env[key];
const child = spawn(process.execPath, [path.join(dir, "server", "dist", "index.js")], {
  cwd: dataDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

const base = `http://127.0.0.1:${port}`;
async function waitForServer() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      await fetch(`${base}/api/rpg/v1/features`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("server did not start in time");
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}

let failed = false;
try {
  await waitForServer();
  const home = await fetch(`${base}/`);
  check(
    home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"),
    `GET / returned ${home.status}`,
  );
  const deep = await fetch(`${base}/campaigns/smoke`);
  check(deep.status === 200, `deep link returned ${deep.status}`);
  const missing = await fetch(`${base}/api/release-smoke-missing`);
  check(missing.status === 404, `unknown API path returned ${missing.status}`);
  const features = await (await fetch(`${base}/api/rpg/v1/features`)).json();
  check(
    features.campaign && features.mechanics && features.combat && features.studio,
    `RPG features not on: ${JSON.stringify(features)}`,
  );
  console.log(`release smoke ok (${dir})`);
} catch (error) {
  failed = true;
  console.error(`release smoke failed: ${error instanceof Error ? error.message : error}\n${output.slice(-8000)}`);
} finally {
  child.kill();
  await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
