import { vi } from "vitest";
import type { DesktopSetupHandlers, DesktopSetupState } from "../../src/ui/app";
import type { DashboardData, DashboardHandlers, DashboardState } from "../../src/ui/pages/dashboard";
import type { DesktopStoreStatus, DryRunReport } from "../../src/ui/transport";
export const NOW = Date.parse("2026-09-20T12:00:00-04:00");
export const DATA: DashboardData = {
  version: "a".repeat(64),
  courses: [
    { id: "570", courseCode: "IT570", title: "Policy", gradeGroups: [{ id: "570-projects", name: "Projects", weight: 70 }, { id: "570-exams", name: "Exams", weight: 30 }] },
    { id: "530", courseCode: "IT 530", title: "Security", gradeGroups: [{ id: "530-projects", name: "Projects", weight: 60 }, { id: "530-exams", name: "Exams", weight: 40 }] },
    { id: "540", courseCode: "IT540", title: "Data" },
  ],
  events: [
    { id: "a", sourceItemId: "a", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Lab report", startsAt: "2026-09-20T20:00:00-04:00", completed: false, source: "canvas", points: 20, score: 18, grade: "90%", gradedAt: "2026-09-19T18:00:00-04:00", assignmentGroupId: "530-projects", assignmentGroupName: "Projects", assignmentGroupWeight: 60 },
    { id: "b", sourceItemId: "b", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Reading", startsAt: "2026-09-20T23:59:00-04:00", completed: false, points: 10, score: null, grade: null, gradedAt: null, assignmentGroupId: "530-projects", assignmentGroupName: "Projects", assignmentGroupWeight: 60 },
    { id: "c", courseId: "540", courseCode: "IT540", kind: "class", title: "Workshop", startsAt: "2026-09-23T18:00:00-04:00", completed: false },
    { id: "discussion", sourceItemId: "discussion", courseId: "570", courseCode: "IT570", kind: "discussion", title: "Discussion board", startsAt: "2026-09-25T18:00:00-04:00", completed: false, discussionPostDone: true, discussionRepliesDone: false },
    { id: "d", sourceItemId: "d", courseId: "570", courseCode: "IT570", kind: "deadline", title: "Memo", startsAt: "2026-09-26T12:00:00-04:00", completed: true, completedAt: NOW },
  ],
  pendingSourceLinks: [],
  resources: [
    { id: "safe", courseId: "530", courseCode: "IT530", type: "File", title: "Guide", localUrl: "/api/local/resources/safe" },
    { id: "unsafe", courseId: "540", courseCode: "IT540", type: "Link", title: "Remote", localUrl: "https://example.invalid/" },
  ],
  conversations: [{ id: "message", courseCode: "IT570", sender: "Instructor", subject: "Update", body: "Read-only body", unread: true, messages: [{ id: "m1", author: "Instructor", createdAt: NOW, body: "Full thread body", attachments: [{ name: "guide.pdf" }] }], historyComplete: true }],
  refreshes: [{ id: "refresh", startedAt: NOW, status: "partial", summary: "Existing items were kept.", added: 0, changed: 0, removed: 0, changes: [{ kind: "notice", title: "IT 570 unavailable", detail: "No existing data was removed." }] }],
  profile: null,
  refreshAvailable: true,
  sourceStatus: { state: "ready", label: "Local source", detail: "Available", lastRefreshAt: NOW },
};

export const handlers: DashboardHandlers = {
  onNavigate: vi.fn(), onEventMode: vi.fn(), onCourseFilter: vi.fn(), onGradeCourseFilter: vi.fn(), onGradeMode: vi.fn(), onResourceFilter: vi.fn(), onToggleEvent: vi.fn(), onToggleCompletion: vi.fn(), onToggleDiscussion: vi.fn(), onEditManualGrade: vi.fn(), onManualGradeDraft: vi.fn(), onSaveManualGrade: vi.fn(), onCancelManualGrade: vi.fn(), onSelectConversation: vi.fn(), onSelectRefresh: vi.fn(), onRefresh: vi.fn(), onCopyAssignment: vi.fn(),
};
export function state(page: DashboardState["page"]): DashboardState {
  return { page, loading: false, data: DATA, now: NOW, eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), pendingManualGradeIds: new Set(), failedManualGradeIds: new Set(), selectedConversationId: "message", selectedRefreshId: "refresh", refreshState: "idle", desktop: { storeState: "preview", dataFolder: "~/Library/Application Support/com.zerodelta.duegood", importedAt: null } };
}
export const DATA_FOLDER = "~/Library/Application Support/com.zerodelta.duegood";
export const DIGEST = "a".repeat(64);

export function storeStatus(overrides: Partial<DesktopStoreStatus> = {}): DesktopStoreStatus {
  return { availability: "ready", state: "empty", dataFolder: DATA_FOLDER, legacyRootSelected: false, importedAt: null, files: null, bytes: null, refreshAvailable: false, icalRefreshAvailable: false, canvasRefreshEnabled: false, snapshotInProgress: false, snapshotProgress: null, problem: null, ...overrides };
}

export function dryRun(overrides: Partial<DryRunReport> = {}): DryRunReport {
  return { caps: { totalBytes: 1024 }, inventory: { courseworkDocuments: 1, courseFolders: 2, materialFiles: 3, files: 9, directories: 4, bytes: 4096 }, refusals: {}, unsupportedTypes: {}, legacyLockPresent: false, wouldImport: true, ...overrides };
}

export function nativeBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeState: "preview",
    coursework: {
      text: JSON.stringify({ generated: "2026-09-20T12:00:00Z", courses: [{ key: "syn-101", code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", folder: "syn-101" }], items: [{ id: "syn-101-essay-1", course: "syn-101", kind: "assignment", title: "Essay draft", at: "2026-09-25T23:59" }] }),
      version: DIGEST,
    },
    refreshHistory: null,
    conversations: null,
    profile: JSON.stringify({ name: "Synthetic Learner", avatar: { path: "canvas-avatar.png", contentType: "image/png" } }),
    avatar: { sizeBytes: 69, head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    courseExports: {
      "syn-101": {
        files: JSON.stringify([{ id: 1, display_name: "Syllabus", updated_at: "2026-09-01T00:00:00Z" }, { id: 2, display_name: "Handout", updated_at: "2026-09-02T00:00:00Z" }]),
        pages: null, modules: null, announcements: null,
        downloadManifest: JSON.stringify([{ id: 1, status: "downloaded", filename: "syllabus.pdf" }]),
      },
    },
    ...overrides,
  };
}

export const setupHandlers = (): DesktopSetupHandlers => ({ onChoose: vi.fn(), onRecheck: vi.fn(), onImport: vi.fn(), onCancel: vi.fn() });
export function setup(overrides: Partial<DesktopSetupState> = {}): DesktopSetupState {
  return { status: storeStatus({ state: "preview" }), replacePreview: false, step: "idle", ...overrides };
}
