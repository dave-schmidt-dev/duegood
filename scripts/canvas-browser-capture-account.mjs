const MAX_CONVERSATIONS = 500;
export const MAX_ACCOUNT_FILE_IDS = 5000;
const CALENDAR_WINDOW_DAYS = 90;

export const ACCOUNT_DETAIL_REQUEST_CAPS = Object.freeze({
  conversation: MAX_CONVERSATIONS,
  file: 1500,
  personalFile: 1500,
});

function accountError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function calendarWindow(capturedAt) {
  const calendarEnd = capturedAt.toISOString().slice(0, 10);
  const start = new Date(`${calendarEnd}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (CALENDAR_WINDOW_DAYS - 1));
  return { calendarStart: start.toISOString().slice(0, 10), calendarEnd };
}

/**
 * Read optional account routes and bounded detail resources through collector-owned callbacks.
 * @param {object} options Collector callbacks, captured course file IDs, and fixed capture time.
 * @returns {Promise<{calendarStart: string, calendarEnd: string}>} The requested current calendar window.
 */
export async function collectCanvasAccountCapture({
  readEndpoint,
  addResource,
  addNotAttemptedGap,
  reserveDetailRequest,
  courseFileIds,
  capturedAt,
}) {
  const { calendarStart, calendarEnd } = calendarWindow(capturedAt);
  const accountLists = new Map();
  const personalFileIds = new Set();
  for (const endpoint of ["groups", "personalFiles", "personalFolders", "inbox", "inboxAll", "conversationsSent", "conversationsArchived"]) {
    const { result, gap } = await readEndpoint(endpoint);
    if (gap) {
      if (endpoint === "personalFiles") addNotAttemptedGap("personalFile", null);
      continue;
    }
    await addResource(endpoint, null, result);
    accountLists.set(endpoint, result);
    if (endpoint === "personalFiles") {
      for (const file of result.items) {
        if (!positiveId(file.id) || (personalFileIds.size >= MAX_ACCOUNT_FILE_IDS && !personalFileIds.has(file.id))) {
          addNotAttemptedGap("personalFile", null);
        } else personalFileIds.add(file.id);
      }
    }
  }

  const calendarRead = await readEndpoint("calendarEvents", { calendarStart, calendarEnd });
  if (!calendarRead.gap) await addResource("calendarEvents", null, calendarRead.result);
  addNotAttemptedGap("calendarEventsHistory", null);

  const conversationIds = new Set();
  for (const endpoint of ["inbox", "inboxAll", "conversationsSent", "conversationsArchived"]) {
    for (const conversation of accountLists.get(endpoint)?.items ?? []) {
      if (!positiveId(conversation.id)) throw accountError("INVALID_CONVERSATION_ID");
      if (conversationIds.has(conversation.id)) continue;
      if (conversationIds.size >= MAX_CONVERSATIONS) {
        addNotAttemptedGap("conversation", null);
        continue;
      }
      conversationIds.add(conversation.id);
    }
  }
  for (const conversationId of conversationIds) {
    if (!reserveDetailRequest("conversation", null)) continue;
    const { result, gap } = await readEndpoint("conversation", { conversationId });
    if (!gap) {
      if (result.items.length !== 1 || result.items[0].id !== conversationId) {
        throw accountError("CONVERSATION_IDENTITY_MISMATCH");
      }
      await addResource("conversation", null, result);
    }
  }

  for (const [endpoint, fileIds] of [["file", courseFileIds], ["personalFile", personalFileIds]]) {
    for (const fileId of fileIds) {
      if (!reserveDetailRequest(endpoint, null)) continue;
      const { result, gap } = await readEndpoint(endpoint, { fileId });
      if (!gap) {
        if (result.items.length !== 1 || result.items[0].id !== fileId) throw accountError("FILE_IDENTITY_MISMATCH");
        await addResource(endpoint, null, result);
      }
    }
  }

  return { calendarStart, calendarEnd };
}
