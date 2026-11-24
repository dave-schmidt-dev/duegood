import { expect, test } from "@playwright/test";
import { automaticAccessibilityViolations } from "./a11y";
import { DATA_FOLDER, dryRunSection, expectNoHorizontalOverflow, expectNoPathArguments, importButton, installTauriMock, ipcCalls, openDesktop, scenario, type RecordedCall } from "./desktop-first-run-fixtures";

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }] as const) {
  test.describe(`desktop app screens at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("first run: calendar connection creates the native dashboard without a legacy folder", async ({ page }) => {
      const apiRequests = await openDesktop(page, scenario({ icalReady: true }));
      await expect(page.getByRole("heading", { level: 1, name: "Connect your Canvas calendar" })).toBeVisible();
      await expect(page.getByText("Add assignments and dates from your Canvas calendar.", { exact: true })).toBeVisible();
      const importDetails = page.locator("details").filter({ has: page.getByText("About calendar import", { exact: true }) });
      await expect(importDetails).toHaveCount(1);
      await expect(importDetails).not.toHaveAttribute("open", "");
      await expect(importDetails).toContainText("They do not include grades, messages, or progress saved in an older Due Good folder.");
      await expect(importDetails.locator(".setup-path")).toHaveText(DATA_FOLDER);
      await expect(page.getByText(/API token|credential/i)).toHaveCount(0);
      await importDetails.getByText("About calendar import", { exact: true }).click();
      await expect(importDetails).toHaveAttribute("open", "");
      await expect(importDetails.getByText("Calendar events can supply assignments and dates. They do not include grades, messages, or progress saved in an older Due Good folder.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose legacy folder…" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(await automaticAccessibilityViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "Connect calendar" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
      await expect(page.locator(".top-actions .refresh-button")).toBeEnabled();
      await expect(page.locator(".top-actions .preview-badge")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      const calls = await expectNoPathArguments(page);
      expect(calls.map((call) => call.command)).toEqual(["store_status", "start_ical_refresh", "store_status", "read_dashboard_documents", "read_avatar_bytes", "start_ical_refresh", "read_dashboard_documents", "read_avatar_bytes", "store_status"]);
      expect(apiRequests).toEqual([]);
    });

    test("replace preview: keep the current copy, then archive and replace it", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview" }));
      await expect(page.locator(".top-actions .preview-badge")).toHaveText("Preview copy");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const card = page.locator("[data-desktop-store=preview]");
      await expect(card).toContainText("It does not follow later source changes.");
      await expect(card.locator(".setup-path")).toHaveText(DATA_FOLDER);

      await card.getByRole("button", { name: "Replace preview copy…" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Replace the preview copy" })).toBeVisible();
      await expect(page.getByText("timestamped backup that is never deleted", { exact: false })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Keep current preview copy" }).click();
      await expect(page.locator(".top-actions .preview-badge")).toHaveText("Preview copy");

      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Replace preview copy…" }).click();
      await page.getByRole("button", { name: "Choose legacy folder…" }).click();
      await expect(dryRunSection(page)).toBeVisible();
      await page.getByRole("button", { name: "Archive and replace preview copy" }).click();
      await expect(page.locator(".top-actions .preview-badge")).toHaveText("Preview copy");

      const calls = await expectNoPathArguments(page);
      const imports = calls.filter((call) => call.command === "import_legacy_root");
      expect(imports).toHaveLength(1);
      expect(imports[0]?.args.replacePreview).toBe(true);
      expect(calls.filter((call) => call.command === "choose_legacy_root")).toHaveLength(1);
    });

    test("import refusals show named counts and never start or keep a partial import", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", dryRunRefusals: { escapingMaterialSymlinks: 2, malformedJson: 1 } }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Replace preview copy…" }).click();
      await page.getByRole("button", { name: "Choose legacy folder…" }).click();
      const refusals = dryRunSection(page).locator(".setup-refusals li");
      await expect(refusals).toHaveCount(2);
      await expect(refusals.filter({ hasText: "Material links that leave the materials folder" })).toContainText("2");
      await expect(refusals.filter({ hasText: "Malformed JSON documents" })).toContainText("1");
      await expect(dryRunSection(page)).toContainText("Nothing is dropped silently");
      await expect(importButton(page)).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      expect((await ipcCalls(page)).some((call) => call.command === "import_legacy_root")).toBe(false);
      await expectNoPathArguments(page);
    });

    test("an import refused after the dry run reports named counts and keeps the selection", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", importError: { code: "refused", message: "The legacy folder cannot be imported as it is. Nothing was changed.", refusals: { duplicateItemIds: 3 } } }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Replace preview copy…" }).click();
      await page.getByRole("button", { name: "Choose legacy folder…" }).click();
      await importButton(page).click();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("The legacy folder cannot be imported as it is. Nothing was changed.");
      await expect(alert.locator(".setup-refusals li")).toHaveText([/Duplicate item IDs\s*3/]);
      await expect(page.getByRole("heading", { level: 1, name: "Replace the preview copy" })).toBeVisible();
      await expect(page.locator(".setup-step")).toHaveText("Folder selected. Its location is never shown or stored.");
      await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
      await expect(importButton(page)).toBeDisabled();
      await expect(page.locator(".top-actions")).toHaveCount(0);
      await expectNoPathArguments(page);
    });

    test("refresh is unavailable: no refresh control for a preview or an authoritative store", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative" }));
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
      await expect(page.locator(".top-actions .preview-badge")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /refresh/i })).toHaveCount(0);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const card = page.locator("[data-desktop-store=authoritative]");
      await expect(card).toContainText("Import never replaces it.");
      await expect(card.getByRole("button", { name: "Return app store to preview…" })).toBeVisible();
      await expect(card.getByRole("button", { name: /refresh/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /refresh/i })).toHaveCount(0);
      await expect(page.getByText("Last refresh", { exact: true })).toHaveCount(0);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Library", exact: true }).click();
      const saved = page.locator(".resource-row").filter({ hasText: "Synthetic syllabus" });
      await expect(saved).toContainText("Open or save");
      await saved.getByRole("button", { name: "Open or save" }).click();
      await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      const calls = await expectNoPathArguments(page);
      expect(calls.map((call) => call.command)).toEqual(["store_status", "read_dashboard_documents", "read_avatar_bytes", "open_library_resource"]);
    });

    test("the owner can enable refresh without implying it is available", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", helperReady: false }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const toggle = page.getByRole("checkbox", { name: "Enable Canvas refresh" });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect(toggle).toBeChecked();
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Canvas refresh is unavailable on this computer.");
      await expect(page.getByRole("button", { name: /refresh/i })).toHaveCount(0);
      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "set_canvas_refresh_enabled")).toEqual([{ command: "set_canvas_refresh_enabled", args: { enabled: true } }]);
    });

    test("configured native refresh streams progress and reports an incomplete run truthfully", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", canvasRefreshEnabled: true, helperReady: true, holdRefresh: true, refreshStatus: "incomplete" }));
      const refresh = page.locator(".top-actions").getByRole("button", { name: "Refresh" });
      await expect(refresh).toBeVisible();
      await refresh.click();
      await expect(page.locator(".refresh-details p")).toContainText("Canvas refresh · Reading Canvas data · 2 of 4 completed · 8192 bytes received");
      await expect(refresh).toBeDisabled();
      await page.waitForFunction(() => typeof (window as unknown as { __releaseRefresh?: unknown }).__releaseRefresh === "function");
      await page.evaluate(() => (window as unknown as { __releaseRefresh: () => void }).__releaseRefresh());
      await expect(page.locator(".refresh-details p")).toHaveText("Refresh incomplete. Existing data was kept.");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Last refresh");
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Sep 23");
      const calls = await expectNoPathArguments(page);
      const start = calls.find((call) => call.command === "start_canvas_refresh");
      expect(start?.args).toMatchObject({ onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) });
      expect(calls.filter((call) => call.command === "read_dashboard_documents")).toHaveLength(3);
    });

    test("native refresh failure reports preserved data without exposing helper error detail", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", canvasRefreshEnabled: true, helperReady: true, refreshError: { code: "synthetic-failure", message: "Private synthetic diagnostic" } }));
      await page.locator(".top-actions").getByRole("button", { name: "Refresh" }).click();
      await expect(page.locator(".refresh-details p")).toHaveText("Refresh failed. Existing data was kept.");
      await expect(page.getByText("Private synthetic diagnostic", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Synthetic essay draft" })).toBeVisible();
      await expectNoPathArguments(page);
    });

    test("native calendar refresh shows counts and sends no feed data through IPC", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", icalReady: true }));
      await page.locator(".top-actions").getByRole("button", { name: "Refresh" }).click();
      await expect(page.locator(".refresh-details p")).toHaveText("Calendar refresh complete · 2 added · 1 updated · 0 held");
      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "start_ical_refresh")).toHaveLength(2);
      expect(calls.filter((call) => call.command === "start_ical_refresh").at(-1)).toEqual(
        { command: "start_ical_refresh", args: { onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) } },
      );
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Calendar feed");
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Available for native refresh.");
    });

    test("syllabus sessions retain their time range without completion controls or writes", async ({ page }) => {
      const start = new Date(Date.now() + 2 * 86_400_000);
      start.setUTCHours(18, 0, 0, 0);
      const session = {
        id: "syn-101-syllabus-session", course: "syn-101", kind: "session", source: "syllabus", title: "Class session",
        at: start.toISOString(), endsAt: new Date(start.getTime() + 150 * 60_000).toISOString(), done: false,
        syllabusSession: { version: 1, canvasCourseId: 101, date: start.toISOString().slice(0, 10), startTime: "18:00", endTime: "20:30", timeZone: "UTC", source: { kind: "course-body", sha256: "a".repeat(64), line: 1 } },
      };
      const coursework = JSON.stringify({
        generated: new Date().toISOString(),
        courses: [{ key: "syn-101", code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", folder: "syn-101" }],
        items: [session],
      });
      const apiRequests = await openDesktop(page, scenario({ state: "authoritative", coursework }));
      const range = await page.evaluate(({ at, endsAt }) => {
        const format = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
        return `${format.format(new Date(at))}–${format.format(new Date(endsAt))}`;
      }, session);
      const meeting = page.locator(".class-meeting");
      await expect(meeting).toBeVisible();
      await expect(meeting.getByRole("heading", { name: "Class session", exact: true })).toBeVisible();
      await expect(meeting.locator(".event-time")).toHaveText(range);
      await expect(meeting.locator("time")).toHaveAttribute("datetime", session.at);
      await expect(meeting.getByRole("checkbox")).toHaveCount(0);
      await meeting.getByRole("button", { name: "Details", exact: true }).click();
      await expect(meeting.getByRole("button", { name: /mark (complete|not done)/i })).toHaveCount(0);
      await page.getByRole("button", { name: "Deadlines only", exact: true }).click();
      await expect(meeting).toHaveCount(0);
      await page.getByRole("button", { name: "All events", exact: true }).click();
      await expect(meeting.locator(".event-time")).toHaveText(range);
      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "read_dashboard_documents")).toHaveLength(1);
      expect(calls.filter((call) => ["set_item_completion", "set_discussion_field"].includes(call.command))).toEqual([]);
      expect(apiRequests).toEqual([]);
    });

    test("native progress edits send only item IDs and prior booleans", async ({ page }) => {
      const apiRequests = await openDesktop(page, scenario({ state: "authoritative" }));
      const essayDone = page.locator('[data-due-item="syn-101-essay"]').getByRole("checkbox", { name: "Mark Synthetic essay draft done" });
      await expect(essayDone).toBeVisible();
      await essayDone.click();
      await expect(essayDone).toHaveCount(0);

      const discussionReplies = page.locator('[data-due-item="syn-101-discussion"]').getByRole("checkbox", { name: "Replied to two classmates" });
      await discussionReplies.check();
      await expect(discussionReplies).toBeChecked();
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Done", exact: true }).click();
      await expect(page.getByText("Synthetic essay draft", { exact: true })).toBeVisible();

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "set_item_completion")).toEqual([
        { command: "set_item_completion", args: { itemId: "syn-101-essay", expected: false, value: true } },
      ]);
      expect(calls.filter((call) => call.command === "set_discussion_field")).toEqual([
        { command: "set_discussion_field", args: { itemId: "syn-101-discussion", field: "replies", expected: false, value: true } },
      ]);
      expect(apiRequests).toEqual([]);
    });

    test("native conflicts reload the latest item and discussion state", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", mutationConflicts: ["set_item_completion", "set_discussion_field"] }));
      const essayDone = page.locator('[data-due-item="syn-101-essay"]').getByRole("checkbox", { name: "Mark Synthetic essay draft done" });
      await essayDone.click();
      await expect(essayDone).toHaveCount(0);

      const discussionReplies = page.locator('[data-due-item="syn-101-discussion"]').getByRole("checkbox", { name: "Replied to two classmates" });
      await discussionReplies.check();
      await expect(discussionReplies).toBeChecked();
      await expect(page.locator('[data-due-item="syn-101-discussion"] .rail-failure')).toHaveText("This discussion changed elsewhere. Latest state reloaded; try again.");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Done", exact: true }).click();
      await expect(page.getByText("Synthetic essay draft", { exact: true })).toBeVisible();

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "set_item_completion")).toEqual([
        { command: "set_item_completion", args: { itemId: "syn-101-essay", expected: false, value: true } },
      ]);
      expect(calls.filter((call) => call.command === "set_discussion_field")).toEqual([
        { command: "set_discussion_field", args: { itemId: "syn-101-discussion", field: "replies", expected: false, value: true } },
      ]);
      expect(calls.filter((call) => call.command === "read_dashboard_documents")).toHaveLength(3);
    });

    test("snapshot recovery lists generated IDs and restores only the selected ID", async ({ page }) => {
      const setup = scenario({ state: "authoritative" });
      await openDesktop(page, setup);
      await expect(page.locator(".topbar").getByRole("button", { name: "Recovery", exact: true })).toHaveCount(0);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Recovery", exact: true }).click();
      const recoveryPoints = page.getByRole("region", { name: "Recovery points" });
      await expect(recoveryPoints).toContainText("Daily snapshot");
      await recoveryPoints.getByRole("button", { name: "Restore snapshot" }).click();
      const confirmation = page.getByRole("dialog", { name: "Confirm snapshot restore" });
      await expect(confirmation).toContainText("archives the current app store before restoring this recovery point");
      expect((await expectNoPathArguments(page)).filter((call) => call.command === "restore_snapshot")).toHaveLength(0);
      await confirmation.getByRole("button", { name: "Restore selected snapshot" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "list_snapshots")).toHaveLength(1);
      expect(calls.filter((call) => call.command === "restore_snapshot")).toEqual([
        { command: "restore_snapshot", args: { id: setup.snapshotId } },
      ]);
    });

    test("rollback export streams progress through a channel and shows completion", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative" }));
      await expect(page.locator(".topbar").getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await expect(page.getByText("Rollback folder exported.", { exact: true })).toBeVisible();
      await expect(page.getByText("2 files copied", { exact: true })).toBeVisible();

      const calls = await expectNoPathArguments(page);
      const exports = calls.filter((call) => call.command === "export_legacy_folder");
      expect(exports).toHaveLength(1);
      expect(exports[0]?.args.onProgress).toMatch(/^__CHANNEL__:\d+$/);
      expect(calls.filter((call) => call.command === "list_snapshots")).toHaveLength(1);
    });

    test("promotion requires a backup comparison, a UI confirmation, and the native confirmation command", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", holdTransition: "prepare" }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const preview = page.locator("[data-desktop-store=preview]");
      await expect(preview.getByRole("button", { name: "Promote to authoritative store" })).toHaveCount(0);
      await preview.getByRole("button", { name: "Choose and compare backup…" }).click();
      await expect(preview).toContainText("5 files · 20480 bytes processed.");
      await expect(preview.getByRole("button", { name: "Comparing backup…" })).toBeDisabled();
      await page.waitForFunction(() => typeof (window as unknown as { __releaseTransition?: unknown }).__releaseTransition === "function");
      await page.evaluate(() => (window as unknown as { __releaseTransition: () => void }).__releaseTransition());
      await expect(preview).toContainText("Exact comparison passed: 5 files · 20 KB");
      await expect(preview).toContainText("native dialog");
      await expect(page.locator("body")).not.toContainText("synthetic-proof-0001");
      await preview.getByRole("button", { name: "Promote to authoritative store" }).click();
      await expect(page.locator("[data-desktop-store=authoritative]")).toBeVisible();
      await expect(page.locator("[data-desktop-store=authoritative]").getByText(/^Promotion complete\./)).toBeVisible();

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => ["prepare_store_promotion", "confirm_store_promotion"].includes(call.command))).toEqual([
        { command: "prepare_store_promotion", args: { onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) } },
        { command: "confirm_store_promotion", args: { proofId: "synthetic-proof-0001", onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) } },
      ]);
      expect(calls.every((call) => !Object.hasOwn(call.args, "confirmed"))).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __ipcCalls: RecordedCall[] }).__ipcCalls.some((call) => call.command.startsWith("/")))).toBe(false);
    });

    test("promotion picker and native confirmation cancellations leave preview truthful and consume the proof", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", transitionCancel: "prepare" }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      let preview = page.locator("[data-desktop-store=preview]");
      await preview.getByRole("button", { name: "Choose and compare backup…" }).click();
      await expect(preview).toContainText("Backup selection cancelled. The app store remains a preview copy.");
      expect((await ipcCalls(page)).some((call) => call.command === "confirm_store_promotion")).toBe(false);

      // A new page gives the native confirmation a separate cancellation response.
      await page.reload();
      await page.addInitScript(installTauriMock, scenario({ state: "preview", transitionCancel: "confirm" }));
      await page.goto("/");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      preview = page.locator("[data-desktop-store=preview]");
      await preview.getByRole("button", { name: "Choose and compare backup…" }).click();
      await preview.getByRole("button", { name: "Promote to authoritative store" }).click();
      await expect(preview).toContainText("Promotion cancelled. The app store remains a preview copy");
      await expect(preview.getByRole("button", { name: "Promote to authoritative store" })).toHaveCount(0);
      await expectNoPathArguments(page);
    });

    test("a refused promotion clears its proof and exposes a fresh comparison retry", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", transitionFail: "confirm" }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const preview = page.locator("[data-desktop-store=preview]");
      await preview.getByRole("button", { name: "Choose and compare backup…" }).click();
      await preview.getByRole("button", { name: "Promote to authoritative store" }).click();
      await expect(preview.getByRole("alert")).toHaveText("The preview changed after comparison. Compare the backup again.");
      await expect(preview.getByRole("button", { name: "Promote to authoritative store" })).toHaveCount(0);
      await expect(preview.getByRole("button", { name: "Choose and compare backup…" })).toBeEnabled();
      await expectNoPathArguments(page);
    });

    test("rollback demotes first, disables refresh, then exports and verifies the frozen legacy source", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", canvasRefreshEnabled: true }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const authoritative = page.locator("[data-desktop-store=authoritative]");
      await authoritative.getByRole("button", { name: "Return app store to preview…" }).click();
      await expect(page.locator("[data-desktop-store=preview]")).toBeVisible();
      await expect(page.locator("[data-desktop-store=preview]")).toContainText("Canvas refresh is unavailable for a preview copy.");
      await page.locator("[data-desktop-store=preview]").getByRole("button", { name: "Export frozen rollback copy…" }).click();
      await expect(page.locator("[data-desktop-store=preview]")).toContainText("Frozen rollback export verified. Use this copy when restoring the legacy local source.");

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => ["demote_store_for_rollback", "export_frozen_for_rollback"].includes(call.command)).map((call) => [call.command, call.args])).toEqual([
        ["demote_store_for_rollback", { onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) }],
        ["export_frozen_for_rollback", { onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) }],
      ]);
      expect(calls.every((call) => !Object.hasOwn(call.args, "confirmed"))).toBe(true);
    });

    test("cancelling native rollback confirmation preserves the authoritative app store", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", transitionCancel: "demote" }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      const authoritative = page.locator("[data-desktop-store=authoritative]");
      await authoritative.getByRole("button", { name: "Return app store to preview…" }).click();
      await expect(authoritative).toContainText("Rollback cancelled. The app store remains authoritative.");
      await expect(page.locator("[data-desktop-store=preview]")).toHaveCount(0);
      expect((await ipcCalls(page)).some((call) => call.command === "export_frozen_for_rollback")).toBe(false);
      await expectNoPathArguments(page);
    });

    test("a mismatched or cancelled frozen export is reported and can be retried", async ({ page }) => {
      await openDesktop(page, scenario({ state: "preview", frozenExportEqual: false }));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      let preview = page.locator("[data-desktop-store=preview]");
      await preview.getByRole("button", { name: "Export frozen rollback copy…" }).click();
      await expect(preview.getByRole("alert")).toHaveText("The exported copy did not match the frozen source. Do not use it for rollback.");
      await expect(preview).not.toContainText("Frozen rollback export verified");

      await page.reload();
      await page.addInitScript(installTauriMock, scenario({ state: "preview", transitionCancel: "export" }));
      await page.goto("/");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      preview = page.locator("[data-desktop-store=preview]");
      await preview.getByRole("button", { name: "Export frozen rollback copy…" }).click();
      await expect(preview).toContainText("Export cancelled. No rollback copy was completed.");
      await expect(preview.getByRole("button", { name: "Export frozen rollback copy…" })).toBeEnabled();
      await expectNoPathArguments(page);
    });

    test("native Copy assignment sends only synthetic assignment text and reports success", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative" }));
      const essay = page.locator('[data-due-item="syn-101-essay"]');
      await essay.getByRole("button", { name: "Copy assignment" }).click();
      const copied = essay.getByRole("button", { name: "Copied" });
      await expect(copied).toBeVisible();
      await expect(copied).toHaveAttribute("aria-live", "polite");

      const calls = await expectNoPathArguments(page);
      const copy = calls.filter((call) => call.command === "copy_assignment_text");
      expect(copy).toHaveLength(1);
      expect(copy[0]?.args.text).toMatch(/^Course code: SYN 101\nAssignment title: Synthetic essay draft\nDue date\/time: .+\nCanvas submission status: Not submitted\nDue Good completion status: Not completed\nAssignment details: No additional details were supplied\.$/);
      expect(copy[0]?.args.text).not.toMatch(/(?:https?:\/\/|file:\/\/|\/Users\/|\/private\/|\/tmp\/|~\/)/i);
    });

    test("native Copy assignment reports a clipboard failure", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", copyFailure: true }));
      const essay = page.locator('[data-due-item="syn-101-essay"]');
      await essay.getByRole("button", { name: "Copy assignment" }).click();
      const failed = essay.getByRole("button", { name: "Could not copy" });
      await expect(failed).toBeVisible();
      await expect(failed).toHaveAttribute("aria-live", "polite");

      const calls = await expectNoPathArguments(page);
      const copy = calls.filter((call) => call.command === "copy_assignment_text");
      expect(copy).toHaveLength(1);
      expect(copy[0]?.args.text).toContain("Assignment title: Synthetic essay draft");
    });

    test("snapshot warning leaves the native dashboard usable", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", problem: "A daily recovery snapshot could not be created." }));
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText("A daily recovery snapshot could not be created.");
      const essayDone = page.locator('[data-due-item="syn-101-essay"]').getByRole("checkbox", { name: "Mark Synthetic essay draft done" });
      await expect(essayDone).toBeEnabled();
      await essayDone.click();
      await expect(essayDone).toHaveCount(0);
      await expectNoPathArguments(page);
    });

    test("another instance and an unavailable app data folder show no import controls", async ({ page }) => {
      await openDesktop(page, scenario({ availability: "another-instance" }));
      await expect(page.getByRole("heading", { level: 1, name: "Due Good is already open" })).toBeVisible();
      await expect(page.getByRole("button")).toHaveCount(0);
      await expectNoPathArguments(page);

      await page.addInitScript(installTauriMock, scenario({ availability: "unavailable", problem: "The app data folder could not be created." }));
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "App data folder unavailable" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText("The app data folder could not be created.");
      await expect(page.locator(".setup-path")).toHaveText(DATA_FOLDER);
      await expect(page.getByRole("button")).toHaveCount(0);
      await expectNoPathArguments(page);
    });


  });
}
