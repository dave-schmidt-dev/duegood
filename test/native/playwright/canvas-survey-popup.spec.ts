import { expect, test } from "@playwright/test";
import { dismissSurveyPopup } from "../../../scripts/canvas-survey-popup.mjs";

const canvas = "https://marymount.instructure.com";
const later = '<a class="ek-widget-btn-default"> Do It Later </a>';
const close = '<a id="ek-modal-close">Close</a>';
for (const scenario of [
  { name: "absent", controls: "", absent: true, expected: "ABSENT", clicks: [] },
  { name: "delayed reminder", controls: close.replace("<a", "<a hidden") + later, expected: "DISMISSED", clicks: ["later"] },
  { name: "visible close", controls: close + later, expected: "DISMISSED", clicks: ["close"] },
  { name: "ineffective click", controls: later, sticky: true, expected: "UNDISMISSED", clicks: ["later"] },
  { name: "no-op JavaScript reminder", controls: later.replace("<a", '<a href="javascript:void(0);"'), expected: "DISMISSED", clicks: ["later"] },
  { name: "fragment reminder", controls: later.replace("<a", '<a href="#"'), expected: "DISMISSED", clicks: ["later"] },
  { name: "executable JavaScript reminder", controls: later.replace("<a", '<a href="javascript:alert(1)"'), expected: "UNDISMISSED", clicks: [] },
  { name: "external dismiss link", controls: later.replace("<a", '<a href="https://example.invalid/"'), expected: "UNDISMISSED", clicks: [] },
  { name: "other origin", controls: later, other: true, expected: "ABSENT", clicks: [] },
  { name: "mislabelled default", controls: later.replace("Do It Later", "Skip survey"), expected: "UNDISMISSED", clicks: [] },
  { name: "submit button", controls: '<button class="ek-widget-btn-default">Do It Later</button>', expected: "UNDISMISSED", clicks: [] },
]) {
  test(scenario.name, async ({ page }) => {
    const origin = scenario.other ? "https://example.invalid" : canvas;
    await page.context().route("**/*", route => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
    await page.goto(origin);
    await page.evaluate(({ controls, absent, delayed, sticky }) => {
      document.body.dataset.clicks = "[]";
      if (absent) return;
      function show() {
        document.body.innerHTML = '<div id="ek-modal" role="dialog"><a class="ek-widget-btn-primary">Go To Survey</a>' + controls + "</div>";
        document.body.addEventListener("click", event => {
          event.preventDefault();
          const el = event.target as HTMLElement;
          const clicks = JSON.parse(document.body.dataset.clicks!);
          clicks.push(el.id ? "close" : el.matches(".ek-widget-btn-default") ? "later" : "survey");
          document.body.dataset.clicks = JSON.stringify(clicks);
          if (!sticky) document.querySelector("#ek-modal")?.remove();
        });
      }
      if (delayed) setTimeout(show, 120);
      else show();
    }, { controls: scenario.controls, absent: !!scenario.absent, delayed: scenario.name === "delayed reminder", sticky: !!scenario.sticky });
    expect(await dismissSurveyPopup(page, { settleMs: 500, confirmMs: 200 })).toBe(scenario.expected);
    expect(await page.locator("body").getAttribute("data-clicks")).toBe(JSON.stringify(scenario.clicks));
  });
}
