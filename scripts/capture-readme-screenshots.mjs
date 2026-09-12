import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Captures the README screenshots from a running Velvet instance at high
 * resolution (1920x1200 CSS pixels at 2x device scale) and crops each shot to
 * the meaningful surface so it stays legible when scaled down in the README.
 *
 * Start a seeded server and a client pointed at it, then run:
 *   node scripts/capture-readme-screenshots.mjs \
 *     --base-url http://127.0.0.1:18791 \
 *     --campaign bc-v1-000001 \
 *     --room 3c8f35ab-193e-423b-8cc5-4f098c60e8d1 \
 *     [--out docs/images]
 */
function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18791", campaign: "", room: "", out: "docs/images" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base-url") args.baseUrl = value;
    else if (key === "--campaign") args.campaign = value;
    else if (key === "--room") args.room = value;
    else if (key === "--out") args.out = value;
    else continue;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.campaign || !args.room) {
  console.error("--campaign and --room are required");
  process.exit(1);
}
mkdirSync(args.out, { recursive: true });

const base = args.baseUrl.replace(/\/$/, "");
const url = (route) => `${base}/#${route}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1200 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const failures = [];

async function shot(name, locator) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: 20000 });
    const box = await locator.first().boundingBox();
    await locator.first().screenshot({ path: path.join(args.out, `${name}.png`), animations: "disabled" });
    console.log(`captured ${name}.png (${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "?"} css px)`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

/** Captures the union of several sibling regions as one clip (page must not be scrolled). */
async function shotUnion(name, locators) {
  try {
    const boxes = [];
    for (const locator of locators) {
      await locator.first().waitFor({ state: "visible", timeout: 20000 });
      const box = await locator.first().boundingBox();
      if (box) boxes.push(box);
    }
    if (!boxes.length) throw new Error("no visible regions");
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    const clip = { x: left, y: top, width: right - left, height: bottom - top };
    await page.screenshot({ path: path.join(args.out, `${name}.png`), clip, animations: "disabled" });
    console.log(`captured ${name}.png (${Math.round(clip.width)}x${Math.round(clip.height)} css px)`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

/** Captures from the top of one region down to the bottom of a later region inside it. */
async function shotRange(name, startSelector, endSelector) {
  try {
    await page.locator(startSelector).first().waitFor({ state: "visible", timeout: 20000 });
    const bounds = await page.evaluate(([startQuery, endQuery]) => {
      const start = document.querySelector(startQuery);
      const end = document.querySelector(endQuery);
      if (!start || !end) return null;
      const startRect = start.getBoundingClientRect();
      const endRect = end.getBoundingClientRect();
      return { x: startRect.x + window.scrollX, y: startRect.y + window.scrollY,
        width: startRect.width, height: endRect.bottom - startRect.top };
    }, [startSelector, endSelector]);
    if (!bounds || bounds.height <= 0) throw new Error("region bounds unavailable");
    await page.screenshot({ path: path.join(args.out, `${name}.png`), clip: bounds, fullPage: true, animations: "disabled" });
    console.log(`captured ${name}.png (${Math.round(bounds.width)}x${Math.round(bounds.height)} css px)`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

/** Captures a region of the page capped to a readable height (top-anchored). */
async function shotRegion(name, selector, maxHeight = 1080) {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 20000 });
    const box = await locator.boundingBox();
    if (!box) throw new Error("region bounds unavailable");
    const height = Math.max(200, Math.min(box.height, maxHeight, 1188 - box.y));
    const clip = { x: box.x, y: box.y, width: box.width, height };
    await page.screenshot({ path: path.join(args.out, `${name}.png`), clip, fullPage: true, animations: "disabled" });
    console.log(`captured ${name}.png (${Math.round(clip.width)}x${Math.round(clip.height)} css px)`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

async function goto(route, ready) {
  await page.goto(url(route), { waitUntil: "domcontentloaded" });
  if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(700);
}

// 1. Campaign library
await goto("/campaigns", "text=Campaigns");
await shot("campaign-library", page.locator(".library-page .campaign-shell").first());

// Widen the tools pane so in-room tool content stays legible in the crops below.
await page.evaluate(() => {
  const preferences = { theme: "system", density: "comfortable", contextVisible: true, quickToolsVisible: true,
    contextWidth: 300, quickToolsWidth: 520, widgets: ["location", "cast", "objectives", "resources", "encounter"] };
  localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify(preferences));
});

// 2. Command Center table (context + map, narration, character summary), no tool open
await goto(`/campaign/${args.campaign}/play/${args.room}`, '[data-command-center="true"] .campaign-play-grid');
await page.waitForTimeout(2500);
await shot("command-center", page.locator(".campaign-play-grid").first());

// 3. Director drawer
await page.locator('[data-atlas-tool="director"]').click();
await page.waitForTimeout(900);
await shotRegion("director", ".campaign-play-grid");
await page.getByRole("button", { name: /^Close Director$/ }).click().catch(() => undefined);
await page.waitForTimeout(400);

// 4. Character sheet drawer
await page.locator('[data-atlas-tool="character"]').click();
await page.locator(".gameplay-sheet-drawer").filter({ hasText: "Inventory and equipment" }).first().waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(900);
await shotRegion("character-sheet", ".campaign-play-grid");
await page.getByRole("button", { name: /^Close character sheet$/ }).click().catch(() => undefined);
await page.waitForTimeout(400);

// 5. World expedition (Travel drawer: route plan plus bootstrap placement and camp)
await page.locator('[data-atlas-tool="travel"]').click();
await page.waitForTimeout(1500);
await shotRegion("world-expedition", ".campaign-play-grid");

// 6. Combat tracker (encounter lifecycle plus reviewed generation)
await goto(`/campaign/${args.campaign}/combat`, ".combat-shell");
await shot("combat-tracker", page.locator(".encounter-lifecycle").first());

// 7. Cast companion administration with an exact grant
await goto(`/campaign/${args.campaign}/cast`, "text=Cast & factions");
await page.getByRole("button", { name: "Companion administration", exact: true }).click();
await page.waitForTimeout(500);
const companionSelect = page.getByLabel("Companion NPC");
if (await companionSelect.count()) {
  const options = await companionSelect.locator("option").allTextContents();
  const first = options.find((value) => value && value !== "Choose an NPC");
  if (first) { await companionSelect.selectOption({ label: first }); await page.waitForTimeout(1500); }
}
await shotRange("cast-companion", ".companion-administration", ".companion-grant-list");

await browser.close();
if (failures.length) { console.error(`\n${failures.length} capture(s) failed: ${failures.join(", ")}`); process.exitCode = 1; }
