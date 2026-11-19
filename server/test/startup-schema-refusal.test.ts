import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseDriver from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-startup-"));
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

function childEnv(dataDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VELVET_DATA_DIR: dataDir,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
  };
  for (const name of [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENAI_BASE_URL",
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
  ])
    delete env[name];
  return env;
}

function startServer(dataDir: string, port: number) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: childEnv(dataDir, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function healthy(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe("startup schema refusal", () => {
  it("exits non-zero on a mismatched database, leaves it untouched and points at the export command", async () => {
    const dataDir = tempDir();
    const databasePath = path.join(dataDir, "velvet.sqlite");
    const raw = new DatabaseDriver(databasePath);
    raw.exec(
      "CREATE TABLE legacy_campaigns(id TEXT PRIMARY KEY, name TEXT); INSERT INTO legacy_campaigns VALUES('c1','Kept')",
    );
    raw.close();

    const port = await freePort();
    const server = startServer(dataDir, port);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 45_000));
    const code = await Promise.race([server.exited, timeout]);
    if (code === "timeout") server.child.kill("SIGKILL");
    expect(code).not.toBe("timeout");
    expect(code).not.toBe(0);
    const output = server.output();
    expect(output).toMatch(/does not match the current development schema/);
    expect(output).toMatch(/Velvet did not modify it/);
    expect(output).toMatch(/db:export/);
    expect(output).not.toMatch(/Delete the local database/i);

    const after = new DatabaseDriver(databasePath, { readonly: true });
    try {
      const names = (
        after.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(names).toEqual(["legacy_campaigns"]);
      expect(after.prepare("SELECT * FROM legacy_campaigns").all()).toEqual([{ id: "c1", name: "Kept" }]);
    } finally {
      after.close();
    }
  }, 60_000);

  it("still starts and serves health on an empty data directory", async () => {
    const dataDir = tempDir();
    const port = await freePort();
    const server = startServer(dataDir, port);
    try {
      expect(await healthy(port, Date.now() + 45_000), server.output()).toBe(true);
    } finally {
      server.child.kill("SIGTERM");
      await Promise.race([server.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }
  }, 60_000);
});
