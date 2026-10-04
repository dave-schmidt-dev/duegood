import { Channel, invoke } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { parseDashboard } from "../../src/ui/app";
import { renderDashboard } from "../../src/ui/pages/dashboard";
import { projectDashboardDocuments } from "../../src/shared/dashboard-projection";
import { createNativeTransport, DesktopCommandError, nativeProjectionOptions, parseDocumentBundle, type CanvasRefreshProgress, type ImportProgress } from "../../src/ui/transport";
import { DATA_FOLDER, DIGEST, dryRun, handlers, nativeBundle, state, storeStatus } from "./desktop-test-fixtures";
import { findAll, words } from "./descriptor-test-helpers";

interface MockInternals { runCallback(id: number, data: unknown): void }

function withMockWindow(): MockInternals {
  // `@tauri-apps/api` reads `window.__TAURI_INTERNALS__`; the UI suite runs in plain Node.
  (globalThis as { window?: unknown }).window = globalThis;
  return new Proxy({} as MockInternals, { get: (_target, key) => (globalThis as unknown as { __TAURI_INTERNALS__: Record<string | symbol, unknown> }).__TAURI_INTERNALS__[key] });
}

function nativeTransport() {
  return createNativeTransport((command, args) => invoke(command, args), (onMessage) => new Channel<unknown>(onMessage));
}
describe("desktop transport and first-run screen", () => {
  afterEach(() => {
    const scope = globalThis as { window?: unknown; __TAURI_INTERNALS__?: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown };
    if (scope.window === undefined) return;
    clearMocks();
    delete scope.__TAURI_INTERNALS__;
    delete scope.__TAURI_EVENT_PLUGIN_INTERNALS__;
    delete scope.window;
  });

  it("keeps DashboardData.version a string for both the digest and older numeric bodies", () => {
    expect(parseDashboard({ version: DIGEST }).version).toBe(DIGEST);
    expect(parseDashboard({ version: 7 }).version).toBe("7");
    expect(parseDashboard({ version: Number.NaN }).version).toBe("");
    expect(parseDashboard({}).version).toBe("");
  });

  it("calls only the fixed read commands through mocked Tauri IPC and never sends a path", async () => {
    withMockWindow();
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === "store_status") return storeStatus({ state: "preview", legacyRootSelected: true, importedAt: "2026-09-22T12:00:00Z", files: 9, bytes: 4096 });
      if (command === "choose_legacy_root") return { selected: true };
      if (command === "dry_run_import") return dryRun();
      if (command === "read_dashboard_documents") return nativeBundle();
      throw new Error(`unexpected command ${command}`);
    });
    const transport = nativeTransport();
    await expect(transport.storeStatus()).resolves.toMatchObject({ availability: "ready", state: "preview", dataFolder: DATA_FOLDER, refreshAvailable: false });
    await expect(transport.chooseLegacyRoot()).resolves.toBe(true);
    await expect(transport.dryRunImport()).resolves.toEqual(dryRun());
    const body = await transport.loadDashboardBody(false);
    expect(calls.map(([command]) => command)).toEqual(["store_status", "choose_legacy_root", "dry_run_import", "read_dashboard_documents"]);
    for (const [, args] of calls) expect(args).toEqual({});

    expect(body.version).toBe(DIGEST);
    expect(body.refreshAvailable).toBe(false);
    expect(body.sourceStatus.label).toBe("Desktop preview copy");
    expect(body.profile).toEqual({ displayName: "Synthetic Learner" });
    expect(body.resources.map((item) => [item.title, item.openPath, item.savedLocally])).toEqual([["Handout", null, undefined], ["Syllabus", null, true]]);
    const parsed = parseDashboard(body);
    expect(parsed.version).toBe(DIGEST);
    expect(parsed.resources.find((item) => item.title === "Syllabus")).toMatchObject({ savedLocally: true });
    expect(parsed.resources.every((item) => item.localUrl === undefined)).toBe(true);
    const library = renderDashboard({ ...state("library"), data: parsed, desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, handlers);
    expect(words(library)).toContain("Saved locally");
    expect(findAll(library, (item) => item.tag === "a" && item.attrs?.class === "more-action")).toHaveLength(0);
  });

  it("validates native Canvas refresh status, owner setting, progress, and result over narrow IPC", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receiveProgress: ((message: unknown) => void) | undefined;
    const channel = { channel: "synthetic" };
    const progress: CanvasRefreshProgress[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "store_status") return storeStatus({ state: "authoritative", canvasRefreshEnabled: true, refreshAvailable: true });
      if (command === "set_canvas_refresh_enabled") return { canvasRefreshEnabled: args?.enabled === true, refreshAvailable: args?.enabled === true };
      if (command === "start_canvas_refresh") {
        receiveProgress?.({ phase: "fetch", completed: 2, total: null, bytesDone: 4096 });
        receiveProgress?.({ phase: "<private course name>", completed: 99, total: 100, bytesDone: 2 });
        return { status: "incomplete", updatedAt: "2026-09-23T12:00:00Z" };
      }
      throw new Error(`unexpected command ${command}`);
    }, (onMessage) => { receiveProgress = onMessage; return channel; });

    await expect(transport.storeStatus()).resolves.toMatchObject({ canvasRefreshEnabled: true, refreshAvailable: true });
    await expect(transport.setCanvasRefreshEnabled(false)).resolves.toEqual({ canvasRefreshEnabled: false, refreshAvailable: false });
    await expect(transport.startCanvasRefresh((event) => progress.push(event))).resolves.toEqual({ status: "incomplete", updatedAt: "2026-09-23T12:00:00Z" });
    expect(progress).toEqual([{ phase: "fetch", completed: 2, total: null, bytesDone: 4096 }]);
    expect(calls).toEqual([
      ["store_status", undefined],
      ["set_canvas_refresh_enabled", { enabled: false }],
      ["start_canvas_refresh", { onProgress: channel }],
    ]);
  });

  it("validates the native calendar refresh result and keeps calendar progress content-free", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receiveProgress: ((message: unknown) => void) | undefined;
    const phases: string[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "start_ical_refresh") {
        receiveProgress?.({ phase: "waiting-for-calendar" });
        receiveProgress?.({ phase: "private coursework title" });
        return { status: "complete", updatedAt: "2026-09-25T12:00:00Z", added: 2, updated: 1, held: 3, removed: 0 };
      }
      if (command === "start_full_refresh") {
        receiveProgress?.({ phase: "browser-capture" });
        receiveProgress?.({ phase: "private course title" });
        return { status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete", gapCount: 2, omissionCount: 0, calendarAdded: 1, calendarUpdated: 0, calendarHeld: 3, updatedAt: null, errorCode: "coverage-gap" };
      }
      throw new Error(`unexpected ${command}`);
    }, (onMessage) => { receiveProgress = onMessage; return { channel: "calendar" }; });
    await expect(transport.startIcalRefresh((progress) => phases.push(progress.phase))).resolves.toMatchObject({ added: 2, updated: 1, held: 3, removed: 0 });
    const fullPhases: string[] = [];
    await expect(transport.startFullRefresh((progress) => fullPhases.push(progress.phase))).resolves.toMatchObject({ status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete", gapCount: 2, omissionCount: 0, calendarHeld: 3, errorCode: "coverage-gap" });
    expect(phases).toEqual(["waiting-for-calendar"]);
    expect(fullPhases).toEqual(["browser-capture"]);
    expect(calls).toEqual([
      ["start_ical_refresh", { onProgress: { channel: "calendar" } }],
      ["start_full_refresh", { onProgress: { channel: "calendar" } }],
    ]);
  });

  it("validates native promotion, demotion, and frozen-export commands without accepting paths or confirmation shortcuts", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const channel = { channel: "transition-progress" };
    const progress: { filesDone: number; bytesDone: number }[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (typeof args?.onProgress === "function") (args.onProgress as (event: unknown) => void)({ filesDone: 2, bytesDone: 4096 });
      if (command === "prepare_store_promotion") return { proofId: "proof-opaque", files: 4, bytes: 8192 };
      if (command === "confirm_store_promotion") return { state: "authoritative", files: 4, bytes: 8192 };
      if (command === "demote_store_for_rollback") return { state: "preview", recoveryFiles: 5, recoveryBytes: 9000 };
      if (command === "export_frozen_for_rollback") return { files: 7, bytes: 16_384, equal: true };
      throw new Error(`unexpected command ${command}`);
    }, (receive) => {
      // The injected channel is represented as a callable in this focused transport test.
      return Object.assign((event: unknown) => receive(event), channel);
    });

    const onProgress = (event: { filesDone: number; bytesDone: number }): void => { progress.push(event); };
    await expect(transport.prepareStorePromotion(onProgress)).resolves.toEqual({ proofId: "proof-opaque", files: 4, bytes: 8192 });
    await expect(transport.confirmStorePromotion("proof-opaque", onProgress)).resolves.toEqual({ state: "authoritative", files: 4, bytes: 8192 });
    await expect(transport.demoteStoreForRollback(onProgress)).resolves.toEqual({ state: "preview", recoveryFiles: 5, recoveryBytes: 9000 });
    await expect(transport.exportFrozenForRollback(onProgress)).resolves.toEqual({ files: 7, bytes: 16_384, equal: true });
    expect(calls).toEqual([
      ["prepare_store_promotion", { onProgress: expect.any(Function) }],
      ["confirm_store_promotion", { proofId: "proof-opaque", onProgress: expect.any(Function) }],
      ["demote_store_for_rollback", { onProgress: expect.any(Function) }],
      ["export_frozen_for_rollback", { onProgress: expect.any(Function) }],
    ]);
    expect(progress).toEqual(Array.from({ length: 4 }, () => ({ filesDone: 2, bytesDone: 4096 })));
    expect(calls.every(([, args]) => !Object.hasOwn(args ?? {}, "confirmed"))).toBe(true);

    const malformed = createNativeTransport(async (command) => command === "prepare_store_promotion"
      ? { proofId: "/private/legacy", files: 4, bytes: 8192 }
      : undefined, (receive) => Object.assign((event: unknown) => receive(event), channel));
    await expect(malformed.prepareStorePromotion(() => undefined)).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("never claims the imported desktop copy is synced", () => {
    const inbox = (complete: boolean): string => JSON.stringify({ complete, generatedAt: "2026-09-20T12:05:00Z", conversations: [] });
    const project = (conversations: string | null, options = nativeProjectionOptions("preview")) => projectDashboardDocuments(parseDocumentBundle(nativeBundle({ conversations })), options);

    const imported = project(inbox(true));
    expect(imported.sourceStatus.detail).toContain("Inbox imported");
    expect(project(inbox(false)).sourceStatus.detail).toContain("Inbox partial");
    expect(project(null).sourceStatus.detail).toContain("Inbox not captured");
    for (const status of [imported, project(inbox(false)), project(null), project(inbox(true), nativeProjectionOptions("authoritative"))].map((body) => body.sourceStatus)) {
      expect(status.label).not.toMatch(/synced/i);
      expect(status.detail).not.toMatch(/synced/i);
    }
    const more = renderDashboard({ ...state("more"), data: parseDashboard(imported), desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, handlers);
    expect(words(more)).toContain("Inbox imported");
    expect(words(more)).not.toMatch(/synced/i);
  });

  it("streams validated, content-free import progress through a mocked Tauri channel", async () => {
    const internals = withMockWindow();
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command !== "import_legacy_root") throw new Error(`unexpected command ${command}`);
      const channel = (args as { onProgress: Channel<unknown> }).onProgress;
      const send = (index: number, message: unknown): void => internals.runCallback(channel.id, { index, message });
      // Out of order on purpose: the channel restores order by index.
      send(1, { phase: "copying", filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 });
      send(0, { phase: "scanning", filesDone: 0, filesTotal: 3, bytesDone: 0, bytesTotal: 30 });
      send(2, { phase: "copying", filesDone: 3, filesTotal: 3, bytesDone: 30, bytesTotal: 30, name: "never-surfaced.json" });
      send(3, { phase: "exploding", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
      send(4, { phase: "validating", filesDone: -1, filesTotal: 3, bytesDone: 30, bytesTotal: 30 });
      send(5, { phase: "complete", filesDone: 3, filesTotal: 3, bytesDone: 30, bytesTotal: 30 });
      internals.runCallback(channel.id, { index: 6, end: true });
      return { state: "preview", files: 3, bytes: 30, replacedPreview: true };
    });
    const events: ImportProgress[] = [];
    await expect(nativeTransport().importLegacyRoot(true, (event) => events.push(event))).resolves.toEqual({ state: "preview", files: 3, bytes: 30, replacedPreview: true });
    expect(events.map((event) => [event.phase, event.filesDone, event.bytesDone])).toEqual([["scanning", 0, 0], ["copying", 1, 10], ["copying", 3, 30], ["complete", 3, 30]]);
    for (const event of events) expect(Object.keys(event).sort()).toEqual(["bytesDone", "bytesTotal", "filesDone", "filesTotal", "phase"]);
    expect(JSON.stringify(events)).not.toContain("never-surfaced");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.[1])).toMatch(/^\{"replacePreview":true,"onProgress":"__CHANNEL__:\d+"\}$/);
  });

  it("maps structured command errors, including named refusal counts, and rejects malformed results", async () => {
    withMockWindow();
    let bundle: Record<string, unknown> = nativeBundle();
    let status: unknown = storeStatus();
    mockIPC((command) => {
      if (command === "import_legacy_root") throw { code: "refused", message: "The legacy folder cannot be imported as it is.", refusals: { escapingMaterialSymlinks: 1, malformedJson: 2 }, unsupportedTypes: { script: 1 } };
      if (command === "dry_run_import") throw "no legacy folder";
      if (command === "store_status") return status;
      if (command === "read_dashboard_documents") return bundle;
      if (command === "choose_legacy_root") return { selected: "yes" };
      throw new Error(`unexpected command ${command}`);
    });
    const transport = nativeTransport();
    const refused = await transport.importLegacyRoot(false, () => undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DesktopCommandError);
    expect(refused).toMatchObject({ code: "refused", refusals: { escapingMaterialSymlinks: 1, malformedJson: 2 }, unsupportedTypes: { script: 1 } });
    await expect(transport.dryRunImport()).rejects.toMatchObject({ code: "ipc", message: "no legacy folder" });
    await expect(transport.chooseLegacyRoot()).rejects.toMatchObject({ code: "malformed-response" });

    status = { ...storeStatus(), canvasRefreshEnabled: "yes" };
    await expect(transport.storeStatus()).rejects.toMatchObject({ code: "malformed-response" });
    status = { ...storeStatus(), state: "syncing" };
    await expect(transport.storeStatus()).rejects.toMatchObject({ code: "malformed-response" });

    bundle = nativeBundle({ coursework: { text: "{}", version: "not-a-digest" } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ courseExports: { "../escape": { files: null, pages: null, modules: null, announcements: null, downloadManifest: null } } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ avatar: { sizeBytes: 69, head: new Array(17).fill(0) } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ coursework: { text: "{\"courses\": [", version: DIGEST } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "invalid-coursework" });
  });
});
