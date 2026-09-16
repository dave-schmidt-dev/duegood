import { describe, expect, it } from "vitest";
import type { AssignmentListItem } from "../../src/db/types";
import { assignmentDetail, submissionStateText } from "../../src/ui/components/assignment-detail";
import { assignmentRow, formatDueAt } from "../../src/ui/components/assignment-row";
import { completionToggle } from "../../src/ui/components/completion-toggle";
import { recoveryPanel, type RecoveryState, type TokenConnectState } from "../../src/ui/components/recovery-panel";
import { syncStatus, type SyncStatusState } from "../../src/ui/components/sync-status";
import type { ElementDescriptor } from "../../src/ui/dom";
import { renderThisWeekPage, type ThisWeekPageHandlers, type ThisWeekPageState } from "../../src/ui/pages/this-week";
import { PHASE_1_ROUTES, primaryNav } from "../../src/ui/routes";

/**
 * The "non-browser UI contract test" the master task doc's Task 1.5 requires: asserts on the
 * plain descriptor objects `src/ui/components/*`/`src/ui/pages/*` return, never on real DOM — see
 * `src/ui/dom.ts`'s doc comment for why that split exists. No `document` is available in this
 * suite's Node environment (`vitest.ui.config.ts`) at all, which is itself proof nothing here
 * secretly depends on a browser.
 */

function flattenText(descriptor: ElementDescriptor): string {
  const own = descriptor.text ?? "";
  const childText = (descriptor.children ?? []).map(flattenText).join(" ");
  return [own, childText].filter(Boolean).join(" ");
}

function findAll(descriptor: ElementDescriptor, predicate: (d: ElementDescriptor) => boolean): ElementDescriptor[] {
  const self = predicate(descriptor) ? [descriptor] : [];
  return self.concat(...(descriptor.children ?? []).map((child) => findAll(child, predicate)));
}

const BASE_ITEM: AssignmentListItem = {
  sourceItemId: "item-1",
  courseId: "course-1",
  courseCode: "TECH 101",
  courseTitle: "Introduction to Computing",
  title: "Reading response",
  dueAt: "2026-09-20T22:00:00Z",
  dueAtState: "known",
  submissionState: "known_submitted",
  completed: false,
  completedAt: null,
};

const NOOP_HANDLERS = { onToggleDetail: () => undefined, onToggleCompletion: () => undefined };

describe("routes.ts — phase-1 navigation inventory", () => {
  it("contains only This Week — every other destination is deferred", () => {
    expect(PHASE_1_ROUTES).toEqual([{ path: "/", label: "This Week" }]);
  });

  it("marks the current route with aria-current, and no other", () => {
    const nav = primaryNav("/");
    const links = findAll(nav, (d) => d.tag === "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.attrs?.["aria-current"]).toBe("page");
    expect(links[0]?.text).toBe("This Week");
  });
});

describe("assignment-row.ts — due date four-state text", () => {
  it.each([
    ["known", "2026-09-20T22:00:00Z", /2026|9\/20|Sep/],
    ["known_null", null, /No deadline set/],
    ["not_returned", null, /Due date unknown/],
    ["unsupported", null, /Due date unknown/],
  ] as const)("dueAtState=%s renders distinctly", (state, dueAt, expected) => {
    expect(formatDueAt(dueAt, state)).toMatch(expected);
  });

  it("renders the checkbox, title, course code, due date, and an accessible chevron", () => {
    const detail = assignmentDetail({ item: BASE_ITEM, id: "detail-1", hidden: true });
    const row = assignmentRow({
      item: BASE_ITEM,
      expanded: false,
      detailId: "detail-1",
      detail,
      completionPending: false,
      completionFailed: false,
      ...NOOP_HANDLERS,
    });

    expect(row.tag).toBe("li");
    const checkbox = findAll(row, (d) => d.attrs?.type === "checkbox")[0];
    expect(checkbox?.attrs?.["aria-label"]).toContain("Reading response");
    expect(flattenText(row)).toContain("Reading response");
    expect(flattenText(row)).toContain("TECH 101");

    const chevron = findAll(row, (d) => d.tag === "button")[0];
    expect(chevron?.attrs?.["aria-expanded"]).toBe("false");
    expect(chevron?.attrs?.["aria-controls"]).toBe("detail-1");

    // The detail panel is nested inside this row's own <li>, not a sibling — a <ul>'s only valid
    // direct child is <li>.
    expect(row.children).toContain(detail);
  });

  it("never wires a click handler to the row itself — only the checkbox and chevron", () => {
    const row = assignmentRow({
      item: BASE_ITEM,
      expanded: false,
      detailId: "detail-1",
      detail: assignmentDetail({ item: BASE_ITEM, id: "detail-1", hidden: true }),
      completionPending: false,
      completionFailed: false,
      ...NOOP_HANDLERS,
    });
    expect(row.on).toBeUndefined();
  });
});

describe("assignment-detail.ts — Canvas submission four-state text", () => {
  it.each([
    ["known_submitted", "Submitted"],
    ["known_not_submitted", "Not submitted"],
    ["unknown", "unknown"],
    ["unsupported", "not available"],
  ] as const)("submissionState=%s renders distinctly, never as a false negative", (state, expectedSubstring) => {
    expect(submissionStateText(state)).toContain(expectedSubstring);
  });

  it("hides via the `hidden` attribute when collapsed, and omits it when expanded", () => {
    const hidden = assignmentDetail({ item: BASE_ITEM, id: "d1", hidden: true });
    const expanded = assignmentDetail({ item: BASE_ITEM, id: "d1", hidden: false });
    expect(hidden.attrs?.hidden).toBe("");
    expect(expanded.attrs?.hidden).toBeUndefined();
  });
});

describe("completion-toggle.ts — the only control bound to the personal-completion route", () => {
  it("reflects completed via the checkbox's checked attribute, not text", () => {
    const complete = completionToggle({ sourceItemId: "i1", title: "X", completed: true, pending: false, failed: false, onToggle: () => undefined });
    const incomplete = completionToggle({ sourceItemId: "i1", title: "X", completed: false, pending: false, failed: false, onToggle: () => undefined });
    const completeBox = findAll(complete, (d) => d.attrs?.type === "checkbox")[0];
    const incompleteBox = findAll(incomplete, (d) => d.attrs?.type === "checkbox")[0];
    expect(completeBox?.attrs?.checked).toBe("");
    expect(incompleteBox?.attrs?.checked).toBeUndefined();
  });

  it("disables the control while a request is pending", () => {
    const pending = completionToggle({ sourceItemId: "i1", title: "X", completed: false, pending: true, failed: false, onToggle: () => undefined });
    const box = findAll(pending, (d) => d.attrs?.type === "checkbox")[0];
    expect(box?.attrs?.disabled).toBe("");
  });

  it("shows an accessible retry status after a failed mutation — never a silent revert", () => {
    const failed = completionToggle({ sourceItemId: "i1", title: "X", completed: false, pending: false, failed: true, onToggle: () => undefined });
    const status = findAll(failed, (d) => d.attrs?.role === "status")[0];
    expect(status?.attrs?.["aria-live"]).toBe("polite");
    expect(flattenText(failed)).toMatch(/retry/i);
    const retryButton = findAll(failed, (d) => d.tag === "button")[0];
    expect(retryButton?.text).toBe("Retry");
  });

  it("shows no retry affordance when nothing has failed", () => {
    const ok = completionToggle({ sourceItemId: "i1", title: "X", completed: false, pending: false, failed: false, onToggle: () => undefined });
    expect(findAll(ok, (d) => d.tag === "button")).toHaveLength(0);
  });
});

describe("sync-status.ts — the truthful sync-status line", () => {
  const cases: readonly [SyncStatusState, RegExp][] = [
    [{ kind: "connected_synced", lastSyncedAt: Date.parse("2026-09-16T12:00:00Z") }, /Connected & synced/],
    [{ kind: "never_synced" }, /Not yet synced/],
    [{ kind: "stale", lastSyncedAt: Date.parse("2026-09-01T00:00:00Z") }, /Last synced/],
    [{ kind: "syncing" }, /Syncing/],
    [{ kind: "partial_import" }, /Partial import/],
  ];

  it.each(cases)("renders %o as an accessible, distinct status line", (state, expected) => {
    const node = syncStatus(state);
    expect(node.attrs?.role).toBe("status");
    expect(node.attrs?.["aria-live"]).toBe("polite");
    expect(node.text).toMatch(expected);
  });

  it("never renders the same text for two different states", () => {
    const texts = new Set(cases.map(([state]) => syncStatus(state).text));
    expect(texts.size).toBe(cases.length);
  });
});

const EMPTY_TOKEN_CONNECT: TokenConnectState = { value: "", pending: false, error: undefined };
const NOOP_TOKEN_HANDLERS = { onTokenInput: () => undefined, onTokenSubmit: () => undefined };

describe("recovery-panel.ts — connection/course recovery states", () => {
  const cases: readonly [RecoveryState, RegExp][] = [
    [{ kind: "disconnected", oauthConfigured: true }, /No Canvas connection/],
    [{ kind: "no_course_selected" }, /No course connected yet/],
    [{ kind: "quota_exhausted" }, /Sync paused/],
    [{ kind: "retrying" }, /Retrying/],
  ];

  it.each(cases)("renders %o as an accessible status message", (state, expected) => {
    const node = recoveryPanel(state);
    expect(node.attrs?.role).toBe("status");
    expect(node.attrs?.["aria-live"]).toBe("polite");
    expect(flattenText(node)).toMatch(expected);
  });

  it("only the disconnected+OAuth-configured state offers the Canvas connect link", () => {
    const disconnected = recoveryPanel({ kind: "disconnected", oauthConfigured: true });
    const noCourse = recoveryPanel({ kind: "no_course_selected" });
    expect(findAll(disconnected, (d) => d.attrs?.href === "/auth/canvas/start")).toHaveLength(1);
    expect(findAll(noCourse, (d) => d.attrs?.href === "/auth/canvas/start")).toHaveLength(0);
  });

  it("disconnected without an OAuth client renders a token-paste form instead of the link", () => {
    const node = recoveryPanel({ kind: "disconnected", oauthConfigured: false }, EMPTY_TOKEN_CONNECT, NOOP_TOKEN_HANDLERS);
    expect(findAll(node, (d) => d.attrs?.href === "/auth/canvas/start")).toHaveLength(0);
    const form = findAll(node, (d) => d.tag === "form")[0];
    expect(form).toBeDefined();
    const input = findAll(node, (d) => d.attrs?.type === "password")[0];
    expect(input).toBeDefined();
    expect(input?.attrs?.autocomplete).toBe("off");
  });

  it("never puts the token value in a plain-text field, and disables the form while pending", () => {
    const node = recoveryPanel(
      { kind: "disconnected", oauthConfigured: false },
      { value: "secret-canvas-token", pending: true, error: undefined },
      NOOP_TOKEN_HANDLERS,
    );
    expect(findAll(node, (d) => d.attrs?.type === "text" && d.attrs.value === "secret-canvas-token")).toHaveLength(0);
    const input = findAll(node, (d) => d.attrs?.type === "password")[0];
    expect(input?.attrs?.disabled).toBe("");
    const submit = findAll(node, (d) => d.attrs?.type === "submit")[0];
    expect(submit?.attrs?.disabled).toBe("");
  });

  it("surfaces a connect error as an accessible status message", () => {
    const node = recoveryPanel(
      { kind: "disconnected", oauthConfigured: false },
      { value: "", pending: false, error: "That token wasn't accepted. Double-check it and try again." },
      NOOP_TOKEN_HANDLERS,
    );
    const status = findAll(node, (d) => d.attrs?.role === "status" && (d.text?.includes("wasn't accepted") ?? false))[0];
    expect(status?.attrs?.["aria-live"]).toBe("polite");
  });
});

describe("pages/this-week.ts — page composition", () => {
  const baseState: ThisWeekPageState = {
    currentPath: "/",
    loading: false,
    recovery: undefined,
    sync: { kind: "connected_synced", lastSyncedAt: Date.now() },
    assignments: [BASE_ITEM],
    assignmentUi: new Map(),
    tokenConnect: EMPTY_TOKEN_CONNECT,
  };
  const handlers: ThisWeekPageHandlers = { ...NOOP_HANDLERS, ...NOOP_TOKEN_HANDLERS };

  it("renders the This Week heading and nav", () => {
    const page = renderThisWeekPage(baseState, handlers);
    const heading = findAll(page, (d) => d.tag === "h1")[0];
    expect(heading?.text).toBe("This Week");
    expect(findAll(page, (d) => d.tag === "nav")).toHaveLength(1);
  });

  it("shows a loading skeleton with no assignment content while loading", () => {
    const page = renderThisWeekPage({ ...baseState, loading: true, sync: undefined, assignments: [] }, handlers);
    expect(findAll(page, (d) => (d.attrs?.class ?? "").includes("skeleton")).length).toBeGreaterThan(0);
    expect(flattenText(page)).not.toContain("Reading response");
  });

  it("shows the recovery panel instead of the assignment list when disconnected", () => {
    const page = renderThisWeekPage(
      { ...baseState, recovery: { kind: "disconnected", oauthConfigured: true }, sync: undefined, assignments: [] },
      handlers,
    );
    expect(flattenText(page)).toMatch(/No Canvas connection/);
    expect(flattenText(page)).not.toContain("Reading response");
  });

  it("shows an honest empty state when there are no assignments yet", () => {
    const page = renderThisWeekPage({ ...baseState, assignments: [] }, handlers);
    expect(flattenText(page)).toMatch(/No assignments imported yet/);
  });

  it("renders one row per assignment, wired to the page's own handlers", () => {
    const page = renderThisWeekPage(baseState, handlers);
    const checkboxes = findAll(page, (d) => d.attrs?.type === "checkbox");
    expect(checkboxes).toHaveLength(1);
  });
});
