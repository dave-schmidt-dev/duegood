/**
 * Runs the Tauri interface in Playwright with Tauri IPC mocked in the page. No Worker, loopback API,
 * or Tauri runtime is involved: an init script installs `window.__TAURI_INTERNALS__` (invoke,
 * transformCallback, unregisterCallback) and `isTauri`, so desktop code runs against synthetic
 * command results. Every IPC call is recorded and checked for paths.
 */
import { expect, type Page } from "@playwright/test";

export type StoreState = "empty" | "preview" | "authoritative";
export type Availability = "ready" | "another-instance" | "unavailable";

export interface Scenario {
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
  readonly conversationsJson?: string | null;
}

export interface RecordedCall { readonly command: string; readonly args: Record<string, unknown> }

export const DATA_FOLDER = "~/Library/Application Support/com.zerodelta.duegood";
const COMMANDS = ["store_status", "choose_legacy_root", "dry_run_import", "import_legacy_root", "read_dashboard_documents", "read_avatar_bytes", "open_library_resource", "copy_assignment_text", "set_item_completion", "set_discussion_field", "list_snapshots", "restore_snapshot", "export_legacy_folder", "set_canvas_refresh_enabled", "start_canvas_refresh", "start_ical_refresh", "prepare_store_promotion", "confirm_store_promotion", "demote_store_for_rollback", "export_frozen_for_rollback"];
const at = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);

export function scenario(overrides: Partial<Scenario> = {}): Scenario {
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
export function installTauriMock(setup: Scenario): void {
  type Callback = (message: unknown) => void;
  const scope = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, Callback>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let canvasRefreshCalls = 0;
  let calendarRefreshCalls = 0;
  let calendarJustConnected = false;
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
        canvasRefreshCalls += 1;
        if (canvasRefreshCalls === 1) return { status: "complete", updatedAt: "2026-09-23T12:00:00Z" };
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
        calendarRefreshCalls += 1;
        if (!status().icalRefreshAvailable) throw { code: "calendar-unavailable", message: "The synthetic calendar refresh is unavailable." };
        if (state === "empty") calendarJustConnected = true;
        else if (calendarRefreshCalls === 1 || calendarJustConnected) {
          calendarJustConnected = false;
          return { status: "complete", updatedAt: "2026-09-25T12:00:00Z", added: 0, updated: 0, held: 0, removed: 0 };
        }
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
          conversations: setup.conversationsJson ?? null,
          profile: JSON.stringify({ name: "Synthetic Learner" }),
          avatar: null,
          courseExports: {
            "syn-101": {
              files: JSON.stringify([{ id: 1, display_name: "Synthetic syllabus", updated_at: "2026-09-01T00:00:00Z" }, { id: 2, display_name: "Synthetic handout", updated_at: "2026-09-02T00:00:00Z" }]),
              pages: null, modules: null, announcements: null, quizzes: null,
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

export async function openDesktop(page: Page, setup: Scenario): Promise<string[]> {
  const apiRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
  await page.addInitScript(installTauriMock, setup);
  await page.goto("/");
  const refresh = page.locator(".top-actions .refresh-button");
  if (await refresh.count() > 0) await expect(refresh).toBeEnabled();
  return apiRequests;
}

export async function ipcCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(() => (window as unknown as { __ipcCalls: RecordedCall[] }).__ipcCalls);
}

/** IPC arguments are fixed identifiers, synthetic copy text, prior/current booleans, and channels. */
export async function expectNoPathArguments(page: Page): Promise<RecordedCall[]> {
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

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

export const importButton = (page: Page) => page.getByRole("button", { name: "Archive and replace preview copy" });
export const dryRunSection = (page: Page) => page.getByRole("region", { name: "Dry run" });
