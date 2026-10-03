import { expect, type Page } from "@playwright/test";

/** Callers close the active drawer before opening the default surface's native menu. */
export async function openTableTools(page: Page) {
  const table = page.locator("[data-adventure-table]");
  await table.getByRole("button", { name: "Table tools", exact: true }).click();
  const menu = table.getByRole("dialog", { name: "Table tools", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Secondary tools open a modal drawer and return focus to Table tools on close. */
export async function openTableTool(page: Page, name: string) {
  const menu = await openTableTools(page);
  await menu.getByRole("navigation", { name: "More play tools", exact: true }).getByRole("button", { name, exact: true }).click();
  await expect(menu).toBeHidden();
  const drawer = page.getByRole("dialog", { name, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  return drawer;
}
