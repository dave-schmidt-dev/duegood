import { describe, expect, it } from "vitest";
import { refreshChangeAlert } from "../../src/ui/refresh-change-alert";
import { DATA, NOW } from "./desktop-test-fixtures";

describe("refresh change alerts", () => {
  const baseline = {
    ...DATA,
    profile: { displayName: "Learner", avatarPath: null },
    sourceStatus: { ...DATA.sourceStatus, library: "synced" as const },
  };

  it("alerts on grade-only updates recorded in coursework history", () => {
    const current = {
      ...baseline,
      refreshes: [...baseline.refreshes, {
        id: "grade-update", startedAt: 2, status: "complete" as const, summary: "Canvas refreshed",
        added: 0, changed: 1, removed: 0, changes: [{ kind: "changed" as const, title: "Lab report", detail: "Grade changed." }],
      }],
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 0 added · 1 changed · 0 removed.");
  });

  it("includes a new Inbox conversation when source delta arrays are empty", () => {
    const current = {
      ...baseline,
      conversations: [...baseline.conversations, { id: "inbox-new", subject: "New thread", sender: "Instructor", unread: true }],
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 1 added · 0 changed · 0 removed.");
  });

  it("detects edits to existing Inbox messages and their attachments", () => {
    const current = {
      ...baseline,
      conversations: baseline.conversations.map((conversation) => conversation.id === "message"
        ? { ...conversation, messages: [...conversation.messages!, { id: "m2", author: "Instructor", createdAt: NOW + 1, body: "Changed instructions", attachments: [{ name: "updated.pdf" }] }] }
        : conversation),
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 0 added · 1 changed · 0 removed.");
  });

  it("detects a Library-only file change from the verified resource list", () => {
    const current = {
      ...baseline,
      resources: [...baseline.resources, { id: "new-file", courseId: "530", courseCode: "IT530", type: "File", title: "New notes.pdf" }],
      refreshes: [...baseline.refreshes, {
        id: "empty-coursework-update", startedAt: 2, status: "complete" as const, summary: "Canvas refreshed",
        added: 0, changed: 0, removed: 0, changes: [],
      }],
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 1 added · 0 changed · 0 removed.");
  });

  it("keeps verified Library additions from a partial snapshot and suppresses its removals", () => {
    const current = {
      ...baseline,
      resources: [{ id: "new-file", courseId: "530", courseCode: "IT530", type: "File", title: "New notes.pdf" }],
      sourceStatus: { ...baseline.sourceStatus, library: "not_synced" as const },
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 1 added · 0 changed · 0 removed.");
  });

  it("includes standalone course and profile changes", () => {
    const current = {
      ...baseline,
      courses: [...baseline.courses, { id: "new-course", courseCode: "IT 501", title: "New Course", gradeGroups: [] }],
      profile: { displayName: "Updated Learner", avatarPath: null },
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 1 added · 1 changed · 0 removed.");
  });

  it("includes verified added and changed items from partial refreshes but suppresses removals", () => {
    const current = {
      ...baseline,
      refreshes: [...baseline.refreshes, {
        id: "partial-refresh", startedAt: 2, status: "partial" as const, summary: "Canvas was incomplete",
        added: 1, changed: 2, removed: 1, changes: [],
      }],
    };
    expect(refreshChangeAlert(baseline, current)).toBe("Refresh found changes · 1 added · 2 changed · 0 removed.");
  });

  it("does not report removals when the Library snapshot is temporarily unverified", () => {
    const current = {
      ...baseline,
      resources: [],
      sourceStatus: { ...baseline.sourceStatus, library: "not_synced" as const },
      refreshes: [...baseline.refreshes, {
        id: "failed-refresh", startedAt: 2, status: "failed" as const, summary: "Canvas failed",
        added: 0, changed: 0, removed: 0, changes: [],
      }],
    };
    expect(refreshChangeAlert(baseline, current)).toBeUndefined();
  });

  it("stays quiet when a successful refresh finds no changes", () => {
    const current = {
      ...baseline,
      refreshes: [...baseline.refreshes, {
        id: "no-change", startedAt: 2, status: "complete" as const, summary: "Canvas refreshed",
        added: 0, changed: 0, removed: 0, changes: [],
      }],
    };
    expect(refreshChangeAlert(baseline, current)).toBeUndefined();
  });
});
