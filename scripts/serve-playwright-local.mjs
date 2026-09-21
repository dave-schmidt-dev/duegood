import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portArgument = process.argv.find((value) => value === "--port");
const port = Number(process.argv[process.argv.indexOf(portArgument ?? "") + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid port");

const directory = await mkdtemp(path.join(os.tmpdir(), "duegood-playwright-local-"));
const coursework = path.join(directory, "coursework.json");
const fixture = JSON.parse(await readFile(path.join(root, "fixtures", "local-coursework-contract.json"), "utf8"));
const now = Date.now();
const at = (days) => new Date(now + days * 86_400_000).toISOString();
fixture.generated = new Date(now).toISOString();
fixture.sync.startedAt = new Date(now - 60_000).toISOString();
fixture.sync.completedAt = new Date(now).toISOString();
fixture.items[0].at = at(1);
fixture.items[0].submittedAt = at(-1);
fixture.items[0].gradedAt = at(-1);
fixture.items[1].at = at(3);
fixture.items.push({
  id: "course-a-canvas-discussion-1",
  course: "course-a",
  kind: "discussion",
  title: "Synthetic Discussion Board",
  at: at(5),
  points: 10,
  source: "canvas",
  confidence: "confirmed",
  detail: "Complete the main post and reply to two classmates.",
  submissionStatus: "unsubmitted",
  done: false,
  doneAt: null,
  discussionPostDone: false,
  discussionRepliesDone: false,
});
await writeFile(coursework, `${JSON.stringify(fixture, null, 2)}\n`);

const courseRoot = path.join(directory, "classes", "synthetic-course-a", "canvas-export");
await mkdir(path.join(courseRoot, "api"), { recursive: true });
await mkdir(path.join(directory, "classes", "synthetic-course-a", "materials"), { recursive: true });
await writeFile(path.join(courseRoot, "api", "files.json"), JSON.stringify([{ id: 7001, display_name: "Synthetic syllabus.pdf", filename: "canvas-syllabus.pdf", size: 1024, updated_at: at(-2) }]));
await writeFile(path.join(courseRoot, "api", "pages.json"), JSON.stringify([{ page_id: "page-1", title: "Synthetic course home", updated_at: at(-3) }]));
await writeFile(path.join(courseRoot, "api", "modules.json"), JSON.stringify([{ id: 7101, name: "Synthetic module", items_count: 2, items: [{ id: 7102, type: "ExternalUrl", title: "Synthetic reference link" }] }]));
await writeFile(path.join(courseRoot, "api", "announcements.json"), JSON.stringify([{ id: 7201, title: "Synthetic announcement", posted_at: at(-4) }]));
await writeFile(path.join(courseRoot, "download-manifest.json"), JSON.stringify([{ id: 7001, filename: "7001-synthetic-syllabus.pdf", status: "downloaded" }]));
await writeFile(path.join(directory, "classes", "synthetic-course-a", "materials", "7001-synthetic-syllabus.pdf"), "synthetic local file\n");
await writeFile(path.join(directory, "canvas-conversations.json"), JSON.stringify({
  generatedAt: new Date(now - 30_000).toISOString(),
  complete: true,
  conversations: [{
    canvasConversationId: "conversation-1",
    contextLabel: "Synthetic Foundations",
    subject: "Synthetic inbox message",
    participants: [{ canvasUserId: "instructor-1", name: "Example Instructor" }],
    latestMessagePreview: "A synthetic message body for browser coverage.",
    latestMessageAt: at(-1),
    unread: true,
    starred: false,
    messageCount: 1,
    messages: [{ canvasMessageId: "message-1", authorId: "instructor-1", author: "Example Instructor", createdAt: at(-1), body: "This is a synthetic Canvas inbox message.", attachments: [{ name: "synthetic-reading.pdf", contentType: "application/pdf", sizeBytes: 2048 }] }],
    historyComplete: true,
    safetyTruncated: false,
    attachments: [{ name: "synthetic-reading.pdf", contentType: "application/pdf", sizeBytes: 2048 }],
  }],
}));
await writeFile(path.join(directory, "coursework-refresh-history.json"), JSON.stringify({ events: [{ id: "refresh-1", status: "succeeded", sourceComplete: true, startedAt: at(-2), finishedAt: at(-2), summary: { added: 1, updated: 1, removed: 0 }, changes: [{ kind: "changed", title: "Synthetic Pending Work", course: "SYN-101", fields: [{ field: "submissionState", before: "known_not_submitted", after: "known_submitted" }] }] }] }));
const syntheticAvatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
await writeFile(path.join(directory, "canvas-profile.json"), JSON.stringify({ name: "Alex Student", short_name: "Alex", avatar: { path: "canvas-profile-avatar", contentType: "image/png", bytes: syntheticAvatar.length } }));
await writeFile(path.join(directory, "canvas-profile-avatar"), syntheticAvatar);
await writeFile(path.join(root, "test-results", "local-playwright-fixture.json"), JSON.stringify({ coursework }));

const child = spawn(process.execPath, [path.join(root, "dist", "local", "server.mjs"), "--coursework", coursework, "--port", String(port), "--enable-refresh"], { stdio: ["ignore", "inherit", "inherit"] });
const cleanup = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
child.once("exit", (code, signal) => { process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)); });
