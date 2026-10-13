# Due Good motif designs: incorporation guide

Package date: 2026-10-12. Status: not integrated. Nothing under `src/`, `src/ui/styles/`, or `src-tauri/` references these motifs yet; this README is the implementation contract for the four owner-approved Due Good glyphs.

The package is the owner-approved motif set exported from the comparison gallery (`#app-7`, recorded in [approved.json](./approved.json)): four single-ink SVG glyphs, one animated, each with a 20 px and 64 px dark asset, a template, and a contact-sheet frame. The Due Good and Argus options were accepted 2026-10-11 and are unchanged; this package was signed off 2026-10-12. `verify.json` (shipped beside this file) records the export-to-page pixel match.

## Approved elements

| id | title | owner's approved option (`ownerSelection`) | kind | sizes | multicolor | primary asset |
| --- | --- | --- | --- | --- | --- | --- |
| `refresh-book-trace` | Refresh in progress: open book with a gently traced page | accepted 2026-10-11 (Due Good/Argus) | animated | 20, 64 | no | `assets/refresh-book-trace-64-dark.svg` |
| `timeline-navigation-book-spine` | Timeline navigation: book spine with dated timeline dots | accepted 2026-10-11 (Due Good/Argus) | static | 20, 64 | no | `assets/timeline-navigation-book-spine-64-dark.svg` |
| `library-navigation-stacked-books` | Library navigation: stacked books with a bookmark | accepted 2026-10-11 (Due Good/Argus) | static | 20, 64 | no | `assets/library-navigation-stacked-books-64-dark.svg` |
| `mark-complete-notebook-check` | Mark complete action: notebook check | accepted 2026-10-11 (Due Good/Argus) | static | 20, 64 | no | `assets/mark-complete-notebook-check-64-dark.svg` |

No stock picks ship in this package; all four choices carry SVG assets. Every element is `multicolor: false` with one ink, `#b08d57` (`inkColors`). Both sizes use `viewBox="0 0 64 64"`, `displayPx` 20x20 and 64x64, `outsideViewBox: false`, and `markup: "own markup"` (do not derive the 20 px form by scaling). Themes: `["dark"]` only; `colors[].light` is null and no light assets exist.

## Where each element goes

The UI stack is a Tauri 2 WebView frontend written as plain TypeScript descriptor trees. `ElementDescriptor` (src/ui/dom.ts:6) is converted to DOM by `render()` (src/ui/dom.ts:23), bundled by esbuild (scripts/build-ui.mjs:37) into `dist/public`, which Tauri serves (src-tauri/tauri.conf.json:8). The stylesheet is the concatenation of `tokens.css`, `shell.css`, and `components.css` (scripts/build-ui.mjs:29). The app is dark-only (src/ui/styles/tokens.css:2, `color-scheme: dark`).

### refresh-book-trace (animated)

- Replaces the current refreshing spinner: `.refresh-button.refreshing::before` (src/ui/styles/components.css:9, keyframes at src/ui/styles/components.css:10). It is rendered from `refreshButton` (src/ui/pages/dashboard.ts:760) whenever `state.refreshState === "running"` (src/ui/pages/dashboard.ts:754).
- The adjacent status copy is built by `refreshNote` (src/ui/pages/dashboard-refresh.ts:24) and `refreshActionLabel` (src/ui/pages/dashboard-refresh.ts:8).
- 20 px: inline in the refresh button. 64 px: new surface, no current call site. The likely host is the Activity page refresh evidence panel (`activityPage`, src/ui/pages/dashboard.ts:562) or a standalone refresh status card.

### timeline-navigation-book-spine (static)

- Replaces the Timeline nav glyph `"│"` in `DASHBOARD_ROUTES` (src/ui/routes.ts:6), rendered as the decorative `.nav-icon` span in `dashboardNav` (src/ui/routes.ts:21) and styled at src/ui/styles/shell.css:26. That slot is 19 px wide, so use the 20 px asset.
- 64 px: new surface, no current call site. The likely host is the Timeline hero (src/ui/pages/dashboard.ts:337) or the no-courses empty state (src/ui/pages/dashboard.ts:339).

### library-navigation-stacked-books (static)

- Replaces the Library nav glyph `"≡"` (src/ui/routes.ts:11) through the same `.nav-icon` render path (src/ui/routes.ts:21).
- 64 px: new surface, no current call site. The likely host is the Library heading (`renderLibraryPage`, src/ui/pages/dashboard-library.ts:43) or its empty state (src/ui/pages/dashboard-library.ts:25).

### mark-complete-notebook-check (static)

- Completion glyph for the existing completion controls: `completionButton` ("Mark complete" / "Mark not done", src/ui/pages/dashboard.ts:158) used by timeline cards (src/ui/pages/timeline-event-card.ts:42) and the Completed page (src/ui/pages/dashboard.ts:348); `completionCheckbox` ("Done", src/ui/pages/dashboard.ts:164) used by timeline cards (src/ui/pages/timeline-event-card.ts:35); and `railCompletionCheckbox` (src/ui/pages/dashboard.ts:257).
- The native checkboxes are styled with `accent-color` (src/ui/styles/components.css:112, src/ui/styles/components.css:53). Keep the `input` as the interactive control and apply the glyph as its visual mark; do not replace the checkbox with a non-focusable image.
- 64 px: new surface, no current call site. The likely host is the Completed page heading (src/ui/pages/dashboard.ts:346) or its empty state.

## How to implement

### Stack and asset handling

- This is not a SwiftUI/AppKit app, so there is no asset catalog, `systemImage:`, or SF Symbol step. The equivalent here is an SVG file consumed by the WebView.
- `scripts/build-ui.mjs` currently writes only `index.html`, `app.css`, and `app.js` (scripts/build-ui.mjs:48). No frontend asset copy exists. Add a copy step that places the approved SVGs into `dist/public` (for example `dist/public/motifs/`, proposed new output, not an existing path), and reference them by URL from the descriptors. Do not hand-edit `dist/`.
- `render()` uses `document.createElement` (src/ui/dom.ts:24), which creates HTML-namespace nodes. The simplest compliant path is `<img>` descriptors for the flattened `-dark.svg` assets (paints are already inlined) or a `span` with CSS `mask-image` pointing at the `-template.svg` when the ink must follow a token. Do not inject SVG markup as innerHTML; `ElementDescriptor.text` is applied via `textContent` (src/ui/dom.ts:26).

### Ink mapping

- Every layer of every element is dark `#b08d57` with gallery variable `--accent`. In this repo the documented token `color-classic-gold` is exactly `#B08D57` (docs/DESIGN-SYSTEM.md:43), so that is the mapping.
- Flag: the live CSS token `--color-classic-gold` currently aliases `--gold` (src/ui/styles/tokens.css:27), whose value is `#d2ad72` (src/ui/styles/tokens.css:12), not the documented `#B08D57`. Choose one with the owner: tint templates with `var(--gold)` / `var(--color-classic-gold)` for token consistency, or use the flattened assets whose baked-in ink is exactly `#b08d57`. Do not add or change a color token as part of motif incorporation; that is a separate design-system decision.
- There is no second theme to wire. Use only `-dark.svg` assets.

### Static elements (timeline nav, library nav, mark complete)

- Use `assets/<id>-20-dark.svg` for the nav and inline checkbox/button slots and `assets/<id>-64-dark.svg` only where a 64 px presentation exists. Never scale the 64 px asset down to 20 px; the 20 px asset is its own drawing.
- Use `assets/<id>-20-template.svg` / `assets/<id>-64-template.svg` only when CSS-controlled tint is required (black ink on transparent, masks keep their white/black). Tint with the app's existing `--gold`/`--color-classic-gold` accent; for completion controls the existing per-course accent is `--course-color` (src/ui/styles/components.css:112), which is a different, per-course color, so use gold for the motif and keep `--course-color` for the control's accent as today.
- Nav icons stay inside the existing `aria-hidden="true"` `.nav-icon` span so the visible route label remains the accessible name; the precedent is src/ui/routes.ts:21.

### Animated element (refresh-book-trace)

- Motion record: `cycleMs` 2000, `drivenBy: "css"`, one animation named `trace` targeting `path.trace` with keyframes `strokeDashoffset: 0px` at offset 0 and `-34px` at offset 1, timing `linear`, `infinite`, no delay, direction `normal`.
- Re-create it as a CSS keyframe rule on the traced path (for example `animation: duegood-book-trace 2000ms linear infinite;`). The exporter strips classes and data attributes from the flattened assets, so re-add a stable hook (class or attribute) to the path that carries the trace before targeting it. The existing spinner precedent is `@keyframes duegood-spin` at src/ui/styles/components.css:10.
- It is indeterminate activity only. Never bind it to `refreshProgress`, counts, percentage, or completion; the button's text and `aria-busy` (src/ui/pages/dashboard.ts:760) already state the real refresh state.
- Reduce motion: show the settled frame, which is the flattened SVG. The repo already has reduce-motion handling at src/ui/styles/shell.css:62 and src/ui/styles/components.css:11; keep the animation suppressed there.
- Visual acceptance reference: `frames/refresh-book-trace-dark.png`. Frames were captured at seed 0 (true cycle times); for this app the gallery used the generic `Animation.currentTime` seek over every document animation rather than `window.designReview.seek`.

### Accessibility

- Standalone use: give the glyph `role="img"` and `aria-label` equal to the element's `a11yLabel` (for example "Refresh in progress: open book with a gently traced page"). `a11yLabelSource` is the gallery title; the page SVG had no `aria-label`.
- Decorative use: hide the glyph with `aria-hidden="true"` and keep the host control's existing name. This applies inside the refresh button (text plus `aria-busy`), inside the nav links (visible route label), and beside the completion checkboxes (existing `aria-label` "Done" or "Mark ... done", src/ui/pages/dashboard.ts:166, src/ui/pages/dashboard.ts:261).

### Element-specific caveats recorded in approved.json

- All four elements: single dark surface; single ink; `themeNote` says light is not exported; `outsideViewBox: false`, so no overflow padding is needed when used as a standalone image.
- `refresh-book-trace`: reduced motion removes the animation, and the settled `.active` dash pattern stays at offset 0. The 20 px check mirror on the gallery page had no `.active` class, so its trace lines are solid; treat the 20 px refresh asset as a static glyph, not an animated one. Its `motion` has no phases and no design-contract times.
- No element records omitted runtime text, `overflow="visible"` geometry, a resized-markup 20 px form, `drivenBy: "js"`, or a `notExportedAsSvg` entry; every motif asset is SVG and the frames are PNG reference captures.

## Acceptance checks for the implementer

Test setup: descriptor contract tests are Vitest under `test/ui/` (vitest.ui.config.ts includes `test/ui/**/*.test.ts`, run `npm run test:ui`; helpers in test/ui/descriptor-test-helpers.ts). Rendered UI tests are Playwright under `test/native/playwright/` (testDir in playwright.config.ts, run `npm run test:desktop-ui`). Accessibility automation is `automaticAccessibilityViolations` (test/native/playwright/a11y.ts:4).

- Render coverage per element: descriptor assertions at the call sites above for both sizes and the only shipped theme (dark), for example an `<img>`/mask descriptor with the right `src`, size class, and hidden/role attributes. Add to the existing nav contract test (test/ui/dashboard.test.ts:47) for the two nav glyphs and to the completion tests for the check glyph; there is no existing visual snapshot harness, so use the descriptor tests plus the frames as the visual reference.
- Reduced motion: emulate with `page.emulateMedia({ reducedMotion: "reduce" })` (precedent at test/native/playwright/dashboard-view-state.spec.ts:133) and assert the settled glyph is shown and no animation is running.
- Accessibility label: assert `role="img"` plus `aria-label` equal to `a11yLabel` for meaningful placements, and `aria-hidden` for decorative placements; run `automaticAccessibilityViolations` on the Timeline, Library, and topbar surfaces.
- Animated frame checks: seek every document animation to a few `sampleTimesMs` values (0, 500, 1000, 2000; the full list is `[0, 250, 500, 1000, 1500, 1900, 1999, 2000]` in approved.json) via `document.getAnimations()`, and compare against `frames/refresh-book-trace-dark.png`. Settled assets match within 2 channel levels per verify.json; the compositor-transform edge-pixel caveat in verify.json names other apps' elements (Gradus, WWPIS, Pantry, Argus), not this stroke animation.
- Keep per-change verification scoped to the descriptor tests and targeted Playwright specs. Screen-seizing UI automation (`npm run test:desktop-ui`, wired into `test:all` at package.json:46) is a release-milestone step, not a per-change requirement.

## Asset inventory

- `refresh-book-trace`: `assets/refresh-book-trace-20-dark.svg`, `assets/refresh-book-trace-64-dark.svg`, `assets/refresh-book-trace-20-template.svg`, `assets/refresh-book-trace-64-template.svg`, `frames/refresh-book-trace-dark.png`
- `timeline-navigation-book-spine`: `assets/timeline-navigation-book-spine-20-dark.svg`, `assets/timeline-navigation-book-spine-64-dark.svg`, `assets/timeline-navigation-book-spine-20-template.svg`, `assets/timeline-navigation-book-spine-64-template.svg`, `frames/timeline-navigation-book-spine-dark.png`
- `library-navigation-stacked-books`: `assets/library-navigation-stacked-books-20-dark.svg`, `assets/library-navigation-stacked-books-64-dark.svg`, `assets/library-navigation-stacked-books-20-template.svg`, `assets/library-navigation-stacked-books-64-template.svg`, `frames/library-navigation-stacked-books-dark.png`
- `mark-complete-notebook-check`: `assets/mark-complete-notebook-check-20-dark.svg`, `assets/mark-complete-notebook-check-64-dark.svg`, `assets/mark-complete-notebook-check-20-template.svg`, `assets/mark-complete-notebook-check-64-template.svg`, `frames/mark-complete-notebook-check-dark.png`
- Package level: `approved.json` (element, color, motion, and asset record) and `verify.json` (pixel-match evidence for the swapped-in exports).
