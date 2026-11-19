#!/usr/bin/env node
// Builds a self-contained runtime directory from a built checkout, for the Dockerfile and the
// release workflow, so both ship the same layout:
//   package.json, package-lock.json, packages/contracts/{package.json,dist},
//   server/{package.json,dist}, client/{package.json,dist}, LICENSE, NOTICE.md, .env.example,
//   start.sh / start.cmd, and node_modules from `npm ci --omit=dev` run inside the output.
// Installing inside the output (rather than copying node_modules) gives a better-sqlite3 binary built
// or provided for the machine that runs this. npm's workspace links (symlinks, or absolute junctions on
// Windows) are then replaced: the runtime needs only @velvet/contracts, copied in as a real directory,
// so the output can be moved, zipped and unzipped anywhere.
// Run after `npm ci && npm run build` from the repository root.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
    materializeWorkspaceLinks(out);
  }
  return out;
}

/** Replaces workspace links in `<out>/node_modules` with a copy of the contracts package; drops the rest. */
export function materializeWorkspaceLinks(out) {
  const modules = path.join(out, "node_modules");
  const isLink = (target) => lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  // A Windows junction is removed with rmdir; a POSIX symlink with unlink. Neither touches the target.
  const removeLink = (target) => { try { unlinkSync(target); } catch { rmdirSync(target); } };
  for (const name of ["velvet-mvp-server", "velvet-mvp-client"]) {
    const link = path.join(modules, name);
    if (isLink(link)) removeLink(link);
  }
  const contracts = path.join(modules, "@velvet", "contracts");
  if (isLink(contracts)) {
    removeLink(contracts);
    for (const entry of ["package.json", "dist", "node_modules"]) {
      const source = path.join(out, "packages", "contracts", entry);
      if (existsSync(source)) cpSync(source, path.join(contracts, entry), { recursive: true });
    }
  }
  const remaining = readdirSync(modules, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink() && !entry.parentPath.includes(`${path.sep}.bin`));
  if (remaining.length) throw new Error(`unexpected links in staged node_modules: ${remaining.map((e) => path.join(e.parentPath, e.name)).join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/release/stage.mjs <out-dir>");
    process.exit(2);
  }
  console.log(`staged ${stage(target)}`);
}
