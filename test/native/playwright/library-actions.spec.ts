import { expect, test } from "@playwright/test";

interface RecordedCall { readonly command: string; readonly args: Record<string, unknown> }

/** Installs a bounded native IPC mock with two independently pending Library resources. */
function installLibraryActionMock(): void {
  const scope = window as unknown as Record<string, unknown>;
  const calls: RecordedCall[] = [];
  const releases: (() => void)[] = [];
  scope.__ipcCalls = calls;
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback() { return 1; },
    unregisterCallback() {},
    async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
      if (command === "store_status") return { availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood", legacyRootSelected: false, importedAt: "2026-10-01T12:00:00Z", files: 2, bytes: 1024, canvasRefreshEnabled: false, refreshAvailable: false, icalRefreshAvailable: false, snapshotInProgress: false, snapshotProgress: null, problem: null };
      if (command === "read_dashboard_documents") return {
        storeState: "authoritative",
        coursework: { text: JSON.stringify({ generated: "2026-10-01T12:00:00Z", courses: [{ key: "syn-101", code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", folder: "syn-101" }], items: [] }), version: "c".repeat(64) },
        refreshHistory: null,
        conversations: null,
        profile: JSON.stringify({ name: "Synthetic Learner" }),
        avatar: null,
        courseExports: {
          "syn-101": {
            files: JSON.stringify([{ id: 1, display_name: "Synthetic syllabus", updated_at: "2026-10-01T00:00:00Z" }, { id: 2, display_name: "Synthetic handout", updated_at: "2026-10-02T00:00:00Z" }]),
            pages: JSON.stringify([{ page_id: 3, title: "Synthetic course page", updated_at: "2026-10-03T00:00:00Z", detail: "## Page overview\n\nPage paragraph.\n\n1. Numbered step\n- Bullet step", bodyHtml: "<h2>Page overview</h2>", bodyEmpty: false }]),
            modules: null,
            announcements: JSON.stringify([{ id: 4, title: "Synthetic announcement", posted_at: "2026-10-04T00:00:00Z", detail: "Announcement body text.", bodyHtml: "<p>Announcement body text.</p>", bodyEmpty: false }]),
            quizzes: JSON.stringify([{ id: 5, title: "Synthetic quiz", updated_at: "2026-10-05T00:00:00Z", detail: "Quiz body text.", bodyHtml: "<p>Quiz body text.</p>", bodyEmpty: false }]),
            downloadManifest: JSON.stringify([{ id: 1, status: "downloaded", filename: "syllabus.pdf" }, { id: 2, status: "downloaded", filename: "handout.pdf" }]),
          },
        },
      };
      if (command === "read_avatar_bytes") return null;
      if (command === "open_library_resource") {
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return args.id === "syn-101:file:2" ? "downloaded" : "opened";
      }
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
  scope.__releaseLibraryActions = () => { for (const release of releases.splice(0)) release(); };
}

test("Library actions latch a pending resource and keep feedback beside each row", async ({ page }) => {
  await page.addInitScript(installLibraryActionMock);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Library", exact: true }).click();

  const syllabus = page.locator(".resource-row").filter({ hasText: "Synthetic syllabus" });
  const handout = page.locator(".resource-row").filter({ hasText: "Synthetic handout" });
  const syllabusAction = syllabus.getByRole("button", { name: "Open or save" });
  await syllabusAction.click();
  await expect(syllabus.getByRole("button", { name: "Opening…" })).toBeDisabled();
  await expect(syllabus.locator("[data-resource-action='syn-101:file:1']")).toHaveText("Opening the saved library file…");

  await syllabus.getByRole("button", { name: "Opening…" }).evaluate((button) => button.dispatchEvent(new Event("click", { bubbles: true })));
  await handout.getByRole("button", { name: "Open or save" }).click();
  const pendingCalls = await page.evaluate(() => (window as unknown as { __ipcCalls: RecordedCall[] }).__ipcCalls.filter((call) => call.command === "open_library_resource"));
  expect(pendingCalls).toEqual([
    { command: "open_library_resource", args: { id: "syn-101:file:1" } },
    { command: "open_library_resource", args: { id: "syn-101:file:2" } },
  ]);

  await page.evaluate(() => (window as unknown as { __releaseLibraryActions: () => void }).__releaseLibraryActions());
  await expect(syllabus.locator("[data-resource-action='syn-101:file:1']")).toHaveText("File opened.");
  await expect(handout.locator("[data-resource-action='syn-101:file:2']")).toHaveText("File saved.");
});

test("Library discloses structured bodies for pages, quizzes, and announcements", async ({ page }) => {
  await page.addInitScript(installLibraryActionMock);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Library", exact: true }).click();

  const pageRow = page.locator(".resource-row").filter({ hasText: "Synthetic course page" });
  const quizRow = page.locator(".resource-row").filter({ hasText: "Synthetic quiz" });
  const announcementRow = page.locator(".resource-row").filter({ hasText: "Synthetic announcement" });
  await pageRow.getByText("Read body").click();
  await expect(pageRow.locator("h4")).toHaveText("Page overview");
  await expect(pageRow.locator("ol")).toContainText("Numbered step");
  await expect(pageRow.locator("ul")).toContainText("Bullet step");
  await quizRow.getByText("Read body").click();
  await expect(quizRow.locator(".event-body")).toContainText("Quiz body text.");
  await announcementRow.getByText("Read body").click();
  await expect(announcementRow.locator(".event-body")).toContainText("Announcement body text.");
  await expect(page.locator(".resource-row script, .resource-row iframe")).toHaveCount(0);
});
