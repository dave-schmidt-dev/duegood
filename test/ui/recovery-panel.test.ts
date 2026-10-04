import { describe, expect, it, vi } from "vitest";
import { desktopStoreStatusPanel } from "../../src/ui/desktop-setup";
import { desktopRecoveryPanel } from "../../src/ui/components/recovery-panel";
import type { ElementDescriptor } from "../../src/ui/dom";

function textOf(node: ElementDescriptor): string {
  return [node.text ?? "", ...(node.children ?? []).map(textOf)].join(" ");
}

function nodes(node: ElementDescriptor): readonly ElementDescriptor[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe("desktop recovery feedback", () => {
  it("keeps a known legacy import visible while snapshots are loading without claiming the list is empty", () => {
    const panel = desktopRecoveryPanel({ snapshots: [], importedAt: "2026-10-01T12:00:00Z", busy: false, loading: true }, { onRestore: vi.fn(), onExport: vi.fn() }, Date.parse("2026-10-01T13:00:00Z"));
    expect(textOf(panel)).toContain("Legacy import · today");
    expect(textOf(panel)).toContain("Finding recovery points…");
    expect(textOf(panel)).not.toContain("No recovery points are available yet.");
    expect(nodes(panel).find((node) => node.text === "Finding recovery points…")?.attrs).toMatchObject({ role: "status", "aria-busy": "true" });
    const loadingList = nodes(panel).find((node) => node.tag === "ol");
    expect(nodes(loadingList!).some((node) => node.attrs?.role === "status" || node.attrs?.role === "alert")).toBe(false);
  });

  it("shows an error retry, then reports an actual empty response", () => {
    const retry = vi.fn();
    const failed = desktopRecoveryPanel({ snapshots: [], importedAt: null, busy: false, error: "Could not read recovery points." }, { onRestore: vi.fn(), onExport: vi.fn(), onRetry: retry });
    const retryButton = nodes(failed).find((node) => node.text === "Retry recovery points");
    expect(retryButton?.attrs?.class).toBe("more-action");
    expect(textOf(failed)).toContain("Could not read recovery points.");
    const failedList = nodes(failed).find((node) => node.tag === "ol");
    expect(nodes(failedList!).some((node) => node.attrs?.role === "alert")).toBe(false);
    expect(textOf(failedList!)).not.toContain("No recovery points are available yet.");
    expect(retryButton?.on?.click).toBeDefined();
    retryButton!.on!.click!(new Event("click"));
    expect(retry).toHaveBeenCalledOnce();

    const empty = desktopRecoveryPanel({ snapshots: [], importedAt: null, busy: false }, { onRestore: vi.fn(), onExport: vi.fn() });
    expect(textOf(empty)).toContain("No recovery points are available yet.");
  });

  it("uses shared action classes for main recovery controls while leaving confirmation controls intact", () => {
    const snapshot = { id: "daily-20261001T120000Z-0123abcd", createdAt: "2026-10-01T12:00:00Z", kind: "daily" as const };
    const panel = desktopRecoveryPanel({ snapshots: [snapshot], importedAt: null, busy: false, pendingRestoreId: snapshot.id }, { onRestore: vi.fn(), onConfirmRestore: vi.fn(), onCancelRestore: vi.fn(), onExport: vi.fn(), onBack: vi.fn() });
    expect(button(panel, "Restore snapshot")?.attrs?.class).toBe("more-action");
    expect(button(panel, "Export rollback folder…")?.attrs?.class).toBe("more-action");
    expect(button(panel, "Back to dashboard")?.attrs?.class).toBe("setup-secondary");
    expect(button(panel, "Cancel")?.attrs?.class).toBe("setup-secondary");
    expect(button(panel, "Restore selected snapshot")?.attrs?.class).toBe("sync-button");
  });

  it("requires an explicit, cancellable confirmation before a selected snapshot is restored", () => {
    const onRestore = vi.fn();
    const onConfirmRestore = vi.fn();
    const onCancelRestore = vi.fn();
    const snapshot = { id: "daily-20261001T120000Z-0123abcd", createdAt: "2026-10-01T12:00:00Z", kind: "daily" as const };
    const selected = desktopRecoveryPanel({ snapshots: [snapshot], importedAt: null, busy: false, pendingRestoreId: snapshot.id }, { onRestore, onConfirmRestore, onCancelRestore, onExport: vi.fn() });
    expect(nodes(selected).find((node) => node.attrs?.role === "dialog")?.attrs).toMatchObject({ "aria-label": "Confirm snapshot restore" });
    expect(textOf(selected)).toContain("archives the current app store before restoring this recovery point");
    expect(textOf(selected).match(/Existing backups are never deleted\./g)).toHaveLength(1);
    button(selected, "Cancel")?.on?.click?.(new Event("click"));
    expect(onCancelRestore).toHaveBeenCalledOnce();
    expect(onRestore).not.toHaveBeenCalled();
    button(selected, "Restore selected snapshot")?.on?.click?.(new Event("click"));
    expect(onConfirmRestore).toHaveBeenCalledOnce();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("keeps the selected restore intent visible while restore feedback is busy", () => {
    const snapshot = { id: "daily-20261001T120000Z-0123abcd", createdAt: "2026-10-01T12:00:00Z", kind: "daily" as const };
    const busy = desktopRecoveryPanel({ snapshots: [snapshot], importedAt: null, busy: true, pendingRestoreId: snapshot.id }, { onRestore: vi.fn(), onConfirmRestore: vi.fn(), onCancelRestore: vi.fn(), onExport: vi.fn() });
    expect(button(busy, "Restoring selected snapshot…")?.attrs).toMatchObject({ disabled: "", "aria-busy": "true" });
    expect(button(busy, "Cancel")?.attrs?.disabled).toBe("");
  });

  it("renders immediate store feedback and a retry after a failed read", () => {
    const retry = vi.fn();
    expect(textOf(desktopStoreStatusPanel({ loading: true }, { onRetry: retry }))).toContain("Checking the local app store…");
    const failed = desktopStoreStatusPanel({ error: "Native store unavailable." }, { onRetry: retry });
    const button = nodes(failed).find((node) => node.text === "Retry");
    expect(textOf(failed)).toContain("Native store unavailable.");
    expect(button?.on?.click).toBeDefined();
    button!.on!.click!(new Event("click"));
    expect(retry).toHaveBeenCalledOnce();
  });
});

function button(node: ElementDescriptor, text: string): ElementDescriptor | undefined {
  return nodes(node).find((item) => item.tag === "button" && item.text === text);
}
