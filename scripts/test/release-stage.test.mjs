import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stage } from "../release/stage.mjs";

function fakeCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "velvet-stage-src-"));
  const write = (relative, text = "x") => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  for (const file of ["package.json", "package-lock.json", "NOTICE.md", ".env.example"]) write(file);
  for (const workspace of ["packages/contracts", "server", "client"]) {
    write(`${workspace}/package.json`);
    write(`${workspace}/dist/index.js`);
    write(`${workspace}/src/secret-source.ts`);
  }
  write("server/data/velvet.sqlite");
  write(".env", "OPENROUTER_API_KEY=not-a-real-key");
  return root;
}

test("stage copies only the runtime layout and writes start scripts", () => {
  const from = fakeCheckout();
  const out = path.join(mkdtempSync(path.join(tmpdir(), "velvet-stage-out-")), "velvetrp");
  try {
    stage(out, { from, install: false });
    for (const relative of ["package.json", "package-lock.json", "NOTICE.md", ".env.example", "packages/contracts/dist/index.js",
      "server/dist/index.js", "client/dist/index.js", "server/package.json", "start.sh", "start.cmd"]) {
      assert.ok(existsSync(path.join(out, relative)), relative);
    }
    for (const relative of [".env", "server/data", "server/src", "client/src", "packages/contracts/src"]) {
      assert.ok(!existsSync(path.join(out, relative)), `${relative} must not be staged`);
    }
    assert.match(readFileSync(path.join(out, "start.sh"), "utf8"), /exec node server\/dist\/index\.js/);
    if (process.platform !== "win32") assert.ok(statSync(path.join(out, "start.sh")).mode & 0o100);
    assert.match(readFileSync(path.join(out, "start.cmd"), "utf8"), /node server\\dist\\index\.js/);
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test("stage refuses an unbuilt checkout", () => {
  const from = fakeCheckout();
  rmSync(path.join(from, "server", "dist"), { recursive: true });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "velvet-stage-out-")), "velvetrp");
  try {
    assert.throws(() => stage(out, { from, install: false }), /missing server[\\/]dist/);
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
