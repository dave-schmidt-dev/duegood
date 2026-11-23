import type { ElementDescriptor } from "../dom";
import type { DashboardEvent, DashboardHandlers, DashboardState } from "./dashboard";
import type { CanvasRubricCriterion, CanvasRubricRating } from "../../db/types";

export interface TimelineEventCardRenderers {
  readonly el: (tag: string, text?: string, attrs?: Record<string, string>, children?: readonly ElementDescriptor[]) => ElementDescriptor;
  readonly code: (courseCode: string) => string;
  readonly color: (courseCode: string) => string;
  readonly eventTime: (event: DashboardEvent) => string;
  readonly isDateOnly: (value: string | number | null | undefined) => value is string;
  readonly discussionCheckboxes: (event: DashboardEvent) => readonly ElementDescriptor[];
  readonly completionCheckbox: (event: DashboardEvent) => ElementDescriptor;
  readonly completionButton: (event: DashboardEvent) => ElementDescriptor;
  readonly failureMessage: (id: string, fallback: string) => string;
  readonly copyButton: (event: DashboardEvent) => ElementDescriptor;
}

function ratingRow(rating: CanvasRubricRating, index: number, el: TimelineEventCardRenderers["el"]): ElementDescriptor {
  return el("li", undefined, { class: "rubric-rating" }, [
    el("strong", rating.description ?? `Rating ${String(index + 1)}`),
    ...(rating.points === null ? [] : [el("span", `${String(rating.points)} points`)]),
    ...(rating.longDescription === null ? [] : [el("p", rating.longDescription)]),
  ]);
}

function criterionCard(criterion: CanvasRubricCriterion, index: number, el: TimelineEventCardRenderers["el"]): ElementDescriptor {
  return el("li", undefined, { class: "rubric-criterion" }, [
    el("div", undefined, { class: "rubric-criterion__heading" }, [
      el("strong", criterion.description ?? `Criterion ${String(index + 1)}`),
      ...(criterion.points === null ? [] : [el("span", `${String(criterion.points)} points`)]),
    ]),
    ...(criterion.longDescription === null ? [] : [el("p", criterion.longDescription)]),
    ...(criterion.ratings.length === 0 ? [] : [el("ul", undefined, { class: "rubric-ratings" }, criterion.ratings.map((rating, ratingIndex) => ratingRow(rating, ratingIndex, el)))]),
  ]);
}

function rubricSection(event: DashboardEvent, el: TimelineEventCardRenderers["el"]): ElementDescriptor[] {
  const rubric = event.rubric;
  if (rubric === undefined || rubric === null) return [];
  return [el("section", undefined, { class: "event-rubric" }, [
    el("h3", "Rubric"),
    ...(rubric.settings?.title === null || rubric.settings?.title === undefined ? [] : [el("p", rubric.settings.title)]),
    ...(rubric.settings?.pointsPossible === null || rubric.settings?.pointsPossible === undefined ? [] : [el("p", `Points possible: ${String(rubric.settings.pointsPossible)}`)]),
    ...(rubric.useForGrading === null ? [] : [el("p", rubric.useForGrading ? "Used for grading" : "Not used for grading")]),
    ...(rubric.settings?.freeFormCriterionComments === null || rubric.settings?.freeFormCriterionComments === undefined ? [] : [el("p", rubric.settings.freeFormCriterionComments ? "Free-form comments are allowed" : "Free-form comments are not allowed")]),
    ...(rubric.criteria.length === 0 ? [] : [el("ol", undefined, { class: "rubric-criteria" }, rubric.criteria.map((criterion, index) => criterionCard(criterion, index, el)))]),
  ])];
}

function bodyBlocks(text: string, el: TimelineEventCardRenderers["el"]): ElementDescriptor[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ElementDescriptor[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const line = lines[index] ?? "";
    const heading = /^ {0,3}(#{1,6})\s+(\S.*?)\s*#*$/u.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1]!.length + 2);
      blocks.push(el(`h${String(level)}`, heading[2]!.trim(), { class: "event-body__heading" }));
      index += 1;
      continue;
    }

    const fence = /^\s*(```+|~~~+)\s*$/u.exec(line);
    if (fence !== null) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1]!)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(el("pre", undefined, { class: "event-body__code" }, [el("code", codeLines.join("\n"))]));
      continue;
    }

    const listItem = /^\s*(?:(\d+)\.\s+|[-*+]\s+)(.*)$/u.exec(line);
    if (listItem !== null) {
      const ordered = listItem[1] !== undefined;
      const items: ElementDescriptor[] = [];
      const firstNumber = ordered ? Number(listItem[1]) : 1;
      while (index < lines.length) {
        const candidate = /^(\s*)(?:(\d+)\.\s+|[-*+]\s+)(.*)$/u.exec(lines[index] ?? "");
        if (candidate === null || (candidate[2] !== undefined) !== ordered) break;
        const indentation = Math.min(candidate[1]!.length, 12);
        items.push(el("li", candidate[3]!, {
          ...(indentation === 0 ? {} : { style: `margin-left:${String(indentation * 0.5)}em` }),
        }));
        index += 1;
      }
      blocks.push(el(ordered ? "ol" : "ul", undefined, {
        class: "event-body__list",
        ...(ordered && firstNumber > 1 ? { start: String(firstNumber) } : {}),
      }, items));
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      blocks.push(el("blockquote", undefined, { class: "event-body__quote" }, [el("p", quoteLines.join("\n"))]));
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== ""
        && !/^ {0,3}#{1,6}\s+\S/u.test(lines[index] ?? "")
        && !/^\s*(?:(?:\d+)\.\s+|[-*+]\s+|>\s?)/u.test(lines[index] ?? "")
        && !/^\s*(?:```+|~~~+)\s*$/u.test(lines[index] ?? "")) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraphLines.length > 0) {
      const children: ElementDescriptor[] = [];
      paragraphLines.forEach((paragraphLine, lineIndex) => {
        if (lineIndex > 0) children.push(el("br"));
        children.push(el("span", paragraphLine));
      });
      blocks.push(el("p", undefined, { class: "event-body__paragraph" }, children));
    } else {
      blocks.push(el("p", line, { class: "event-body__paragraph" }));
      index += 1;
    }
  }

  return blocks;
}

/** Renders sanitized Canvas structured text with DOM descriptors only. */
export function renderStructuredBody(text: string, el: TimelineEventCardRenderers["el"]): ElementDescriptor[] {
  return bodyBlocks(text, el);
}

function renderBodySection(label: string, text: string, el: TimelineEventCardRenderers["el"]): ElementDescriptor {
  return el("section", undefined, { class: "event-body-section" }, [
    el("strong", label, { class: "event-body-section__label" }),
    el("div", undefined, { class: "event-body" }, bodyBlocks(text, el)),
  ]);
}

export function renderCanvasBodyContent(event: DashboardEvent, el: TimelineEventCardRenderers["el"]): ElementDescriptor[] {
  const detail = event.detail?.replace(/\r\n?/gu, "\n").trim() || undefined;
  const assignmentDetail = event.assignmentDetail?.replace(/\r\n?/gu, "\n").trim() || undefined;
  if (detail !== undefined && assignmentDetail !== undefined && detail === assignmentDetail) {
    return [el("div", undefined, { class: "event-body" }, bodyBlocks(detail, el))];
  }
  if (detail !== undefined && assignmentDetail !== undefined) {
    return [
      renderBodySection(event.kind === "discussion" ? "Discussion prompt" : "Assignment details", detail, el),
      renderBodySection("Assignment instructions", assignmentDetail, el),
    ];
  }
  if (detail !== undefined) return [el("div", undefined, { class: "event-body" }, bodyBlocks(detail, el))];
  if (assignmentDetail !== undefined) return [renderBodySection("Assignment instructions", assignmentDetail, el)];
  return [];
}

/** Renders one Timeline card, including honest rolling-window state for calendar-only items. */
export function renderTimelineEventCard(
  event: DashboardEvent,
  state: DashboardState,
  handlers: DashboardHandlers,
  renderers: TimelineEventCardRenderers,
): ElementDescriptor {
  const { el } = renderers;
  const expanded = state.expandedEventIds.has(event.id);
  const hasBody = event.detail?.trim().length || event.assignmentDetail?.trim().length;
  const hasRubric = event.rubric !== undefined && event.rubric !== null;
  const detailsId = `event-detail-${event.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const retained = event.calendarRetained === true && event.source !== "canvas";
  return el("article", undefined, { class: `event-card ${event.kind === "class" ? "class-meeting" : ""} ${event.kind === "discussion" ? "discussion-card" : ""} ${event.completed ? "completed" : ""}`.trim(), style: `--course-color:${renderers.color(event.courseCode)}` }, [
    el("div", undefined, { class: "event-top" }, [el("div", undefined, undefined, [el("div", `${renderers.code(event.courseCode)} · ${event.kind === "class" ? "Class meeting" : event.kind === "discussion" ? "Discussion" : event.startsAt === null ? "Assignment" : "Assignment due"}`, { class: "event-kind" }), el("h2", event.title, { class: "event-title" })]), event.startsAt === null
      ? el("span", "No due date", { class: "event-time event-time--undated" })
      : el("time", renderers.eventTime(event), { class: "event-time", datetime: event.startsAt, ...(renderers.isDateOnly(event.startsAt) && event.kind !== "class" ? { title: "No time supplied; 11:59 PM assumed." } : {}) })]),
    el("div", undefined, { class: "event-meta" }, [el("span", event.location ?? (event.kind === "class" ? "Location not supplied" : "Canvas")), el("span", event.kind === "class" ? "Scheduled meeting" : event.completed ? "Completed by you" : "Not completed by you")]),
    ...(retained ? [el("p", "Previously imported, not in the latest verified feed. The rolling calendar window may omit older items.", { class: "calendar-retained-note", role: "note" })] : []),
    ...(event.kind === "class" ? [] : event.kind === "discussion" ? [
      el("div", undefined, { class: "discussion-progress", "aria-label": "Discussion requirements" }, [el("span", "Discussion requirements", { class: "discussion-progress__label" }), ...renderers.discussionCheckboxes(event)]),
      el("div", undefined, { class: "discussion-overall" }, [el("span", "Overall assignment"), renderers.completionCheckbox(event)]),
    ] : [renderers.completionCheckbox(event)]),
    ...(state.failedCompletionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save. Existing completion state was restored."), { class: "inline-error event-failure", role: "status", "aria-live": "polite" })] : []),
    ...(state.failedDiscussionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save discussion progress. Existing marks were restored."), { class: "inline-error event-failure", role: "status", "aria-live": "polite" })] : []),
    el("div", undefined, { class: "event-actions" }, [
      ...(event.kind !== "class" ? [renderers.copyButton(event)] : []),
      { tag: "button", attrs: { type: "button", class: "event-expand", "aria-expanded": String(expanded), "aria-controls": detailsId }, text: expanded ? "Hide details" : "Details", on: { click: () => handlers.onToggleEvent(event.id) } },
    ]),
    el("div", undefined, { id: detailsId, class: "event-detail", ...(expanded ? {} : { hidden: "" }) }, [
      el("div", undefined, { class: "event-detail__content" }, [
        ...(!expanded ? [] : hasBody === undefined || hasBody === 0
          ? hasRubric ? [] : [el("span", "No additional details were supplied.")]
          : renderCanvasBodyContent(event, el)),
        ...(expanded ? rubricSection(event, el) : []),
      ]),
      ...(event.kind !== "class" ? [renderers.completionButton(event)] : []),
      ...(state.failedCompletionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save. Existing completion state was restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : []),
      ...(state.failedDiscussionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save discussion progress. Existing marks were restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : []),
    ]),
  ]);
}
