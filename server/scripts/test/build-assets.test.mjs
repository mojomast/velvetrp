// Approved test for Phase 0.3: the build copies every SQL file structurally, and smoke:dist proves dist/ starts.
// Run from server/ with: node --test scripts/test/build-assets.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPY = path.join(SERVER, "scripts", "copy-sql.mjs");
const SMOKE = path.join(SERVER, "scripts", "smoke-dist.mjs");

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("CopySqlAssets", () => {
  it("test_copies_every_sql_file_including_a_new_one_without_a_list", async () => {
    const src = tmp("copy-sql-src-");
    const dest = path.join(tmp("copy-sql-dest-"), "nested", "db");
    try {
      writeFileSync(path.join(src, "currentSchema.sql"), "CREATE TABLE a(x);");
      writeFileSync(path.join(src, "brandNewDummySchema.sql"), "CREATE TABLE dummy(x);");
      writeFileSync(path.join(src, "notes.txt"), "not sql");
      writeFileSync(path.join(src, "schema.ts"), "export {};");
      const { copySqlAssets } = await import(pathToFileURL(COPY).href);
      const copied = copySqlAssets(src, dest);
      assert.deepEqual([...copied].sort(), ["brandNewDummySchema.sql", "currentSchema.sql"]);
      assert.deepEqual(readdirSync(dest).sort(), ["brandNewDummySchema.sql", "currentSchema.sql"]);
      assert.equal(readFileSync(path.join(dest, "brandNewDummySchema.sql"), "utf8"), "CREATE TABLE dummy(x);");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(path.dirname(path.dirname(dest)), { recursive: true, force: true });
    }
  });

  it("test_cli_copies_with_explicit_dirs_and_fails_closed_when_no_sql", () => {
    const src = tmp("copy-sql-cli-src-");
    const dest = tmp("copy-sql-cli-dest-");
    const empty = tmp("copy-sql-cli-empty-");
    try {
      writeFileSync(path.join(src, "one.sql"), "SELECT 1;");
      const ok = spawnSync(process.execPath, [COPY, src, dest], { cwd: tmpdir(), encoding: "utf8", timeout: 30000 });
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(existsSync(path.join(dest, "one.sql")));
      const bad = spawnSync(process.execPath, [COPY, empty, dest], { cwd: tmpdir(), encoding: "utf8", timeout: 30000 });
      assert.notEqual(bad.status, 0, "copying zero .sql files must fail");
    } finally {
      for (const d of [src, dest, empty]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("test_every_sql_file_schema_ts_reads_exists_in_the_copied_source_dir", () => {
    const schema = readFileSync(path.join(SERVER, "src", "repo", "db", "schema.ts"), "utf8");
    const referenced = [...schema.matchAll(/["'`]\.\/([A-Za-z0-9_-]+\.sql)["'`]/g)].map((m) => m[1]);
    assert.ok(referenced.length >= 11, `expected schema.ts to reference the SQL files, found ${referenced.length}`);
    const present = new Set(readdirSync(path.join(SERVER, "src", "repo", "db")).filter((f) => f.endsWith(".sql")));
    for (const name of referenced)
      assert.ok(present.has(name), `${name} must live in src/repo/db so the glob copies it`);
  });

  it("test_build_script_has_no_hand_kept_sql_list", () => {
    const pkg = JSON.parse(readFileSync(path.join(SERVER, "package.json"), "utf8"));
    assert.match(pkg.scripts.build, /^tsc -p tsconfig\.json && node scripts\/copy-sql\.mjs$/);
    assert.doesNotMatch(pkg.scripts.build, /\.sql/);
    assert.equal(pkg.scripts["smoke:dist"], "node scripts/smoke-dist.mjs");
    assert.equal(pkg.scripts.start, "node dist/index.js");
  });
});

const FAKE_OK = `
import http from "node:http";
import { writeFileSync } from "node:fs";
if (process.env.FAKE_REPORT) writeFileSync(process.env.FAKE_REPORT, JSON.stringify({ dataDir: process.env.VELVET_DATA_DIR, host: process.env.HOST, port: process.env.PORT }));
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
server.listen(Number(process.env.PORT), process.env.HOST);
`;
const FAKE_CRASH = `throw new Error("ENOENT: missing schema sql");`;
const FAKE_500 = `
import http from "node:http";
http.createServer((req, res) => { res.writeHead(500); res.end("no"); }).listen(Number(process.env.PORT), process.env.HOST);
`;

function smoke(source, extraEnv = {}, timeoutMs = 8000) {
  const dir = tmp("smoke-dist-fake-");
  const entry = path.join(dir, "index.mjs");
  writeFileSync(entry, source);
  const started = Date.now();
  const result = spawnSync(process.execPath, [SMOKE, "--entry", entry, "--timeout-ms", String(timeoutMs)], {
    cwd: SERVER,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60000,
  });
  rmSync(dir, { recursive: true, force: true });
  return { ...result, elapsed: Date.now() - started };
}

describe("SmokeDist", () => {
  it("test_passes_when_health_answers_ok_and_cleans_up_temp_data_dir", () => {
    const reportDir = tmp("smoke-dist-report-");
    const report = path.join(reportDir, "report.json");
    try {
      const result = smoke(FAKE_OK, { FAKE_REPORT: report });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const seen = JSON.parse(readFileSync(report, "utf8"));
      assert.ok(seen.dataDir && path.isAbsolute(seen.dataDir), "smoke must set VELVET_DATA_DIR to a temp dir");
      assert.equal(seen.host, "127.0.0.1");
      assert.ok(Number(seen.port) > 0);
      assert.equal(existsSync(seen.dataDir), false, "smoke must remove its temp data dir");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("test_fails_fast_when_the_server_crashes_on_start", () => {
    const result = smoke(FAKE_CRASH, {}, 20000);
    assert.notEqual(result.status, 0);
    assert.ok(
      result.elapsed < 15000,
      `should fail when the child exits, not wait for the timeout (took ${result.elapsed}ms)`,
    );
  });

  it("test_fails_when_health_never_answers_ok", () => {
    const result = smoke(FAKE_500, {}, 3000);
    assert.notEqual(result.status, 0);
  });
});
