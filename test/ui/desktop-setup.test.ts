import { describe, expect, it, vi } from "vitest";
import { renderDesktopSetup, resolveNativeMutationConflict } from "../../src/ui/app";
import { desktopRecoveryPanel } from "../../src/ui/components/recovery-panel";
import { renderDashboard } from "../../src/ui/pages/dashboard";
import { createNativeTransport, DesktopCommandError } from "../../src/ui/transport";
import { DATA, DATA_FOLDER, DIGEST, dryRun, handlers, NOW, setup, setupHandlers, state, storeStatus } from "./desktop-test-fixtures";
import { button, buttons, findAll, words } from "./descriptor-test-helpers";

describe("desktop transport and first-run screen", () => {
  it("renders the first-run screen with the fixed app-data folder, a legacy-folder picker, and the preview-copy label", () => {
    const actions = setupHandlers();
    const screen = renderDesktopSetup(setup(), actions);
    const text = words(screen);
    expect(text).toContain("Import existing coursework");
    expect(text).toContain(DATA_FOLDER);
    expect(text).toContain("It cannot be changed.");
    expect(text).toContain("Preview copy");
    expect(text).toContain("It does not follow later changes in the legacy local source. Personal progress edits stay in this copy.");
    expect(text).not.toMatch(/change storage location/i);
    expect(findAll(screen, (item) => item.attrs?.class === "preview-badge")).toHaveLength(1);
    const choose = button(screen, "Choose legacy folder…");
    expect(choose?.attrs?.disabled).toBeUndefined();
    choose?.on?.click?.(new Event("click"));
    expect(actions.onChoose).toHaveBeenCalledOnce();
    expect(button(screen, "Import as preview copy")?.attrs?.disabled).toBe("");
    expect(button(screen, "Check again")).toBeUndefined();
    expect(button(screen, "Keep current preview copy")).toBeUndefined();
  });

  it("keeps first-run calendar details closed until requested and preserves connection feedback", () => {
    const actions = setupHandlers();
    const screen = renderDesktopSetup(setup({ status: storeStatus({ state: "empty" }) }), actions);
    const setupChildren = findAll(screen, (item) => item.attrs?.class?.includes("setup-card") === true)[0]?.children ?? [];
    const connectIndex = setupChildren.findIndex((item) => item.tag === "button" && item.text === "Connect calendar");
    const details = findAll(screen, (item) => item.tag === "details" && words(item).includes("About calendar import"))[0];
    const detailsIndex = setupChildren.indexOf(details!);
    expect(words(screen)).toContain("Add assignments and dates from your Canvas calendar.");
    expect(connectIndex).toBeGreaterThan(0);
    expect(detailsIndex).toBeGreaterThan(connectIndex);
    expect(details?.attrs?.open).toBeUndefined();
    expect(words(details!)).toContain("They do not include grades, messages, or progress saved in an older Due Good folder.");
    expect(words(details!)).toContain(DATA_FOLDER);
    expect(words(screen)).not.toMatch(/API token|credential/i);

    const connecting = renderDesktopSetup(setup({ status: storeStatus({ state: "empty" }), step: "connecting", calendarProgress: { phase: "waiting-for-calendar" } }), actions);
    expect(button(connecting, "Connecting…")?.attrs?.disabled).toBe("");
    expect(findAll(connecting, (item) => item.attrs?.role === "status").some((item) => words(item).includes("Fetching your calendar…"))).toBe(true);
    const failed = renderDesktopSetup(setup({ status: storeStatus({ state: "empty" }), error: { message: "Calendar connection failed.", refusals: {}, unsupportedTypes: {} } }), actions);
    expect(findAll(failed, (item) => item.attrs?.role === "alert").some((item) => words(item).includes("Calendar connection failed."))).toBe(true);
  });

  it("shows dry-run counts and enables import only for an importable folder", () => {
    const actions = setupHandlers();
    const ready = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), step: "ready", report: dryRun() }), actions);
    expect(words(ready)).toContain("Counts only; nothing was copied.");
    expect(words(ready)).toContain("Material files");
    const importButton = button(ready, "Import as preview copy");
    expect(importButton?.attrs?.disabled).toBeUndefined();
    importButton?.on?.click?.(new Event("click"));
    expect(actions.onImport).toHaveBeenCalledOnce();
    button(ready, "Check again")?.on?.click?.(new Event("click"));
    expect(actions.onRecheck).toHaveBeenCalledOnce();

    const refused = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), step: "ready", report: dryRun({ wouldImport: false, legacyLockPresent: true, refusals: { escapingMaterialSymlinks: 2 }, unsupportedTypes: { script: 1 } }) }), actions);
    expect(button(refused, "Import as preview copy")?.attrs?.disabled).toBe("");
    const refusalRows = findAll(refused, (item) => item.attrs?.class === "setup-counts setup-refusals")[0];
    expect(words(refusalRows!).replace(/\s+/g, " ").trim()).toBe("Material links that leave the materials folder 2");
    expect(words(refused)).toContain("Nothing is dropped silently");
    expect(words(refused)).toContain("The legacy local source is being written right now. The import waits for that write to finish.");
    expect(words(refused)).toContain("script");
  });

  it("shows streamed import progress, errors with refusals, and the replace-preview variant", () => {
    const actions = setupHandlers();
    const importing = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), step: "importing", report: dryRun(), progress: { phase: "copying", filesDone: 4, filesTotal: 9, bytesDone: 2048, bytesTotal: 4096 } }), actions);
    const bar = findAll(importing, (item) => item.tag === "progress")[0];
    expect(bar?.attrs).toMatchObject({ max: "9", value: "4" });
    expect(words(importing)).toContain("Copying files");
    expect(words(importing)).toContain("4 of 9 files · 2.0 KB of 4.0 KB");
    expect(buttons(importing).every((item) => item.attrs?.disabled === "")).toBe(true);

    const failed = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), error: { message: "The legacy folder changed during the copy. Nothing was changed.", refusals: { malformedJson: 1 }, unsupportedTypes: {} } }), actions);
    const alert = findAll(failed, (item) => item.attrs?.role === "alert")[0];
    expect(words(alert!)).toContain("The legacy folder changed during the copy.");
    expect(words(alert!)).toContain("Malformed JSON documents");

    const replace = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), replacePreview: true, step: "ready", report: dryRun() }), actions);
    expect(words(replace)).toContain("Replace the preview copy");
    expect(words(replace)).toContain("timestamped backup that is never deleted");
    expect(button(replace, "Archive and replace preview copy")?.attrs?.disabled).toBeUndefined();
    button(replace, "Keep current preview copy")?.on?.click?.(new Event("click"));
    expect(actions.onCancel).toHaveBeenCalledOnce();
  });

  it("renders the another-instance, unavailable, and recovery screens without any import control", () => {
    const actions = setupHandlers();
    const other = renderDesktopSetup(setup({ status: storeStatus({ availability: "another-instance", state: "unknown" }) }), actions);
    expect(words(other)).toContain("Due Good is already open");
    const unavailable = renderDesktopSetup(setup({ status: storeStatus({ availability: "unavailable", state: "unknown", problem: "The app data folder could not be created." }) }), actions);
    expect(words(unavailable)).toContain("The app data folder could not be created.");
    const damaged = renderDesktopSetup(setup({ status: storeStatus({ state: "damaged", problem: "The store manifest is invalid." }) }), actions);
    expect(words(damaged)).toContain("The app store needs recovery");
    expect(words(damaged)).toContain("nothing will be imported over it");
    for (const screen of [other, unavailable, damaged]) {
      expect(buttons(screen)).toHaveLength(0);
      expect(words(screen)).toContain(DATA_FOLDER);
    }
  });

  it("renders a writable preview dashboard with a truthful store card and a replace action", () => {
    const onReplacePreview = vi.fn();
    const desktop = { storeState: "preview" as const, dataFolder: DATA_FOLDER, importedAt: "2026-09-22T12:00:00Z" };
    const timeline = renderDashboard({ ...state("timeline"), desktop }, { ...handlers, onReplacePreview });
    const inputs = findAll(timeline, (item) => item.tag === "input" && item.attrs?.type === "checkbox");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some((item) => item.attrs?.disabled === undefined)).toBe(true);
    expect(findAll(timeline, (item) => item.attrs?.class === "complete-button").some((item) => item.attrs?.disabled === undefined)).toBe(true);
    expect(words(findAll(timeline, (item) => item.attrs?.class === "top-actions")[0]!)).toContain("Preview copy");
    expect(findAll(timeline, (item) => item.attrs?.class === "sync-note")[0]?.text).toMatch(/^Imported /);

    const more = renderDashboard({ ...state("more"), desktop }, { ...handlers, onReplacePreview });
    const card = findAll(more, (item) => item.attrs?.["data-desktop-store"] === "preview")[0];
    expect(words(card!)).toContain("It does not follow later source changes.");
    expect(words(card!)).toContain(DATA_FOLDER);
    expect(words(more)).not.toContain("remains the authoritative writable source");
    button(card!, "Replace preview copy…")?.on?.click?.(new Event("click"));
    expect(onReplacePreview).toHaveBeenCalledOnce();

    const authoritative = renderDashboard({ ...state("more"), desktop: { ...desktop, storeState: "authoritative" } }, handlers);
    expect(words(authoritative)).toContain("Import never replaces it.");
    expect(button(authoritative, "Replace preview copy…")).toBeUndefined();
    expect(words(findAll(renderDashboard({ ...state("timeline"), desktop: { ...desktop, storeState: "authoritative" } }, handlers), (item) => item.attrs?.class === "top-actions")[0]!)).not.toContain("Preview copy");

    const native = renderDashboard(state("timeline"), handlers);
    expect(findAll(native, (item) => item.tag === "input" && item.attrs?.type === "checkbox").some((item) => item.attrs?.disabled === undefined)).toBe(true);
  });

  it("shows the preview promotion review counts without exposing the opaque proof and separates both confirmations", () => {
    const onPreparePromotion = vi.fn();
    const onConfirmPromotion = vi.fn();
    const onCancelPromotion = vi.fn();
    const desktop = { storeState: "preview" as const, dataFolder: DATA_FOLDER, importedAt: "2026-09-22T12:00:00Z" };
    const idle = renderDashboard({ ...state("more"), desktop }, { ...handlers, onPreparePromotion, onConfirmPromotion, onCancelPromotion });
    const idleCard = findAll(idle, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    button(idleCard, "Choose and compare backup…")?.on?.click?.(new Event("click"));
    expect(onPreparePromotion).toHaveBeenCalledOnce();

    const reviewed = renderDashboard({
      ...state("more"), desktop,
      storeTransition: { phase: "ready", proof: { proofId: "proof-opaque-test-only", files: 12, bytes: 4096 } },
    }, { ...handlers, onPreparePromotion, onConfirmPromotion, onCancelPromotion });
    const reviewCard = findAll(reviewed, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    expect(words(reviewCard)).toContain("Exact comparison passed: 12 files · 4.0 KB");
    expect(words(reviewCard)).toContain("native dialog");
    expect(words(reviewCard)).not.toContain("proof-opaque-test-only");
    button(reviewCard, "Promote to authoritative store")?.on?.click?.(new Event("click"));
    expect(onConfirmPromotion).toHaveBeenCalledWith("proof-opaque-test-only");
    button(reviewCard, "Discard comparison")?.on?.click?.(new Event("click"));
    expect(onCancelPromotion).toHaveBeenCalledOnce();
  });

  it("offers native-confirmed demotion on authoritative stores and frozen rollback export in preview", () => {
    const onDemoteStore = vi.fn();
    const onExportFrozenRollback = vi.fn();
    const desktop = { storeState: "authoritative" as const, dataFolder: DATA_FOLDER, importedAt: null };
    const more = renderDashboard({ ...state("more"), desktop }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const card = findAll(more, (item) => item.attrs?.["data-desktop-store"] === "authoritative")[0]!;
    button(card, "Return app store to preview…")?.on?.click?.(new Event("click"));
    expect(onDemoteStore).toHaveBeenCalledOnce();
    expect(button(card, "Promote to authoritative store")).toBeUndefined();
    expect(button(card, "Export frozen rollback copy…")).toBeUndefined();
    const preview = renderDashboard({ ...state("more"), desktop: { ...desktop, storeState: "preview" } }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const previewCard = findAll(preview, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    button(previewCard, "Export frozen rollback copy…")?.on?.click?.(new Event("click"));
    expect(onExportFrozenRollback).toHaveBeenCalledOnce();
    const busy = renderDashboard({ ...state("more"), desktop, storeTransition: { phase: "demoting" } }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const busyCard = findAll(busy, (item) => item.attrs?.["data-desktop-store"] === "authoritative")[0]!;
    expect(button(busyCard, "Returning to preview…")?.attrs?.disabled).toBe("");
    const progressing = renderDashboard({
      ...state("more"), desktop: { ...desktop, storeState: "preview" },
      storeTransition: { phase: "exporting", progress: { filesDone: 3, bytesDone: 2048 } },
    }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    expect(findAll(progressing, (item) => item.attrs?.role === "status").map(words)).toContain("3 files · 2048 bytes processed.");
  });

  it("shows the native owner toggle separately from availability and renders native progress", () => {
    const onToggleCanvasRefresh = vi.fn();
    const desktop = { storeState: "authoritative" as const, dataFolder: DATA_FOLDER, importedAt: null, canvasRefreshEnabled: true, refreshAvailable: false };
    const unavailable = renderDashboard({ ...state("more"), desktop, data: { ...DATA, refreshAvailable: false } }, { ...handlers, onToggleCanvasRefresh });
    const toggle = findAll(unavailable, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Enable Canvas refresh")[0];
    expect(toggle?.attrs).toMatchObject({ checked: "" });
    expect(words(unavailable)).toContain("Canvas refresh is unavailable on this computer.");
    expect(findAll(unavailable, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)).toHaveLength(0);
    toggle?.on?.change?.({ currentTarget: { checked: false } } as unknown as Event);
    expect(onToggleCanvasRefresh).toHaveBeenCalledWith(false);

    const running = renderDashboard({
      ...state("timeline"), desktop: { ...desktop, refreshAvailable: true }, data: { ...DATA, refreshAvailable: true }, refreshState: "running",
      refreshProgress: { phase: "fetch", completed: 2, total: 4, bytesDone: 4096 },
    }, handlers);
    expect(findAll(running, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Canvas refresh · Reading Canvas data · 2 of 4 completed · 4096 bytes received");
    expect(findAll(running, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)[0]?.attrs).toMatchObject({ disabled: "", "aria-busy": "true" });
    const calendar = renderDashboard({ ...state("timeline"), desktop: { ...desktop, icalRefreshAvailable: true }, data: { ...DATA, refreshAvailable: true }, refreshState: "running", refreshProgress: { phase: "waiting-for-calendar", completed: 0, total: null, bytesDone: null } }, handlers);
    expect(findAll(calendar, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Calendar refresh · Waiting for calendar");
    const fullDesktop = { ...desktop, browserRefreshAvailable: true, refreshAvailable: false, icalRefreshAvailable: true };
    const fullMore = renderDashboard({ ...state("more"), desktop: fullDesktop, data: { ...DATA, refreshAvailable: true } }, handlers);
    expect(words(fullMore)).toContain("Full refresh is available. It reads Canvas through the bundled browser and then updates calendar deadlines; Canvas may ask you to sign in.");
    expect(findAll(fullMore, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Enable Canvas refresh")).toHaveLength(0);
    const fullRunning = renderDashboard({ ...state("timeline"), desktop: fullDesktop, data: { ...DATA, refreshAvailable: true }, refreshState: "running", refreshProgress: { phase: "browser-import", completed: 0, total: null, bytesDone: null } }, handlers);
    expect(findAll(fullRunning, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Canvas and calendar refresh · Importing Canvas coursework");
    expect(findAll(fullRunning, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)[0]?.attrs?.title).toContain("calendar deadlines");
    const fullActivity = renderDashboard({ ...state("activity"), desktop: fullDesktop, data: { ...DATA, refreshAvailable: true }, refreshState: "partial", refreshDetail: "Full refresh partial. Canvas incomplete (2 coverage gaps); calendar complete (1 added, 0 updated, 3 held)." }, handlers);
    expect(words(fullActivity)).toContain("Full refresh partial. Canvas incomplete (2 coverage gaps); calendar complete (1 added, 0 updated, 3 held).");
  });

  it("routes native mutations, avatar bytes, resource IDs, clipboard, and snapshots through narrow commands", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "set_item_completion") return { completed: true, completedAt: NOW, discussionPostDone: false, discussionRepliesDone: false, version: DIGEST };
      if (command === "set_discussion_field") throw { code: "item-conflict", message: "Changed elsewhere", currentValue: true };
      if (command === "resolve_pending_source_link") return { version: DIGEST };
      if (command === "set_manual_grade") return { manualGrade: "A-", manualGradeVersion: 1, version: DIGEST };
      if (command === "read_avatar_bytes") return { contentType: "image/png", bytes: [137, 80, 78, 71] };
      if (command === "open_library_resource") return args?.id === "syn:file:2" ? "downloaded" : "opened";
      if (command === "copy_assignment_text" || command === "restore_snapshot") return null;
      if (command === "list_snapshots") return [{ id: "daily-20260923T120000Z-1234abcd", createdAt: "2026-09-23T12:00:00Z", kind: "daily" }];
      throw new Error(`unexpected ${command}`);
    }, () => ({}));
    await expect(transport.setCompletion("item-1", false, true)).resolves.toMatchObject({ completed: true });
    await expect(transport.setDiscussionField("item-1", "post", false, true)).rejects.toMatchObject({ code: "item-conflict", currentValue: true });
    await expect(transport.resolvePendingSourceLink("pending-1", "item-1", "confirm", DIGEST)).resolves.toEqual({ version: DIGEST });
    await expect(transport.setManualGrade("item-1", "A-", DIGEST)).resolves.toEqual({ manualGrade: "A-", manualGradeVersion: 1, version: DIGEST });
    await expect(transport.readAvatar()).resolves.toEqual({ contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71]) });
    await expect(transport.openResource("syn:file:1")).resolves.toBe("opened");
    await expect(transport.openResource("syn:file:2")).resolves.toBe("downloaded");
    await transport.copyText("Synthetic assignment");
    await expect(transport.listSnapshots()).resolves.toHaveLength(1);
    await transport.restoreSnapshot("daily-20260923T120000Z-1234abcd");
    expect(calls).toEqual([
      ["set_item_completion", { itemId: "item-1", expected: false, value: true }],
      ["set_discussion_field", { itemId: "item-1", field: "post", expected: false, value: true }],
      ["resolve_pending_source_link", { pendingId: "pending-1", localItemId: "item-1", decision: "confirm", expectedVersion: DIGEST }],
      ["set_manual_grade", { itemId: "item-1", value: "A-", expectedVersion: DIGEST }],
      ["read_avatar_bytes", undefined],
      ["open_library_resource", { id: "syn:file:1" }],
      ["open_library_resource", { id: "syn:file:2" }],
      ["copy_assignment_text", { text: "Synthetic assignment" }],
      ["list_snapshots", undefined],
      ["restore_snapshot", { id: "daily-20260923T120000Z-1234abcd" }],
    ]);
  });

  it("reloads native documents before showing a per-item conflict notice", async () => {
    const reload = vi.fn(async () => true);
    await expect(resolveNativeMutationConflict(new DesktopCommandError("item-conflict", "Changed", {}, {}, true), reload, "item")).resolves.toEqual({ reloaded: true, message: "This item changed elsewhere. Latest state reloaded; try again." });
    expect(reload).toHaveBeenCalledOnce();
    await expect(resolveNativeMutationConflict(new DesktopCommandError("item-conflict", "Changed"), async () => false, "discussion")).resolves.toEqual({ reloaded: false, message: "This discussion changed elsewhere. Reload the page and try again." });
  });

  it("offers snapshots before the age-labeled legacy import and renders native resource actions", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const onRestore = vi.fn();
    const recovery = desktopRecoveryPanel({ snapshots: [{ id: "new", kind: "daily", createdAt: "2026-09-23T11:00:00Z" }, { id: "older", kind: "pre-refresh", createdAt: "2026-09-21T11:00:00Z" }], importedAt: "2026-09-20T11:00:00Z", busy: false }, { onRestore, onExport: vi.fn() }, now);
    const labels = findAll(recovery, (item) => item.tag === "li").map(words);
    expect(labels[0]).toContain("Daily snapshot · today");
    expect(labels[1]).toContain("Before refresh · 2 days ago");
    expect(labels[2]).toContain("Legacy import · 3 days ago");
    button(recovery, "Restore snapshot")?.on?.click?.(new Event("click"));
    expect(onRestore).toHaveBeenCalledWith("new");
    const onOpenResource = vi.fn();
    const data = { ...DATA, resources: [{ id: "syn:file:1", courseId: "530", courseCode: "IT530", type: "File", title: "Synthetic PDF", savedLocally: true }] };
    const library = renderDashboard({ ...state("library"), data, desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, { ...handlers, onOpenResource });
    button(library, "Open or save")?.on?.click?.(new Event("click"));
    expect(onOpenResource).toHaveBeenCalledWith("syn:file:1");
    const avatar = renderDashboard({ ...state("timeline"), data: { ...DATA, profile: { displayName: "Synthetic Learner", avatarPath: "blob:synthetic" } } }, handlers);
    expect(findAll(avatar, (item) => item.tag === "img")[0]?.attrs?.src).toBe("blob:synthetic");
  });

  it("keeps a preview dashboard visible when a daily snapshot fails and shows the warning", () => {
    const warning = "A daily snapshot could not be saved. Coursework remains available; check storage before relying on recovery.";
    const screen = renderDashboard({ ...state("timeline"), desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null, warning } }, handlers);
    expect(findAll(screen, (item) => item.attrs?.role === "alert").map(words)).toContain(warning);
    expect(findAll(screen, (item) => item.tag === "input" && item.attrs?.type === "checkbox").length).toBeGreaterThan(0);
  });
});
