/**
 * Read a bounded Canvas API resource from the browser's existing same-origin session.
 * This function is intentionally self-contained so Playwright can serialize it into a page.
 * Pass a fetch adapter only in synthetic tests; production calls it inside Chrome.
 */
export async function readCanvasBrowserApi(input, fetchAdapter = globalThis.fetch) {
  const fixedOrigin = "https://marymount.instructure.com";
  const defaults = { pages: 25, items: 5000, bytes: 20 * 1024 * 1024, milliseconds: 30_000 };
  const codes = Object.freeze({
    invalid: "INVALID_REQUEST",
    unsafe: "UNSAFE_URL",
    redirect: "REDIRECT_REJECTED",
    session: "SESSION_FAILURE",
    html: "HTML_OR_SSO_REJECTED",
    json: "INVALID_JSON",
    notFound: "NOT_FOUND",
    incomplete: "INCOMPLETE_REQUIRED_AREA",
    identity: "IDENTITY_MISMATCH",
    identityUnavailable: "IDENTITY_UNAVAILABLE",
    budget: "BUDGET_EXCEEDED",
    transport: "REQUEST_FAILED",
  });
  const fail = (code) => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
  const allowedInputKeys = new Set([
    "mode", "endpoint", "courseId", "fileId", "conversationId", "expectedUserId", "perPage",
    "assignmentId", "pageSlug", "moduleId", "topicId", "entryId", "quizId",
    "calendarStart", "calendarEnd",
    "maxPages", "maxItems", "maxBytes", "timeoutMs",
  ]);
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !allowedInputKeys.has(key))) fail(codes.invalid);
  if (input.mode !== "probe" && input.mode !== "read") fail(codes.invalid);
  if ((input.mode === "read" && !positiveId(input.expectedUserId))
      || (input.expectedUserId !== undefined && !positiveId(input.expectedUserId))) fail(codes.invalid);
  if (input.mode === "read" && typeof input.endpoint !== "string") fail(codes.invalid);
  if (typeof fetchAdapter !== "function") fail(codes.invalid);

  const maximumMilliseconds = input.mode === "probe" ? 90_000 : defaults.milliseconds;
  const limits = {
    pages: input.maxPages ?? defaults.pages,
    items: input.maxItems ?? defaults.items,
    bytes: input.maxBytes ?? defaults.bytes,
    milliseconds: input.timeoutMs ?? maximumMilliseconds,
  };
  if (!Number.isInteger(limits.pages) || limits.pages < 1 || limits.pages > defaults.pages
      || !Number.isInteger(limits.items) || limits.items < 1 || limits.items > defaults.items
      || !Number.isInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > defaults.bytes
      || !Number.isInteger(limits.milliseconds) || limits.milliseconds < 1 || limits.milliseconds > maximumMilliseconds) {
    fail(codes.invalid);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.milliseconds);
  const deadline = Date.now() + limits.milliseconds;
  let bytesRead = 0;
  let pagesRead = 0;
  let itemsRead = 0;

  function courseRoute(values, suffix, list = true, optionalDenied = false) {
    if (!positiveId(values.courseId)) fail(codes.invalid);
    return { path: `/api/v1/courses/${values.courseId}${suffix}`, list, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied, fixed: {} };
  }
  function pageSlug(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(value);
  }
  function dateOnly(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  }
  function routeFor(endpoint, values) {
    switch (endpoint) {
      case "profile": return { path: "/api/v1/users/self/profile", list: false, fixed: {} };
      case "coursesActive": return { path: "/api/v1/courses", list: true, fixed: { enrollment_state: "active" } };
      case "coursesCompleted": return { path: "/api/v1/courses", list: true, fixed: { enrollment_state: "completed" } };
      case "course":
        if (!positiveId(values.courseId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}`, list: false, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, expectedId: values.courseId, fixed: {} };
      case "syllabus":
        if (!positiveId(values.courseId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}`, list: false, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, expectedId: values.courseId, fixed: {} };
      case "courseTabs": return courseRoute(values, "/tabs", true, true);
      case "assignments": return courseRoute(values, "/assignments");
      case "assignmentGroups": return courseRoute(values, "/assignment_groups", true, true);
      case "submissions": {
        const route = courseRoute(values, "/students/submissions");
        route.expectedUserId = values.expectedUserId;
        return route;
      }
      case "submission": {
        if (!positiveId(values.courseId) || !positiveId(values.assignmentId)) fail(codes.invalid);
        return {
          path: `/api/v1/courses/${values.courseId}/assignments/${values.assignmentId}/submissions/self`,
          list: false,
          courseId: values.courseId,
          expectedContextCode: `course_${values.courseId}`,
          expectedAssignmentId: values.assignmentId,
          expectedUserId: values.expectedUserId,
          optionalDenied: true,
          fixed: { "include[]": "submission_comments" },
        };
      }
      case "pages": return courseRoute(values, "/pages", true, true);
      case "page":
        if (!positiveId(values.courseId) || !pageSlug(values.pageSlug)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}/pages/${values.pageSlug}`, list: false, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied: true, fixed: {} };
      case "modules": return courseRoute(values, "/modules", true, true);
      case "moduleItems":
        if (!positiveId(values.courseId) || !positiveId(values.moduleId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}/modules/${values.moduleId}/items`, list: true, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied: true, fixed: {} };
      case "discussions": return courseRoute(values, "/discussion_topics", true, true);
      case "discussionEntries":
        if (!positiveId(values.courseId) || !positiveId(values.topicId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}/discussion_topics/${values.topicId}/entries`, list: true, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied: true, fixed: {} };
      case "discussionReplies":
        if (!positiveId(values.courseId) || !positiveId(values.topicId) || !positiveId(values.entryId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}/discussion_topics/${values.topicId}/entries/${values.entryId}/replies`, list: true, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied: true, fixed: {} };
      case "announcements":
        if (!positiveId(values.courseId)) fail(codes.invalid);
        return { path: "/api/v1/announcements", list: true, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, optionalDenied: true, fixed: { "context_codes[]": `course_${values.courseId}` } };
      case "quizzes": return courseRoute(values, "/quizzes", true, true);
      case "quiz":
        if (!positiveId(values.courseId) || !positiveId(values.quizId)) fail(codes.invalid);
        return { path: `/api/v1/courses/${values.courseId}/quizzes/${values.quizId}`, list: false, courseId: values.courseId, expectedContextCode: `course_${values.courseId}`, expectedId: values.quizId, optionalDenied: true, fixed: {} };
      case "courseFiles": return courseRoute(values, "/files", true, true);
      case "folders": return courseRoute(values, "/folders", true, true);
      case "groups": return { path: "/api/v1/users/self/groups", list: true, optionalDenied: true, fixed: {} };
      case "personalFiles": return { path: "/api/v1/users/self/files", list: true, optionalDenied: true, fixed: {} };
      case "personalFolders": return { path: "/api/v1/users/self/folders", list: true, expectedOwnerContextType: "User", expectedOwnerContextId: values.expectedUserId, optionalDenied: true, fixed: {} };
      case "personalFile":
        if (!positiveId(values.fileId)) fail(codes.invalid);
        return { path: `/api/v1/users/self/files/${values.fileId}`, list: false, fileId: values.fileId, expectedId: values.fileId, optionalDenied: true, fixed: {} };
      case "inbox": return { path: "/api/v1/conversations", list: true, optionalDenied: true, fixed: { scope: "unread" } };
      case "inboxAll": return { path: "/api/v1/conversations", list: true, optionalDenied: true, fixed: {} };
      case "conversationsSent": return { path: "/api/v1/conversations", list: true, optionalDenied: true, fixed: { scope: "sent" } };
      case "conversationsArchived": return { path: "/api/v1/conversations", list: true, optionalDenied: true, fixed: { scope: "archived" } };
      case "conversation":
        if (!positiveId(values.conversationId)) fail(codes.invalid);
        return { path: `/api/v1/conversations/${values.conversationId}`, list: false, expectedId: values.conversationId, optionalDenied: true, fixed: { auto_mark_as_read: "false" } };
      case "file":
        if (!positiveId(values.fileId)) fail(codes.invalid);
        return { path: `/api/v1/files/${values.fileId}`, list: false, fileId: values.fileId, expectedId: values.fileId, optionalDenied: true, fixed: {} };
      case "calendarEvents": {
        const start = dateOnly(values.calendarStart);
        const end = dateOnly(values.calendarEnd);
        if (!positiveId(values.expectedUserId) || start === null || end === null
            || end < start || end.getTime() - start.getTime() > 89 * 24 * 60 * 60 * 1000) fail(codes.invalid);
        const contextCode = `user_${values.expectedUserId}`;
        return {
          path: "/api/v1/calendar_events",
          list: true,
          expectedContextCode: contextCode,
          optionalDenied: true,
          fixed: { "context_codes[]": contextCode, start_date: values.calendarStart, end_date: values.calendarEnd },
        };
      }
      default: fail(codes.invalid);
    }
  }
  function initialUrl(route, values) {
    const url = new URL(route.path, fixedOrigin);
    for (const [key, value] of Object.entries(route.fixed)) url.searchParams.append(key, value);
    if (route.list) url.searchParams.set("per_page", String(values.perPage ?? 100));
    route.perPage = values.perPage ?? 100;
    return url;
  }
  function validateUrl(candidate, route, baseUrl) {
    let url;
    try { url = new URL(candidate, fixedOrigin); } catch { fail(codes.unsafe); }
    if (url.origin !== fixedOrigin || url.protocol !== "https:" || url.username || url.password
        || url.hash || url.pathname !== route.path) fail(codes.unsafe);
    const allowed = new Set([...Object.keys(route.fixed), ...(route.list ? ["per_page", "page"] : [])]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) fail(codes.unsafe);
    for (const [key, value] of Object.entries(route.fixed)) {
      const values = url.searchParams.getAll(key);
      if (values.length !== 1 || values[0] !== value) fail(codes.unsafe);
    }
    if (route.list) {
      const perPage = url.searchParams.getAll("per_page");
      const page = url.searchParams.getAll("page");
      if (perPage.length !== 1 || perPage[0] !== String(route.perPage)
          || page.length > 1 || (page.length === 1 && !validPageToken(page[0], baseUrl))) {
        fail(codes.unsafe);
      }
    }
    if (baseUrl !== undefined && url.href === baseUrl) fail(codes.unsafe);
    return url;
  }
  function validPageToken(value, baseUrl) {
    if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9._~:/+=,_-]+$/.test(value)) return false;
    const current = baseUrl === undefined ? null : new URL(baseUrl).searchParams.get("page");
    if (/^\d+$/.test(value)) {
      const page = Number(value);
      if (!Number.isSafeInteger(page) || page < 2 || page > limits.pages || String(page) !== value) return false;
      const prior = current === null ? 1 : /^\d+$/.test(current) ? Number(current) : Number.NaN;
      return Number.isSafeInteger(prior) && page === prior + 1;
    }
    return current === null || !/^\d+$/.test(current);
  }
  function nextUrl(linkHeader, route, currentUrl) {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(/,(?=\s*<)/)) {
      const match = /^\s*<([^>]+)>(.*)$/.exec(part);
      const rel = match?.[2].match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/);
      const relation = rel?.[1] ?? rel?.[2] ?? "";
      if (match && relation.split(/\s+/).includes("next")) return validateUrl(match[1], route, currentUrl);
    }
    return null;
  }
  function reportProgress(state) {
    try {
      const callback = globalThis.__duegoodCanvasReaderProgress;
      if (typeof callback !== "function") return;
      const pending = callback(state);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch { /* progress reporting is advisory and receives fixed status strings only */ }
  }
  async function responseBytes(response, perResponseLimit) {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > perResponseLimit) fail(codes.budget);
    if (response.body === null || typeof response.body?.getReader !== "function") fail(codes.json);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        if (Date.now() > deadline) fail(codes.budget);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        bytesRead += value.byteLength;
        if (size > perResponseLimit || bytesRead > limits.bytes) {
          await reader.cancel();
          fail(codes.budget);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  }
  function parseJson(text) {
    let value = text.replace(/^\uFEFF/, "").trimStart();
    if (value.startsWith("while(1);")) value = value.slice("while(1);".length).trimStart();
    else if (value.startsWith(")]}'")) value = value.slice(4).replace(/^,?\s*/, "");
    if (value.startsWith("<") || /^<!doctype\s+html/i.test(value)) fail(codes.html);
    try { return JSON.parse(value); } catch { fail(codes.json); }
  }
  function normalizeItems(data, route) {
    const items = route.list ? data : [data];
    if (!Array.isArray(items) || (route.list && items.some((item) => item === null || typeof item !== "object" || Array.isArray(item)))
        || (!route.list && (data === null || typeof data !== "object" || Array.isArray(data)))) fail(codes.json);
    if (items.length > limits.items) fail(codes.budget);
    for (const item of items) {
      if (route.courseId && item.course_id !== undefined && item.course_id !== route.courseId) fail(codes.identity);
      if (route.expectedContextCode !== undefined && item.context_code !== undefined
          && item.context_code !== route.expectedContextCode) fail(codes.identity);
      if (route.expectedOwnerContextType !== undefined && item.context_type !== route.expectedOwnerContextType) fail(codes.identity);
      if (route.expectedOwnerContextId !== undefined && item.context_id !== route.expectedOwnerContextId) fail(codes.identity);
    }
    if (route.expectedId && data.id !== route.expectedId) fail(codes.identity);
    if (route.expectedAssignmentId && data.assignment_id !== route.expectedAssignmentId) fail(codes.identity);
    if (route.expectedUserId && items.some((item) => item.user_id !== route.expectedUserId)) fail(codes.identity);
    return items;
  }
  async function readPages(endpoint, overrides = {}, samplePageLimit = undefined) {
    const merged = { ...input, ...overrides, endpoint };
    const route = routeFor(endpoint, merged);
    if (route.list && merged.perPage !== undefined && (!Number.isInteger(merged.perPage) || merged.perPage < 1 || merged.perPage > 100)) fail(codes.invalid);
    const first = initialUrl(route, merged);
    let next = first;
    const seen = new Set();
    const items = [];
    let pages = 0;
    while (next !== null) {
      if (Date.now() > deadline || pages >= limits.pages || pagesRead >= limits.pages || seen.has(next.href)) fail(codes.budget);
      const safeUrl = validateUrl(next.href, route);
      seen.add(safeUrl.href);
      let response;
      reportProgress("CANVAS_GET_STARTED");
      try {
        response = await fetchAdapter(safeUrl.href, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch { fail(controller.signal.aborted ? codes.budget : codes.transport); }
      finally { reportProgress("CANVAS_GET_FINISHED"); }
      if (response.status === 401) fail(codes.session);
      if (response.status === 403) {
        if (route.optionalDenied === true) return { status: "gap", reason: "FORBIDDEN_OPTIONAL", items: [], pages };
        fail(codes.incomplete);
      }
      if (response.status === 404) fail(codes.notFound);
      if (response.type === "opaqueredirect" || response.redirected || response.status === 0
          || (response.status >= 300 && response.status < 400)) fail(codes.redirect);
      if (response.url && response.url !== safeUrl.href) fail(codes.redirect);
      if (!response.ok) fail(codes.transport);
      const contentType = response.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType === "text/html" || contentType === "application/xhtml+xml") fail(codes.html);
      if (contentType !== "application/json" && contentType !== "application/problem+json") fail(codes.json);
      const body = await responseBytes(response, limits.bytes - bytesRead);
      const parsed = parseJson(body);
      const current = normalizeItems(parsed, route);
      if (items.length + current.length > limits.items || itemsRead + current.length > limits.items) fail(codes.budget);
      items.push(...current);
      pages += 1;
      pagesRead += 1;
      itemsRead += current.length;
      const rawNext = response.headers?.get?.("link") ?? response.headers?.get?.("Link") ?? null;
      const candidate = route.list ? nextUrl(rawNext, route, safeUrl.href) : null;
      if (samplePageLimit !== undefined && pages >= samplePageLimit && candidate !== null) {
        return { status: "sampled", pages, items, hasNextPage: true };
      }
      next = candidate;
    }
    return { status: "ok", pages, items };
  }
  function publicProbeStatus(error) {
    switch (error?.code) {
      case codes.session: return "SESSION_FAILED";
      case codes.identity: return "MISMATCH";
      case codes.identityUnavailable: return "UNAVAILABLE";
      case codes.incomplete: return "INCOMPLETE";
      case codes.notFound: return "NOT_FOUND";
      case codes.redirect: return "REDIRECT_REJECTED";
      case codes.unsafe: return "UNSAFE_LINK";
      case codes.budget: return "BUDGET_EXCEEDED";
      default: return "UNAVAILABLE";
    }
  }
  try {
    if (input.perPage !== undefined && (!Number.isInteger(input.perPage) || input.perPage < 1 || input.perPage > 100)) fail(codes.invalid);
    if (input.mode === "read") routeFor(input.endpoint, input);
    const profileResult = await readPages("profile");
    const profile = profileResult.items[0];
    if (!positiveId(profile?.id)) fail(codes.identityUnavailable);
    if (input.expectedUserId !== undefined && profile.id !== input.expectedUserId) fail(codes.identity);
    if (input.mode === "probe") {
      const result = {
        signedInContinuity: "OK",
        accountIdentity: input.expectedUserId === undefined ? "AVAILABLE_UNBOUND" : "MATCH",
        apiShapePagination: "UNAVAILABLE",
        inboxUnreadState: "UNAVAILABLE",
        fileMetadata: "UNAVAILABLE",
        fileVerifier: "UNAVAILABLE",
        cookielessDownload: "UNAVAILABLE",
        nativeDownloader: "NOT_TESTED",
      };
      let courseId;
      try {
        const activeCourses = await readPages("coursesActive", { perPage: 1 }, 1);
        if (activeCourses.status !== "ok" && activeCourses.status !== "sampled") throw { code: codes.incomplete };
        let course = activeCourses.items.find((item) => positiveId(item.id));
        let courseSelectionIncomplete = activeCourses.status === "sampled";
        if (course === undefined) {
          const completedCourses = await readPages("coursesCompleted", { perPage: 1 }, 1);
          if (completedCourses.status !== "ok" && completedCourses.status !== "sampled") throw { code: codes.incomplete };
          course = completedCourses.items.find((item) => positiveId(item.id));
          courseSelectionIncomplete ||= completedCourses.status === "sampled";
        }
        if (course === undefined) result.apiShapePagination = courseSelectionIncomplete ? "NO_COURSE_SAMPLED" : "NO_COURSES";
        else {
          courseId = course.id;
          const courseDetail = await readPages("course", { courseId });
          result.apiShapePagination = courseDetail.items[0]?.id === courseId ? "OK" : "MISMATCH";
        }
      } catch (error) { result.apiShapePagination = publicProbeStatus(error); }
      try {
        const before = await readPages("inbox", { perPage: 100 });
        if (before.status === "gap") result.inboxUnreadState = "OPTIONAL_DENIED";
        else {
          const unreadIds = before.items.map((item) => item.id).filter(positiveId);
          if (unreadIds.length === 0) result.inboxUnreadState = "NO_UNREAD_ITEMS";
          else {
            await readPages("conversation", { conversationId: unreadIds[0] });
            const after = await readPages("inbox", { perPage: 100 });
            if (after.status === "gap") result.inboxUnreadState = "OPTIONAL_DENIED";
            else {
              const afterIds = after.items.map((item) => item.id).filter(positiveId);
              result.inboxUnreadState = JSON.stringify(unreadIds) === JSON.stringify(afterIds) ? "UNCHANGED" : "CHANGED";
            }
          }
        }
      } catch (error) { result.inboxUnreadState = publicProbeStatus(error); }
      if (courseId !== undefined) {
        try {
          const files = await readPages("courseFiles", { courseId, perPage: 1 }, 1);
          if (files.status === "gap") result.fileMetadata = "OPTIONAL_DENIED";
          else if (files.items.length === 0) result.fileMetadata = files.status === "sampled" ? "NO_FILE_SAMPLED" : "NO_FILE";
          else {
            const fileId = files.items.find((file) => positiveId(file.id))?.id;
            if (fileId === undefined) fail(codes.json);
            result.fileMetadata = "AVAILABLE";
            const metadata = await readPages("file", { fileId });
            const fileUrl = metadata.items[0]?.url;
            result.fileVerifier = "MISSING";
            if (typeof fileUrl === "string") {
              let safeFileUrl;
              try {
                safeFileUrl = new URL(fileUrl, fixedOrigin);
                const expectedPath = `/files/${fileId}/download`;
                const queryKeys = [...safeFileUrl.searchParams.keys()];
                const verifiers = safeFileUrl.searchParams.getAll("verifier");
                const downloadFrd = safeFileUrl.searchParams.getAll("download_frd");
                const hasVerifier = verifiers.length === 1 && verifiers[0] !== "";
                const hasDownloadFrd = downloadFrd.length === 1 && downloadFrd[0] === "1";
                result.fileVerifier = safeFileUrl.searchParams.has("verifier") ? "AVAILABLE" : "MISSING";
                if (safeFileUrl.origin !== fixedOrigin || safeFileUrl.username || safeFileUrl.password
                    || safeFileUrl.hash || safeFileUrl.pathname !== expectedPath
                    || queryKeys.some((key) => key !== "verifier" && key !== "download_frd")
                    || verifiers.length > 1 || (verifiers.length === 1 && !hasVerifier)
                    || downloadFrd.length > 1 || (downloadFrd.length === 1 && !hasDownloadFrd)
                    || (!hasVerifier && !hasDownloadFrd)) fail(codes.unsafe);
              } catch { fail(codes.unsafe); }
              let downloadResponse;
              reportProgress("CANVAS_GET_STARTED");
              try {
                downloadResponse = await fetchAdapter(safeFileUrl.href, {
                  method: "GET",
                  headers: { Accept: "application/octet-stream", Range: "bytes=0-0" },
                  credentials: "omit",
                  redirect: "manual",
                  cache: "no-store",
                  signal: controller.signal,
                });
              } catch { fail(codes.transport); }
              finally { reportProgress("CANVAS_GET_FINISHED"); }
              if (downloadResponse.status === 401) result.cookielessDownload = "SESSION_REQUIRED";
              else if (downloadResponse.type === "opaqueredirect" || downloadResponse.redirected
                  || (downloadResponse.status >= 300 && downloadResponse.status < 400)
                  || (downloadResponse.url && downloadResponse.url !== safeFileUrl.href)) result.cookielessDownload = "REDIRECT_WITHHELD";
              else {
                const contentType = downloadResponse.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase();
                const rawLength = downloadResponse.headers?.get?.("content-length");
                const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
                const contentRange = downloadResponse.headers?.get?.("content-range") ?? "";
                if (["text/html", "application/xhtml+xml"].includes(contentType)) result.cookielessDownload = "HTML_REJECTED";
                else if (downloadResponse.status === 206 && /^bytes 0-0\/(?:\d+|\*)$/.test(contentRange)
                    && rawLength !== null && contentLength === 1) result.cookielessDownload = "BROWSER_RANGE_AVAILABLE";
                else if (downloadResponse.status === 200 && rawLength !== null && contentLength === 0) result.cookielessDownload = "BROWSER_RANGE_AVAILABLE";
                else if (downloadResponse.status === 200) result.cookielessDownload = "RANGE_IGNORED";
                else result.cookielessDownload = "UNAVAILABLE";
              }
              try { await downloadResponse.body?.cancel(); } catch { /* response body is deliberately discarded */ }
            }
          }
        } catch (error) {
          if (result.fileMetadata === "UNAVAILABLE") result.fileMetadata = publicProbeStatus(error);
          else if (result.fileVerifier === "UNAVAILABLE") result.fileVerifier = publicProbeStatus(error);
          else if (result.cookielessDownload === "UNAVAILABLE") result.cookielessDownload = publicProbeStatus(error);
        }
      } else {
        result.fileMetadata = "NO_COURSE";
        result.fileVerifier = "NO_COURSE";
        result.cookielessDownload = "NO_COURSE";
      }
      return result;
    }
    if (input.endpoint === "profile") return { status: "ok", identity: { userId: profile.id }, pages: profileResult.pages, items: [profile] };
    const result = await readPages(input.endpoint);
    return { ...result, identity: { userId: profile.id } };
  } catch (error) {
    if (input.mode === "probe") {
      const status = publicProbeStatus(error);
      return {
        signedInContinuity: status === "SESSION_FAILED" ? status : "UNAVAILABLE",
        accountIdentity: status === "MISMATCH" ? status : "UNAVAILABLE",
        apiShapePagination: "UNAVAILABLE",
        inboxUnreadState: "UNAVAILABLE",
        fileMetadata: "UNAVAILABLE",
        fileVerifier: "UNAVAILABLE",
        cookielessDownload: "UNAVAILABLE",
        nativeDownloader: "NOT_TESTED",
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
