import type { CanvasRubric, CanvasRubricCriterion, CanvasRubricRating, CanvasRubricSettings } from "../db/types";
export type { CanvasRubric } from "../db/types";

type JsonObject = Record<string, unknown>;
const MAX_CRITERIA = 100_000;
const MAX_RATINGS = 100_000;
const MAX_TEXT_LENGTH = 32 * 1024 * 1024;

/** Returns undefined for old records that never captured rubric state, and null for known absence. */
export function parseCanvasRubric(value: unknown): CanvasRubric | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const rubric = object(value, "item.rubric");
  const criteria = array(rubric.criteria, "item.rubric.criteria");
  if (criteria.length > MAX_CRITERIA) throw new Error("item.rubric.criteria exceeds the limit");
  const settings = rubric.settings === null || rubric.settings === undefined ? null : parseSettings(rubric.settings);
  return {
    criteria: criteria.map(parseCriterion),
    settings,
    useForGrading: nullableBoolean(rubric.useForGrading, "item.rubric.useForGrading"),
  };
}

function parseCriterion(value: unknown): CanvasRubricCriterion {
  const criterion = object(value, "item.rubric.criteria entry");
  const ratings = array(criterion.ratings, "item.rubric.criteria.ratings");
  if (ratings.length > MAX_RATINGS) throw new Error("item.rubric.criteria.ratings exceeds the limit");
  return {
    id: criterion.id === null || typeof criterion.id === "string" || typeof criterion.id === "number" ? criterion.id : null,
    description: text(criterion.description, "item.rubric.criteria.description"),
    longDescription: text(criterion.longDescription ?? criterion.long_description, "item.rubric.criteria.longDescription"),
    points: numeric(criterion.points, "item.rubric.criteria.points"),
    ratings: ratings.map(parseRating),
  };
}

function parseRating(value: unknown): CanvasRubricRating {
  const rating = object(value, "item.rubric.criteria.rating");
  return {
    description: text(rating.description, "item.rubric.criteria.rating.description"),
    longDescription: text(rating.longDescription ?? rating.long_description, "item.rubric.criteria.rating.longDescription"),
    points: numeric(rating.points, "item.rubric.criteria.rating.points"),
  };
}

function parseSettings(value: unknown): CanvasRubricSettings {
  const settings = object(value, "item.rubric.settings");
  return {
    title: text(settings.title, "item.rubric.settings.title"),
    pointsPossible: numeric(settings.pointsPossible, "item.rubric.settings.pointsPossible"),
    freeFormCriterionComments: nullableBoolean(settings.freeFormCriterionComments, "item.rubric.settings.freeFormCriterionComments"),
  };
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new Error(`${label} must be bounded text or null`);
  return value;
}

function numeric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number or null`);
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean or null`);
  return value;
}
