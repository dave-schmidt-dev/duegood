import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export async function automaticAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations;
}
