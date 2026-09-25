/**
 * Runs the Tauri interface in Playwright with Tauri IPC mocked in the page. No Worker, loopback API,
 * or Tauri runtime is involved: an init script installs `window.__TAURI_INTERNALS__` (invoke,
 * transformCallback, unregisterCallback) and `isTauri`, so desktop code runs against synthetic
 * command results. Every IPC call is recorded and checked for paths.
 */
import { expect, test, type Page } from "@playwright/test";
import { automaticAccessibilityViolations } from "./a11y";

type StoreState = "empty" | "preview" | "authoritative";
type Availability = "ready" | "another-instance" | "unavailable";

interface Scenario {
  readonly state: StoreState;
  readonly availability: Availability;
  readonly problem: string | null;
  readonly dryRunRefusals: Readonly<Record<string, number>>;
  readonly importError: { readonly code: string; readonly message: string; readonly refusals?: Readonly<Record<string, number>> } | null;
  readonly holdImport: boolean;
  readonly coursework: string;
  readonly mutationConflicts: readonly ("set_item_completion" | "set_discussion_field")[];
  readonly snapshotId: string;
  readonly copyFailure: boolean;
  readonly canvasRefreshEnabled: boolean;
  readonly helperReady: boolean;
  readonly icalReady: boolean;
  readonly holdRefresh: boolean;
  readonly refreshStatus: "complete" | "incomplete";
  readonly refreshError: { readonly code: string; readonly message: string } | null;
  readonly transitionCancel: "prepare" | "confirm" | "demote" | "export" | null;
  readonly transitionFail: "prepare" | "confirm" | "demote" | "export" | null;
  readonly frozenExportEqual: boolean;
  readonly holdTransition: "prepare" | "confirm" | "demote" | "export" | null;
}

interface RecordedCall { readonly command: string; readonly args: Record<string, unknown> }

const DATA_FOLDER = "~/Library/Application Support/com.zerodelta.duegood";
const COMMANDS = ["store_status", "choose_legacy_root", "dry_run_import", "import_legacy_root", "read_dashboard_documents", "read_avatar_bytes", "open_library_resource", "copy_assignment_text", "set_item_completion", "set_discussion_field", "list_snapshots", "restore_snapshot", "export_legacy_folder", "set_canvas_refresh_enabled", "start_canvas_refresh", "start_ical_refresh", "prepare_store_promotion", "confirm_store_promotion", "demote_store_for_rollback", "export_frozen_for_rollback"];
const at = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  const coursework = JSON.stringify({
    generated: new Date().toISOString(),
    courses: [{ key: "syn-101", code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", folder: "syn-101" }],
    items: [
      { id: "syn-101-essay", course: "syn-101", kind: "assignment", title: "Synthetic essay draft", at: at(2), submissionStatus: "unsubmitted", done: false },
      { id: "syn-101-discussion", course: "syn-101", kind: "discussion", title: "Synthetic discussion", at: at(3), discussionPostDone: true, discussionRepliesDone: false },
    ],
  });
  return {
    state: "empty", availability: "ready", problem: null, dryRunRefusals: {}, importError: null, holdImport: false, coursework,
    mutationConflicts: [], snapshotId: "daily-20260923T120000Z-0123abcd", copyFailure: false, canvasRefreshEnabled: false, helperReady: false, icalReady: false,
    holdRefresh: false, refreshStatus: "complete", refreshError: null, transitionCancel: null, transitionFail: null, frozenExportEqual: true, holdTransition: null, ...overrides,
  };
}

/** Runs in the page before the app loads. Must stay self-contained (it is serialized). */
function installTauriMock(setup: Scenario): void {
  type Callback = (message: unknown) => void;
  const scope = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, Callback>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let nextId = 1;
  let state = setup.state;
  let canvasRefreshEnabled = setup.canvasRefreshEnabled;
  let coursework = setup.coursework;
  const remainingConflicts = new Set(setup.mutationConflicts);
  const findItem = (itemId: string): Record<string, unknown> | undefined => {
    const document = JSON.parse(coursework) as { items: Record<string, unknown>[] };
    return document.items.find((item) => item.id === itemId);
  };
  const updateItem = (itemId: string, update: (item: Record<string, unknown>) => void): void => {
    const document = JSON.parse(coursework) as { items: Record<string, unknown>[] };
    const item = document.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) update(item);
    coursework = JSON.stringify(document);
  };
  const sendTransitionProgress = (args: Record<string, unknown>, message: { filesDone: number; bytesDone: number }): void => {
    const channel = args.onProgress as { id: number };
    callbacks.get(channel.id)?.({ index: 0, message });
    callbacks.get(channel.id)?.({ index: 1, end: true });
  };
  const mutationResult = (itemId: string) => {
    const item = findItem(itemId) ?? {};
    return {
      completed: item.done === true,
      completedAt: typeof item.doneAt === "string" ? Date.parse(item.doneAt) : null,
      discussionPostDone: item.discussionPostDone === true,
      discussionRepliesDone: item.discussionRepliesDone === true,
      version: "d".repeat(64),
    };
  };
  let selected = false;
  const status = () => ({
    availability: setup.availability,
    state: setup.availability === "ready" ? state : "unknown",
    dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
    legacyRootSelected: selected,
    importedAt: state === "empty" ? null : "2026-09-22T12:00:00Z",
    files: state === "empty" ? null : 5,
    bytes: state === "empty" ? null : 20_480,
    canvasRefreshEnabled,
    refreshAvailable: availabilityIsReady() && state === "authoritative" && canvasRefreshEnabled && setup.helperReady,
    icalRefreshAvailable: availabilityIsReady() && (state === "empty" || state === "authoritative") && setup.icalReady,
    snapshotInProgress: false,
    problem: setup.problem,
  });
  function availabilityIsReady(): boolean { return setup.availability === "ready"; }
  scope.__ipcCalls = calls;
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback(callback: Callback): number { const id = nextId; nextId += 1; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
      // Record what would cross IPC: a Channel serializes to `__CHANNEL__:<id>`.
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
      if (command === "store_status") return status();
      if (command === "set_canvas_refresh_enabled") {
        canvasRefreshEnabled = args.enabled === true;
        return { canvasRefreshEnabled, refreshAvailable: setup.availability === "ready" && state === "authoritative" && canvasRefreshEnabled && setup.helperReady };
      }
      if (command === "start_canvas_refresh") {
        const statusNow = status();
        if (!statusNow.refreshAvailable) throw { code: "refresh-unavailable", message: "The synthetic Canvas refresh is unavailable." };
        const serializedChannel: unknown = JSON.parse(JSON.stringify(args.onProgress));
        const channel = typeof serializedChannel === "string" ? serializedChannel.match(/^__CHANNEL__:(\d+)$/) : null;
        if (channel === null) throw { code: "invalid-channel", message: "The synthetic progress channel is invalid." };
        const callback = callbacks.get(Number(channel[1]));
        callback?.({ index: 0, message: { phase: "fetch", completed: 2, total: 4, bytesDone: 8192 } });
        callback?.({ index: 1, end: true });
        if (setup.holdRefresh) await new Promise<void>((resolve) => { scope.__releaseRefresh = resolve; });
        if (setup.refreshError !== null) throw setup.refreshError;
        return { status: setup.refreshStatus, updatedAt: "2026-09-23T12:00:00Z" };
      }
      if (command === "start_ical_refresh") {
        if (!status().icalRefreshAvailable) throw { code: "calendar-unavailable", message: "The synthetic calendar refresh is unavailable." };
        const serializedChannel: unknown = JSON.parse(JSON.stringify(args.onProgress));
        const channel = typeof serializedChannel === "string" ? serializedChannel.match(/^__CHANNEL__:(\d+)$/) : null;
        if (channel === null) throw { code: "invalid-channel", message: "The synthetic progress channel is invalid." };
        const callback = callbacks.get(Number(channel[1]));
        callback?.({ index: 0, message: { phase: "waiting-for-calendar" } });
        callback?.({ index: 1, message: { phase: "importing" } });
        callback?.({ index: 2, end: true });
        if (state === "empty") state = "authoritative";
        return { status: "complete", updatedAt: "2026-09-25T12:00:00Z", added: 2, updated: 1, held: 0, removed: 0 };
      }
      if (command === "choose_legacy_root") { selected = true; return { selected: true }; }
      if (command === "dry_run_import") {
        const refused = Object.keys(setup.dryRunRefusals).length > 0;
        return {
          caps: { totalBytes: 1_073_741_824, perFileBytes: 104_857_600, entries: 20_000 },
          inventory: { courseworkDocuments: 1, courseFolders: 1, exportDocuments: 3, materialFiles: 2, files: 5, directories: 4, bytes: 20_480 },
          refusals: setup.dryRunRefusals,
          unsupportedTypes: refused ? { script: 1 } : {},
          legacyLockPresent: false,
          wouldImport: !refused,
        };
      }
      if (command === "import_legacy_root") {
        const channel = args.onProgress as { id: number };
        let index = 0;
        const send = (phase: string, filesDone: number): void => {
          callbacks.get(channel.id)?.({ index, message: { phase, filesDone, filesTotal: 5, bytesDone: filesDone * 4096, bytesTotal: 20_480 } });
          index += 1;
        };
        const end = (): void => { callbacks.get(channel.id)?.({ index, end: true }); };
        send("locking", 0); send("scanning", 0); send("hashing", 0); send("copying", 1); send("copying", 2);
        if (setup.holdImport) await new Promise<void>((resolve) => { scope.__releaseImport = resolve; });
        if (setup.importError !== null) { end(); throw setup.importError; }
        send("copying", 3); send("copying", 4); send("copying", 5); send("rechecking", 5); send("validating", 5); send("adopting", 5); send("complete", 5);
        end();
        const replacedPreview = state === "preview";
        state = "preview";
        return { state: "preview", files: 5, bytes: 20_480, replacedPreview };
      }
      if (command === "read_dashboard_documents") {
        return {
          storeState: state,
          coursework: { text: coursework, version: "c".repeat(64) },
          refreshHistory: null,
          conversations: null,
          profile: JSON.stringify({ name: "Synthetic Learner" }),
          avatar: null,
          courseExports: {
            "syn-101": {
              files: JSON.stringify([{ id: 1, display_name: "Synthetic syllabus", updated_at: "2026-09-01T00:00:00Z" }, { id: 2, display_name: "Synthetic handout", updated_at: "2026-09-02T00:00:00Z" }]),
              pages: null, modules: null, announcements: null,
              downloadManifest: JSON.stringify([{ id: 1, status: "downloaded", filename: "syllabus.pdf" }]),
            },
          },
        };
      }
      if (command === "read_avatar_bytes") return null;
      if (command === "open_library_resource") return "opened";
      if (command === "copy_assignment_text") {
        if (setup.copyFailure) throw { code: "clipboard", message: "The assignment could not be copied." };
        return null;
      }
      if (command === "set_item_completion") {
        const itemId = String(args.itemId);
        const item = findItem(itemId);
        const current = item?.done === true;
        const value = args.value === true;
        if (remainingConflicts.delete(command)) {
          updateItem(itemId, (entry) => { entry.done = value; entry.doneAt = new Date().toISOString(); });
          throw { code: "item-conflict", message: "The synthetic item changed elsewhere." };
        }
        if (current !== (args.expected === true)) throw { code: "item-conflict", message: "The synthetic item changed elsewhere." };
        updateItem(itemId, (entry) => {
          entry.done = value;
          if (value) entry.doneAt = new Date().toISOString();
          else delete entry.doneAt;
        });
        return mutationResult(itemId);
      }
      if (command === "set_discussion_field") {
        const itemId = String(args.itemId);
        const item = findItem(itemId);
        const key = args.field === "post" ? "discussionPostDone" : "discussionRepliesDone";
        const current = item?.[key] === true;
        const value = args.value === true;
        if (remainingConflicts.delete(command)) {
          updateItem(itemId, (entry) => { entry[key] = value; });
          throw { code: "item-conflict", message: "The synthetic discussion changed elsewhere." };
        }
        if (current !== (args.expected === true)) throw { code: "item-conflict", message: "The synthetic discussion changed elsewhere." };
        updateItem(itemId, (entry) => { entry[key] = value; });
        return mutationResult(itemId);
      }
      if (command === "list_snapshots") {
        return [{ id: setup.snapshotId, createdAt: "2026-09-23T12:00:00Z", kind: "daily" }];
      }
      if (command === "restore_snapshot") return null;
      if (command === "export_legacy_folder") {
        const channel = args.onProgress as { id: number };
        callbacks.get(channel.id)?.({ filesDone: 1, bytesDone: 4096 });
        return { filesDone: 2, bytesDone: 8192 };
      }
      if (command === "prepare_store_promotion") {
        if (setup.transitionCancel === "prepare") throw { code: "cancelled", message: "The synthetic folder picker was cancelled." };
        if (setup.transitionFail === "prepare") throw { code: "backup-mismatch", message: "The selected backup does not match this preview." };
        sendTransitionProgress(args, { filesDone: 5, bytesDone: 20_480 });
        if (setup.holdTransition === "prepare") await new Promise<void>((resolve) => { scope.__releaseTransition = resolve; });
        return { proofId: "synthetic-proof-0001", files: 5, bytes: 20_480 };
      }
      if (command === "confirm_store_promotion") {
        if (args.proofId !== "synthetic-proof-0001") throw { code: "invalid-proof", message: "The synthetic proof is invalid." };
        if (setup.transitionCancel === "confirm") throw { code: "cancelled", message: "The synthetic native confirmation was cancelled." };
        if (setup.transitionFail === "confirm") throw { code: "proof-expired", message: "The preview changed after comparison. Compare the backup again." };
        sendTransitionProgress(args, { filesDone: 5, bytesDone: 20_480 });
        if (setup.holdTransition === "confirm") await new Promise<void>((resolve) => { scope.__releaseTransition = resolve; });
        state = "authoritative";
        return { state: "authoritative", files: 5, bytes: 20_480 };
      }
      if (command === "demote_store_for_rollback") {
        if (setup.transitionCancel === "demote") throw { code: "cancelled", message: "The synthetic native confirmation was cancelled." };
        if (setup.transitionFail === "demote") throw { code: "rollback-guard", message: "A store write is still active. Try rollback again when it finishes." };
        sendTransitionProgress(args, { filesDone: 6, bytesDone: 24_576 });
        if (setup.holdTransition === "demote") await new Promise<void>((resolve) => { scope.__releaseTransition = resolve; });
        state = "preview";
        canvasRefreshEnabled = false;
        return { state: "preview", recoveryFiles: 6, recoveryBytes: 24_576 };
      }
      if (command === "export_frozen_for_rollback") {
        if (setup.transitionCancel === "export") throw { code: "cancelled", message: "The synthetic export picker was cancelled." };
        if (setup.transitionFail === "export") throw { code: "export-failed", message: "The frozen source could not be exported." };
        sendTransitionProgress(args, { filesDone: 5, bytesDone: 20_480 });
        if (setup.holdTransition === "export") await new Promise<void>((resolve) => { scope.__releaseTransition = resolve; });
        return { files: 5, bytes: 20_480, equal: setup.frozenExportEqual };
      }
      throw { code: "internal", message: `unexpected command ${command}` };
    },
  };
}

async function openDesktop(page: Page, setup: Scenario): Promise<string[]> {
  const apiRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
  await page.addInitScript(installTauriMock, setup);
  await page.goto("/");
  return apiRequests;
}

async function ipcCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(() => (window as unknown as { __ipcCalls: RecordedCall[] }).__ipcCalls);
}

/** IPC arguments are fixed identifiers, synthetic copy text, prior/current booleans, and channels. */
async function expectNoPathArguments(page: Page): Promise<RecordedCall[]> {
  const calls = await ipcCalls(page);
  expect(calls.length).toBeGreaterThan(0);
  for (const { command, args } of calls) {
    expect(COMMANDS).toContain(command);
    const keysByCommand: Readonly<Record<string, readonly string[]>> = {
      store_status: [], choose_legacy_root: [], dry_run_import: [], read_dashboard_documents: [], read_avatar_bytes: [], list_snapshots: [],
      import_legacy_root: ["onProgress", "replacePreview"], open_library_resource: ["id"], copy_assignment_text: ["text"],
      set_item_completion: ["expected", "itemId", "value"], set_discussion_field: ["expected", "field", "itemId", "value"],
      restore_snapshot: ["id"], export_legacy_folder: ["onProgress"],
      set_canvas_refresh_enabled: ["enabled"], start_canvas_refresh: ["onProgress"], start_ical_refresh: ["onProgress"],
      prepare_store_promotion: ["onProgress"], confirm_store_promotion: ["onProgress", "proofId"], demote_store_for_rollback: ["onProgress"], export_frozen_for_rollback: ["onProgress"],
    };
    expect(Object.keys(args).sort()).toEqual([...(keysByCommand[command] ?? [])].sort());
    if ("replacePreview" in args) expect(typeof args.replacePreview).toBe("boolean");
    if ("onProgress" in args) expect(args.onProgress).toMatch(/^__CHANNEL__:\d+$/);
    if ("itemId" in args) expect(args.itemId).toMatch(/^syn-101-(essay|discussion)$/);
    if ("expected" in args) expect(typeof args.expected).toBe("boolean");
    if ("value" in args) expect(typeof args.value).toBe("boolean");
    if ("field" in args) expect(["post", "replies"]).toContain(args.field);
    if (command === "open_library_resource") expect(args.id).toMatch(/^syn-101:file:\d+$/);
    if (command === "restore_snapshot") expect(args.id).toMatch(/^(daily|refresh)-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    if (command === "copy_assignment_text") expect(typeof args.text).toBe("string");
    if (command === "confirm_store_promotion") expect(args.proofId).toBe("synthetic-proof-0001");
    expect(args).not.toHaveProperty("confirmed");
    expect(JSON.stringify(args)).not.toMatch(/(?:https?:\/\/|file:\/\/|\/Users\/|\/private\/|\/tmp\/|~\/|[A-Z]:\\\\|\\\\\\\\)/i);
  }
  return calls;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const importButton = (page: Page) => page.getByRole("button", { name: "Archive and replace preview copy" });
const dryRunSection = (page: Page) => page.getByRole("region", { name: "Dry run" });

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }] as const) {
  test.describe(`desktop app screens at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("first run: calendar connection creates the native dashboard without a legacy folder", async ({ page }) => {
      const apiRequests = await openDesktop(page, scenario({ icalReady: true }));
      await expect(page.getByRole("heading", { level: 1, name: "Connect your Canvas calendar" })).toBeVisible();
      await expect(page.getByText("The feed credential is separate from a Canvas API token.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose legacy folder…" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(await automaticAccessibilityViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "Connect calendar" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
      await expect(page.locator(".top-actions .preview-badge")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      const calls = await expectNoPathArguments(page);
      expect(calls.map((call) => call.command)).toEqual(["store_status", "start_ical_refresh", "store_status", "read_dashboard_documents", "read_avatar_bytes"]);
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
      await expect(page.locator(".sync-note")).toContainText("Canvas refresh · Reading Canvas data · 2 of 4 completed · 8192 bytes received");
      await expect(refresh).toBeDisabled();
      await page.waitForFunction(() => typeof (window as unknown as { __releaseRefresh?: unknown }).__releaseRefresh === "function");
      await page.evaluate(() => (window as unknown as { __releaseRefresh: () => void }).__releaseRefresh());
      await expect(page.locator(".sync-note")).toHaveText("Refresh incomplete. Existing data was kept.");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Last refresh");
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Sep 23");
      const calls = await expectNoPathArguments(page);
      const start = calls.find((call) => call.command === "start_canvas_refresh");
      expect(start?.args).toMatchObject({ onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) });
      expect(calls.filter((call) => call.command === "read_dashboard_documents")).toHaveLength(2);
    });

    test("native refresh failure reports preserved data without exposing helper error detail", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", canvasRefreshEnabled: true, helperReady: true, refreshError: { code: "synthetic-failure", message: "Private synthetic diagnostic" } }));
      await page.locator(".top-actions").getByRole("button", { name: "Refresh" }).click();
      await expect(page.locator(".sync-note")).toHaveText("Refresh failed. Existing data was kept.");
      await expect(page.getByText("Private synthetic diagnostic", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Synthetic essay draft" })).toBeVisible();
      await expectNoPathArguments(page);
    });

    test("native calendar refresh shows counts and sends no feed data through IPC", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative", icalReady: true }));
      await page.locator(".top-actions").getByRole("button", { name: "Refresh" }).click();
      await expect(page.locator(".sync-note")).toHaveText("Calendar refresh complete · 2 added · 1 updated · 0 held");
      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "start_ical_refresh")).toEqual([
        { command: "start_ical_refresh", args: { onProgress: expect.stringMatching(/^__CHANNEL__:\d+$/) } },
      ]);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Calendar feed");
      await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Available for native refresh.");
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
      await page.getByRole("button", { name: "Recovery", exact: true }).click();
      const recoveryPoints = page.getByRole("region", { name: "Recovery points" });
      await expect(recoveryPoints).toContainText("Daily snapshot");
      await recoveryPoints.getByRole("button", { name: "Restore snapshot" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();

      const calls = await expectNoPathArguments(page);
      expect(calls.filter((call) => call.command === "list_snapshots")).toHaveLength(1);
      expect(calls.filter((call) => call.command === "restore_snapshot")).toEqual([
        { command: "restore_snapshot", args: { id: setup.snapshotId } },
      ]);
    });

    test("rollback export streams progress through a channel and shows completion", async ({ page }) => {
      await openDesktop(page, scenario({ state: "authoritative" }));
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
