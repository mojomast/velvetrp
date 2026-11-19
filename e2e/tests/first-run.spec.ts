// Plan 1.7: the first-run path a new user takes, against the real production process.
// The compiled server (server/dist) starts on an empty data directory, serves the built client,
// and uses the deterministic fake model provider. The user starts a Quick adventure from the
// campaign library and resolves a first adventure turn.
import { quickAdventureCreateResponseSchema } from "@velvet/contracts";
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 18797;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FAKE_PROVIDER = "http://127.0.0.1:18788";

async function narrationCalls(): Promise<number> {
  const stats = (await (await fetch(`${FAKE_PROVIDER}/stats`)).json()) as { narrationResponses: number };
  return stats.narrationResponses;
}

let server: ChildProcess | null = null;
let dataDir = "";
let output = "";

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`production server exited early (${server?.exitCode}):\n${output}`);
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`production server did not become healthy:\n${output}`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  for (const built of ["server/dist/index.js", "client/dist/index.html"]) {
    if (!existsSync(path.join(ROOT, built)))
      throw new Error(`the first-run e2e needs the production build (${built}); run \`npm run build\` first`);
  }
  dataDir = mkdtempSync(path.join(tmpdir(), "velvet-first-run-"));
  // A clean first-run environment: nothing from a developer's .env, saved flags or real provider keys.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("OPENROUTER_") &&
        !name.startsWith("OPENAI_") &&
        !name.startsWith("FEATURE_RPG_") &&
        !name.startsWith("VELVET_"),
    ),
  );
  server = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: ROOT,
    env: {
      ...inherited,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      VELVET_DATA_DIR: dataDir,
      VELVET_ENV_FILE: path.join(dataDir, "no-such.env"),
      OPENAI_BASE_URL: "http://127.0.0.1:18788/v1",
      OPENAI_MODEL: "velvet-e2e-model",
      OPENAI_API_KEY: "local-e2e-placeholder",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  server.stderr?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  await waitForHealth();
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("a new user starts a Quick adventure and resolves a first turn", async ({ page }) => {
  test.setTimeout(120_000);
  expect(
    readdirSync(dataDir)
      .filter((name) => name !== "no-such.env")
      .every((name) => name.startsWith("velvet.sqlite")),
  ).toBe(true);
  const empty = await page.request.get(`${ORIGIN}/api/rpg/v1/campaigns`);
  expect(empty.status()).toBe(200);
  expect((await empty.json()).campaigns).toEqual([]);

  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole("heading", { name: "Campaigns & worlds", exact: true })).toBeVisible();

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/rpg/v1/quick-adventures",
  );
  const started = Date.now();
  await page.getByRole("button", { name: "Start a quick adventure", exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  expect(Date.now() - started).toBeLessThan(30_000);
  const adventure = quickAdventureCreateResponseSchema.parse(await response.json());

  // The library opens the new campaign straight into play.
  await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
  await expect(
    page
      .locator("[data-adventure-table]")
      .getByRole("heading", { name: adventure.campaignName, level: 1, exact: true }),
  ).toBeVisible();

  const declaration = "I look around the square and ask who tends the commons fire.";
  const callsBefore = await narrationCalls();
  const streamed = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/rpg/v1/adventure-turns/stream" &&
      (candidate.request().postDataJSON() as { declaration?: unknown } | null)?.declaration === declaration,
  );
  await page.getByRole("textbox", { name: "What do you do?", exact: true }).fill(declaration);
  await page.getByRole("button", { name: "Send action", exact: true }).click();
  const stream = await streamed;
  expect(stream.status()).toBe(200);
  await expect(page.getByRole("textbox", { name: "What do you do?", exact: true })).toBeEnabled({ timeout: 30_000 });

  // The turn is durably resolved in the new campaign, and the narration lane went to the model provider.
  const turnId = stream.headers()["x-adventure-turn-id"];
  expect(turnId).toBeTruthy();
  const saved = await page.request.get(`${ORIGIN}/api/rpg/v1/adventure-turns/${turnId}`);
  expect(saved.status()).toBe(200);
  const turn = (await saved.json()) as {
    turn: { campaignId: string; sessionId: string; declaration: string; state: string };
    narrationStatus: { status: string; text: string };
  };
  expect(turn.turn).toMatchObject({
    campaignId: adventure.campaignId,
    sessionId: adventure.sessionId,
    declaration,
    state: "completed",
  });
  expect(turn.narrationStatus.status).toBe("completed");
  expect(turn.narrationStatus.text.length).toBeGreaterThan(0);
  expect(await narrationCalls()).toBeGreaterThan(callsBefore);

  // The room transcript the page renders agrees with the turn's settled narration.
  await expect
    .poll(async () => {
      const transcript = await page.request.get(
        `${ORIGIN}/api/rpg/v1/adventure-turns/transcript?campaignId=${adventure.campaignId}&sessionId=${adventure.sessionId}`,
      );
      const entries = ((await transcript.json()) as { turns: Array<{ turnId: string; narration: string }> }).turns;
      return entries.find((entry) => entry.turnId === turnId)?.narration ?? null;
    })
    .toBe(turn.narrationStatus.text);

  // The player sees their action and the settled narration in the adventure history.
  const history = page.getByRole("log", { name: "Adventure history" });
  await expect(history).toContainText(declaration);
  await expect(history).toContainText(turn.narrationStatus.text);
});
