import type { ElementDescriptor } from "../dom";
import type { DashboardHandlers, DashboardState } from "./dashboard";
import { code, color, el, empty, formatted, heading } from "./dashboard-utils";


export function renderInboxPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const inboxVerified = state.data.sourceStatus.inbox === "synced" && state.data.sourceStatus.browserFreshness?.current !== false;
  const messages = state.data.conversations;
  const selected = messages.find((message) => message.id === state.selectedConversationId) ?? messages[0];
  const thread = selected?.messages ?? [];
  const warning = selected !== undefined && (selected.historyComplete === false || selected.safetyTruncated === true || thread.some((message) => message.bodyTruncated === true));
  const unreadCount = messages.filter((message) => message.unread).length;
  const countLabel = inboxVerified ? `${unreadCount} unread` : "Inbox unverified";
  const noImport = state.data.sourceStatus.browserFreshness?.reason === "not-imported"
    && state.data.sourceStatus.browserFreshness.runId === null
    && state.data.sourceStatus.browserFreshness.observedAt === null;
  const emptyState = messages.length === 0
    ? empty(
        inboxVerified
          ? "No conversations in your Canvas inbox."
          : noImport
            ? "Canvas conversations have not been synced yet."
            : "Inbox could not be verified. Refresh to check conversations."
      )
    : el("div", undefined, { class: `inbox-layout${state.inboxThreadOpen ? " inbox-layout--thread" : ""}`, "data-inbox-mode": state.inboxThreadOpen ? "thread" : "list" }, [
        el("div", undefined, { class: "message-list" }, messages.map((message) => ({
          tag: "button",
          attrs: { type: "button", class: `message-row ${message.id === selected?.id ? "active" : ""} ${message.unread ? "unread" : ""}`, style: `--course-color:${color(state.data.courses, message.courseCode ?? "")}` },
          on: { click: () => handlers.onSelectConversation(message.id) },
          children: [
            el("span", undefined, { class: "message-course", "aria-hidden": "true" }),
            el("span", undefined, undefined, [
              el("strong", message.subject),
              el("span", `${message.sender}${message.contextLabel ? ` · ${message.contextLabel}` : message.courseCode ? ` · ${code(message.courseCode)}` : ""}`),
              el("small", message.preview ?? "No preview supplied"),
            ]),
          ],
        }))),
        selected === undefined
          ? empty("Select a conversation.")
          : el("article", undefined, { class: "message-detail" }, [
              {
                tag: "button",
                attrs: { type: "button", class: "setup-secondary inbox-back-button", "aria-label": "Back to conversations" },
                text: "← All conversations",
                on: { click: () => handlers.onCloseInboxThread?.() },
              },
              el("div", `${selected.contextLabel ?? (selected.courseCode ? code(selected.courseCode) : "Canvas conversation")} · ${formatted(selected.receivedAt, true)}`, { class: "message-detail__meta" }),
              el("h2", selected.subject),
              el("div", `Participants: ${selected.sender}${selected.messageCount === undefined ? "" : ` · ${selected.messageCount} message${selected.messageCount === 1 ? "" : "s"}`}${selected.attachmentCount ? ` · ${selected.attachmentCount} attachment${selected.attachmentCount === 1 ? "" : "s"}` : ""}`, { class: "message-detail__sender" }),
              ...(warning ? [el("p", "This thread is incomplete or was safety-limited. Refresh Inbox to retrieve the available history; no content was silently hidden.", { class: "inbox-warning", role: "status" })] : []),
              ...(thread.length > 0 ? [el("div", undefined, { class: "message-thread" }, thread.map((message) => el("article", undefined, { class: "thread-message" }, [el("header", undefined, { class: "thread-message__head" }, [el("strong", message.author), el("time", formatted(message.createdAt, true))]), el("div", message.body, { class: "message-detail__body" }), ...(message.attachments.length > 0 ? [el("div", undefined, { class: "thread-attachments" }, message.attachments.map((attachment) => el("span", `${attachment.name}${attachment.contentType ? ` · ${attachment.contentType}` : ""}`, { class: "thread-attachment" })))] : []), ...(message.bodyTruncated ? [el("small", "This message reached the safety display limit.", { class: "inbox-warning" })] : [])]))) ] : [el("div", selected.body ?? selected.preview ?? "No message body was supplied.", { class: "message-detail__body" })]),
            ]),
      ]);
  return el("section", undefined, { class: "page" }, [
    heading("Canvas communication", "Inbox", "Read-only Canvas conversations. Selecting one here never changes it in Canvas.", countLabel),
    emptyState,
  ]);
}
