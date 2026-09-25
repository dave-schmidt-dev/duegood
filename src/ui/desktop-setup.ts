import { desktopRecoveryPanel } from "./components/recovery-panel";
import type { ElementDescriptor } from "./dom";
import { DesktopCommandError, type DesktopStoreStatus, type DryRunReport, type ImportProgress, type DesktopSnapshot, type IcalRefreshProgress } from "./transport";

function element(tag: string, attrs: Record<string, string> = {}, text?: string): ElementDescriptor {
  return { tag, attrs, ...(text !== undefined ? { text } : {}) };
}

const REFUSAL_LABELS: Readonly<Record<string, string>> = {
  missingCourseworkDocument: "coursework.json is missing",
  unsupportedRootEntries: "Unrecognized items at the top level",
  unsupportedCourseEntries: "Unrecognized items in course folders",
  unsupportedExportEntries: "Unrecognized items in Canvas exports",
  invalidCourseFolderNames: "Course folders with unsupported names",
  symlinksOutsideMaterials: "Links outside a materials folder",
  escapingMaterialSymlinks: "Material links that leave the materials folder",
  brokenMaterialSymlinks: "Broken material links",
  materialSymlinksToNonFiles: "Material links to folders or special files",
  specialFiles: "Special files (sockets, devices, pipes)",
  leftoverTemporaryFiles: "Leftover temporary files",
  staleLockRemnants: "Leftover lock folders",
  filesOverPerFileCap: "Files over the per-file cap",
  jsonDocumentsOverCap: "JSON documents over the JSON cap",
  totalBytesOverCap: "Total size over the cap",
  entriesOverCap: "More files and folders than the cap",
  materialsNestedTooDeep: "Materials nested deeper than the cap",
  malformedJson: "Malformed JSON documents",
  duplicateJsonKeys: "JSON documents with duplicate keys",
  invalidCourseworkDocument: "Invalid coursework document",
  duplicateCourseKeys: "Duplicate course keys",
  duplicateItemIds: "Duplicate item IDs",
  nonUtf8Names: "Names that are not valid UTF-8",
  unreadableEntries: "Unreadable items",
};

const INVENTORY_LABELS: readonly (readonly [string, string])[] = [
  ["courseworkDocuments", "Coursework documents"],
  ["courseFolders", "Course folders"],
  ["exportDocuments", "Canvas export documents"],
  ["materialFiles", "Material files"],
  ["historyDocuments", "Refresh history documents"],
  ["inboxDocuments", "Inbox documents"],
  ["profileDocuments", "Profile documents"],
  ["files", "Files in total"],
  ["directories", "Folders in total"],
];

const PHASE_LABELS: Readonly<Record<ImportProgress["phase"], string>> = {
  locking: "Waiting for the source folder lock",
  scanning: "Checking the legacy folder",
  hashing: "Fingerprinting files",
  copying: "Copying files",
  rechecking: "Confirming nothing changed during the copy",
  validating: "Validating the copy",
  adopting: "Adopting the preview copy",
  complete: "Import complete",
};

/** The first-run / recovery screen state. The legacy folder path never reaches the webview. */
export interface DesktopSetupState {
  readonly status: DesktopStoreStatus;
  readonly replacePreview: boolean;
  readonly step: "idle" | "choosing" | "checking" | "ready" | "importing" | "connecting";
  readonly calendarProgress?: IcalRefreshProgress;
  readonly report?: DryRunReport;
  readonly progress?: ImportProgress;
  readonly error?: { readonly message: string; readonly refusals: Readonly<Record<string, number>>; readonly unsupportedTypes: Readonly<Record<string, number>> };
  readonly recoveryMode?: boolean;
  readonly snapshots?: readonly DesktopSnapshot[];
  readonly recoveryBusy?: boolean;
  readonly recoveryMessage?: string;
  readonly recoveryFilesDone?: number;
}

export interface DesktopSetupHandlers {
  readonly onConnectCalendar?: () => void;
  readonly onChoose: () => void;
  readonly onRecheck: () => void;
  readonly onImport: () => void;
  readonly onCancel?: () => void;
  readonly onRestoreSnapshot?: (id: string) => void;
  readonly onExport?: () => void;
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? "TB"}`;
}

function countRows(counts: Readonly<Record<string, number>>, labels: Readonly<Record<string, string>>, className: string): ElementDescriptor {
  return { tag: "ul", attrs: { class: className }, children: Object.entries(counts).map(([name, total]) => ({ tag: "li", children: [element("span", {}, labels[name] ?? name), element("strong", {}, String(total))] })) };
}

export function setupPanel(eyebrow: string, title: string, children: readonly ElementDescriptor[]): ElementDescriptor {
  return { tag: "div", attrs: { class: "shell desktop-setup" }, children: [{ tag: "main", attrs: { id: "main", class: "panel setup-card", tabindex: "-1" }, children: [element("p", { class: "eyebrow" }, eyebrow), element("h1", {}, title), ...children] }] };
}

function folderBox(label: string, note: string, folder: string): ElementDescriptor {
  return { tag: "div", attrs: { class: "setup-choice" }, children: [element("strong", {}, label), element("small", {}, note), element("code", { class: "setup-path" }, folder.length > 0 ? folder : "Unavailable")] };
}

/** Renders the desktop first-run, replace-preview, and recovery screens as a pure descriptor. */
export function renderDesktopSetup(state: DesktopSetupState, handlers: DesktopSetupHandlers): ElementDescriptor {
  const { status } = state;
  const dataFolder = folderBox("App data folder", "Fixed for this app on this computer. It cannot be changed.", status.dataFolder);
  if (status.availability === "another-instance") {
    return setupPanel("Desktop app", "Due Good is already open", [element("p", {}, "Another Due Good window owns the app store. Use that window; this one reads and changes nothing."), dataFolder]);
  }
  if (status.availability === "unavailable") {
    return setupPanel("Desktop app", "App data folder unavailable", [element("p", { role: "alert" }, status.problem ?? "The app data folder could not be opened."), dataFolder]);
  }
  if (state.recoveryMode === true) {
    return setupPanel("Recovery", "Recover or export coursework", [
      desktopRecoveryPanel({ snapshots: state.snapshots ?? [], importedAt: status.importedAt, busy: state.recoveryBusy === true, message: state.recoveryMessage, filesDone: state.recoveryFilesDone }, {
        onRestore: (id) => handlers.onRestoreSnapshot?.(id),
        onExport: () => handlers.onExport?.(),
        ...(status.state === "preview" || status.state === "authoritative" ? { onBack: () => handlers.onCancel?.() } : {}),
      }),
      ...(state.error === undefined ? [] : [element("p", { role: "alert" }, state.error.message)]),
    ]);
  }
  if (status.state === "damaged" || status.state === "unknown") {
    return setupPanel("Recovery", "The app store needs recovery", [
      element("p", {}, "Due Good found its app store but could not read it safely. Nothing was changed, and nothing will be imported over it."),
      ...(status.problem === null ? [] : [element("p", { class: "status", role: "status" }, status.problem)]),
      dataFolder,
    ]);
  }
  if (status.state === "empty") {
    const connecting = state.step === "connecting";
    const phase = state.calendarProgress?.phase;
    const progress = phase === "broker-starting" ? "Opening the calendar connection…"
      : phase === "waiting-for-calendar" ? "Fetching your calendar…"
      : phase === "importing" ? "Adding calendar assignments…"
      : "";
    return setupPanel("First run", "Connect your Canvas calendar", [
      element("p", {}, "Due Good will create a fresh local coursework list from your calendar feed. The feed credential is separate from a Canvas API token."),
      element("p", {}, "Calendar events can supply assignments and dates. They do not include grades, messages, or progress saved in an older Due Good folder."),
      dataFolder,
      { tag: "button", attrs: { type: "button", class: "more-action", ...(connecting ? { disabled: "" } : {}) }, text: connecting ? "Connecting…" : "Connect calendar", on: { click: () => handlers.onConnectCalendar?.() } },
      ...(connecting ? [element("p", { role: "status", "aria-live": "polite" }, progress)] : []),
      ...(state.error === undefined ? [] : [element("p", { role: "alert" }, state.error.message)]),
    ]);
  }
  const busy = state.step === "choosing" || state.step === "checking" || state.step === "importing";
  const report = state.report;
  const progress = state.progress;
  const disabled = (flag: boolean): Record<string, string> => flag ? { disabled: "" } : {};
  const stepNote = state.step === "choosing" ? "Waiting for the folder picker…" : state.step === "checking" ? "Running a dry run. Nothing is copied." : status.legacyRootSelected ? "Folder selected. Its location is never shown or stored." : "No folder selected.";
  const children: ElementDescriptor[] = [
    element("p", {}, state.replacePreview
      ? "Import the legacy folder again. The current preview copy is first archived into a private, timestamped backup that is never deleted."
      : "Import your existing Due Good folder once. Due Good copies it into its own app store and never changes the original folder."),
    { tag: "p", attrs: { class: "preview-label" }, children: [element("span", { class: "preview-badge" }, "Preview copy"), element("span", {}, " It does not follow later changes in the legacy local source. Personal progress edits stay in this copy.")] },
    dataFolder,
    { tag: "div", attrs: { class: "setup-choice" }, children: [
      element("strong", {}, "Legacy folder"),
      element("small", {}, "The folder that holds coursework.json and the classes folder. Chosen with the system folder picker."),
      element("span", { class: "setup-step", role: "status", "aria-live": "polite" }, stepNote),
      { tag: "div", attrs: { class: "setup-actions" }, children: [
        { tag: "button", attrs: { type: "button", class: "more-action", ...disabled(busy) }, text: "Choose legacy folder…", on: { click: handlers.onChoose } },
        ...(status.legacyRootSelected && !busy ? [{ tag: "button", attrs: { type: "button", class: "setup-secondary" }, text: "Check again", on: { click: handlers.onRecheck } }] : []),
      ] },
    ] },
  ];
  if (report !== undefined) {
    const inventory = Object.fromEntries(INVENTORY_LABELS.filter(([name]) => name in report.inventory).map(([name]) => [name, report.inventory[name] ?? 0]));
    children.push({ tag: "section", attrs: { class: "setup-report", "aria-label": "Dry run" }, children: [
      element("h2", {}, "Dry run"),
      element("p", {}, `Counts only; nothing was copied. ${byteSize(report.inventory.bytes ?? 0)} in total.`),
      countRows(inventory, Object.fromEntries(INVENTORY_LABELS), "setup-counts"),
      ...(report.legacyLockPresent ? [element("p", { class: "status", role: "status" }, "The legacy local source is being written right now. The import waits for that write to finish.")] : []),
      ...(Object.keys(report.refusals).length === 0 ? [] : [element("p", { class: "inline-error" }, "The folder cannot be imported as it is. Nothing is dropped silently:"), countRows(report.refusals, REFUSAL_LABELS, "setup-counts setup-refusals")]),
      ...(Object.keys(report.unsupportedTypes).length === 0 ? [] : [element("p", {}, "Unsupported items by type:"), countRows(report.unsupportedTypes, {}, "setup-counts")]),
    ] });
  }
  if (state.step === "importing") {
    const total = progress?.filesTotal ?? 0;
    children.push({ tag: "div", attrs: { class: "setup-progress", role: "status", "aria-live": "polite" }, children: [
      element("strong", {}, progress === undefined ? "Starting the import…" : PHASE_LABELS[progress.phase]),
      { tag: "progress", attrs: { max: String(Math.max(total, 1)), value: String(progress?.filesDone ?? 0), "aria-label": "Import progress" } },
      element("span", {}, progress === undefined ? "" : `${String(progress.filesDone)} of ${String(progress.filesTotal)} files · ${byteSize(progress.bytesDone)} of ${byteSize(progress.bytesTotal)}`),
    ] });
  }
  if (state.error !== undefined) {
    children.push({ tag: "div", attrs: { class: "load-error", role: "alert" }, children: [
      element("strong", {}, state.error.message),
      ...(Object.keys(state.error.refusals).length === 0 ? [] : [countRows(state.error.refusals, REFUSAL_LABELS, "setup-counts setup-refusals")]),
      ...(Object.keys(state.error.unsupportedTypes).length === 0 ? [] : [countRows(state.error.unsupportedTypes, {}, "setup-counts")]),
    ] });
  }
  children.push({ tag: "div", attrs: { class: "setup-actions" }, children: [
    { tag: "button", attrs: { type: "button", class: "sync-button", ...disabled(busy || report?.wouldImport !== true) }, text: state.replacePreview ? "Archive and replace preview copy" : "Import as preview copy", on: { click: handlers.onImport } },
    ...(!state.replacePreview || handlers.onCancel === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary", ...disabled(state.step === "importing") }, text: "Keep current preview copy", on: { click: handlers.onCancel } }]),
  ] });
  return setupPanel(state.replacePreview ? "Replace preview copy" : "Local import", state.replacePreview ? "Replace the preview copy" : "Import existing coursework", children);
}

export function setupError(error: unknown): NonNullable<DesktopSetupState["error"]> {
  if (error instanceof DesktopCommandError) return { message: error.message, refusals: error.refusals, unsupportedTypes: error.unsupportedTypes };
  return { message: "The desktop command failed. Nothing was changed.", refusals: {}, unsupportedTypes: {} };
}
