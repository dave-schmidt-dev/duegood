import { describe, expect, it } from "vitest";
import { createDashboardViewStateStore, parseDashboardViewState, reconcileDashboardViewState } from "../../src/ui/dashboard-view-state";

const data = {
  courses: [{ courseCode: "IT 530" }],
  events: [{ id: "assignment-1", kind: "assignment" }, { id: "class-1", kind: "class" }],
  resources: [{ type: "file" }],
  conversations: [{ id: "thread-selected" }, { id: "thread-other" }],
  refreshes: [{ id: "refresh-selected" }],
};

describe("dashboard view state", () => {
  it("parses only bounded preferences and route-specific scroll positions", () => {
    const parsed = parseDashboardViewState({
      eventMode: "deadlines", courseFilter: "IT530", gradeCourseFilter: "IT530", gradeMode: "graded", resourceFilter: "file",
      expandedEventIds: ["assignment-1", "assignment-1", 12], selectedConversationId: "thread-selected", selectedRefreshId: "refresh-selected",
      editingManualGrade: { id: "assignment-1", draft: "89" }, scrollPositions: { timeline: 3903.9, grades: -1, invalid: 42 },
    });
    expect(parsed).toMatchObject({ eventMode: "deadlines", courseFilter: "IT530", gradeMode: "graded", expandedEventIds: ["assignment-1"], scrollPositions: { timeline: 3903 } });
    expect(parsed.scrollPositions).not.toHaveProperty("grades");
  });

  it("drops stale IDs and preferences against the current loaded document", () => {
    const restored = reconcileDashboardViewState(parseDashboardViewState({
      courseFilter: "unknown", gradeCourseFilter: "IT 530", resourceFilter: "page", expandedEventIds: ["assignment-1", "missing"],
      selectedConversationId: "thread-selected", selectedRefreshId: "missing", editingManualGrade: { id: "class-1", draft: "88" },
    }), data);
    expect(restored).toMatchObject({ courseFilter: "all", gradeCourseFilter: "IT 530", resourceFilter: "all", expandedEventIds: ["assignment-1"], selectedConversationId: "thread-selected" });
    expect(restored.selectedRefreshId).toBeUndefined();
    expect(restored.editingManualGrade).toBeUndefined();
  });

  it("uses distinct desktop-store namespaces and ignores corrupt or unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = createDashboardViewStateStore("/private/app-store-one", storage);
    expect(store.load().courseFilter).toBe("all");
    expect(store.save(parseDashboardViewState({ courseFilter: "IT530" }))).toBe(true);
    expect([...values.keys()][0]).toContain("com.zerodelta.duegood.dashboard-view-state.v1:%2Fprivate%2Fapp-store-one");
    expect(createDashboardViewStateStore("/private/app-store-two", storage).load().courseFilter).toBe("all");
    const corrupt = createDashboardViewStateStore("corrupt", { getItem: () => "{not json", setItem: () => undefined });
    expect(corrupt.load().courseFilter).toBe("all");
    const unavailable = createDashboardViewStateStore("blocked", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(unavailable.load().expandedEventIds).toEqual([]);
    expect(unavailable.save(parseDashboardViewState({}))).toBe(false);
  });

  it("rejects oversized drafts, stored bytes, and out-of-range scroll offsets", () => {
    const parsed = parseDashboardViewState({
      editingManualGrade: { id: "assignment-1", draft: "x".repeat(16_001) },
      scrollPositions: { timeline: 10_000_001 },
    });
    expect(parsed.editingManualGrade).toBeUndefined();
    expect(parsed.scrollPositions).toEqual({});
    const overLimit = createDashboardViewStateStore("load-limit", { getItem: () => "x".repeat(32 * 1024 + 1), setItem: () => undefined });
    expect(overLimit.load()).toEqual(parseDashboardViewState({}));
    const writes: string[] = [];
    const unicode = { ...parseDashboardViewState({}), expandedEventIds: Array.from({ length: 100 }, (_, index) => `${"😀".repeat(126)}${String(index).padStart(4, "0")}`) };
    expect(createDashboardViewStateStore("unicode-limit", { getItem: () => null, setItem: (_key, value) => { writes.push(value); } }).save(unicode)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("does not read an unavailable global storage getter while mounting", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked getter"); } });
    try {
      expect(createDashboardViewStateStore("getter-unavailable").load()).toEqual(parseDashboardViewState({}));
    } finally {
      if (descriptor === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});
