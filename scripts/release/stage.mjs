#!/usr/bin/env node
// Builds a self-contained runtime directory from a built checkout, for the Dockerfile and the
// release workflow, so both ship the same layout:
//   package.json, package-lock.json, packages/contracts/{package.json,dist},
//   server/{package.json,dist}, client/{package.json,dist}, LICENSE, NOTICE.md, .env.example,
//   start.sh / start.cmd, and node_modules from `npm ci --omit=dev` run inside the output.
// Installing inside the output (rather than copying node_modules) gives native workspace links on
// every OS and a better-sqlite3 binary built or downloaded for the machine that runs this.
// Run after `npm ci && npm run build` from the repository root.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = ["packages/contracts", "server", "client"];

export function stage(outDir, { from = root, install = true } = {}) {
  const out = path.resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const copy = (relative, required = true) => {
    const source = path.join(from, relative);
    if (!existsSync(source)) {
      if (required) throw new Error(`missing ${relative}; run npm ci and npm run build first`);
      return;
    }
    cpSync(source, path.join(out, relative), { recursive: true });
  };
  for (const file of ["package.json", "package-lock.json"]) copy(file);
  for (const file of ["LICENSE", "NOTICE.md", ".env.example"]) copy(file, false);
  for (const workspace of WORKSPACES) {
    copy(path.join(workspace, "package.json"));
    copy(path.join(workspace, "dist"));
  }
  writeFileSync(path.join(out, "start.sh"), "#!/bin/sh\ncd \"$(dirname \"$0\")\" && exec node server/dist/index.js \"$@\"\n", { mode: 0o755 });
  writeFileSync(path.join(out, "start.cmd"), "@echo off\r\ncd /d \"%~dp0\"\r\nnode server\\dist\\index.js %*\r\n");
  if (install) {
    const result = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: out, stdio: "inherit", shell: process.platform === "win32",
    });
    if (result.status !== 0) throw new Error(`npm ci --omit=dev failed in ${out}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/release/stage.mjs <out-dir>");
    process.exit(2);
  }
  console.log(`staged ${stage(target)}`);
}
