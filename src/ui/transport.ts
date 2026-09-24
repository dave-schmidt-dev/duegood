/**
 * How the dashboard reaches its data. Browser mode keeps the loopback HTTP API (reads here;
 * CSRF-protected mutations stay in `app.ts`, unchanged). Native mode calls the desktop app's
 * narrow Rust commands, validates every result, and runs the shared projection over the raw
 * documents, so both modes render the same dashboard. The webview never supplies a path.
 */
import {
  projectDashboardDocuments,
  type AvatarHeader,
  type CourseExportTexts,
  type DashboardBody,
  type DashboardDocumentBundle,
  type DashboardProjectionOptions,
} from "../shared/dashboard-projection";
import type { TauriChannelFactory, TauriInvoke } from "./tauri";

export interface DashboardTransport {
  readonly mode: "browser" | "native";
  /**
   * The `/api/dashboard`-shaped body. Browser mode resolves `undefined` when the loopback
   * projection is unavailable (the caller falls back to the legacy routes); failures throw.
   */
  loadDashboardBody(fresh: boolean): Promise<unknown>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Loopback HTTP transport. `fetchImpl` is resolved per call so test stubs apply. */
export function createBrowserTransport(fetchImpl: FetchLike = (input, init) => fetch(input, init)): DashboardTransport {
  return {
    mode: "browser",
    async loadDashboardBody(fresh) {
      const response = await fetchImpl("/api/dashboard", { credentials: "same-origin", ...(fresh ? { cache: "no-store" } : {}) });
      return response.ok ? await response.json() as unknown : undefined;
    },
  };
}

type DesktopStoreState = "empty" | "preview" | "authoritative" | "damaged" | "unknown";

/** `store_status`: availability, state, and the fixed app-data folder (home shown as `~`). */
export interface DesktopStoreStatus {
  readonly availability: "ready" | "another-instance" | "unavailable";
  readonly state: DesktopStoreState;
  readonly dataFolder: string;
  readonly legacyRootSelected: boolean;
  readonly importedAt: string | null;
  readonly files: number | null;
  readonly bytes: number | null;
  /** True only when the authoritative store, owner setting, and helper self-check all pass. */
  readonly refreshAvailable: boolean;
  /** Owner preference. This alone does not mean refresh is available. */
  readonly canvasRefreshEnabled: boolean;
  /** A private daily recovery snapshot is being written without blocking dashboard reads. */
  readonly snapshotInProgress: boolean;
  readonly snapshotProgress: { readonly filesDone: number; readonly bytesDone: number } | null;
  readonly problem: string | null;
}

/** `dry_run_import`: counts, caps, and named refusals only; no names, paths, or content. */
export interface DryRunReport {
  readonly caps: Readonly<Record<string, number>>;
  readonly inventory: Readonly<Record<string, number>>;
  readonly refusals: Readonly<Record<string, number>>;
  readonly unsupportedTypes: Readonly<Record<string, number>>;
  readonly legacyLockPresent: boolean;
  readonly wouldImport: boolean;
}

export const IMPORT_PHASES = ["locking", "scanning", "hashing", "copying", "rechecking", "validating", "adopting", "complete"] as const;
type ImportPhase = (typeof IMPORT_PHASES)[number];

/** One content-free progress event streamed while an import runs. */
export interface ImportProgress {
  readonly phase: ImportPhase;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

interface ImportSummary {
  readonly state: "preview" | "authoritative";
  readonly files: number;
  readonly bytes: number;
  readonly replacedPreview: boolean;
}

/** A structured, content-free command failure. `refusals` names every reason an import stopped. */
export class DesktopCommandError extends Error {
  readonly code: string;
  readonly refusals: Readonly<Record<string, number>>;
  readonly unsupportedTypes: Readonly<Record<string, number>>;
  readonly currentValue: boolean | undefined;

  constructor(code: string, message: string, refusals: Readonly<Record<string, number>> = {}, unsupportedTypes: Readonly<Record<string, number>> = {}, currentValue?: boolean) {
    super(message);
    this.name = "DesktopCommandError";
    this.code = code;
    this.refusals = refusals;
    this.unsupportedTypes = unsupportedTypes;
    this.currentValue = currentValue;
  }
}

export interface NativeTransport extends DashboardTransport {
  readonly mode: "native";
  storeStatus(): Promise<DesktopStoreStatus>;
  setCanvasRefreshEnabled(enabled: boolean): Promise<CanvasRefreshSetting>;
  startCanvasRefresh(onProgress: (progress: CanvasRefreshProgress) => void): Promise<CanvasRefreshResult>;
  /** Opens the native folder picker in Rust; resolves whether a legacy folder is selected. */
  chooseLegacyRoot(): Promise<boolean>;
  dryRunImport(): Promise<DryRunReport>;
  importLegacyRoot(replacePreview: boolean, onProgress: (progress: ImportProgress) => void): Promise<ImportSummary>;
  loadDashboardBody(fresh: boolean): Promise<DashboardBody>;
  setCompletion(itemId: string, expected: boolean, value: boolean): Promise<NativeMutationResult>;
  setDiscussionField(itemId: string, field: "post" | "replies", expected: boolean, value: boolean): Promise<NativeMutationResult>;
  readAvatar(): Promise<{ readonly contentType: string; readonly bytes: Uint8Array } | null>;
  openResource(id: string): Promise<"opened" | "downloaded" | "cancelled">;
  copyText(text: string): Promise<void>;
  listSnapshots(): Promise<readonly DesktopSnapshot[]>;
  restoreSnapshot(id: string): Promise<void>;
  exportLegacy(onProgress: (progress: { readonly filesDone: number; readonly bytesDone: number }) => void): Promise<{ readonly filesDone: number; readonly bytesDone: number }>;
  /** Native folder picker plus an exact content-tree comparison. Proof stays in memory only. */
  prepareStorePromotion(onProgress: (progress: StoreTransitionProgress) => void): Promise<PromotionReadiness>;
  /** Consumes a one-use proof and asks for a second confirmation in a native OS dialog. */
  confirmStorePromotion(proofId: string, onProgress: (progress: StoreTransitionProgress) => void): Promise<PromotionResult>;
  /** Native confirmation, guarded rollback, and refresh disablement. */
  demoteStoreForRollback(onProgress: (progress: StoreTransitionProgress) => void): Promise<DemotionResult>;
  /** Native folder picker and frozen, byte-verified rollback export. */
  exportFrozenForRollback(onProgress: (progress: StoreTransitionProgress) => void): Promise<FrozenExportResult>;
}

interface PromotionReadiness { readonly proofId: string; readonly files: number; readonly bytes: number }
interface PromotionResult { readonly state: "authoritative"; readonly files: number; readonly bytes: number }
interface DemotionResult { readonly state: "preview"; readonly recoveryFiles: number; readonly recoveryBytes: number }
interface FrozenExportResult { readonly files: number; readonly bytes: number; readonly equal: boolean }
export interface StoreTransitionProgress { readonly filesDone: number; readonly bytesDone: number }

interface CanvasRefreshSetting {
  readonly canvasRefreshEnabled: boolean;
  readonly refreshAvailable: boolean;
}

/** Content-free progress from the native refresh helper. */
export interface CanvasRefreshProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number | null;
  readonly bytesDone: number | null;
}

interface CanvasRefreshResult {
  readonly status: "complete" | "incomplete";
  readonly updatedAt: string | null;
}

interface NativeMutationResult {
  readonly completed: boolean;
  readonly completedAt: number | null;
  readonly discussionPostDone: boolean;
  readonly discussionRepliesDone: boolean;
  readonly version: string;
}

export interface DesktopSnapshot { readonly id: string; readonly createdAt: string; readonly kind: "daily" | "pre-refresh" }

type JsonObject = Record<string, unknown>;

function malformed(what: string): DesktopCommandError {
  return new DesktopCommandError("malformed-response", `The desktop app returned an unexpected ${what}.`);
}

function objectOf(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed(what);
  return value as JsonObject;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw malformed(what);
  return value;
}

function nullableCount(value: unknown, what: string): number | null {
  return value === null ? null : count(value, what);
}

function nullableString(value: unknown, what: string): string | null {
  if (value !== null && typeof value !== "string") throw malformed(what);
  return value;
}

function counts(value: unknown, what: string): Readonly<Record<string, number>> {
  const record = objectOf(value, what);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, count(entry, what)]));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw malformed(what);
  return value as T;
}

function commandError(error: unknown): DesktopCommandError {
  if (error instanceof DesktopCommandError) return error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as JsonObject;
    if (typeof record.code === "string" && typeof record.message === "string") {
      const refusals = typeof record.refusals === "object" && record.refusals !== null ? safeCounts(record.refusals) : {};
      const unsupported = typeof record.unsupportedTypes === "object" && record.unsupportedTypes !== null ? safeCounts(record.unsupportedTypes) : {};
      return new DesktopCommandError(record.code, record.message, refusals, unsupported, typeof record.currentValue === "boolean" ? record.currentValue : undefined);
    }
  }
  return new DesktopCommandError("ipc", typeof error === "string" ? error : "The desktop command failed.");
}

function safeCounts(value: object): Readonly<Record<string, number>> {
  try { return counts(value, "refusal count"); } catch { return {}; }
}

function parseStatus(value: unknown): DesktopStoreStatus {
  const record = objectOf(value, "store status");
  if (typeof record.dataFolder !== "string" || typeof record.legacyRootSelected !== "boolean" || typeof record.refreshAvailable !== "boolean" || typeof record.canvasRefreshEnabled !== "boolean") throw malformed("store status");
  let snapshotProgress: DesktopStoreStatus["snapshotProgress"] = null;
  if (record.snapshotProgress !== undefined && record.snapshotProgress !== null) {
    const progress = objectOf(record.snapshotProgress, "snapshot progress");
    snapshotProgress = { filesDone: count(progress.filesDone, "snapshot progress"), bytesDone: count(progress.bytesDone, "snapshot progress") };
  }
  return {
    availability: oneOf(record.availability, ["ready", "another-instance", "unavailable"], "store availability"),
    state: oneOf(record.state, ["empty", "preview", "authoritative", "damaged", "unknown"], "store state"),
    dataFolder: record.dataFolder,
    legacyRootSelected: record.legacyRootSelected,
    importedAt: nullableString(record.importedAt, "import time"),
    files: nullableCount(record.files, "file count"),
    bytes: nullableCount(record.bytes, "byte count"),
    refreshAvailable: record.refreshAvailable,
    canvasRefreshEnabled: record.canvasRefreshEnabled,
    snapshotInProgress: record.snapshotInProgress === true,
    snapshotProgress,
    problem: nullableString(record.problem, "problem"),
  };
}

function parseDryRun(value: unknown): DryRunReport {
  const record = objectOf(value, "dry-run report");
  if (typeof record.legacyLockPresent !== "boolean" || typeof record.wouldImport !== "boolean") throw malformed("dry-run report");
  return {
    caps: counts(record.caps, "cap"),
    inventory: counts(record.inventory, "inventory count"),
    refusals: counts(record.refusals, "refusal count"),
    unsupportedTypes: counts(record.unsupportedTypes, "type count"),
    legacyLockPresent: record.legacyLockPresent,
    wouldImport: record.wouldImport,
  };
}

/** Validates one streamed progress event; anything else is dropped. */
function parseImportProgress(value: unknown): ImportProgress | null {
  try {
    const record = objectOf(value, "progress event");
    return {
      phase: oneOf(record.phase, IMPORT_PHASES, "import phase"),
      filesDone: count(record.filesDone, "progress"),
      filesTotal: count(record.filesTotal, "progress"),
      bytesDone: count(record.bytesDone, "progress"),
      bytesTotal: count(record.bytesTotal, "progress"),
    };
  } catch {
    return null;
  }
}

function parseSummary(value: unknown): ImportSummary {
  const record = objectOf(value, "import summary");
  if (typeof record.replacedPreview !== "boolean") throw malformed("import summary");
  return { state: oneOf(record.state, ["preview", "authoritative"], "store state"), files: count(record.files, "file count"), bytes: count(record.bytes, "byte count"), replacedPreview: record.replacedPreview };
}

function parseMutation(value: unknown): NativeMutationResult {
  const row = objectOf(value, "mutation result");
  if (typeof row.completed !== "boolean" || typeof row.discussionPostDone !== "boolean" || typeof row.discussionRepliesDone !== "boolean" || typeof row.version !== "string") throw malformed("mutation result");
  return { completed: row.completed, completedAt: nullableCount(row.completedAt, "completion time"), discussionPostDone: row.discussionPostDone, discussionRepliesDone: row.discussionRepliesDone, version: row.version };
}

function parseExportProgress(value: unknown): { readonly filesDone: number; readonly bytesDone: number } {
  const row = objectOf(value, "export progress");
  return { filesDone: count(row.filesDone, "export file count"), bytesDone: count(row.bytesDone, "export byte count") };
}

function opaqueProofId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\\/]/.test(value)) throw malformed("promotion proof");
  return value;
}

function parsePromotionReadiness(value: unknown): PromotionReadiness {
  const row = objectOf(value, "promotion readiness");
  return { proofId: opaqueProofId(row.proofId), files: count(row.files, "promotion file count"), bytes: count(row.bytes, "promotion byte count") };
}

function parsePromotionResult(value: unknown): PromotionResult {
  const row = objectOf(value, "promotion result");
  return { state: oneOf(row.state, ["authoritative"], "promoted store state"), files: count(row.files, "promotion file count"), bytes: count(row.bytes, "promotion byte count") };
}

function parseDemotionResult(value: unknown): DemotionResult {
  const row = objectOf(value, "rollback result");
  return { state: oneOf(row.state, ["preview"], "rollback store state"), recoveryFiles: count(row.recoveryFiles, "recovery file count"), recoveryBytes: count(row.recoveryBytes, "recovery byte count") };
}

function parseFrozenExportResult(value: unknown): FrozenExportResult {
  const row = objectOf(value, "frozen export result");
  if (typeof row.equal !== "boolean") throw malformed("frozen export equality");
  return { files: count(row.files, "export file count"), bytes: count(row.bytes, "export byte count"), equal: row.equal };
}

function parseCanvasRefreshProgress(value: unknown): CanvasRefreshProgress | null {
  try {
    const row = objectOf(value, "Canvas refresh progress");
    if (typeof row.phase !== "string" || row.phase.length === 0 || row.phase.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(row.phase)) return null;
    return {
      phase: row.phase,
      completed: count(row.completed, "Canvas refresh progress"),
      total: nullableCount(row.total, "Canvas refresh progress"),
      bytesDone: nullableCount(row.bytesDone, "Canvas refresh progress"),
    };
  } catch {
    return null;
  }
}

function parseCanvasRefreshSetting(value: unknown): CanvasRefreshSetting {
  const row = objectOf(value, "Canvas refresh setting");
  if (typeof row.canvasRefreshEnabled !== "boolean" || typeof row.refreshAvailable !== "boolean") throw malformed("Canvas refresh setting");
  return { canvasRefreshEnabled: row.canvasRefreshEnabled, refreshAvailable: row.refreshAvailable };
}

function parseCanvasRefreshResult(value: unknown): CanvasRefreshResult {
  const row = objectOf(value, "Canvas refresh result");
  const updatedAt = nullableString(row.updatedAt, "Canvas refresh time");
  if (updatedAt !== null && !Number.isFinite(Date.parse(updatedAt))) throw malformed("Canvas refresh time");
  return { status: oneOf(row.status, ["complete", "incomplete"], "Canvas refresh status"), updatedAt };
}

function parseAvatar(value: unknown): AvatarHeader | null {
  if (value === null) return null;
  const record = objectOf(value, "avatar header");
  if (!Array.isArray(record.head) || record.head.length > 16) throw malformed("avatar header");
  const head = record.head.map((byte) => { if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) throw malformed("avatar header"); return byte; });
  return { sizeBytes: count(record.sizeBytes, "avatar size"), head };
}

function parseCourseExports(value: unknown): Readonly<Record<string, CourseExportTexts>> {
  const record = objectOf(value, "course exports");
  const result: Record<string, CourseExportTexts> = {};
  for (const [folder, candidate] of Object.entries(record)) {
    if (!/^[a-z0-9-]+$/.test(folder)) throw malformed("course folder name");
    const texts = objectOf(candidate, "course export");
    result[folder] = {
      files: nullableString(texts.files, "course export"),
      pages: nullableString(texts.pages, "course export"),
      modules: nullableString(texts.modules, "course export"),
      announcements: nullableString(texts.announcements, "course export"),
      downloadManifest: nullableString(texts.downloadManifest, "course export"),
    };
  }
  return result;
}

/** Validates the `read_dashboard_documents` result. */
export function parseDocumentBundle(value: unknown): DashboardDocumentBundle {
  const record = objectOf(value, "document bundle");
  const coursework = objectOf(record.coursework, "coursework document");
  if (typeof coursework.text !== "string" || typeof coursework.version !== "string" || !/^[0-9a-f]{64}$/.test(coursework.version)) throw malformed("coursework document");
  return {
    storeState: oneOf(record.storeState, ["preview", "authoritative"], "store state"),
    coursework: { text: coursework.text, version: coursework.version },
    refreshHistory: nullableString(record.refreshHistory, "refresh history"),
    conversations: nullableString(record.conversations, "Inbox document"),
    profile: nullableString(record.profile, "profile document"),
    avatar: parseAvatar(record.avatar),
    courseExports: parseCourseExports(record.courseExports),
  };
}

/**
 * Native-mode projection options; the only intended differences from browser mode. The desktop
 * store holds imported documents it never refreshes, so its source detail never claims "synced".
 */
export function nativeProjectionOptions(storeState: DashboardDocumentBundle["storeState"]): DashboardProjectionOptions {
  return { resourceOpenPrefix: null, avatarPath: null, refreshAvailable: false, sourceLabel: storeState === "preview" ? "Desktop preview copy" : "Desktop app store", dataOrigin: "imported" };
}

/** Desktop transport over Tauri IPC. `invoke` and `createChannel` are injected for testing. */
export function createNativeTransport(invoke: TauriInvoke, createChannel: TauriChannelFactory): NativeTransport {
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      return await invoke(command, args);
    } catch (error) {
      throw commandError(error);
    }
  }
  function progressChannel(onProgress: (progress: StoreTransitionProgress) => void): object {
    return createChannel((event) => { try { onProgress(parseExportProgress(event)); } catch { /* invalid advisory event */ } });
  }
  return {
    mode: "native",
    async storeStatus() { return parseStatus(await call("store_status")); },
    async setCanvasRefreshEnabled(enabled) { return parseCanvasRefreshSetting(await call("set_canvas_refresh_enabled", { enabled })); },
    async startCanvasRefresh(onProgress) {
      const channel = createChannel((message) => {
        const progress = parseCanvasRefreshProgress(message);
        if (progress !== null) onProgress(progress);
      });
      return parseCanvasRefreshResult(await call("start_canvas_refresh", { onProgress: channel }));
    },
    async chooseLegacyRoot() {
      const choice = objectOf(await call("choose_legacy_root"), "folder choice");
      if (typeof choice.selected !== "boolean") throw malformed("folder choice");
      return choice.selected;
    },
    async dryRunImport() { return parseDryRun(await call("dry_run_import")); },
    async importLegacyRoot(replacePreview, onProgress) {
      const channel = createChannel((message) => {
        const progress = parseImportProgress(message);
        if (progress !== null) onProgress(progress);
      });
      return parseSummary(await call("import_legacy_root", { replacePreview, onProgress: channel }));
    },
    async loadDashboardBody() {
      const bundle = parseDocumentBundle(await call("read_dashboard_documents"));
      try {
        return projectDashboardDocuments(bundle, nativeProjectionOptions(bundle.storeState));
      } catch {
        throw new DesktopCommandError("invalid-coursework", "The stored coursework document could not be read. Nothing was changed.");
      }
    },
    async setCompletion(itemId, expected, value) { return parseMutation(await call("set_item_completion", { itemId, expected, value })); },
    async setDiscussionField(itemId, field, expected, value) { return parseMutation(await call("set_discussion_field", { itemId, field, expected, value })); },
    async readAvatar() {
      const payload = await call("read_avatar_bytes");
      if (payload === null) return null;
      const row = objectOf(payload, "avatar bytes");
      if (typeof row.contentType !== "string" || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(row.contentType) || !Array.isArray(row.bytes) || row.bytes.length > 5 * 1024 * 1024 || row.bytes.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) throw malformed("avatar bytes");
      return { contentType: row.contentType, bytes: Uint8Array.from(row.bytes as number[]) };
    },
    async openResource(id) { return oneOf(await call("open_library_resource", { id }), ["opened", "downloaded", "cancelled"] as const, "resource action"); },
    async copyText(text) { await call("copy_assignment_text", { text }); },
    async listSnapshots() {
      const payload = await call("list_snapshots");
      if (!Array.isArray(payload)) throw malformed("snapshot list");
      return payload.map((value): DesktopSnapshot => { const row = objectOf(value, "snapshot"); if (typeof row.id !== "string" || typeof row.createdAt !== "string") throw malformed("snapshot"); return { id: row.id, createdAt: row.createdAt, kind: oneOf(row.kind, ["daily", "pre-refresh"], "snapshot kind") }; });
    },
    async restoreSnapshot(id) { await call("restore_snapshot", { id }); },
    async exportLegacy(onProgress) {
      const channel = createChannel((event) => { try { onProgress(parseExportProgress(event)); } catch { /* invalid advisory event */ } });
      return parseExportProgress(await call("export_legacy_folder", { onProgress: channel }));
    },
    async prepareStorePromotion(onProgress) { return parsePromotionReadiness(await call("prepare_store_promotion", { onProgress: progressChannel(onProgress) })); },
    async confirmStorePromotion(proofId, onProgress) { return parsePromotionResult(await call("confirm_store_promotion", { proofId, onProgress: progressChannel(onProgress) })); },
    async demoteStoreForRollback(onProgress) { return parseDemotionResult(await call("demote_store_for_rollback", { onProgress: progressChannel(onProgress) })); },
    async exportFrozenForRollback(onProgress) { return parseFrozenExportResult(await call("export_frozen_for_rollback", { onProgress: progressChannel(onProgress) })); },
  };
}
