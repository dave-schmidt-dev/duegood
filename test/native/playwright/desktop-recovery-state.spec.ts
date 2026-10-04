import { expect, test, type Page } from "@playwright/test";

interface Calls { status: number; snapshots: number; restores: number }
interface MockSetup { readonly snapshotFirst: "fail" | "hold"; readonly restore: "success" | "hold" | "fail" }

/** Synthetic IPC only: held reads make each visible state independently assertable. */
function installMock(setup: MockSetup): void {
  type Release = (value?: unknown) => void;
  const scope = window as unknown as { __releaseStatus?: Release; __releaseSnapshots?: Release; __releaseRestore?: Release; __calls?: Calls; __TAURI_INTERNALS__?: unknown; isTauri?: boolean };
  let statusAttempt = 0;
  let snapshotsAttempt = 0;
  const readyStatus = (): Record<string, unknown> => ({
    availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
    legacyRootSelected: false, importedAt: null, files: 1, bytes: 1,
    canvasRefreshEnabled: false, refreshAvailable: false, icalRefreshAvailable: false, snapshotInProgress: false, snapshotProgress: null, problem: null,
  });
  scope.__calls = { status: 0, snapshots: 0, restores: 0 };
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
    invoke: async (command: string): Promise<unknown> => {
      if (command === "store_status") {
        scope.__calls!.status += 1;
        statusAttempt += 1;
        if (statusAttempt === 1) return await new Promise((resolve, reject) => { scope.__releaseStatus = (value) => value === "fail" ? reject({ code: "unavailable", message: "Synthetic store read failed." }) : resolve(readyStatus()); });
        return readyStatus();
      }
      if (command === "list_snapshots") {
        scope.__calls!.snapshots += 1;
        snapshotsAttempt += 1;
        if (snapshotsAttempt === 1) return await new Promise((resolve, reject) => { scope.__releaseSnapshots = (value) => setup.snapshotFirst === "fail" || value === "fail" ? reject({ code: "unavailable", message: "Synthetic recovery read failed." }) : resolve(value); });
        return [];
      }
      if (command === "restore_snapshot") {
        scope.__calls!.restores += 1;
        if (setup.restore === "fail") throw { code: "restore-failed", message: "Synthetic restore failed." };
        if (setup.restore === "hold") return await new Promise((resolve) => { scope.__releaseRestore = resolve; });
        return null;
      }
      if (command === "read_dashboard_documents") return {
        storeState: "authoritative",
        coursework: { text: JSON.stringify({ generated: new Date().toISOString(), courses: [{ key: "syn-101", canvasCourseId: 101, code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", active: true, folder: "syn-101", gradeGroups: [] }], items: [] }), version: "c".repeat(64) },
        refreshHistory: null, conversations: null, profile: JSON.stringify({ name: "Synthetic Learner" }), avatar: null,
        courseExports: { "syn-101": { files: JSON.stringify([]), pages: null, modules: null, announcements: null, downloadManifest: JSON.stringify([]) } },
      };
      if (command === "read_avatar_bytes") return null;
      throw { code: "unexpected", message: command };
    },
  };
}

async function open(page: Page, snapshotFirst: "fail" | "hold", restore: "success" | "hold" | "fail" = "success"): Promise<void> {
  await page.addInitScript(installMock, { snapshotFirst, restore });
  await page.goto("/");
}

async function openReadyRecovery(page: Page, restore: "success" | "hold" | "fail" = "success"): Promise<ReturnType<Page["getByRole"]>> {
  await open(page, "hold", restore);
  await page.evaluate(() => (window as unknown as { __releaseStatus: (value: string) => void }).__releaseStatus("ready"));
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  const recovery = page.getByRole("region", { name: "Recovery points" });
  await page.evaluate(() => (window as unknown as { __releaseSnapshots: (value: unknown) => void }).__releaseSnapshots([{ id: "daily-20261001T120000Z-0123abcd", createdAt: "2026-10-01T12:00:00Z", kind: "daily" }]));
  await expect(recovery.getByRole("button", { name: "Restore snapshot" })).toBeVisible();
  return recovery;
}

async function clickTwice(page: Page, name: string): Promise<void> {
  await page.evaluate((buttonName) => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === buttonName);
    button?.click(); button?.click();
  }, name);
}

test("main recovery controls use accepted action classes and non-default button styling", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const recovery = await openReadyRecovery(page);
  const controls = [
    { locator: recovery.getByRole("button", { name: "Restore snapshot" }), className: "more-action" },
    { locator: recovery.getByRole("button", { name: "Export rollback folder…" }), className: "more-action" },
    { locator: recovery.getByRole("button", { name: "Back to dashboard" }), className: "setup-secondary" },
  ];
  for (const control of controls) await expect(control.locator).toHaveClass(control.className);
  const styles = await Promise.all(controls.map(async ({ locator }) => locator.evaluate((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, borderStyle: style.borderStyle };
  })));
  expect(styles[0]).toEqual({ background: styles[1]?.background, borderStyle: "solid" });
  expect(styles[1]?.background).not.toBe("rgb(239, 239, 239)");
  expect(styles[2]).toEqual({ background: "rgba(0, 0, 0, 0)", borderStyle: "none" });
});

for (const viewport of [{ width: 720, height: 560 }, { width: 1280, height: 840 }] as const) {
  test(`held reads show feedback and reject duplicate retries at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "fail");
    await expect(page.getByRole("status")).toHaveText("Checking the local app store…");
    await expect(page.getByRole("heading", { level: 1, name: "Opening your coursework" })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __releaseStatus: (value: string) => void }).__releaseStatus("fail"));
    await expect(page.getByRole("alert")).toContainText("Synthetic store read failed.");
    await clickTwice(page, "Retry");
    await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.status)).toBe(2);

    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Recovery", exact: true }).click();
    const recovery = page.getByRole("region", { name: "Recovery points" });
    await expect(recovery).toContainText("Finding recovery points…");
    await expect(recovery).not.toContainText("No recovery points are available yet.");
    await page.evaluate(() => (window as unknown as { __releaseSnapshots: (value: string) => void }).__releaseSnapshots("fail"));
    await expect(recovery.getByRole("alert")).toContainText("Synthetic recovery read failed.");
    await expect(recovery.getByRole("button", { name: "Retry recovery points" })).toHaveClass("more-action");
    await clickTwice(page, "Retry recovery points");
    await expect(recovery).toContainText("No recovery points are available yet.");
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.snapshots)).toBe(2);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  });

  test(`a stale recovery list cannot replace a reopened screen at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "hold");
    await page.evaluate(() => (window as unknown as { __releaseStatus: (value: string) => void }).__releaseStatus("ready"));
    await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Recovery", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recovery points" })).toContainText("Finding recovery points…");
    await page.getByRole("button", { name: "Back to dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
    await page.getByRole("button", { name: "Recovery", exact: true }).click();
    const reopened = page.getByRole("region", { name: "Recovery points" });
    await expect(reopened).toContainText("No recovery points are available yet.");
    await page.evaluate(() => (window as unknown as { __releaseSnapshots: (value: unknown) => void }).__releaseSnapshots([{ id: "daily-stale", createdAt: "2026-10-01T12:00:00Z", kind: "daily" }]));
    await expect(reopened).not.toContainText("Daily snapshot");
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.snapshots)).toBe(2);
  });

  test(`cancel keeps recovery selected and makes no restore IPC at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const recovery = await openReadyRecovery(page);
    await recovery.getByRole("button", { name: "Restore snapshot" }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm snapshot restore" });
    await expect(confirmation).toContainText("archives the current app store before restoring this recovery point");
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(0);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(recovery.getByRole("button", { name: "Restore snapshot" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  });

  test(`confirm starts one restore IPC and rejects duplicate confirmation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const recovery = await openReadyRecovery(page, "hold");
    await recovery.getByRole("button", { name: "Restore snapshot" }).click();
    await clickTwice(page, "Restore selected snapshot");
    const confirmation = page.getByRole("dialog", { name: "Confirm snapshot restore" });
    await expect(confirmation.getByRole("button", { name: "Restoring selected snapshot…" })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(1);
    await page.evaluate(() => (window as unknown as { __releaseRestore: () => void }).__releaseRestore());
    await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(1);
  });

  test(`restore failure retains the selected confirmation without automatic retry at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const recovery = await openReadyRecovery(page, "fail");
    await recovery.getByRole("button", { name: "Restore snapshot" }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm snapshot restore" });
    await confirmation.getByRole("button", { name: "Restore selected snapshot" }).click();
    await expect(page.getByRole("alert")).toContainText("Synthetic restore failed.");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(confirmation.getByRole("button", { name: "Restore selected snapshot" })).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(1);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(1);
    await confirmation.getByRole("button", { name: "Restore selected snapshot" }).click();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(2);
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(recovery.getByRole("button", { name: "Restore snapshot" })).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(2);
  });

  test(`keyboard cancel returns focus to the originating restore row with no restore IPC at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const recovery = await openReadyRecovery(page);
    const restore = recovery.getByRole("button", { name: "Restore snapshot" });
    await restore.focus();
    await page.keyboard.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "Confirm snapshot restore" });
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(restore).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.restores)).toBe(0);
  });
}
