import { describe, expect, it } from "vitest";
import { compareInventory, type CommittedItem, type FetchedItem } from "../../src/import/compare";

function committed(overrides: Partial<CommittedItem> & Pick<CommittedItem, "canvasItemId">): CommittedItem {
  return { fingerprint: "fp", available: true, ...overrides };
}

function fetchedItem(overrides: Partial<FetchedItem> & Pick<FetchedItem, "canvasItemId">): FetchedItem {
  return { fingerprint: "fp", title: "Title", dueAt: null, dueAtState: "not_returned", submissionState: "unknown", ...overrides };
}

describe("compareInventory", () => {
  it("upserts a new item not previously committed", () => {
    const item = fetchedItem({ canvasItemId: "1", fingerprint: "fp-a" });
    const result = compareInventory([], [item]);
    expect(result).toEqual({ upserts: [item], newlyUnavailableCanvasItemIds: [], anomalous: false });
  });

  it("leaves an unchanged item out of upserts entirely", () => {
    const result = compareInventory(
      [committed({ canvasItemId: "1", fingerprint: "fp-a" })],
      [fetchedItem({ canvasItemId: "1", fingerprint: "fp-a" })],
    );
    expect(result.upserts).toEqual([]);
    expect(result.anomalous).toBe(false);
  });

  it("upserts an item whose fingerprint changed", () => {
    const item = fetchedItem({ canvasItemId: "1", fingerprint: "fp-b" });
    const result = compareInventory([committed({ canvasItemId: "1", fingerprint: "fp-a" })], [item]);
    expect(result.upserts).toEqual([item]);
  });

  it("marks a single genuinely-missing item unavailable in a large course, without flagging anomalous", () => {
    const committedItems: CommittedItem[] = Array.from({ length: 10 }, (_, i) => committed({ canvasItemId: String(i), fingerprint: "fp" }));
    const fetched: FetchedItem[] = committedItems.slice(1).map((item) => fetchedItem({ canvasItemId: item.canvasItemId, fingerprint: item.fingerprint }));
    const result = compareInventory(committedItems, fetched);
    expect(result.anomalous).toBe(false);
    expect(result.newlyUnavailableCanvasItemIds).toEqual(["0"]);
  });

  it("flags anomalous, with no writes, when a large course's available set drops past the ratio", () => {
    const committedItems: CommittedItem[] = Array.from({ length: 10 }, (_, i) => committed({ canvasItemId: String(i), fingerprint: "fp" }));
    const fetched: FetchedItem[] = [fetchedItem({ canvasItemId: "0", fingerprint: "fp" })];
    const result = compareInventory(committedItems, fetched);
    expect(result).toEqual({ upserts: [], newlyUnavailableCanvasItemIds: [], anomalous: true });
  });

  it("flags anomalous when a previously non-empty course now fetches completely empty", () => {
    const result = compareInventory([committed({ canvasItemId: "1", fingerprint: "fp" })], []);
    expect(result.anomalous).toBe(true);
  });

  it("does not flag anomalous for a small course losing most of its items below the ratio floor", () => {
    const committedItems: CommittedItem[] = [
      committed({ canvasItemId: "1", fingerprint: "fp" }),
      committed({ canvasItemId: "2", fingerprint: "fp" }),
      committed({ canvasItemId: "3", fingerprint: "fp" }),
    ];
    const result = compareInventory(committedItems, [fetchedItem({ canvasItemId: "1", fingerprint: "fp" })]);
    expect(result.anomalous).toBe(false);
    expect(result.newlyUnavailableCanvasItemIds).toEqual(["2", "3"]);
  });

  it("never re-marks an already-unavailable item, and ignores it when computing the drop ratio", () => {
    const committedItems: CommittedItem[] = [
      committed({ canvasItemId: "1", fingerprint: "fp" }),
      committed({ canvasItemId: "2", fingerprint: "fp", available: false }),
    ];
    const result = compareInventory(committedItems, [fetchedItem({ canvasItemId: "1", fingerprint: "fp" })]);
    expect(result.newlyUnavailableCanvasItemIds).toEqual([]);
    expect(result.anomalous).toBe(false);
  });

  it("upserts an item that was previously marked unavailable and has now reappeared", () => {
    const committedItems: CommittedItem[] = [committed({ canvasItemId: "1", fingerprint: "fp", available: false })];
    const item = fetchedItem({ canvasItemId: "1", fingerprint: "fp" });
    const result = compareInventory(committedItems, [item]);
    expect(result.upserts).toEqual([item]);
  });
});
