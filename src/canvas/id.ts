type CanvasId = string;

export interface CanvasIdResult {
  readonly status: "safe" | "unsafe";
  readonly id?: CanvasId;
}

/**
 * Canvas ids arrive as a JSON number on most endpoints. Standard `JSON.parse` (which
 * `Response.json()` uses) silently rounds any integer literal above `Number.MAX_SAFE_INTEGER` to
 * the nearest representable double — by the time this function sees a `number`, a value that was
 * ever unsafe is already corrupted, and two different real ids can round to the same double. There
 * is no way to recover the original digits after that point without a custom text-level parser,
 * which is deliberately out of scope for phase 1 (see docs/IMPORT-STRATEGY-DECISION.md): an unsafe
 * id is refused outright, never repaired.
 *
 * A string-form id never loses precision in JSON parsing, but this still refuses one whose
 * magnitude exceeds `Number.MAX_SAFE_INTEGER`: any later, ordinary numeric use of the id
 * (comparison, storage, logging) is one accidental `Number(id)` away from the same collision, and
 * this project does not special-case "safe until touched."
 */
export function parseCanvasId(raw: unknown): CanvasIdResult {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) return { status: "unsafe" };
    return { status: "safe", id: String(raw) };
  }
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) {
    if (!Number.isSafeInteger(Number(raw))) return { status: "unsafe" };
    return { status: "safe", id: raw };
  }
  return { status: "unsafe" };
}
