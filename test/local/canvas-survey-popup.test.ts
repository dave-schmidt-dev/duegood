import { expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { dismissSurveyPopup, handleSurveyPopup } from "../../scripts/canvas-survey-popup.mjs";

const origin = "https://marymount.instructure.com";
function blockingPage() {
  const waitFor = vi.fn(async () => {});
  const page = { url: () => origin, locator: () => ({ waitFor }), evaluate: async () => false };
  return { page: page as unknown as Page, waitFor };
}

it("ignores lookalike hosts without inspecting their document", async () => {
  const locator = vi.fn();
  expect(await dismissSurveyPopup({ url: () => origin + ".invalid", locator } as unknown as Page)).toBe("ABSENT");
  expect(locator).not.toHaveBeenCalled();
});

it("fails immediately when headless", async () => {
  const { page, waitFor } = blockingPage();
  const progress = vi.fn();
  await expect(handleSurveyPopup(page, { deadline: Date.now() + 1000, attended: false, progress }))
    .rejects.toThrow("SURVEY_POPUP_BLOCKING");
  expect(progress).not.toHaveBeenCalled();
  expect(waitFor).toHaveBeenCalledTimes(1);
});

it("reports a blocking reminder and waits for the owner within the deadline", async () => {
  const { page, waitFor } = blockingPage();
  const progress = vi.fn();
  await handleSurveyPopup(page, { deadline: Date.now() + 1000, attended: true, progress });
  expect(progress).toHaveBeenCalledWith("SURVEY_POPUP_BLOCKING");
  expect(waitFor.mock.lastCall).toEqual([{ state: "hidden", timeout: expect.any(Number) }]);
});
