import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Real Adventure Table captures from an already prepared demonstration campaign.
 * Uses an isolated browser context; edits only its local draft and sheet selections.
 * No declaration, map movement, Director beat, generation, or other write is sent.
 *
 * node scripts/capture-readme-screenshots.mjs \
 *   --base-url http://127.0.0.1:18892 --campaign CAMPAIGN_ID --room ROOM_ID \
 *   --reference "Waylamp (1)" --out docs/images
 *
 * Use a disposable fixture database. Preparation, active room, and unlocked play
 * are prerequisites; this script deliberately fails if the table needs recovery.
 */
function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:5173", campaign: "", room: "", out: "docs/images", references: [],
    draft: "I examine the markings with my waylamp.",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH };
  const keys = { "--base-url": "baseUrl", "--campaign": "campaign", "--room": "room", "--out": "out", "--draft": "draft", "--executable-path": "executablePath" };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--reference") args.references.push(value);
    else if (keys[flag]) args[keys[flag]] = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!args.campaign || !args.room) throw new Error("--campaign and --room are required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const browser = await chromium.launch(args.executablePath ? { executablePath: args.executablePath } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5, reducedMotion: "reduce" });
  // Keep captures repeatable and prevent an automatic narration retry on a restored fixture.
  await context.addInitScript(() => localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify({ theme: "light", density: "comfortable", autoNarrateMechanics: false })));
  const page = await context.newPage();
  const writes = [];
  await page.route("**/api/**", async (route) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  await page.goto(`${args.baseUrl.replace(/\/$/, "")}/#/campaign/${encodeURIComponent(args.campaign)}/play/${encodeURIComponent(args.room)}`);
  await expect(page.locator("[data-adventure-table]")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "What do you do?", exact: true });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(args.draft);
  await page.getByRole("button", { name: "Character", exact: true }).click();
  const sheet = page.locator(".sheet-context-drawer");
  await expect(sheet).toBeVisible();
  for (const reference of args.references) {
    await sheet.getByRole("searchbox").fill(reference.replace(/ \(\d+\)$/, ""));
    await sheet.getByRole("button", { name: `Reference ${reference}`, exact: true }).click();
  }
  await sheet.getByRole("searchbox").fill("");
  await sheet.getByRole("button", { name: /^Back to draft/ }).click();

  const capture = async (name, fullPage = false) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(args.out, `${name}.png`), fullPage, animations: "disabled" });
    console.log(`Captured ${name}.png`);
  };
  // Show the latest complete exchange from its speaker line, rather than a cut-off paragraph.
  await page.locator(".campaign-conversation-log").evaluate((log) => {
    const latest = log.querySelector(".story-entry:last-of-type");
    if (latest) log.scrollTop += latest.getBoundingClientRect().top - log.getBoundingClientRect().top;
  });
  await page.getByRole("tab", { name: "Story", exact: true }).focus();
  await capture("adventure-table");

  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await expect(page.locator(".tactical-map-stage canvas")).toBeVisible();
  await page.getByRole("button", { name: "Fit map", exact: true }).click();
  await page.locator(".table-map").evaluate((panel) => {
    const canvas = panel.querySelector("canvas");
    if (canvas) panel.scrollTop += canvas.getBoundingClientRect().top - panel.getBoundingClientRect().top - 60;
  });
  await capture("adventure-table-map");
  await page.getByRole("tab", { name: "Story", exact: true }).click();
  await page.getByRole("button", { name: "Character", exact: true }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("combobox", { name: "Jump to section" }).selectOption("attributes");
  await capture("adventure-table-character");
  await sheet.getByRole("button", { name: /^Back to draft/ }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  // The composer stays in natural document flow; capture the complete phone interface.
  await page.locator(".campaign-conversation-log").evaluate((log) => {
    const latest = log.querySelector(".story-entry:last-of-type");
    if (latest) log.scrollTop += latest.getBoundingClientRect().top - log.getBoundingClientRect().top;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture("adventure-table-mobile", true);
  expect(writes, "Screenshot capture must never send an API write").toEqual([]);
} finally {
  await browser.close();
}
