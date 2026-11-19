import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";

const SQLITE_FILENAME = "velvet.sqlite";

function resolveDataDir() {
  const override = process.env.VELVET_DATA_DIR;
  return path.resolve(override && override.trim() !== "" ? override : path.join(process.cwd(), "data"));
}

function parseArgs(argv) {
  const options = { dataDir: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--data-dir requires a directory");
      options.dataDir = path.resolve(value);
      i += 1;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--out requires a directory");
      options.outDir = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all();
}

function tableRows(db, name) {
  const table = quoteIdentifier(name);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } catch {
    return db.prepare(`SELECT * FROM ${table}`).all();
  }
}

function serializableRows(rows) {
  return rows.map((row) => {
    const normalized = {};
    for (const [column, value] of Object.entries(row)) {
      normalized[column] = Buffer.isBuffer(value) ? { base64: value.toString("base64") } : value;
    }
    return normalized;
  });
}

function exportTables(db) {
  const tables = {};
  for (const name of tableNames(db)) tables[name] = serializableRows(tableRows(db, name));
  return tables;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`db:export: ${error.message}\n`);
    return 2;
  }

  const dataDir = options.dataDir ?? resolveDataDir();
  const outDir = options.outDir ?? path.join(dataDir, "exports");
  const databasePath = path.join(dataDir, SQLITE_FILENAME);
  if (!existsSync(databasePath)) {
    process.stderr.write(`db:export: ${SQLITE_FILENAME} not found in ${dataDir}\n`);
    return 1;
  }

  const stamp = backupStamp();
  let db;
  try {
    db = new DatabaseDriver(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    process.stderr.write(`db:export: cannot read ${databasePath}\n`);
    return 1;
  }

  try {
    mkdirSync(outDir, { recursive: true });
    const backupPath = path.join(outDir, `velvet-backup-${stamp}.sqlite`);
    const exportPath = path.join(outDir, `velvet-export-${stamp}.json`);

    await db.backup(backupPath);

    const payload = {
      format: "velvet-raw-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: SQLITE_FILENAME,
      tables: exportTables(db),
    };
    writeFileSync(exportPath, `${JSON.stringify(payload, null, 2)}\n`);

    process.stdout.write(`${backupPath}\n${exportPath}\n`);
    return 0;
  } catch {
    process.stderr.write(`db:export: failed to export ${databasePath}\n`);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = await main();
