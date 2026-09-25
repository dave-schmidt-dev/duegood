/** Strict, source-neutral projection of native pending provenance reviews. */
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = Record<string, unknown>;
const MAX_PENDING_LINKS = 100;
const MAX_PENDING_CANDIDATES = 20;
const SOURCE_FIELDS = new Set(["kind", "title", "at", "points", "detail", "url", "submissionStatus", "grade", "score", "submittedAt", "gradedAt", "assignmentGroupId", "assignmentGroupName", "assignmentGroupWeight"]);

interface SourceReference {
  readonly institution: string;
  readonly course: string;
  readonly source: "canvas" | "ical" | "manual" | "pdf";
  readonly id: string;
  readonly instance?: string;
}

export interface PendingSourceLink {
  readonly id: string;
  readonly localId: string;
  readonly course: string;
  readonly reference: SourceReference;
  readonly verifiedReferences: readonly SourceReference[];
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly observedAt?: string;
  readonly candidateIds: readonly string[];
  readonly reason: "ambiguous-match" | "conflicting-match";
  readonly needsRefresh?: true;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${label} must be a nonempty string up to ${max} characters`);
  return value;
}

function reference(value: unknown, label: string): SourceReference {
  const candidate = object(value, label);
  const source = candidate.source;
  if (source !== "canvas" && source !== "ical" && source !== "manual" && source !== "pdf") throw new Error(`${label}.source is unsupported`);
  const instance = candidate.instance === undefined ? undefined : text(candidate.instance, `${label}.instance`);
  return { institution: text(candidate.institution, `${label}.institution`), course: text(candidate.course, `${label}.course`), source, id: text(candidate.id, `${label}.id`), ...(instance === undefined ? {} : { instance }) };
}

function key(value: SourceReference): string { return JSON.stringify([value.institution, value.course, value.source, value.id, value.instance ?? null]); }

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(jsonValue);
}

function fields(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const row = object(value, label);
  const checked: Record<string, JsonValue> = {};
  for (const [field, candidate] of Object.entries(row)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(field) || !SOURCE_FIELDS.has(field) || !jsonValue(candidate)) throw new Error(`${label}.${field} is not a declared source fact`);
    checked[field] = candidate;
  }
  return checked;
}

function references(value: unknown, label: string): readonly SourceReference[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((candidate, index) => reference(candidate, `${label}[${index}]`));
}

function candidates(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PENDING_CANDIDATES) throw new Error(`${label} must be a bounded array`);
  const checked = value.map((candidate, index) => text(candidate, `${label}[${index}]`)).sort();
  if (new Set(checked).size !== checked.length) throw new Error(`${label} must be unique`);
  return checked;
}

function observedAt(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a UTC timestamp`);
  return value;
}

function pending(value: unknown, label: string): PendingSourceLink {
  const row = object(value, label);
  const scoped = reference(row.reference, `${label}.reference`);
  const candidateIds = candidates(row.candidateIds, `${label}.candidateIds`);
  if (row.reason !== "ambiguous-match" && row.reason !== "conflicting-match") throw new Error(`${label}.reason is unsupported`);
  if (row.id === undefined) return { id: key(scoped), localId: "", course: scoped.course, reference: scoped, verifiedReferences: [], fields: {}, candidateIds, reason: row.reason, needsRefresh: true };
  const id = text(row.id, `${label}.id`, 1_000);
  if (id !== key(scoped)) throw new Error(`${label}.id does not match its scoped reference`);
  const course = text(row.course, `${label}.course`);
  if (course !== scoped.course) throw new Error(`${label}.course does not match its reference`);
  const time = observedAt(row.observedAt, `${label}.observedAt`);
  return { id, localId: text(row.localId, `${label}.localId`), course, reference: scoped, verifiedReferences: row.verifiedReferences === undefined ? [] : references(row.verifiedReferences, `${label}.verifiedReferences`), fields: fields(row.fields, `${label}.fields`), candidateIds, reason: row.reason, ...(time === undefined ? {} : { observedAt: time }) };
}

export function pendingSourceLinks(document: JsonObject): readonly PendingSourceLink[] {
  if (document.pendingSourceLinks === undefined) return [];
  if (!Array.isArray(document.pendingSourceLinks)) throw new Error("pendingSourceLinks must be an array");
  const links = document.pendingSourceLinks.map((value, index) => pending(value, `pendingSourceLinks[${index}]`));
  if (links.length > MAX_PENDING_LINKS || new Set(links.map((link) => link.id)).size !== links.length) throw new Error("pending source links have duplicate or excessive identities");
  return links;
}
