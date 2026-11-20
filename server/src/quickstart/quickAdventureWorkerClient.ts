import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { QuickAdventureError, type QuickAdventureResult } from "./quickAdventure.js";

interface QuickAdventureWorkerInput {
  databaseDir: string;
  ownerId: string;
}

type QuickAdventureWorkerMessage =
  { ok: true; result: QuickAdventureResult } | { ok: false; step: string; campaignId: string | null; message: string };

/**
 * Compiled releases ship `quickAdventureWorker.js` beside this module; the TS
 * source tree (tsx, vitest) does not, so it loads the `.ts` entry through the
 * already-installed tsx loader instead.
 */
function resolveWorkerEntry(): { entry: URL; execArgv: string[] } {
  const compiled = new URL("./quickAdventureWorker.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { entry: compiled, execArgv: [] };
  return { entry: new URL("./quickAdventureWorker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

/**
 * Builds a Quick adventure on a worker thread with its own database
 * connection, so the synchronous starter catalog install never blocks the
 * main event loop. Rejects with the worker's step-named failure.
 */
export function runQuickAdventureInWorker({
  databaseDir,
  ownerId,
}: QuickAdventureWorkerInput): Promise<QuickAdventureResult> {
  return new Promise<QuickAdventureResult>((resolve, reject) => {
    const { entry, execArgv } = resolveWorkerEntry();
    const worker = new Worker(entry, {
      workerData: { databaseDir, ownerId },
      execArgv,
    });
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      // The worker closes its own database connection and exits on its own; never terminate it
      // mid-close. Keep an error listener so a late worker error cannot crash the process.
      worker.on("error", () => {});
      worker.unref();
      complete();
    };

    worker.once("message", (message: QuickAdventureWorkerMessage) => {
      if (message.ok) {
        settle(() => resolve(message.result));
      } else {
        settle(() => reject(new QuickAdventureError(message.step, message.campaignId, new Error(message.message))));
      }
    });
    worker.once("error", (error) => {
      settle(() => reject(new QuickAdventureError("worker", null, error)));
    });
    worker.once("exit", (code) => {
      settle(() => reject(new QuickAdventureError("worker", null, new Error(`worker exited with code ${code}`))));
    });
  });
}
