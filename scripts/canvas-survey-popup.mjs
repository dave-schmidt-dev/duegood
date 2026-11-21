/* global location, document, HTMLAnchorElement, HTMLButtonElement */
import { CANVAS_ORIGIN } from "./canvas-okta-sign-in.mjs";

const modal = "#ek-modal[role=dialog]";
/** @typedef {any} Page  A Playwright page (untyped: the browser runtime bundles no test-package types). */

/** Wait for the owner or the click to clear the dialog on the original host.
 * @param {Page} page @param {number} deadline
 */
async function cleared(page, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return false;
  try {
    await page.locator(modal).waitFor({ state: "hidden", timeout });
    return new URL(page.url()).origin === CANVAS_ORIGIN;
  } catch { return false; }
}

/** Inspect only the top-level Canvas document and click a reviewed dismiss control.
 * @param {Page} page
 * @param {{settleMs?: number, confirmMs?: number, deadline?: number}} options
 * @returns {Promise<"ABSENT" | "DISMISSED" | "UNDISMISSED">}
 */
export async function dismissSurveyPopup(page, {
  settleMs = 4000, confirmMs = 5000, deadline = Date.now() + 10000,
} = {}) {
  try {
    if (new URL(page.url()).origin !== CANVAS_ORIGIN) return "ABSENT";
    const timeout = Math.min(settleMs, deadline - Date.now());
    if (timeout <= 0) return "UNDISMISSED";
    const dialog = page.locator(modal);
    try {
      await dialog.waitFor({ state: "visible", timeout });
    } catch (error) {
      if (error?.name === "TimeoutError" && new URL(page.url()).origin === CANVAS_ORIGIN
          && !(await dialog.isVisible())) return "ABSENT";
      return "UNDISMISSED";
    }
    // Validate and click in one document turn so a re-render cannot swap the target.
    const clicked = await page.evaluate(({ modal, origin, deadline }) => {
      if (location.origin !== origin || Date.now() >= deadline) return false;
      const dialogs = document.querySelectorAll(modal);
      if (dialogs.length !== 1) return false;
      const visible = (el) => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0;
      const dialog = dialogs[0];
      if (!visible(dialog)) return false;
      const control = [...dialog.querySelectorAll("a#ek-modal-close")].find(visible)
        ?? [...dialog.querySelectorAll(".ek-widget-btn-default")].find((el) =>
          visible(el) && /^do it later$/iu.test(el.textContent.trim()));
      if (!control || control.matches(".ek-widget-btn-primary") || /survey/iu.test(control.textContent)
          || control.closest(".ek-widget-btn-primary") || control.querySelector(".ek-widget-btn-primary")) return false;
      if (control instanceof HTMLAnchorElement) {
        const rawHref = control.getAttribute("href");
        if (rawHref !== null && !rawHref.startsWith("#")
            && !/^javascript:\s*(void\s*\(\s*0\s*\)\s*;?|;)?\s*$/i.test(rawHref)) {
          const href = new URL(rawHref, document.baseURI);
          if (href.protocol !== "https:" || href.origin !== origin) return false;
        }
      } else if (!(control instanceof HTMLButtonElement && control.type === "button")) return false;
      control.click();
      return true;
    }, { modal, origin: CANVAS_ORIGIN, deadline });
    return clicked && await cleared(page, Math.min(deadline, Date.now() + confirmMs)) ? "DISMISSED" : "UNDISMISSED";
  } catch { return "UNDISMISSED"; }
}

/** @param {Page} page @param {{deadline: number, attended: boolean, progress: (code: string) => void}} options */
export async function handleSurveyPopup(page, { deadline, attended, progress }) {
  if (await dismissSurveyPopup(page, { deadline }) !== "UNDISMISSED") return;
  if (attended) {
    progress("SURVEY_POPUP_BLOCKING");
    if (await cleared(page, deadline)) return;
  }
  throw new Error("SURVEY_POPUP_BLOCKING");
}
