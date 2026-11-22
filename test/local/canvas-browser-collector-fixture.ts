import { vi } from "vitest";
import { sanitizeCanvasLink } from "../../scripts/canvas-browser-links.mjs";
import { collectCanvasBrowserCapture as collectCanvasBrowserCaptureImpl } from "../../scripts/canvas-browser-capture.mjs";

export const USER_ID = 41;
export const COURSE_ID = 900001;
export const ORIGIN = "https://marymount.instructure.com";
export const SYNTHETIC_RUN_ID = 701;
export const SYNTHETIC_GENERATION_ID = "c".repeat(32);
export const collectCanvasBrowserCapture = (options: Record<string, unknown>) => collectCanvasBrowserCaptureImpl({
  runId: SYNTHETIC_RUN_ID,
  generationId: SYNTHETIC_GENERATION_ID,
  ...options,
} as Parameters<typeof collectCanvasBrowserCaptureImpl>[0]);

export type ReaderRequest = {
  mode: string;
  endpoint: string;
  expectedUserId: number;
  courseId?: number;
  groupId?: number;
  folderId?: number;
  accountId?: number;
  conversationId?: number;
  fileId?: number;
  assignmentId?: number;
  pageSlug?: string;
  pageId?: number;
  moduleId?: number;
  topicId?: number;
  entryId?: number;
  quizId?: number;
  calendarStart?: string;
  calendarEnd?: string;
  calendarContextCode?: string;
};

function fakeHtmlReader({ html, options }: { html: string; options: { source: string; baseUrl: string } }) {
  const links = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)]
    .map((match) => sanitizeCanvasLink(match[1] as string, {
      source: options.source,
      title: (match[2] ?? "").replace(/<[^>]*>/gu, " ").trim(),
      baseUrl: options.baseUrl,
    }));
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\b(?:https?:)?\/\/[^\s<>"'`]+/giu, " [link] ")
    .replace(/verifier\s*=\s*[^\s&;,<>"'`]+/giu, "[redacted]")
    .replace(/[\s\u00a0]+/gu, " ")
    .replace(/\s+([.,!?;:])/gu, "$1")
    .trim();
  return { text, links, textTruncated: false, linksTruncated: false };
}

export function successfulResult(request: ReaderRequest) {
  const identity = { userId: USER_ID };
  const one = (item: Record<string, unknown>) => ({ status: "ok", identity, pages: 1, items: [item] });
  const list = (items: Array<Record<string, unknown>>, pages = 1) => ({ status: "ok", identity, pages, items });
  switch (request.endpoint) {
    case "profile": return one({
      id: USER_ID,
      account_id: 41,
      name: "Synthetic Student",
      calendar_ics: `${ORIGIN}/feeds/calendar?token=synthetic-feed-secret`,
    });
    case "coursesActive": return list([{ id: COURSE_ID, name: "SYN-101" }], 2);
    case "coursesCompleted": return list([]);
    case "course": return one({ id: request.courseId, name: "Synthetic Course", syllabus_body: "<p>Course overview</p>" });
    case "courseTabs": return list(request.courseId === COURSE_ID ? [{ id: "home", label: "Home" }] : []);
    case "assignments": return list(request.courseId === COURSE_ID
      ? [{
        id: 501,
        course_id: COURSE_ID,
        name: "Synthetic assignment",
        published: true,
        rubric: [{ id: "criterion-1", description: "Use evidence", long_description: "Cite one source.", points: 5,
          ratings: [{ description: "Complete", long_description: "Evidence is clear.", points: 5 }] }],
        rubric_settings: { title: "Assignment rubric", points_possible: 5, free_form_criterion_comments: true },
        use_rubric_for_grading: true,
        description: "<p>Read <a title=\"Guide\" href=\"/courses/900001/files/900/download?verifier=synthetic-html-secret\">the guide</a> and <a href=\"/courses/900001/files/901/download\">the plain file</a>.</p><script>synthetic-script-secret</script>",
        discussion_topic: { url: `${ORIGIN}/courses/900001/discussion_topics/7?access_token=synthetic-nested-secret` },
      }]
      : []);
    case "assignmentGroups": return list(request.courseId === COURSE_ID ? [{ id: 10, name: "Assignments" }] : []);
    case "submissions": return list(request.courseId === COURSE_ID ? [{ assignment_id: 501, user_id: USER_ID, submitted_at: "2026-09-01T00:00:00Z" }] : []);
    case "submission": return one({ assignment_id: request.assignmentId, user_id: USER_ID, submission_comments: [{ comment: "Synthetic teacher feedback" }] });
    case "pages": return list(request.courseId === COURSE_ID
      ? [{ page_id: 1, url: "overview", title: "Overview", published: true, body: "<p>Page text</p>" }]
      : []);
    case "page": return one({ page_id: 1, url: request.pageSlug, title: "Overview detail", published: true, body: "<p>Detail text</p>" });
    case "modules": return list(request.courseId === COURSE_ID ? [{ id: 2, name: "Week One", state: "unlocked" }] : []);
    case "moduleItems": return list([{ id: 21, module_id: request.moduleId, title: "Page item" }]);
    case "discussions": return list(request.courseId === COURSE_ID ? [{
      id: 6, title: "Welcome", published: true, assignment_id: 501, assignment: { id: 501, name: "Synthetic assignment" },
    }] : []);
    case "discussionEntries": return list([{ id: 61, message: "<p>Synthetic post</p>" }]);
    case "discussionReplies": return list([{ id: 62, parent_id: request.entryId, message: "<p>Synthetic reply</p>" }]);
    case "announcements": return list(request.courseId === COURSE_ID ? [{ id: 31, message: "<p>Synthetic announcement</p>" }] : []);
    case "quizzes": return list(request.courseId === COURSE_ID ? [{ id: 101, title: "Review quiz", published: true }] : []);
    case "quiz": return one({ id: request.quizId, title: "Review quiz detail", published: true });
    case "courseFiles": return list([{ id: 900, display_name: "Guide", url: `${ORIGIN}/files/900/download?verifier=synthetic-file-secret` }]);
    case "folders": return list([{ id: 1, name: "Course Files" }]);
    case "groups": return list([{ id: 7, name: "Synthetic Group" }]);
    case "groupFolders": return list([{ id: 70, name: "Group Files", context_type: "Group", context_id: 7 }]);
    case "groupFolderFiles": return list([{
      id: 901,
      folder_id: request.folderId,
      context_type: "Group",
      context_id: request.groupId,
      display_name: "Group reading",
      url: `${ORIGIN}/files/901/download?verifier=synthetic-group-file-secret`,
    }]);
    case "groupPages": return list([{ page_id: 7, url: "group-overview", title: "Group overview", published: true }]);
    case "groupPage": return one({ page_id: 7, url: request.pageSlug, title: "Group page", published: true, body: "<p>Group page body</p>" });
    case "groupDiscussions": return list([{ id: 71, title: "Group discussion", published: true }]);
    case "groupDiscussionEntries": return list([{ id: 711, message: "<p>Group post</p>" }]);
    case "groupDiscussionReplies": return list([{ id: 712, parent_id: request.entryId, message: "<p>Group reply</p>" }]);
    case "personalFiles": return list([{ id: 900, display_name: "Personal Guide", url: `${ORIGIN}/files/900/download?verifier=synthetic-personal-file-secret` }]);
    case "personalFolders": return list([{ id: 17, name: "Personal Folder" }]);
    case "file": return one({
      id: request.fileId,
      ...(request.groupId === undefined ? {} : { context_type: "Group", context_id: request.groupId }),
      display_name: request.groupId === undefined ? "Course file detail" : "Group file detail",
      url: `${ORIGIN}/files/${request.fileId}/download?verifier=synthetic-file-detail-secret`,
    });
    case "personalFile": return one({ id: request.fileId, display_name: "Personal file detail", url: `${ORIGIN}/files/${request.fileId}/download?verifier=synthetic-personal-detail-secret` });
    case "inbox": return list([{ id: 300, subject: "Synthetic thread" }]);
    case "inboxAll": return list([{ id: 300, subject: "Unread thread" }, { id: 301, subject: "Read thread" }]);
    case "conversationsSent": return list([{ id: 301, subject: "Sent thread" }, { id: 302, subject: "Another sent thread" }]);
    case "conversationsArchived": return list([{ id: 302, subject: "Archived thread" }, { id: 303, subject: "Other archived thread" }]);
    case "conversation": return one({ id: request.conversationId, subject: "Synthetic thread", messages: [{ body: "<p>Private-looking message content</p>" }] });
    case "calendarEvents": return list([{
      id: 808,
      title: "Synthetic event",
      context_code: request.calendarContextCode,
      start_at: "2026-09-27T12:00:00Z",
    }]);
    default: throw new Error(`Unexpected endpoint ${request.endpoint}`);
  }
}

export function testDependencies(overrides: {
  resultFor?: (request: ReaderRequest) => unknown;
  progress?: (event: Record<string, unknown>) => void | Promise<void>;
} = {}) {
  const reader = vi.fn((input: unknown) => (overrides.resultFor ?? successfulResult)(input as ReaderRequest));
  const htmlReader = (input: unknown) => fakeHtmlReader(input as Parameters<typeof fakeHtmlReader>[0]);
  const evaluate = vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => {
    if (fn === reader) return reader(input as ReaderRequest);
    if (fn === htmlReader) return htmlReader(input);
    throw new Error("Unexpected evaluator function");
  });
  const progressEvents: Record<string, unknown>[] = [];
  const progress = vi.fn(async (event: Record<string, unknown>) => {
    progressEvents.push(event);
    await overrides.progress?.(event);
  });
  return { reader, htmlReader, evaluate, progress, progressEvents };
}
