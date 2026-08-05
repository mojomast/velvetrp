import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

interface DatabaseHandle {
  backup: (destination: string) => Promise<unknown>;
  close: () => void;
}

const require = createRequire(path.resolve("e2e/support/live-server.ts"));
const Database = require("../../server/node_modules/better-sqlite3") as new (
  filename: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => DatabaseHandle;

export interface LiveServer {
  baseURL: string;
  stop: () => Promise<void>;
}

async function waitForHealth(baseURL: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("live E2E server exited before becoming healthy");
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup can take a few seconds on the first run.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("live E2E server did not become healthy");
}

export async function startLiveServer(): Promise<LiveServer> {
  const sourceDir = process.env.VELVET_E2E_SOURCE_DATA_DIR
    ? path.resolve(process.env.VELVET_E2E_SOURCE_DATA_DIR)
    : path.resolve("server/data");
  const sourcePath = path.join(sourceDir, "velvet.sqlite");
  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-live-"));
  const backupPath = path.join(dataDir, "velvet.sqlite");
  if (existsSync(sourcePath)) {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(backupPath);
    } finally {
      source.close();
    }
  }

  const port = 18790;
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["--prefix", "server", "run", "dev"], {
    cwd: path.resolve("."),
    detached: true,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VELVET_DATA_DIR: dataDir },
    stdio: "ignore",
  });

  try {
    await waitForHealth(baseURL, child);
  } catch (error) {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseURL,
    stop: async () => {
      if (child.pid && child.exitCode === null) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
