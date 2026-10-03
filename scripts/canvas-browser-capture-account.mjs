const MAX_CONVERSATIONS = 500;
export const MAX_ACCOUNT_FILE_IDS = 5000;
const MAX_GROUPS = 500;

export const ACCOUNT_DETAIL_REQUEST_CAPS = Object.freeze({
  conversation: MAX_CONVERSATIONS,
  file: 1500,
  personalFile: 1500,
  groupFolderFiles: 2500,
  groupPage: 1000,
  groupDiscussionEntries: 500,
  groupDiscussionReplies: 1500,
});

function accountError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function groupItem(item, groupId) {
  if (item.group_id !== undefined && item.group_id !== groupId) throw accountError("GROUP_IDENTITY_MISMATCH");
  if (item.context_type !== undefined && item.context_type !== "Group") throw accountError("GROUP_IDENTITY_MISMATCH");
  if (item.context_id !== undefined && item.context_id !== groupId) throw accountError("GROUP_IDENTITY_MISMATCH");
  return { ...item, group_id: groupId };
}

/**
 * Read bounded account, calendar, and explicit user-owned group resources.
 * Group files flow through the same metadata sanitizer and file-body stager as course files.
 * @param {object} options Collector callbacks, account/course identity, and fixed capture time.
 * @returns {Promise<{calendarMode: "all_events"}>} The fixed Canvas calendar retrieval mode.
 */
export async function collectCanvasAccountCapture({
  readEndpoint,
  addResource,
  addNotAttemptedGap,
  reserveDetailRequest,
  courseFileIds,
  courseIds,
  expectedUserId,
  accountId,
}) {
  const accountLists = new Map();
  const personalFileIds = new Set();
  for (const endpoint of ["groups", "personalFiles", "personalFolders", "inbox", "inboxAll", "conversationsSent", "conversationsArchived"]) {
    const { result, gap } = await readEndpoint(endpoint);
    if (gap) {
      if (endpoint === "personalFiles") addNotAttemptedGap("personalFile", null, undefined, "parent-unavailable");
      continue;
    }
    await addResource(endpoint, null, result);
    accountLists.set(endpoint, result);
    if (endpoint === "personalFiles") {
      for (const file of result.items) {
        if (!positiveId(file.id) || (personalFileIds.size >= MAX_ACCOUNT_FILE_IDS && !personalFileIds.has(file.id))) {
          addNotAttemptedGap("personalFile", null, undefined, "detail-budget");
        } else personalFileIds.add(file.id);
      }
    }
  }

  const knownGroupIds = [];
  const groupsRead = accountLists.get("groups");
  if (groupsRead) {
    const seen = new Set();
    for (const group of groupsRead.items) {
      if (!positiveId(group.id)) throw accountError("INVALID_GROUP_ID");
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      knownGroupIds.push(group.id);
    }
  }
  const groupIds = knownGroupIds.slice(0, MAX_GROUPS);
  for (const groupId of knownGroupIds.slice(MAX_GROUPS)) {
    for (const endpoint of ["groupFolders", "groupFolderFiles", "groupPages", "groupPage", "groupDiscussions", "groupDiscussionEntries", "groupDiscussionReplies", "file"]) {
      addNotAttemptedGap(endpoint, null, groupId, "detail-budget");
    }
  }

  const groupFileIds = new Map();
  for (const groupId of groupIds) {
    const folderRead = await readEndpoint("groupFolders", { groupId });
    if (!folderRead.gap) {
      const folderIds = new Set();
      const folders = folderRead.result.items.map((folder) => {
        if (!positiveId(folder.id)) throw accountError("INVALID_GROUP_FOLDER_ID");
        if (folderIds.has(folder.id)) throw accountError("DUPLICATE_GROUP_FOLDER_ID");
        folderIds.add(folder.id);
        return groupItem(folder, groupId);
      });
      await addResource("folders", null, { ...folderRead.result, items: folders }, { groupId });

      for (const folderId of folderIds) {
        if (!reserveDetailRequest("groupFolderFiles", null, groupId)) continue;
        const filesRead = await readEndpoint("groupFolderFiles", { groupId, folderId });
        if (filesRead.gap) continue;
        const files = [];
        for (const file of filesRead.result.items) {
          if (!positiveId(file.id)) throw accountError("INVALID_GROUP_FILE_ID");
        if (groupFileIds.size >= MAX_ACCOUNT_FILE_IDS && !groupFileIds.has(file.id)) {
            addNotAttemptedGap("file", null, groupId, "detail-budget");
            continue;
          }
          groupFileIds.set(file.id, groupFileIds.get(file.id) ?? groupId);
          files.push(groupItem(file, groupId));
        }
        if (files.length > 0) {
          await addResource("courseFiles", null, { ...filesRead.result, items: files }, { groupId });
        }
      }
    } else {
      addNotAttemptedGap("groupFolderFiles", null, groupId, "parent-unavailable");
    }

    const pagesRead = await readEndpoint("groupPages", { groupId });
    if (!pagesRead.gap) {
      await addResource("pages", null, { ...pagesRead.result, items: pagesRead.result.items.map((page) => groupItem(page, groupId)) }, { groupId });
      for (const page of pagesRead.result.items) {
        if (page.published !== true || page.locked_for_user === true || page.locked === true
            || typeof page.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u.test(page.url)) {
          const reason = page.locked_for_user === true || page.locked === true ? "locked"
            : page.published === false ? "unpublished"
              : typeof page.url !== "string" ? "request-failed" : "invalid-slug";
          addNotAttemptedGap("page", null, groupId, reason);
          continue;
        }
        if (!reserveDetailRequest("groupPage", null, groupId)) continue;
        const pageDetail = await readEndpoint("groupPage", { groupId, pageSlug: page.url });
        if (pageDetail.gap) continue;
        if (pageDetail.result.items.length !== 1 || pageDetail.result.items[0].url !== page.url) {
          throw accountError("GROUP_PAGE_IDENTITY_MISMATCH");
        }
        await addResource("page", null, {
          ...pageDetail.result,
          items: pageDetail.result.items.map((item) => groupItem(item, groupId)),
        }, { groupId });
      }
    } else {
      addNotAttemptedGap("groupPage", null, groupId, "parent-unavailable");
    }

    const discussionsRead = await readEndpoint("groupDiscussions", { groupId });
    if (!discussionsRead.gap) {
      for (const topic of discussionsRead.result.items) {
        if (!positiveId(topic.id)) throw accountError("INVALID_GROUP_DISCUSSION_ID");
      }
      await addResource("discussions", null, {
        ...discussionsRead.result,
        items: discussionsRead.result.items.map((topic) => groupItem(topic, groupId)),
      }, { groupId });
      for (const topic of discussionsRead.result.items) {
        if (topic.published !== true || topic.locked_for_user === true || topic.locked === true) {
          const reason = topic.locked_for_user === true || topic.locked === true ? "locked"
            : topic.published === false ? "unpublished" : "request-failed";
          addNotAttemptedGap("groupDiscussionEntries", null, groupId, reason);
          addNotAttemptedGap("groupDiscussionReplies", null, groupId, reason);
          continue;
        }
        if (!reserveDetailRequest("groupDiscussionEntries", null, groupId)) continue;
        const entriesRead = await readEndpoint("groupDiscussionEntries", { groupId, topicId: topic.id });
        if (entriesRead.gap) continue;
        if (entriesRead.result.items.some((entry) => !positiveId(entry.id))) {
          throw accountError("INVALID_GROUP_DISCUSSION_ENTRY_ID");
        }
        await addResource("discussionEntries", null, {
          ...entriesRead.result,
          items: entriesRead.result.items.map((entry) => groupItem(entry, groupId)),
        }, { groupId });
        for (const entry of entriesRead.result.items) {
          if (!reserveDetailRequest("groupDiscussionReplies", null, groupId)) continue;
          const repliesRead = await readEndpoint("groupDiscussionReplies", {
            groupId,
            topicId: topic.id,
            entryId: entry.id,
          });
          if (repliesRead.gap) continue;
          if (repliesRead.result.items.some((reply) => !positiveId(reply.id)
              || (reply.parent_id !== undefined && !positiveId(reply.parent_id)))) {
            throw accountError("INVALID_GROUP_DISCUSSION_ENTRY_ID");
          }
          await addResource("discussionReplies", null, {
            ...repliesRead.result,
            items: repliesRead.result.items.map((reply) => groupItem(reply, groupId)),
          }, { groupId });
        }
      }
    } else {
      addNotAttemptedGap("groupDiscussionEntries", null, groupId, "parent-unavailable");
      addNotAttemptedGap("groupDiscussionReplies", null, groupId, "parent-unavailable");
    }
  }

  const calendarContexts = [
    { code: `user_${expectedUserId}` },
    ...(positiveId(accountId) ? [{ code: `account_${accountId}`, accountId }] : []),
    ...[...courseIds].map((courseId) => ({ code: `course_${courseId}`, courseId })),
    ...groupIds.map((groupId) => ({ code: `group_${groupId}`, groupId })),
  ];
  for (const context of calendarContexts) {
    const read = await readEndpoint("calendarEvents", {
      allEvents: true,
      calendarContextCode: context.code,
      ...(context.accountId === undefined ? {} : { accountId: context.accountId }),
      ...(context.courseId === undefined ? {} : { courseId: context.courseId }),
      ...(context.groupId === undefined ? {} : { groupId: context.groupId }),
    });
    if (read.gap) continue;
    await addResource("calendarEvents", context.courseId ?? null, read.result, {
      ...(context.groupId === undefined ? {} : { groupId: context.groupId }),
      contextCode: context.code,
    });
  }

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

  for (const [fileId, groupId] of groupFileIds) {
    if (courseFileIds.has(fileId)) continue;
    if (!reserveDetailRequest("file", null, groupId)) continue;
    const { result, gap } = await readEndpoint("file", { fileId, groupId });
    if (!gap) {
      if (result.items.length !== 1 || result.items[0].id !== fileId) throw accountError("FILE_IDENTITY_MISMATCH");
      await addResource("file", null, result, { groupId });
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

  return { calendarMode: "all_events" };
}
