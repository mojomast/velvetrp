"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const { createServer } = require("../server");

async function withBoard(viewport, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-browser-"));
  const server = createServer(path.join(directory, "state", "planning-board.json"));
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText("Saved revision 0", { exact: false }).waitFor();
    await run(page);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Chromium keeps a full custom answer focused under Unanswered only", async () => {
  await withBoard({ width: 1280, height: 900 }, async (page) => {
    await page.getByLabel("Unanswered only").check();
    await page.getByRole("combobox", { name: "Answer for Migration window", exact: true }).selectOption("Custom answer");
    const answer = page.locator("#custom-migration-policy");
    await assert.doesNotReject(() => answer.pressSequentially("Keep exactly two historical schemas", { delay: 5 }));
    await assert.doesNotReject(() => answer.evaluate((element) => {
      if (document.activeElement !== element) throw new Error("Custom answer lost focus");
      if (element.value !== "Keep exactly two historical schemas") throw new Error("Custom answer lost keystrokes");
      if (element.closest("article").hidden) throw new Error("Active decision was filtered out");
    }));
    await page.getByLabel("Unanswered only").focus();
    await assert.doesNotReject(() => page.locator('[data-row-decision="migration-policy"]').waitFor({ state: "hidden" }));
  });
});

test("Chromium exposes item-specific names and retained read-only details", async () => {
  await withBoard({ width: 1280, height: 900 }, async (page) => {
    const row = page.getByRole("article", { name: "Documentation reconciliation" });
    await row.getByLabel("Details for Documentation reconciliation", { exact: true }).click();
    const scope = row.getByLabel("Scope note for Documentation reconciliation", { exact: true });
    await scope.fill("Selectable retained scope\n".repeat(12));
    await row.getByLabel("Include Documentation reconciliation", { exact: true }).uncheck();

    assert.equal(await row.getByLabel("Disposition for Documentation reconciliation", { exact: true }).isDisabled(), true);
    assert.equal(await row.getByLabel("Priority for Documentation reconciliation", { exact: true }).isDisabled(), true);
    assert.equal(await scope.isDisabled(), false);
    assert.equal(await scope.isEditable(), false);
    await scope.focus();
    const retained = await scope.evaluate((element) => {
      element.setSelectionRange(0, 10);
      element.scrollTop = element.scrollHeight;
      return {
        focused: document.activeElement === element,
        selected: element.value.slice(element.selectionStart, element.selectionEnd),
        scrollable: element.scrollHeight > element.clientHeight && element.scrollTop > 0
      };
    });
    assert.deepEqual(retained, { focused: true, selected: "Selectable", scrollable: true });
    await row.getByLabel("Dependencies and risks for Documentation reconciliation", { exact: true }).waitFor();
    await page.getByRole("article", { name: "Migration window" }).getByRole("combobox", { name: "Answer for Migration window", exact: true }).waitFor();
    await row.getByText("details read-only and retained", { exact: false }).waitFor();
  });
});

test("Chromium stacks disposition and priority full-width at 320px", async () => {
  await withBoard({ width: 320, height: 900 }, async (page) => {
    const row = page.getByRole("article", { name: "Documentation reconciliation" });
    const disposition = await row.getByLabel("Disposition for Documentation reconciliation", { exact: true }).boundingBox();
    const priority = await row.getByLabel("Priority for Documentation reconciliation", { exact: true }).boundingBox();
    const rowBox = await row.boundingBox();
    assert.ok(disposition && priority && rowBox);
    assert.ok(priority.y >= disposition.y + disposition.height, "priority should stack below disposition");
    assert.ok(disposition.width >= rowBox.width - 26, "disposition should fill the row content width");
    assert.ok(priority.width >= rowBox.width - 26, "priority should fill the row content width");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page should not overflow horizontally");
  });
});
