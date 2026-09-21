import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardStore } from "../../src/local/dashboard-store";
import type { LocalCourse } from "../../src/local/coursework-store";

const directories: string[] = [];
const COURSE: LocalCourse = { id: "course-a", courseCode: "SYN-101", title: "Synthetic", color: "#123456", folder: "classes/synthetic-course-a", lastSuccessfulCheckAt: null, syncing: false };

async function setup(): Promise<{ root: string; store: DashboardStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-dashboard-"));
  directories.push(root);
  const api = path.join(root, "classes", "synthetic-course-a", "canvas-export", "api");
  const materials = path.join(root, "classes", "synthetic-course-a", "materials");
  await mkdir(api, { recursive: true });
  await mkdir(materials, { recursive: true });
  await Promise.all([
    writeFile(path.join(api, "files.json"), JSON.stringify([{ id: 10, display_name: "Guide.pdf", filename: "guide.pdf", size: 12, updated_at: "2030-01-01T00:00:00Z", url: "https://canvas.invalid/file?token=secret" }])),
    writeFile(path.join(api, "pages.json"), JSON.stringify([{ page_id: 20, title: "Reference page", body: "private body", updated_at: "2030-01-02T00:00:00Z" }])),
    writeFile(path.join(api, "modules.json"), JSON.stringify([{ id: 30, name: "Module one", items_count: 1, items: [{ id: 31, type: "ExternalUrl", title: "External reading", external_url: "https://third-party.invalid/?secret=yes" }] }])),
    writeFile(path.join(api, "announcements.json"), JSON.stringify([{ id: 40, title: "Class notice", message: "private body", posted_at: "2030-01-03T00:00:00Z" }])),
    writeFile(path.join(root, "classes", "synthetic-course-a", "canvas-export", "download-manifest.json"), JSON.stringify([{ id: 10, filename: "guide.pdf", status: "downloaded" }])),
    writeFile(path.join(materials, "guide.pdf"), "synthetic pdf"),
    writeFile(path.join(root, "coursework-refresh-history.json"), JSON.stringify({ schema: 1, events: [{ id: "r1", status: "succeeded", sourceComplete: true, startedAt: "2030-01-03T00:00:00Z", finishedAt: "2030-01-03T00:01:00Z", summary: { added: 1, updated: 2, removed: 1 }, changes: [{ kind: "changed", title: "Synthetic item", course: "SYN-101", fields: [{ field: "at", before: null, after: "2030-01-04T17:30:00Z" }, { field: "submissionState", before: "unsubmitted", after: "pending" }, { field: "points", before: 10, after: 20 }, { field: "assignmentGroupWeight", before: null, after: 60 }] }, { kind: "changed", title: "Future state item", course: "SYN-101", fields: [{ field: "submissionState", before: null, after: "future_canvas_state" }] }, { kind: "added", title: "New item", course: "SYN-101" }, { kind: "removed", title: "Removed item", course: "SYN-101" }, { kind: "notice", title: "Earlier grade history recovered", detail: "An earlier Due Good refresh omitted item-level history." }] }] })),
    writeFile(path.join(root, "canvas-conversations.json"), JSON.stringify({ schema: 1, generatedAt: "2030-01-04T00:00:00Z", complete: false, rejected: 1, conversations: [{ canvasConversationId: "50", contextLabel: "SYN-101", subject: "Synthetic thread", participants: [{ canvasUserId: "9", name: "Instructor" }], latestMessagePreview: "Synthetic preview", latestMessageAt: "2030-01-04T00:00:00Z", unread: true, starred: false, messageCount: 1, messages: [{ canvasMessageId: "m1", authorId: "9", author: "Instructor", createdAt: "2030-01-04T00:00:00Z", body: "A complete body with https://example.invalid/path", bodyTruncated: false, attachments: [{ name: "guide.pdf", contentType: "application/pdf", sizeBytes: 12 }] }], historyComplete: true, safetyTruncated: false, attachments: [{ name: "guide.pdf", contentType: "application/pdf", sizeBytes: 12 }] }], changes: { added: [], changed: [], removed: [] } })),
  ]);
  return { root, store: new DashboardStore(path.join(root, "coursework.json")) };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("DashboardStore", () => {
  it("projects sanitized resource metadata and only local file open paths", async () => {
    const { store } = await setup();
    const resources = await store.resources([COURSE]);
    expect(resources.map((item) => item.type).sort()).toEqual(["Announcement", "File", "Link", "Module", "Page"]);
    expect(resources.find((item) => item.type === "File")?.openPath).toContain("/api/local/resources/");
    expect(resources.find((item) => item.type === "Link")?.openPath).toBeNull();
    expect(JSON.stringify(resources)).not.toContain("secret");
    expect(JSON.stringify(resources)).not.toContain("private body");
  });

  it("projects refresh history and resolves only manifested local files", async () => {
    const { root, store } = await setup();
    const refreshes = await store.refreshes();
    expect(refreshes).toContainEqual(expect.objectContaining({ id: "r1", status: "complete", summary: { added: 1, changed: 2, removed: 1 } }));
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes[0]).toMatchObject({ kind: "changed", title: "Synthetic item", detail: expect.stringContaining("Submission: Not submitted → Submitted") });
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes[0]?.detail).toContain("Due date: Unavailable → Jan 4, 2030, 12:30 PM");
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes[0]?.detail).toContain("Points: 10 → 20");
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes[0]?.detail).toContain("Assignment group weight: Unavailable → 60%");
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes).toContainEqual({ kind: "changed", title: "Future state item", detail: "SYN-101 · Submission: Unknown → Unknown" });
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes).toContainEqual({ kind: "added", title: "New item", detail: "SYN-101" });
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes).toContainEqual({ kind: "removed", title: "Removed item", detail: "SYN-101" });
    expect(refreshes.find((refresh) => refresh.id === "r1")?.changes).toContainEqual({ kind: "notice", title: "Earlier grade history recovered", detail: "An earlier Due Good refresh omitted item-level history." });
    expect(refreshes).toContainEqual(expect.objectContaining({ status: "partial", summary: { added: 0, changed: 0, removed: 0 } }));
    const inbox = await store.conversations();
    expect(inbox.status).toBe("partial");
    expect(inbox.conversations[0]).toMatchObject({ canvasConversationId: "50", unread: true, messages: [{ body: "A complete body with https://example.invalid/path", attachments: [{ name: "guide.pdf" }] }], historyComplete: true });
    const resource = (await store.resources([COURSE])).find((item) => item.type === "File");
    await expect(store.resolveLocalResource(resource?.id ?? "", [COURSE])).resolves.toBe(await realpath(path.join(root, "classes", "synthetic-course-a", "materials", "guide.pdf")));
    await expect(store.resolveLocalResource("course-a:link:31", [COURSE])).resolves.toBeNull();

    const manifest = path.join(root, "classes", "synthetic-course-a", "canvas-export", "download-manifest.json");
    await writeFile(manifest, JSON.stringify([{ id: 10, filename: "../escape.pdf", status: "downloaded" }]));
    await expect(store.resolveLocalResource("course-a:file:10", [COURSE])).resolves.toBeNull();

    await writeFile(manifest, JSON.stringify([{ id: 10, filename: "guide.pdf", status: "downloaded" }]));
    await rm(path.join(root, "classes", "synthetic-course-a", "materials"), { recursive: true });
    await expect(store.resolveLocalResource("course-a:file:10", [COURSE])).resolves.toBeNull();
  });

  it("matches a downloaded local filename by Canvas file ID", async () => {
    const { root, store } = await setup();
    const exportRoot = path.join(root, "classes", "synthetic-course-a", "canvas-export");
    const materials = path.join(root, "classes", "synthetic-course-a", "materials");
    await writeFile(path.join(exportRoot, "download-manifest.json"), JSON.stringify([{ id: 10, filename: "10-guide.pdf", status: "downloaded" }]));
    await writeFile(path.join(materials, "10-guide.pdf"), "synthetic pdf with a local manifest filename");

    const resource = (await store.resources([COURSE])).find((item) => item.id === "course-a:file:10");
    expect(resource?.openPath).toBe("/api/local/resources/course-a%3Afile%3A10");
    await expect(store.resolveLocalResource("course-a:file:10", [COURSE])).resolves.toBe(await realpath(path.join(materials, "10-guide.pdf")));
  });

  it("projects only a validated local profile avatar", async () => {
    const { root, store } = await setup();
    await writeFile(path.join(root, "canvas-profile.json"), JSON.stringify({ name: "Synthetic Student", short_name: "Synthetic", avatar: { path: "canvas-profile-avatar.png", contentType: "image/png", bytes: 16 } }));
    await writeFile(path.join(root, "canvas-profile-avatar.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await expect(store.profile()).resolves.toEqual({ displayName: "Synthetic Student", avatarPath: "/api/local/profile/avatar" });
    await rm(path.join(root, "canvas-profile-avatar.png"));
    await expect(store.profile()).resolves.toEqual({ displayName: "Synthetic Student" });
  });
});
