import { expect, test } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";

test("wrong passcode shows an error and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill("wrong-pass");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Wrong passcode")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("right passcode lands on Today", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});
