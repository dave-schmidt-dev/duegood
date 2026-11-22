function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Copies canonical assignment rubric data onto graded discussion topics.
 * @param {Array<Record<string, unknown>>} topics Discussion topics from Canvas.
 * @param {Array<Record<string, unknown>>} assignments Canonical course assignment rows.
 * @returns {{items: Array<Record<string, unknown>>, assignments: Array<Record<string, unknown>>, unmatchedCount: number, assignmentsUpdated: boolean}} Hydrated topics and unresolved graded links.
 */
export function hydrateDiscussionAssignmentRubrics(topics, assignments) {
  const assignmentsById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  let unmatchedCount = 0;
  let assignmentsUpdated = false;
  const items = topics.map((topic) => {
    const nestedAssignment = isRecord(topic.assignment) ? topic.assignment : null;
    const linked = topic.assignment_id != null || topic.assignment != null;
    if (!linked) return topic;

    if ((topic.assignment_id != null && !positiveId(topic.assignment_id))
        || (nestedAssignment?.id != null && !positiveId(nestedAssignment.id))) {
      unmatchedCount += 1;
      return topic;
    }
    const assignmentId = topic.assignment_id ?? nestedAssignment?.id;
    if (!positiveId(assignmentId)) {
      unmatchedCount += 1;
      return topic;
    }
    if (nestedAssignment && nestedAssignment.id !== undefined
        && nestedAssignment.id !== assignmentId) {
      unmatchedCount += 1;
      return topic;
    }
    const canonical = assignmentsById.get(assignmentId);
    if (!canonical) {
      unmatchedCount += 1;
      return topic;
    }

    const nestedRubric = nestedAssignment?.rubric;
    const nestedHasRubric = Array.isArray(nestedRubric) && nestedRubric.length > 0;
    const canonicalHasRubric = Array.isArray(canonical.rubric) && canonical.rubric.length > 0;
    if (!canonicalHasRubric && nestedHasRubric) {
      canonical.rubric = nestedRubric;
      assignmentsUpdated = true;
    }
    for (const key of ["rubric_settings", "use_rubric_for_grading"]) {
      if (!Object.hasOwn(canonical, key) && nestedAssignment && Object.hasOwn(nestedAssignment, key)) {
        canonical[key] = nestedAssignment[key];
        assignmentsUpdated = true;
      }
    }
    const assignment = { ...(nestedAssignment ?? {}), id: canonical.id };
    assignment.rubric = Array.isArray(canonical.rubric) && canonical.rubric.length > 0
      ? canonical.rubric : null;
    for (const key of ["rubric_settings", "use_rubric_for_grading"]) {
      if (Object.hasOwn(canonical, key)) assignment[key] = canonical[key];
      else delete assignment[key];
    }
    return { ...topic, assignment };
  });
  return { items, assignments, unmatchedCount, assignmentsUpdated };
}
