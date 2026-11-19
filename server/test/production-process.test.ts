import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe("one production process", () => {
  it("loads its own .env file, turns the RPG flags on by default and serves the built client", async () => {
    const dataDir = tempDir("velvet-prod-data-");
    const dist = tempDir("velvet-prod-dist-");
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><body>velvet-prod-index</body></html>");
    const port = await freePort();
    const envFile = path.join(tempDir("velvet-prod-env-"), "velvet.env");
    writeFileSync(
      envFile,
      `PORT=${port}\nHOST=127.0.0.1\nVELVET_DATA_DIR=${dataDir}\nVELVET_CLIENT_DIST=${dist}\nFEATURE_RPG_STUDIO=false\n`,
    );

    const env: NodeJS.ProcessEnv = { ...process.env, VELVET_ENV_FILE: envFile, NODE_ENV: "production" };
    for (const name of [
      "PORT",
      "HOST",
      "VELVET_DATA_DIR",
      "VELVET_CLIENT_DIST",
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_BASE_URL",
      "OPENAI_BASE_URL",
      "FEATURE_RPG_CAMPAIGN",
      "FEATURE_RPG_MECHANICS",
      "FEATURE_RPG_COMBAT",
      "FEATURE_RPG_STUDIO",
      "VITEST",
      "VITEST_POOL_ID",
      "VITEST_WORKER_ID",
    ])
      delete env[name];
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      expect(await waitForHealth(port, Date.now() + 45_000), output).toBe(true);
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("velvet-prod-index");
      const deepLink = await fetch(`http://127.0.0.1:${port}/campaigns/abc`);
      expect(await deepLink.text()).toContain("velvet-prod-index");
      const flags = await (await fetch(`http://127.0.0.1:${port}/api/rpg/v1/features`)).json();
      expect(flags).toMatchObject({ campaign: true, mechanics: true, combat: true, studio: false, systemOne: false });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve(null);
        });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 60_000);
});
