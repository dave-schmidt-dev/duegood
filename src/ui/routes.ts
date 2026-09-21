import type { ElementDescriptor } from "./dom";

export interface RouteDescriptor { readonly path: string; readonly label: string }
export const PHASE_1_ROUTES: readonly RouteDescriptor[] = [{ path: "/", label: "This Week" }];

export type DashboardPage = "timeline" | "grades" | "inbox" | "completed" | "courses" | "library" | "activity" | "more";
export interface DashboardRoute { readonly page: DashboardPage; readonly label: string; readonly icon: string }
export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  { page: "timeline", label: "Timeline", icon: "│" },
  { page: "grades", label: "Grades", icon: "▦" },
  { page: "inbox", label: "Inbox", icon: "✉" },
  { page: "completed", label: "Done", icon: "✓" },
  { page: "courses", label: "Courses", icon: "◫" },
  { page: "library", label: "Library", icon: "≡" },
  { page: "activity", label: "Activity", icon: "↻" },
  { page: "more", label: "More", icon: "•••" },
];

/** Legacy one-route navigation retained for the disconnected phase-1 page contract. */
export function primaryNav(currentPath: string): ElementDescriptor {
  return { tag: "nav", attrs: { class: "primary-nav", "aria-label": "Primary" }, children: [{
    tag: "ul", children: PHASE_1_ROUTES.map((route) => ({ tag: "li", children: [{
      tag: "a", attrs: { href: route.path, ...(route.path === currentPath ? { "aria-current": "page" } : {}) }, text: route.label,
    }] })),
  }] };
}

export function dashboardNav(currentPage: DashboardPage, onNavigate: (page: DashboardPage) => void): ElementDescriptor {
  return { tag: "nav", attrs: { class: "nav", "aria-label": "Primary" }, children: DASHBOARD_ROUTES.map((route) => ({
    tag: "a",
    attrs: { href: `#${route.page}`, class: route.page === currentPage ? "active" : "", ...(route.page === currentPage ? { "aria-current": "page" } : {}) },
    on: { click: (event) => { event.preventDefault(); onNavigate(route.page); } },
    children: [{ tag: "span", attrs: { class: "nav-icon", "aria-hidden": "true" }, text: route.icon }, { tag: "span", text: route.label }],
  })) };
}
