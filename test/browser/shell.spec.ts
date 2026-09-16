import { expect, test } from "@playwright/test";
import { automaticAccessibilityViolations } from "./a11y";

test("renders the disabled-authentication shell without automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Due Good");
  await expect(page.getByRole("heading", { level: 1, name: "Due Good" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Canvas connection unavailable");
  await expect(page.getByRole("status")).toContainText("Institution-enabled OAuth has not been configured");
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});
