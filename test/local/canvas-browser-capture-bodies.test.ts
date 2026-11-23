import { describe, expect, it } from "vitest";
import { collectCanvasBrowserCapture, COURSE_ID, testDependencies, USER_ID, successfulResult } from "./canvas-browser-collector-fixture";
import type { ReaderRequest } from "./canvas-browser-collector-fixture";

describe("Canvas discussion and announcement body capture", () => {
  it("keeps graded, delayed, ungraded, newly posted, and announcement bodies", async () => {
    const deps = testDependencies({
      resultFor: (request: ReaderRequest) => {
        const result = successfulResult(request) as { items?: Array<Record<string, unknown>>; [key: string]: unknown };
        if (request.endpoint === "discussions") {
          return {
            ...result,
            items: [
              { id: 6, title: "Graded prompt", message: "<h2>Graded</h2><ul><li>Respond</li></ul>", published: true, assignment_id: 501 },
              { id: 7, title: "Delayed prompt", message: "<p>Future prompt</p>", published: false,
                delayed_post_at: "2026-12-01T17:00:00Z", posted_at: null },
              { id: 8, title: "New prompt", message: "<p>Newly available</p>", published: true,
                posted_at: "2026-11-22T23:00:00Z" },
            ],
          };
        }
        if (request.endpoint === "announcements") {
          return {
            ...result,
            items: [{ id: 31, title: "Course notice", message: "<p>Notice body</p>",
              posted_at: "2026-11-22T23:00:00Z", delayed_post_at: "2026-11-22T23:00:00Z" }],
          };
        }
        return result;
      },
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      progress: deps.progress,
      now: () => new Date("2026-11-22T23:30:00.000Z"),
    });
    const topics = capture.resources.find((resource) => resource.endpoint === "discussions" && resource.courseId === COURSE_ID)?.items;

    expect(topics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 6, _canvasBody: expect.objectContaining({ text: expect.stringContaining("Respond") }) }),
      expect.objectContaining({ id: 7, delayed_post_at: "2026-12-01T17:00:00Z",
        _canvasBody: expect.objectContaining({ text: expect.stringContaining("Future prompt") }) }),
      expect.objectContaining({ id: 8, posted_at: "2026-11-22T23:00:00Z",
        _canvasBody: expect.objectContaining({ text: expect.stringContaining("Newly available") }) }),
    ]));
    expect(capture.resources.find((resource) => resource.endpoint === "announcements" && resource.courseId === COURSE_ID)?.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 31, posted_at: "2026-11-22T23:00:00Z",
        _canvasBody: expect.objectContaining({ text: expect.stringContaining("Notice body") }) })]));
  });

  it("marks missing page and quiz list bodies only after confirmed detail omissions", async () => {
    const deps = testDependencies({
      resultFor: (request: ReaderRequest) => {
        if (request.endpoint === "pages" && request.groupId === undefined) {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1,
            items: [{ page_id: 9, url: "course-overview", title: "Course page", published: true }] };
        }
        if (request.endpoint === "page" && request.courseId === COURSE_ID) {
          throw Object.assign(new Error("page.evaluate: Error: NOT_FOUND"), { code: "NOT_FOUND" });
        }
        if (request.endpoint === "quizzes") {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1,
            items: [{ id: 101, title: "Review quiz", published: true }] };
        }
        if (request.endpoint === "quiz") {
          throw Object.assign(new Error("page.evaluate: Error: NOT_FOUND"), { code: "NOT_FOUND" });
        }
        if (request.endpoint === "groupPages") {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1,
            items: [{ page_id: 7, url: "group-overview", title: "Group page", published: true }] };
        }
        if (request.endpoint === "groupPage") {
          throw Object.assign(new Error("page.evaluate: Error: NOT_FOUND"), { code: "NOT_FOUND" });
        }
        return successfulResult(request);
      },
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      progress: deps.progress,
      now: () => new Date("2026-11-22T23:30:00.000Z"),
    });
    const page = capture.resources.find((resource) => resource.endpoint === "pages"
      && resource.courseId === COURSE_ID)?.items[0];
    const quiz = capture.resources.find((resource) => resource.endpoint === "quizzes"
      && resource.courseId === COURSE_ID)?.items[0];
    const groupPage = capture.resources.find((resource) => resource.endpoint === "pages"
      && resource.groupId === 7)?.items[0];

    expect(page?._canvasBodyOmissionReason).toBe("not-found");
    expect(quiz?._canvasBodyOmissionReason).toBe("not-found");
    expect(groupPage?._canvasBodyOmissionReason).toBe("not-found");
  });
});
