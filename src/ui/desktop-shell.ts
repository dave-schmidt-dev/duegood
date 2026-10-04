import { render, type ElementDescriptor } from "./dom";
import { desktopStoreStatusPanel, renderDesktopSetup, setupError, type DesktopSetupHandlers, type DesktopSetupState } from "./desktop-setup";
import type { DesktopStoreInfo } from "./pages/dashboard";
import type { DesktopStoreStatus, NativeTransport } from "./transport";

export interface DesktopDashboardOptions {
  readonly info: DesktopStoreInfo;
  readonly onReplacePreview?: () => void;
  readonly onRecovery?: () => void;
  readonly onExport?: () => void;
}

export type MountDashboard = (mount: HTMLElement, transport: NativeTransport, desktop: DesktopDashboardOptions) => () => void;

/** Swaps desktop setup/recovery screens without allowing delayed native reads to redraw an obsolete screen. */
export function mountDesktop(mount: HTMLElement, transport: NativeTransport, mountDashboard: MountDashboard): void {
  let disposeDashboard: (() => void) | undefined;
  let setup: DesktopSetupState | undefined;
  let frame = 0;
  let screenGeneration = 0;
  let statusReading = false;
  let snapshotReadGeneration: number | undefined;
  let restoreStarting = false;
  let restoreFocusIndex: number | undefined;

  function draw(descriptor: ElementDescriptor): void { mount.replaceChildren(render(descriptor)); }
  function drawSetup(): void { if (setup !== undefined) draw(renderDesktopSetup(setup, setupHandlers)); }
  function scheduleDraw(): void {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => { frame = 0; drawSetup(); });
  }
  function update(next: Partial<DesktopSetupState>): void { if (setup !== undefined) setup = { ...setup, ...next }; }
  function focusRecoveryCancel(): void { mount.querySelector<HTMLButtonElement>("[data-recovery-confirm-cancel]")?.focus(); }
  function focusRestoreRow(index: number | undefined): void {
    if (index === undefined) return;
    [...mount.querySelectorAll<HTMLButtonElement>("[data-recovery-restore-index]")].find((button) => button.dataset.recoveryRestoreIndex === String(index))?.focus();
  }
  function disposeActiveDashboard(): void { disposeDashboard?.(); disposeDashboard = undefined; }
  function activate(): number { screenGeneration += 1; return screenGeneration; }
  function active(generation: number): boolean { return generation === screenGeneration; }

  function showDashboard(status: DesktopStoreStatus): void {
    const storeState = status.state === "authoritative" ? "authoritative" : "preview";
    const info: DesktopStoreInfo = { storeState, dataFolder: status.dataFolder, importedAt: status.importedAt, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, icalRefreshAvailable: status.icalRefreshAvailable, browserRefreshAvailable: status.browserRefreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem };
    setup = undefined;
    disposeActiveDashboard();
    disposeDashboard = mountDashboard(mount, transport, { info, onRecovery: () => startRecovery(status), onExport: () => { startRecovery(status); void runExport(); }, ...(storeState === "preview" ? { onReplacePreview: () => startSetup(status, true) } : {}) });
  }

  function startRecovery(status: DesktopStoreStatus): void {
    const generation = activate();
    disposeActiveDashboard();
    setup = { status, replacePreview: false, step: "idle", recoveryMode: true, recoveryLoading: true };
    drawSetup();
    void loadSnapshots(generation);
  }

  async function loadSnapshots(generation = screenGeneration): Promise<void> {
    if (!active(generation) || snapshotReadGeneration === generation) return;
    snapshotReadGeneration = generation;
    update({ recoveryLoading: true, recoveryError: undefined }); drawSetup();
    try {
      const snapshots = await transport.listSnapshots();
      if (active(generation) && setup?.recoveryMode === true) { update({ snapshots, recoveryLoading: false }); drawSetup(); }
    } catch (error) {
      if (active(generation) && setup?.recoveryMode === true) { update({ recoveryLoading: false, recoveryError: setupError(error).message }); drawSetup(); }
    } finally {
      // A new recovery screen may start its own read while this stale request settles.
      if (snapshotReadGeneration === generation) snapshotReadGeneration = undefined;
    }
  }

  function startSetup(status: DesktopStoreStatus, replacePreview: boolean): void {
    activate();
    disposeActiveDashboard();
    setup = { status, replacePreview, step: "idle" };
    drawSetup();
  }

  async function showCurrent(): Promise<void> {
    if (statusReading) return;
    const generation = activate();
    disposeActiveDashboard();
    setup = undefined;
    draw(desktopStoreStatusPanel({ loading: true }, { onRetry: () => { void showCurrent(); } }));
    statusReading = true;
    try {
      const status = await transport.storeStatus();
      if (!active(generation)) return;
      if (status.availability === "ready" && (status.state === "preview" || status.state === "authoritative")) showDashboard(status);
      else if (status.availability === "ready" && (status.state === "damaged" || status.state === "unknown")) startRecovery(status);
      else startSetup(status, false);
    } catch (error) {
      if (active(generation)) draw(desktopStoreStatusPanel({ error: setupError(error).message }, { onRetry: () => { void showCurrent(); } }));
    } finally { statusReading = false; }
  }

  function selectRestore(id: string): void {
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true || !setup.snapshots?.some((snapshot) => snapshot.id === id)) return;
    restoreFocusIndex = setup.snapshots.findIndex((snapshot) => snapshot.id === id);
    update({ pendingRestoreSnapshotId: id, recoveryMessage: undefined, error: undefined }); drawSetup(); focusRecoveryCancel();
  }

  function cancelRestore(): void {
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true) return;
    const focusIndex = restoreFocusIndex;
    restoreFocusIndex = undefined;
    update({ pendingRestoreSnapshotId: undefined, recoveryMessage: "Restore cancelled. The current app store is unchanged.", error: undefined }); drawSetup(); focusRestoreRow(focusIndex);
  }

  async function confirmRestore(): Promise<void> {
    const id = setup?.pendingRestoreSnapshotId;
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true || restoreStarting || id === undefined) return;
    if (!setup.snapshots?.some((snapshot) => snapshot.id === id)) {
      update({ pendingRestoreSnapshotId: undefined, recoveryMessage: "That recovery point is no longer available. Refresh recovery points and choose another.", error: undefined }); drawSetup(); return;
    }
    restoreStarting = true;
    update({ recoveryBusy: true, recoveryMessage: "Archiving the current store and restoring the snapshot…", error: undefined }); drawSetup();
    try { await transport.restoreSnapshot(id); restoreStarting = false; await showCurrent(); }
    catch (error) { restoreStarting = false; update({ recoveryBusy: false, error: setupError(error), recoveryMessage: undefined }); drawSetup(); focusRecoveryCancel(); }
  }

  async function runExport(): Promise<void> {
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true) return;
    update({ recoveryBusy: true, recoveryMessage: "Choose an export folder…", recoveryFilesDone: 0, error: undefined }); drawSetup();
    try {
      const result = await transport.exportLegacy((progress) => { if (setup?.recoveryMode === true) { update({ recoveryMessage: "Copying rollback files…", recoveryFilesDone: progress.filesDone }); scheduleDraw(); } });
      update({ recoveryBusy: false, recoveryMessage: "Rollback folder exported.", recoveryFilesDone: result.filesDone });
    } catch (error) { update({ recoveryBusy: false, error: setupError(error), recoveryMessage: undefined }); }
    drawSetup();
  }

  async function dryRun(): Promise<void> {
    update({ step: "checking", report: undefined, error: undefined }); drawSetup();
    try { const report = await transport.dryRunImport(); update({ step: "ready", report }); }
    catch (error) { update({ step: "idle", error: setupError(error) }); }
    drawSetup();
  }

  async function choose(): Promise<void> {
    if (setup === undefined || setup.step === "choosing" || setup.step === "checking" || setup.step === "importing") return;
    update({ step: "choosing", error: undefined }); drawSetup();
    let selected = false;
    try { selected = await transport.chooseLegacyRoot(); }
    catch (error) { update({ step: "idle", error: setupError(error) }); drawSetup(); return; }
    if (setup === undefined) return;
    update({ status: { ...setup.status, legacyRootSelected: selected } });
    if (!selected) { update({ step: "idle" }); drawSetup(); return; }
    await dryRun();
  }

  async function runImport(): Promise<void> {
    if (setup === undefined || setup.step !== "ready" || setup.report?.wouldImport !== true) return;
    const replacePreview = setup.replacePreview;
    update({ step: "importing", progress: undefined, error: undefined }); drawSetup();
    try { await transport.importLegacyRoot(replacePreview, (progress) => { if (setup?.step === "importing") { update({ progress }); scheduleDraw(); } }); }
    catch (error) { update({ step: "idle", progress: undefined, report: undefined, error: setupError(error) }); drawSetup(); return; }
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0; }
    await showCurrent();
  }

  async function connectCalendar(): Promise<void> {
    if (setup?.status.state !== "empty" || setup.step === "connecting") return;
    update({ step: "connecting", calendarProgress: undefined, error: undefined }); drawSetup();
    try {
      await transport.startIcalRefresh((calendarProgress) => { if (setup?.step === "connecting") { update({ calendarProgress }); scheduleDraw(); } });
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0; }
      await showCurrent();
    } catch (error) { update({ step: "idle", calendarProgress: undefined, error: setupError(error) }); drawSetup(); }
  }

  const setupHandlers: DesktopSetupHandlers = {
    onConnectCalendar() { void connectCalendar(); }, onChoose() { void choose(); },
    onRecheck() { if (setup !== undefined && setup.step !== "importing") void dryRun(); }, onImport() { void runImport(); },
    onCancel() { void showCurrent(); }, onRestoreSnapshot(id) { selectRestore(id); }, onConfirmRestoreSnapshot() { void confirmRestore(); }, onCancelRestoreSnapshot() { cancelRestore(); }, onExport() { void runExport(); },
    onRetryRecoveryPoints() { void loadSnapshots(); },
  };

  mount.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || setup?.recoveryMode !== true || setup.pendingRestoreSnapshotId === undefined || setup.recoveryBusy === true) return;
    event.preventDefault(); cancelRestore();
  });

  void showCurrent();
}
