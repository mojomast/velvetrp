import { parentPort, workerData } from "node:worker_threads";
import { createRepository } from "../repo/index.js";
import { QuickAdventureError, createQuickAdventure } from "./quickAdventure.js";
import type { QuickAdventureId } from "./quickAdventureCatalog.js";

interface QuickAdventureWorkerData {
  databaseDir: string;
  ownerId: string;
  adventureId?: QuickAdventureId;
}

const { databaseDir, ownerId, adventureId } = workerData as QuickAdventureWorkerData;
const repository = createRepository({ dataDir: databaseDir });
try {
  const result = await createQuickAdventure({
    repository,
    ownerId,
    ...(adventureId ? { adventureId } : {}),
  });
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  if (error instanceof QuickAdventureError) {
    const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
    parentPort?.postMessage({ ok: false, step: error.step, campaignId: error.campaignId, message });
  } else {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ ok: false, step: "worker", campaignId: null, message });
  }
} finally {
  repository.close();
}
