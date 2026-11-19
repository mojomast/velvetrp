import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type EnvFileEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function defaultEnvFileCandidates(env: EnvFileEnvironment, cwd = process.cwd()): string[] {
  const configured = env.VELVET_ENV_FILE;
  if (configured && configured.trim()) return [path.resolve(configured)];
  return [...new Set([path.resolve(cwd, ".env"), path.join(repoRoot, ".env")])];
}

export function loadDotEnv(
  env: Record<string, string | undefined>,
  candidates: readonly string[],
): string | null {
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return null;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}
