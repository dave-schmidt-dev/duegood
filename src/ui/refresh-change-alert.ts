import type { DashboardData, DashboardRefresh, DashboardResource } from "./pages/dashboard";

interface ChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

function resourceChanged(before: DashboardResource, after: DashboardResource): boolean {
  return before.type !== after.type
    || before.title !== after.title
    || before.context !== after.context
    || before.updatedAt !== after.updatedAt
    || before.bodyText !== after.bodyText;
}

function libraryChanges(before: DashboardData, after: DashboardData): ChangeCounts {
  if (before.sourceStatus.library !== "synced") {
    return { added: 0, changed: 0, removed: 0 };
  }

  const previous = new Map(before.resources.map((resource) => [resource.id, resource]));
  const current = new Map(after.resources.map((resource) => [resource.id, resource]));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, resource] of current) {
    const prior = previous.get(id);
    if (prior === undefined) added += 1;
    else if (resourceChanged(prior, resource)) changed += 1;
  }
  if (after.sourceStatus.library === "synced") {
    for (const id of previous.keys()) {
      if (!current.has(id)) removed += 1;
    }
  }
  return { added, changed, removed };
}

function conversationChanged(before: DashboardData["conversations"][number], after: DashboardData["conversations"][number]): boolean {
  if (before.courseCode !== after.courseCode
      || before.contextLabel !== after.contextLabel
      || before.subject !== after.subject
      || before.preview !== after.preview
      || before.body !== after.body
      || before.sender !== after.sender
      || before.receivedAt !== after.receivedAt
      || before.messageCount !== after.messageCount
      || before.attachmentCount !== after.attachmentCount
      || before.historyComplete !== after.historyComplete
      || before.safetyTruncated !== after.safetyTruncated) return true;
  if (before.messages === undefined || after.messages === undefined) return before.messages !== after.messages;
  return JSON.stringify(before.messages) !== JSON.stringify(after.messages);
}

function inboxChanges(before: DashboardData, after: DashboardData): ChangeCounts {
  if (before.sourceStatus.inbox !== "synced"
      || after.sourceStatus.inbox === undefined || after.sourceStatus.inbox === "not_synced") {
    return { added: 0, changed: 0, removed: 0 };
  }
  const previous = new Map(before.conversations.map((conversation) => [conversation.id, conversation]));
  const current = new Map(after.conversations.map((conversation) => [conversation.id, conversation]));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, conversation] of current) {
    const prior = previous.get(id);
    if (prior === undefined) added += 1;
    else if (conversationChanged(prior, conversation)) changed += 1;
  }
  if (before.sourceStatus.inbox === "synced" && after.sourceStatus.inbox === "synced") {
    for (const id of previous.keys()) {
      if (!current.has(id)) removed += 1;
    }
  }
  return { added, changed, removed };
}

function courseChanges(before: DashboardData, after: DashboardData): ChangeCounts {
  if (before.sourceStatus.coursework !== "synced" || after.sourceStatus.coursework !== "synced") {
    return { added: 0, changed: 0, removed: 0 };
  }
  const previous = new Map(before.courses.map((course) => [course.id, course]));
  const current = new Map(after.courses.map((course) => [course.id, course]));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, course] of current) {
    const prior = previous.get(id);
    if (prior === undefined) added += 1;
    else if (prior.courseCode !== course.courseCode || prior.title !== course.title || prior.term !== course.term
        || JSON.stringify(prior.gradeGroups) !== JSON.stringify(course.gradeGroups)) changed += 1;
  }
  for (const id of previous.keys()) {
    if (!current.has(id)) removed += 1;
  }
  return { added, changed, removed };
}

function profileChanges(before: DashboardData, after: DashboardData): ChangeCounts {
  if (before.profile === null || after.profile === null || before.profile.displayName === after.profile.displayName) {
    return { added: 0, changed: 0, removed: 0 };
  }
  return { added: 0, changed: 1, removed: 0 };
}

function newRefreshChanges(previous: DashboardData, current: DashboardData): ChangeCounts {
  const previousIds = new Set(previous.refreshes.map((entry) => entry.id));
  return current.refreshes
    .filter((entry) => entry.source !== "inbox" && !previousIds.has(entry.id) && entry.status !== "failed")
    .reduce((counts, entry: DashboardRefresh) => ({
      added: counts.added + entry.added,
      changed: counts.changed + entry.changed,
      removed: counts.removed + (entry.status === "complete" ? entry.removed : 0),
    }), { added: 0, changed: 0, removed: 0 });
}

/** Summarizes verified source changes since the last dashboard view. */
export function refreshChangeAlert(previous: DashboardData, current: DashboardData): string | undefined {
  const history = newRefreshChanges(previous, current);
  const library = libraryChanges(previous, current);
  const inbox = inboxChanges(previous, current);
  const courses = courseChanges(previous, current);
  const profile = profileChanges(previous, current);
  const counts = {
    added: history.added + library.added + inbox.added + courses.added,
    changed: history.changed + library.changed + inbox.changed + courses.changed + profile.changed,
    removed: history.removed + library.removed + inbox.removed + courses.removed,
  };
  if (counts.added + counts.changed + counts.removed === 0) return undefined;
  return `Refresh found changes · ${String(counts.added)} added · ${String(counts.changed)} changed · ${String(counts.removed)} removed.`;
}
