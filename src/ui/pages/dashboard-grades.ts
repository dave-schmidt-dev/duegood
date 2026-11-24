import type { ElementDescriptor } from "../dom";
import type { DashboardCourse, DashboardEvent, DashboardHandlers, DashboardState, DashboardGradeGroup } from "./dashboard";
import { asDate, code, color, courseworkIsVerified, el, empty, heading, key, orderedCourses } from "./dashboard-utils";


function hasNumericGrade(event: DashboardEvent): boolean {
  return typeof event.score === "number" && Number.isFinite(event.score) && typeof event.points === "number" && Number.isFinite(event.points);
}

function hasCanvasReportedGrade(event: DashboardEvent): boolean {
  return (typeof event.score === "number" && Number.isFinite(event.score)) || (typeof event.grade === "string" && event.grade.length > 0) || asDate(event.gradedAt) !== undefined;
}

function hasReportedGrade(event: DashboardEvent): boolean {
  return event.manualGrade !== null && event.manualGrade !== undefined || hasCanvasReportedGrade(event);
}

function pointsText(event: DashboardEvent): string {
  if (hasNumericGrade(event)) return `${String(event.score)} / ${String(event.points)}`;
  if (typeof event.points === "number" && Number.isFinite(event.points)) return `${String(event.points)} possible · awaiting score`;
  if (typeof event.score === "number" && Number.isFinite(event.score)) return `${String(event.score)} earned · points unavailable`;
  return "Awaiting / unavailable";
}

function percentage(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unknown" : `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function groupName(group: DashboardGradeGroup): string {
  return group.name ?? "Unnamed Canvas group";
}

function groupWeight(value: number | null): string {
  return value === null ? "Weight unknown" : `${percentage(value)}`;
}

function groupsSummary(groups: readonly DashboardGradeGroup[] | undefined): string {
  if (groups === undefined || groups.length === 0) return "Grade groups · weights unavailable";
  const knownWeight = groups.reduce((total, group) => total + (typeof group.weight === "number" && Number.isFinite(group.weight) ? group.weight : 0), 0);
  return knownWeight > 0 ? `Grade groups · ${percentage(knownWeight)} of course weight` : "Grade groups · weights unavailable";
}

function recordGroup(event: DashboardEvent, group: DashboardGradeGroup): boolean {
  if (group.id !== null && event.assignmentGroupId !== null && event.assignmentGroupId !== undefined) return event.assignmentGroupId === group.id;
  return group.name !== null && event.assignmentGroupName === group.name;
}

interface GradeProgress {
  readonly graded: number | null;
  readonly gradedCoverage: number | null;
  readonly wholeCourse: number | null;
  readonly publishedCoverage: number | null;
}

export function gradeProgress(course: DashboardCourse, records: readonly DashboardEvent[]): GradeProgress {
  const groups = course.gradeGroups ?? [];
  const weightedGroups = groups.filter((group) => group.weight !== null && Number.isFinite(group.weight));
  const totalWeight = weightedGroups.reduce((sum, group) => sum + (group.weight ?? 0), 0);
  if (totalWeight <= 0) return { graded: null, gradedCoverage: null, wholeCourse: null, publishedCoverage: null };
  let gradedWeight = 0;
  let gradedContribution = 0;
  let publishedWeight = 0;
  let wholeContribution = 0;
  for (const group of weightedGroups) {
    const groupRecords = records.filter((event) => recordGroup(event, group) && typeof event.points === "number" && Number.isFinite(event.points) && event.points > 0);
    if (groupRecords.length === 0) continue;
    const possible = groupRecords.reduce((sum, event) => sum + (event.points ?? 0), 0);
    const earned = groupRecords.reduce((sum, event) => sum + (typeof event.score === "number" && Number.isFinite(event.score) ? event.score : 0), 0);
    const groupWeight = group.weight ?? 0;
    publishedWeight += groupWeight;
    wholeContribution += groupWeight * (earned / possible);
    const gradedRecords = groupRecords.filter((event) => typeof event.score === "number" && Number.isFinite(event.score));
    if (gradedRecords.length === 0) continue;
    const gradedPossible = gradedRecords.reduce((sum, event) => sum + (event.points ?? 0), 0);
    const gradedEarned = gradedRecords.reduce((sum, event) => sum + (event.score ?? 0), 0);
    gradedWeight += groupWeight;
    gradedContribution += groupWeight * (gradedEarned / gradedPossible);
  }
  return {
    graded: gradedWeight > 0 ? (gradedContribution / gradedWeight) * 100 : null,
    gradedCoverage: (gradedWeight / totalWeight) * 100,
    wholeCourse: publishedWeight > 0 ? (wholeContribution / totalWeight) * 100 : null,
    publishedCoverage: (publishedWeight / totalWeight) * 100,
  };
}

function groupCell(event: DashboardEvent): string {
  const name = event.assignmentGroupName ?? "Group unknown";
  const weight = event.assignmentGroupWeight === null || event.assignmentGroupWeight === undefined ? "Weight unknown" : percentage(event.assignmentGroupWeight);
  return `${name} · ${weight}`;
}

function selectedGrade(event: DashboardEvent): string {
  if (event.manualGrade !== null && event.manualGrade !== undefined) return event.manualGrade;
  if (event.grade !== null && event.grade !== undefined && event.grade.length > 0) return event.grade;
  return hasNumericGrade(event) ? pointsText(event) : "Unavailable";
}

function gradeProvenance(event: DashboardEvent): string {
  if (event.manualGrade !== null && event.manualGrade !== undefined) return `${event.manualGradeSource === "pdf" ? "User-confirmed PDF" : "Local observation"} · v${String(event.manualGradeVersion ?? 1)}`;
  if (event.grade !== null && event.grade !== undefined && event.grade.length > 0) return "Canvas grade";
  if (hasNumericGrade(event)) return "Canvas score";
  return "No grade observation";
}

function gradeEditor(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const draft = state.gradeDrafts?.[event.id] ?? (state.editingManualGrade?.id === event.id ? state.editingManualGrade.draft : undefined);
  const isEditing = draft !== undefined || state.editingManualGrade?.id === event.id;
  const pending = state.pendingManualGradeIds.has(event.id);
  if (!isEditing) {
    return { tag: "button", attrs: { type: "button", class: "more-action", "aria-label": `Edit local grade for ${event.title}`, ...(pending ? { disabled: "" } : {}) }, text: event.manualGrade === null || event.manualGrade === undefined ? "Add local grade" : "Edit local grade", on: { click: () => handlers.onEditManualGrade(event.id) } };
  }
  const currentDraft = draft ?? "";
  return { tag: "form", attrs: { class: "grade-editor", "aria-label": `Edit local grade for ${event.title}` }, on: { submit: (input) => { input.preventDefault(); handlers.onSaveManualGrade(event.id); } }, children: [
    { tag: "input", attrs: { type: "text", value: currentDraft, maxlength: "80", autofocus: "", "aria-label": `Local grade for ${event.title}`, ...(pending ? { disabled: "" } : {}) }, on: {
      input: (input) => handlers.onManualGradeDraft((input.currentTarget as HTMLInputElement).value, event.id),
      keydown: (input) => { if ((input as KeyboardEvent).key === "Escape") { input.preventDefault(); handlers.onCancelManualGrade(event.id); } },
    } },
    { tag: "button", attrs: { type: "submit", class: "more-action", ...(pending ? { disabled: "" } : {}) }, text: pending ? "Saving…" : "Save" },
    { tag: "button", attrs: { type: "button", class: "more-action", ...(pending ? { disabled: "" } : {}) }, text: "Cancel", on: { click: () => handlers.onCancelManualGrade(event.id) } },
  ] };
}

function gradeEditorCell(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  if (!/^[a-f0-9]{64}$/.test(state.data.version)) return el("td", "Local editing unavailable");
  const error = state.mutationError?.id === event.id ? state.mutationError.message : undefined;
  return el("td", undefined, undefined, [gradeEditor(event, state, handlers), ...(error === undefined ? [] : [el("span", error, { role: "status", "aria-live": "polite", class: "inline-error" })])]);
}

export function renderGradebookPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courses = orderedCourses(state.data.courses);
  const records = state.data.events.filter((event) => event.kind !== "class");
  const selectedRecords = records.filter((event) => state.gradeCourseFilter === "all" || key(event.courseCode) === key(state.gradeCourseFilter));
  const visibleRecords = selectedRecords.filter((event) => state.gradeMode === "all" || hasReportedGrade(event)).sort((left, right) => {
    const leftDate = asDate(left.gradedAt ?? left.startsAt)?.getTime() ?? 0;
    const rightDate = asDate(right.gradedAt ?? right.startsAt)?.getTime() ?? 0;
    return rightDate - leftDate || left.title.localeCompare(right.title);
  });
  const summary = courses.map((course) => {
    const courseRecords = records.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode));
    const numeric = courseRecords.filter(hasNumericGrade);
    const reported = courseRecords.filter(hasCanvasReportedGrade);
    const earned = numeric.reduce((total, event) => total + (event.score ?? 0), 0);
    const possible = numeric.reduce((total, event) => total + (event.points ?? 0), 0);
    const progress = gradeProgress(course, courseRecords);
    const groupRows: readonly ElementDescriptor[] = course.gradeGroups === undefined || course.gradeGroups.length === 0
      ? [el("p", "Canvas assignment groups were not supplied.", { class: "grade-groups-empty" })]
      : [el("ul", undefined, { class: "grade-groups-list" }, course.gradeGroups.map((group) => el("li", undefined, undefined, [el("span", groupName(group)), el("strong", groupWeight(group.weight))])))];
    return el("article", undefined, { class: "grade-summary-card", style: `--course-color:${color(courses, course.courseCode)}` }, [
      { tag: "button", attrs: { type: "button", class: "grade-summary-card__select", "aria-label": `Filter grades to ${code(course.courseCode)}` }, on: { click: () => handlers.onGradeCourseFilter(course.courseCode) }, children: [
        el("span", undefined, { class: "grade-summary-card__heading" }, [el("span", code(course.courseCode), { class: "course-card__code" }), el("h2", course.title)]),
        el("span", undefined, { class: "grade-summary-card__grade" }, [el("strong", percentage(numeric.length > 0 ? progress.graded : null)), el("small", numeric.length > 0 ? "Graded work" : "No numeric score")]),
      ] },
      el("div", undefined, { class: "grade-summary-metrics" }, [
        el("div", undefined, { class: "grade-summary-metric" }, [el("strong", numeric.length > 0 ? `${String(earned)} / ${String(possible)}` : "—"), el("span", numeric.length > 0 ? "Graded points" : "No graded points")]),
        el("div", undefined, { class: "grade-summary-metric" }, [el("strong", numeric.length > 0 ? percentage(progress.wholeCourse) : "Unknown"), el("span", "Whole-course progress")]),
      ]),
      el("p", `${String(reported.length)} of ${String(courseRecords.length)} listed item${courseRecords.length === 1 ? "" : "s"} graded · ${String(courseRecords.length - reported.length)} awaiting`, { class: "grade-summary-awaiting" }),
      el("p", `Coverage: ${percentage(progress.gradedCoverage)} graded · ${percentage(progress.publishedCoverage)} with current records`, { class: "grade-summary-coverage" }),
      { tag: "details", attrs: { class: "grade-summary-groups", ...(state.openGradeGroupCourseIds?.has(course.id) === true ? { open: "" } : {}) }, on: { toggle: (event: Event) => handlers.onToggleGradeGroups?.(course.id, (event.currentTarget as HTMLDetailsElement).open) }, children: [
        { tag: "summary", attrs: { class: "grade-summary-groups__summary" }, text: groupsSummary(course.gradeGroups) },
        ...groupRows,
      ] },
    ]);
  });
  const table = visibleRecords.length === 0 ? empty(state.gradeMode === "graded" ? "No graded items match this filter." : "No grade records match this filter.") : el("div", undefined, { class: "grade-table-wrap" }, [
    { tag: "table", attrs: { class: "grade-table" }, children: [
      { tag: "caption", text: "Coursework grade records" },
      { tag: "thead", children: [{ tag: "tr", children: [el("th", "Assignment", { scope: "col" }), el("th", "Course", { scope: "col" }), el("th", "Canvas group", { scope: "col" }), el("th", "Canvas score", { scope: "col" }), el("th", "Canvas grade", { scope: "col" }), el("th", "Selected value", { scope: "col" }), el("th", "Provenance", { scope: "col" }), el("th", "Edit", { scope: "col" })] }] },
      { tag: "tbody", children: visibleRecords.map((event) => ({ tag: "tr", children: [
        el("th", event.title, { scope: "row" }),
        el("td", code(event.courseCode)),
        el("td", groupCell(event)),
        el("td", pointsText(event), { class: hasNumericGrade(event) ? "grade-score" : "grade-score grade-score--pending" }),
        el("td", event.grade ?? (hasCanvasReportedGrade(event) ? "Reported" : "Not graded")),
        el("td", selectedGrade(event), { class: event.manualGrade === null || event.manualGrade === undefined ? "grade-score grade-score--pending" : "grade-score" }),
        el("td", gradeProvenance(event)),
        gradeEditorCell(event, state, handlers),
      ] })) },
    ] },
  ]);
  const courseworkVerified = courseworkIsVerified(state.data.sourceStatus, state.data.courses);
  return el("section", undefined, { class: "page", "data-page-panel": "grades" }, [
    heading("Coursework grade records", "Grades", "Canvas facts stay visible beside local observations. No official weighted or final course grade is inferred."),
    el("div", undefined, { class: "grade-honesty", role: "note" }, [
      el("strong", "Graded points are not a final course grade."),
      el("details", undefined, { class: "grade-honesty__details" }, [
        el("summary", "About grade observations"),
        el("p", "A local observation is the selected value until you change or remove it; Canvas score and grade remain visible alongside it. Progress indicators use Canvas points only, and coverage and unknown group data stay visible."),
      ]),
    ]),
    el("section", undefined, { class: "grade-summary-grid", "aria-label": "Course grade summaries" }, summary.length === 0 ? [empty(courseworkVerified ? "No active Canvas courses were found." : "Coursework could not be verified. Refresh to check courses.")] : summary),
    el("section", undefined, { class: "controls grade-controls", "aria-label": "Gradebook controls" }, [
      el("div", undefined, { class: "segmented", "aria-label": "Grade filters" }, (["all", "graded"] as const).map((mode) => ({ tag: "button", attrs: { type: "button", class: state.gradeMode === mode ? "active" : "", "aria-pressed": String(state.gradeMode === mode) }, text: mode === "all" ? "All records" : "Graded only", on: { click: () => handlers.onGradeMode(mode) } }))),
      el("div", undefined, { class: "filters", "aria-label": "Grade course filters" }, [{ tag: "button", attrs: { type: "button", class: `filter ${state.gradeCourseFilter === "all" ? "active" : ""}`, "aria-pressed": String(state.gradeCourseFilter === "all") }, text: "All courses", on: { click: () => handlers.onGradeCourseFilter("all") } }, ...courses.map((course) => ({ tag: "button", attrs: { type: "button", class: `filter ${key(state.gradeCourseFilter) === key(course.courseCode) ? "active" : ""}`, "aria-pressed": String(key(state.gradeCourseFilter) === key(course.courseCode)), style: `--course-color:${color(courses, course.courseCode)}` }, text: code(course.courseCode), on: { click: () => handlers.onGradeCourseFilter(course.courseCode) } }))]),
    ]),
    table,
  ]);
}
