import type { ElementDescriptor } from "./dom";

/**
 * The full phase-1 route table — one entry. Every other destination in the mockup's navigation IA
 * (Timeline, Needs Attention, Courses, Completed, Search, Settings) is deferred past phase 1 and
 * must never appear here, even disabled — see `docs/DESIGN-SYSTEM.md`'s Navigation inventory and
 * the Task 1.5 "navigation test contains only available phase-1 destinations" done-when bullet.
 */
export interface RouteDescriptor {
  readonly path: string;
  readonly label: string;
}

export const PHASE_1_ROUTES: readonly RouteDescriptor[] = [{ path: "/", label: "This Week" }];

/** Same markup at every breakpoint — `shell.css` repositions it (sidebar vs. bottom tab bar) via
 * media queries, not a different component, per the Responsive shell section's "same component
 * set at every size". */
export function primaryNav(currentPath: string): ElementDescriptor {
  return {
    tag: "nav",
    attrs: { class: "primary-nav", "aria-label": "Primary" },
    children: [
      {
        tag: "ul",
        children: PHASE_1_ROUTES.map((route) => ({
          tag: "li",
          children: [
            {
              tag: "a",
              attrs: {
                href: route.path,
                ...(route.path === currentPath ? { "aria-current": "page" } : {}),
              },
              text: route.label,
            },
          ],
        })),
      },
    ],
  };
}
