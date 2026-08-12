import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-"));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("OPENROUTER_")),
);
const child = spawn("npm", ["--prefix", "server", "exec", "--", "tsx", "e2e/support/deterministic-server.ts"], {
  cwd: new URL("../..", import.meta.url),
  env: {
    ...inheritedEnv,
    PORT: "18787",
    HOST: "127.0.0.1",
    VELVET_DATA_DIR: dataDir,
    FEATURE_RPG_CAMPAIGN: "true",
    FEATURE_RPG_MECHANICS: "true",
    FEATURE_RPG_COMBAT: "true",
    OPENAI_BASE_URL: "http://127.0.0.1:18788/v1",
    OPENAI_MODEL: "velvet-e2e-model",
    OPENAI_API_KEY: "local-e2e-placeholder",
  },
  stdio: "inherit",
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  }, 250);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
child.on("exit", (code) => {
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
