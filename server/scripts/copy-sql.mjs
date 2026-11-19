import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function copySqlAssets(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    copied.push(entry.name);
  }
  return copied.sort();
}

function runCli(argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const serverDir = path.resolve(scriptDir, "..");
  const srcDir = path.resolve(argv[0] ?? path.join(serverDir, "src", "repo", "db"));
  const destDir = path.resolve(argv[1] ?? path.join(serverDir, "dist", "repo", "db"));

  const copied = copySqlAssets(srcDir, destDir);
  if (copied.length === 0) {
    process.stderr.write(`copy-sql: found no .sql files in ${srcDir}; refusing to continue\n`);
    process.exit(1);
  }
  console.log(`copied ${copied.length} sql files`);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`copy-sql: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
