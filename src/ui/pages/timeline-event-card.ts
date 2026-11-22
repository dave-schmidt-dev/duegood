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

/** Renders one Timeline card, including honest rolling-window state for calendar-only items. */
export function renderTimelineEventCard(
  event: DashboardEvent,
  state: DashboardState,
  handlers: DashboardHandlers,
  renderers: TimelineEventCardRenderers,
): ElementDescriptor {
  const { el } = renderers;
  const expanded = state.expandedEventIds.has(event.id);
  const detailText = event.detail?.trim();
  const hasRubric = event.rubric !== undefined && event.rubric !== null;
  const detailsId = `event-detail-${event.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const retained = event.calendarRetained === true && event.source !== "canvas";
  return el("article", undefined, { class: `event-card ${event.kind === "class" ? "class-meeting" : ""} ${event.kind === "discussion" ? "discussion-card" : ""} ${event.completed ? "completed" : ""}`.trim(), style: `--course-color:${renderers.color(event.courseCode)}` }, [
    el("div", undefined, { class: "event-top" }, [el("div", undefined, undefined, [el("div", `${renderers.code(event.courseCode)} · ${event.kind === "class" ? "Class meeting" : event.kind === "discussion" ? "Discussion" : "Assignment due"}`, { class: "event-kind" }), el("h2", event.title, { class: "event-title" })]), el("time", renderers.eventTime(event), { class: "event-time", datetime: event.startsAt, ...(renderers.isDateOnly(event.startsAt) && event.kind !== "class" ? { title: "No time supplied; 11:59 PM assumed." } : {}) })]),
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
        ...(detailText === undefined || detailText.length === 0
          ? hasRubric ? [] : [el("span", "No additional details were supplied.")]
          : [el("span", detailText)]),
        ...(expanded ? rubricSection(event, el) : []),
      ]),
      ...(event.kind !== "class" ? [renderers.completionButton(event)] : []),
      ...(state.failedCompletionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save. Existing completion state was restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : []),
      ...(state.failedDiscussionIds.has(event.id) ? [el("span", renderers.failureMessage(event.id, "Could not save discussion progress. Existing marks were restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : []),
    ]),
  ]);
}
