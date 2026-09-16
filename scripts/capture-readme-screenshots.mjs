import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Captures the README screenshots from a running Velvet instance.
 *
 * Each shot is taken at 1920x1200 CSS pixels with a 2x device scale and keeps
 * the full surface visible (the command center header, tool groups, panes, and
 * composer) so the README shows the real UI rather than a tight crop. Pages
 * taller than a viewport are clipped to a readable height.
 *
 * Start a seeded server and a client pointed at it, then run:
 *   node scripts/capture-readme-screenshots.mjs \
 *     --base-url http://127.0.0.1:5173 \
 *     --campaign bc-v1-000001 \
 *     --room 21b1ed06-5614-4725-a9c7-cb75a871b53a \
 *     [--out docs/images]
 */
function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:5173", campaign: "", room: "", out: "docs/images", executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base-url") args.baseUrl = value;
    else if (key === "--campaign") args.campaign = value;
    else if (key === "--room") args.room = value;
    else if (key === "--out") args.out = value;
    else if (key === "--executable-path") args.executablePath = value;
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

const browser = await chromium.launch(args.executablePath ? { executablePath: args.executablePath } : {});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1200 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const failures = [];

/** Waits for a locator, then screenshots just that element. */
async function shotElement(name, selector) {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(500);
    await locator.screenshot({ path: path.join(args.out, `${name}.png`), animations: "disabled" });
    console.log(`captured ${name}.png (element ${selector})`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

/** Screenshots a full-page element, capped to a readable height (top-anchored). */
async function shotElementCapped(name, selector, maxHeight = 1100) {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 25000 });
    const box = await locator.boundingBox();
    if (!box) throw new Error("region bounds unavailable");
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const clip = { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: Math.min(box.height, maxHeight) };
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(args.out, `${name}.png`), clip, fullPage: true, animations: "disabled" });
    console.log(`captured ${name}.png (element ${Math.round(clip.width)}x${Math.round(clip.height)})`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

/** Scrolls the tools pane so an opened tool starts at its top edge. */
async function scrollPanelIntoPane(selector) {
  await page.evaluate((sel) => {
    const pane = document.querySelector(".campaign-quick-tools");
    const el = document.querySelector(sel);
    if (!pane || !el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - 8);
  }, selector);
  await page.waitForTimeout(500);
}

/** Screenshots the whole viewport, including surrounding chrome. */
async function shotViewport(name) {
  try {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(args.out, `${name}.png`), animations: "disabled" });
    console.log(`captured ${name}.png (viewport)`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  }
}

async function goto(route, ready) {
  await page.goto(url(route), { waitUntil: "domcontentloaded" });
  if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(1200);
}

async function close(name) {
  await page.getByRole("button", { name }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
}

// 1. Campaign library
await goto("/campaigns", "text=Campaigns");
await shotElement("campaign-library", ".library-page .campaign-shell");

// Widen the tools pane so in-room tool content stays legible.
await page.evaluate(() => {
  const preferences = { theme: "system", density: "comfortable", contextVisible: true, quickToolsVisible: true,
    contextWidth: 300, quickToolsWidth: 520, widgets: ["location", "cast", "objectives", "resources", "encounter"] };
  localStorage.setItem("velvet.campaign-workbench.v1", JSON.stringify(preferences));
});

// 2. Command Center table: header, tool groups, map/context, narration, character summary, composer.
await goto(`/campaign/${args.campaign}/play/${args.room}`, '[data-command-center="true"] .campaign-play-grid');
await page.waitForTimeout(2000);
await shotElement("command-center", ".campaign-play-page");

// 3. Director panel
await page.locator('[data-atlas-tool="director"]').click();
await page.locator("#atlas-director").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(1200);
await scrollPanelIntoPane("#atlas-director");
await shotElement("director", "#campaign-quick-tools");
await close(/^Close Director$/);

// 4. Character sheet
await page.locator('[data-atlas-tool="character"]').click();
await page.locator(".gameplay-sheet-drawer").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(2000);
await scrollPanelIntoPane(".gameplay-sheet-drawer");
await shotElement("character-sheet", "#campaign-quick-tools");
await close(/^Close character sheet$/);

// 5. World expedition (Travel panel: route plan plus bootstrap placement and camp)
await page.locator('[data-atlas-tool="travel"]').click();
await page.locator("#atlas-travel").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(1500);
await scrollPanelIntoPane("#atlas-travel");
await shotElement("world-expedition", "#campaign-quick-tools");

// 6. Combat tracker (encounter lifecycle plus reviewed generation)
await goto(`/campaign/${args.campaign}/combat`, ".combat-shell");
const encounterSelect = page.getByLabel("Campaign encounter");
if (await encounterSelect.count()) {
  const options = await encounterSelect.locator("option").allTextContents();
  const combat = options.find((value) => value && value !== "Choose a combat");
  if (combat) {
    await encounterSelect.selectOption({ label: combat });
    await page.getByRole("button", { name: "Load combat" }).click().catch(() => undefined);
    await page.waitForTimeout(2500);
  }
}
await shotElementCapped("combat-tracker", ".combat-shell", 1150);

// 7. Cast studio: NPC roster, relationships, factions, and standings
await goto(`/campaign/${args.campaign}/cast`, "text=Cast & factions");
await page.getByRole("button", { name: "Browse cast", exact: true }).click().catch(() => undefined);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1200);
await shotViewport("cast-factions");

await browser.close();
if (failures.length) { console.error(`\n${failures.length} capture(s) failed: ${failures.join(", ")}`); process.exitCode = 1; }
