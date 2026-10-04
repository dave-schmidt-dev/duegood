import type { ElementDescriptor } from "../dom";
import type { DashboardCourse, DashboardHandlers, DashboardState } from "./dashboard";

export interface LibraryPageRenderers {
  readonly el: (tag: string, text?: string, attrs?: Record<string, string>, children?: readonly ElementDescriptor[]) => ElementDescriptor;
  readonly heading: (eyebrow: string, title: string, copy: string, count?: string) => ElementDescriptor;
  readonly empty: (text: string) => ElementDescriptor;
  readonly safeLocalHref: (value: string | null | undefined) => string | undefined;
  readonly formatted: (value: string | number | null | undefined, withTime?: boolean) => string;
  readonly code: (value: string) => string;
  readonly color: (courses: readonly DashboardCourse[], courseCode: string) => string;
}

/** Renders resource actions beside the Library item they affect. */
export function renderLibraryPage(state: DashboardState, handlers: DashboardHandlers, renderers: LibraryPageRenderers): ElementDescriptor {
  const { el, heading, empty, safeLocalHref, formatted, code, color } = renderers;
  const types = ["all", "File", "Page", "Link", "Module", "Announcement"];
  const resources = state.data.resources.filter((item) => state.resourceFilter === "all" || item.type.toLowerCase() === state.resourceFilter.toLowerCase());
  const toolbar = el("div", undefined, { class: "resource-toolbar" }, [
    el("div", undefined, { class: "resource-types", "aria-label": "Canvas item types" }, types.map((type) => ({
      tag: "button", attrs: { type: "button", class: state.resourceFilter === type ? "active" : "" }, text: type === "all" ? "All" : `${type}s`, on: { click: () => handlers.onResourceFilter(type) },
    }))),
  ]);
  const list = resources.length === 0
    ? empty(state.data.resources.length === 0 ? "Canvas library items have not been synced yet." : "No Canvas items match this filter.")
    : el("div", undefined, { class: "resource-list" }, resources.map((resource) => {
      const href = safeLocalHref(resource.localUrl);
      const feedback = state.resourceActions?.[resource.id];
      const pending = feedback?.status === "pending";
      return el("article", undefined, { class: "resource-row", style: `--course-color:${color(state.data.courses, resource.courseCode)}` }, [
        el("span", resource.type, { class: "resource-type" }),
        el("div", undefined, undefined, [
          el("h2", resource.title, { class: "resource-title" }),
          el("p", `${code(resource.courseCode)}${resource.context ? ` · ${resource.context}` : ""}`, { class: "resource-meta" }),
          ...(feedback === undefined ? [] : [el("p", feedback.message, { class: "resource-action-feedback", role: "status", "aria-live": "polite", "data-resource-action": resource.id })]),
        ]),
        el("time", formatted(resource.updatedAt, true), { class: "resource-updated" }),
        ...(resource.savedLocally === true && handlers.onOpenResource !== undefined
          ? [{ tag: "button", attrs: { type: "button", class: "more-action", ...(pending ? { disabled: "", "aria-busy": "true" } : {}) }, text: pending ? "Opening…" : "Open or save", on: { click: () => handlers.onOpenResource?.(resource.id) } }]
          : href !== undefined ? [el("a", "Open", { class: "more-action", href })] : resource.savedLocally === true ? [el("span", "Saved locally", { class: "resource-saved" })] : [el("span", "No local copy", { class: "resource-unavailable" })]),
      ]);
    }));
  return el("section", undefined, { class: "page" }, [heading("Imported from Canvas", "Library", "Files, pages, links, modules, and announcements from your courses.", `${resources.length} items`), toolbar, list]);
}
