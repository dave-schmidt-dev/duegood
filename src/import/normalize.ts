/** A field's presence state as Canvas actually reports it. Plain `null` can't distinguish "Canvas
 * returned null" from "Canvas omitted this field" from "this Canvas instance doesn't support the
 * field at all" — collapsing any of those to null would let a real value regress to unknown
 * without anyone noticing, or a permanently-unsupported field be retried forever. */
export type SourceField<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "known_null" }
  | { readonly state: "not_returned" }
  | { readonly state: "unsupported" };

/** The state tag alone, independent of `T` — for callers (e.g. a `source_items` column) that
 * persist which of the four states applied without also carrying a value. */
export type FieldState = SourceField<unknown>["state"];

export function knownField<T>(value: T): SourceField<T> {
  return { state: "known", value };
}

export function knownNullField<T = never>(): SourceField<T> {
  return { state: "known_null" };
}

export function notReturnedField<T = never>(): SourceField<T> {
  return { state: "not_returned" };
}

export function unsupportedField<T = never>(): SourceField<T> {
  return { state: "unsupported" };
}

/** True only when the field is a real, present value — the one state a caller can safely act on
 * as "the student submitted this" / "this has a grade" / etc. Every other state must read as
 * unknown/unsupported, never as a false negative. */
export function isKnownValue<T>(field: SourceField<T>): field is { state: "known"; value: T } {
  return field.state === "known";
}

/**
 * Reads one field out of a raw Canvas JSON object. `supported` is a fact about the institution's
 * Canvas instance/API version (known out of band, e.g. per course from a config or capability
 * probe), not something a single record's JSON can express — so it's the caller's job to decide
 * whether the field is supported at all before this ever looks at `raw`. When unsupported, the
 * result is always `unsupported` regardless of what `raw` contains, since Canvas can't be trusted
 * to omit a field consistently once it's unrequested/unavailable. When supported, an absent key
 * reads as `not_returned` and a JSON `null` reads as `known_null` — the two are never conflated.
 */
export function readSourceField<T>(raw: Record<string, unknown>, key: string, supported: boolean): SourceField<T> {
  if (!supported) return unsupportedField<T>();
  if (!(key in raw)) return notReturnedField<T>();
  const value = raw[key];
  if (value === null) return knownNullField<T>();
  return knownField(value as T);
}
