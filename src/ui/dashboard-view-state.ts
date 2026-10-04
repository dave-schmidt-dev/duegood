import { DASHBOARD_ROUTES, type DashboardPage } from "./routes";

const STORAGE_PREFIX = "com.zerodelta.duegood.dashboard-view-state.v1";
const MAX_STORED_BYTES = 32 * 1024;
const MAX_EXPANDED_IDS = 100;
const MAX_ID_LENGTH = 256;
const MAX_DRAFT_LENGTH = 16_000;
const MAX_SCROLL_Y = 10_000_000;

export interface DashboardViewStateData {
  readonly courses: readonly { readonly courseCode: string }[];
  readonly events: readonly { readonly id: string; readonly kind: string }[];
  readonly resources: readonly { readonly type: string }[];
  readonly conversations: readonly { readonly id: string }[];
  readonly refreshes: readonly { readonly id: string }[];
}

export interface DashboardViewState {
  readonly eventMode: "all" | "deadlines";
  readonly courseFilter: string;
  readonly gradeCourseFilter: string;
  readonly gradeMode: "all" | "graded";
  readonly resourceFilter: string;
  readonly expandedEventIds: readonly string[];
  readonly selectedConversationId?: string;
  readonly selectedRefreshId?: string;
  readonly editingManualGrade?: { readonly id: string; readonly draft: string };
  readonly scrollPositions: Readonly<Partial<Record<DashboardPage, number>>>;
}

export interface DashboardViewStateStore {
  load(): DashboardViewState;
  save(value: DashboardViewState): boolean;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EMPTY_VIEW_STATE: DashboardViewState = {
  eventMode: "all",
  courseFilter: "all",
  gradeCourseFilter: "all",
  gradeMode: "all",
  resourceFilter: "all",
  expandedEventIds: [],
  scrollPositions: {},
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function preference(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH ? value : fallback;
}

function scrollPosition(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SCROLL_Y ? Math.floor(value) : undefined;
}

function isPage(value: string): value is DashboardPage {
  return DASHBOARD_ROUTES.some((route) => route.page === value);
}

function storageKey(namespace: string): string | undefined {
  try { return `${STORAGE_PREFIX}:${encodeURIComponent(namespace)}`; } catch { return undefined; }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Parses only bounded local presentation preferences; invalid storage falls back to defaults. */
export function parseDashboardViewState(value: unknown): DashboardViewState {
  const source = record(value);
  if (source === undefined) return EMPTY_VIEW_STATE;
  const editing = record(source.editingManualGrade);
  const expanded = Array.isArray(source.expandedEventIds)
    ? [...new Set(source.expandedEventIds.map(id).filter((value): value is string => value !== undefined))].slice(0, MAX_EXPANDED_IDS)
    : [];
  const positions = record(source.scrollPositions);
  const scrollPositions: Partial<Record<DashboardPage, number>> = {};
  for (const [page, position] of Object.entries(positions ?? {})) {
    const parsed = scrollPosition(position);
    if (isPage(page) && parsed !== undefined) scrollPositions[page] = parsed;
  }
  const draft = typeof editing?.draft === "string" && editing.draft.length <= MAX_DRAFT_LENGTH ? editing.draft : undefined;
  const editingId = id(editing?.id);
  return {
    eventMode: source.eventMode === "deadlines" ? "deadlines" : "all",
    courseFilter: preference(source.courseFilter, "all"),
    gradeCourseFilter: preference(source.gradeCourseFilter, "all"),
    gradeMode: source.gradeMode === "graded" ? "graded" : "all",
    resourceFilter: preference(source.resourceFilter, "all"),
    expandedEventIds: expanded,
    ...(id(source.selectedConversationId) === undefined ? {} : { selectedConversationId: id(source.selectedConversationId)! }),
    ...(id(source.selectedRefreshId) === undefined ? {} : { selectedRefreshId: id(source.selectedRefreshId)! }),
    ...(editingId === undefined || draft === undefined ? {} : { editingManualGrade: { id: editingId, draft } }),
    scrollPositions,
  };
}

/** Drops stored IDs and preferences that are absent from the current local dashboard document. */
export function reconcileDashboardViewState(value: DashboardViewState, data: DashboardViewStateData): DashboardViewState {
  const courseKey = (course: string): string => course.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hasCourse = (filter: string): boolean => filter === "all" || data.courses.some((course) => courseKey(course.courseCode) === courseKey(filter));
  const hasResourceType = (filter: string): boolean => filter === "all" || data.resources.some((resource) => resource.type.toLowerCase() === filter.toLowerCase());
  const eventIds = new Set(data.events.map((event) => event.id));
  const editableEventIds = new Set(data.events.filter((event) => event.kind !== "class").map((event) => event.id));
  const conversationIds = new Set(data.conversations.map((conversation) => conversation.id));
  const refreshIds = new Set(data.refreshes.map((refresh) => refresh.id));
  const { selectedConversationId, selectedRefreshId, editingManualGrade, ...preferences } = value;
  return {
    ...preferences,
    courseFilter: hasCourse(value.courseFilter) ? value.courseFilter : "all",
    gradeCourseFilter: hasCourse(value.gradeCourseFilter) ? value.gradeCourseFilter : "all",
    resourceFilter: hasResourceType(value.resourceFilter) ? value.resourceFilter : "all",
    expandedEventIds: value.expandedEventIds.filter((eventId) => eventIds.has(eventId)),
    ...(selectedConversationId !== undefined && conversationIds.has(selectedConversationId) ? { selectedConversationId } : {}),
    ...(selectedRefreshId !== undefined && refreshIds.has(selectedRefreshId) ? { selectedRefreshId } : {}),
    ...(editingManualGrade !== undefined && editableEventIds.has(editingManualGrade.id) ? { editingManualGrade } : {}),
  };
}

/** Uses the fixed desktop-store folder as a local namespace and treats storage failures as non-fatal. */
export function createDashboardViewStateStore(namespace: string, suppliedStorage?: StorageLike): DashboardViewStateStore {
  function storage(): StorageLike | undefined {
    try { return suppliedStorage ?? localStorage; } catch { return undefined; }
  }
  return {
    load(): DashboardViewState {
      try {
        const key = storageKey(namespace);
        if (key === undefined) return EMPTY_VIEW_STATE;
        const raw = storage()?.getItem(key);
        return raw === null || raw === undefined || utf8Length(raw) > MAX_STORED_BYTES ? EMPTY_VIEW_STATE : parseDashboardViewState(JSON.parse(raw));
      } catch {
        return EMPTY_VIEW_STATE;
      }
    },
    save(value: DashboardViewState): boolean {
      try {
        const serialized = JSON.stringify(parseDashboardViewState(value));
        const key = storageKey(namespace);
        const target = storage();
        if (utf8Length(serialized) > MAX_STORED_BYTES || key === undefined || target === undefined) return false;
        target.setItem(key, serialized);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function boundedScrollPosition(value: number): number {
  return Math.max(0, Math.min(MAX_SCROLL_Y, Number.isFinite(value) ? Math.floor(value) : 0));
}
