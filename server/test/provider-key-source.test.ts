import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo, getProviderSettings } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
const KEY_ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENROUTER_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_MODEL", "OPENAI_MODEL", "VELVET_PROVIDER_KEY_STORAGE"];
for (const name of KEY_ENV) delete process.env[name];
useTmpDataDir();
afterEach(() => { for (const name of KEY_ENV) delete process.env[name]; });

const ENV_KEY = "env-test-key-not-real-0001";
const STORED_KEY = "stored-test-key-not-real-0002";

function storedPayload(): Record<string, unknown> | null {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
  try {
    const row = db.prepare("SELECT payload FROM provider WHERE id='provider'").get() as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Record<string, unknown> : null;
  } finally {
    db.close();
  }
}

const put = (payload: Record<string, unknown>) => ({ method: "PUT" as const, url: "/api/provider", headers: { "content-type": "application/json" }, payload });

describe("provider keys come from the environment by default", () => {
  it("uses the env key, reports its source and never writes it to the database", async () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    const app = buildApp();
    try {
      const initial = await app.inject({ method: "GET", url: "/api/provider" });
      expect(initial.json()).toMatchObject({ hasApiKey: true, apiKeySource: "environment" });
      expect(initial.body).not.toContain(ENV_KEY);
      expect((await getProviderSettings()).apiKey).toBe(ENV_KEY);

      const saved = await app.inject(put({ model: "test-model-2" }));
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ model: "test-model-2", hasApiKey: true, apiKeySource: "environment" });
      expect(saved.body).not.toContain(ENV_KEY);
      const payload = storedPayload();
      expect(payload).not.toBeNull();
      expect(JSON.stringify(payload)).not.toContain(ENV_KEY);
      expect(payload?.apiKey ?? "").toBe("");

      delete process.env.OPENROUTER_API_KEY;
      expect((await getProviderSettings()).apiKey).toBe("");
      expect((await app.inject({ method: "GET", url: "/api/provider" })).json()).toMatchObject({ hasApiKey: false, apiKeySource: "none" });
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("refuses to store a key unless database storage is opted in, and always allows clearing", async () => {
    const app = buildApp();
    try {
      const refused = await app.inject(put({ apiKey: STORED_KEY }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: "PROVIDER_KEY_STORAGE_DISABLED" });
      expect(refused.body).not.toContain(STORED_KEY);
      expect(JSON.stringify(storedPayload() ?? {})).not.toContain(STORED_KEY);
      expect((await getProviderSettings()).apiKey).toBe("");

      const cleared = await app.inject(put({ apiKey: "" }));
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ hasApiKey: false, apiKeySource: "none" });
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("stores a key with VELVET_PROVIDER_KEY_STORAGE=database and lets a set env key win", async () => {
    process.env.VELVET_PROVIDER_KEY_STORAGE = "database";
    const app = buildApp();
    try {
      const stored = await app.inject(put({ apiKey: STORED_KEY }));
      expect(stored.statusCode).toBe(200);
      expect(stored.json()).toMatchObject({ hasApiKey: true, apiKeySource: "database" });
      expect(stored.json().apiKeyWarning ?? "").toBe("");
      expect(stored.body).not.toContain(STORED_KEY);
      expect(storedPayload()?.apiKey).toBe(STORED_KEY);
      expect((await getProviderSettings()).apiKey).toBe(STORED_KEY);

      process.env.OPENROUTER_API_KEY = ENV_KEY;
      expect((await getProviderSettings()).apiKey).toBe(ENV_KEY);
      expect((await app.inject({ method: "GET", url: "/api/provider" })).json()).toMatchObject({ apiKeySource: "environment" });
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("keeps a previously stored key working without opt-in, with a plain-text warning", async () => {
    process.env.VELVET_PROVIDER_KEY_STORAGE = "database";
    let app = buildApp();
    try {
      expect((await app.inject(put({ apiKey: STORED_KEY }))).statusCode).toBe(200);
    } finally {
      await app.close();
      closeRepo();
    }
    delete process.env.VELVET_PROVIDER_KEY_STORAGE;
    app = buildApp();
    try {
      const view = (await app.inject({ method: "GET", url: "/api/provider" })).json();
      expect(view).toMatchObject({ hasApiKey: true, apiKeySource: "database" });
      expect(view.apiKeyWarning).toMatch(/plain text/i);
      expect(JSON.stringify(view)).not.toContain(STORED_KEY);
      expect((await getProviderSettings()).apiKey).toBe(STORED_KEY);
      // Saving other settings keeps the legacy key; it is not silently dropped.
      expect((await app.inject(put({ model: "test-model-3" }))).statusCode).toBe(200);
      expect((await getProviderSettings()).apiKey).toBe(STORED_KEY);
    } finally {
      await app.close();
      closeRepo();
    }
  });
});
