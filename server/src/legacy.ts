import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SAMPLERS, defaultHarnessSettings, defaultProviderSettings } from "./defaults.js";
import { systemRuntime } from "./runtime.js";
import type { Clock, IdGenerator } from "./runtime.js";
import type { Database, HarnessSettings, ProviderSettings, SceneState, Session } from "./types.js";

export const LEGACY_DB_FILENAME = "db.json";

export function legacyDbPath(dataDir: string): string {
  return path.join(dataDir, LEGACY_DB_FILENAME);
}

export function migratedDbPath(dataDir: string): string {
  return path.join(dataDir, `${LEGACY_DB_FILENAME}.migrated`);
}

interface LegacyDependencies {
  clock: Clock;
  ids: IdGenerator;
}

function normalize(parsed: Partial<Database>, dependencies: LegacyDependencies): Database {
  const rawSessions = Array.isArray(parsed.sessions) ? (parsed.sessions as Array<Partial<Session>>) : [];
  const rawSettings = (parsed.settings ?? {}) as Partial<HarnessSettings>;
  const rawProvider = (parsed.provider ?? {}) as Partial<ProviderSettings>;
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    sessions: rawSessions.map((s) => ({
      id: s.id ?? dependencies.ids.nextId(),
      characterId: s.characterId ?? "",
      primaryCharacterId: s.characterId ?? "",
      participants: [],
      title: s.title ?? "",
      state: s.state ?? ("setup" as SceneState),
      presetId: s.presetId ?? "default",
      consentLog: Array.isArray(s.consentLog) ? s.consentLog : [],
      activeLeafId: null,
      createdAt: s.createdAt ?? dependencies.clock.now().toISOString(),
      stoppedAt: s.stoppedAt ?? null,
      stopReason: s.stopReason ?? null,
    })),
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
    lore: Array.isArray(parsed.lore) ? parsed.lore : [],
    settings: {
      ...defaultHarnessSettings(rawSettings.updatedAt ?? dependencies.clock.now().toISOString()),
      ...rawSettings,
      id: "harness",
    },
    provider: {
      ...defaultProviderSettings(rawProvider.updatedAt ?? dependencies.clock.now().toISOString()),
      ...rawProvider,
      id: "provider",
      samplers: { ...DEFAULT_SAMPLERS, ...(rawProvider.samplers ?? {}) },
    },
  };
}

export function loadLegacyDatabase(dataDir: string, dependencies: LegacyDependencies = systemRuntime): Database | null {
  const filePath = legacyDbPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: Partial<Database>;
  try {
    parsed = JSON.parse(raw) as Partial<Database>;
  } catch {
    const corruptPath = `${filePath}.corrupt-${dependencies.clock.now().getTime()}`;
    try {
      renameSync(filePath, corruptPath);
    } catch {
      // best effort quarantine, matches previous behavior
    }
    return null;
  }
  return normalize(parsed, dependencies);
}

export function markLegacyMigrated(dataDir: string): void {
  const from = legacyDbPath(dataDir);
  try {
    renameSync(from, migratedDbPath(dataDir));
  } catch {
    // never delete the legacy file; rename is best effort
  }
}
