import { Worker } from "node:worker_threads";

interface SqlStatement {
  sql: string;
  params?: unknown[];
}

interface LockedWrite {
  done: Promise<void>;
  isReleased(): boolean;
}

export function startLockedWrite(
  databasePath: string,
  statements: SqlStatement[],
  holdMs = 150,
): Promise<LockedWrite> {
  const releaseState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require("better-sqlite3");
    const releaseState = new Int32Array(workerData.releaseState);
    const db = new Database(workerData.databasePath);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const statement of workerData.statements) {
        db.prepare(statement.sql).run(...(statement.params || []));
      }
      parentPort.postMessage("locked");
      setTimeout(() => {
        try {
          db.exec("COMMIT");
          Atomics.store(releaseState, 0, 1);
          db.close();
          parentPort.postMessage("done");
        } catch (error) {
          parentPort.postMessage({ error: String(error && error.stack || error) });
        }
      }, workerData.holdMs);
    } catch (error) {
      parentPort.postMessage({ error: String(error && error.stack || error) });
    }
  `, {
    eval: true,
    workerData: { databasePath, statements, holdMs, releaseState: releaseState.buffer },
  });

  return new Promise((resolve, reject) => {
    let locked = false;
    const done = new Promise<void>((resolveDone, rejectDone) => {
      worker.on("message", (message: unknown) => {
        if (message === "locked") {
          locked = true;
          resolve({ done, isReleased: () => Atomics.load(releaseState, 0) === 1 });
        } else if (message === "done") {
          resolveDone();
        } else if (typeof message === "object" && message !== null && "error" in message) {
          rejectDone(new Error(String(message.error)));
          if (!locked) reject(new Error(String(message.error)));
        }
      });
      worker.on("error", (error) => {
        rejectDone(error);
        if (!locked) reject(error);
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          const error = new Error(`lock worker exited with code ${code}`);
          rejectDone(error);
          if (!locked) reject(error);
        }
      });
    });
  });
}
