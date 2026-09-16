# Due Good — Design System (Phase 1)

Text-only token and behavior inventory derived from the user-provided UI mockups (two boards:
brand/IA board and light/dark component board, 2026-09-16). The source PNGs are local creative
references only — never committed (see `.gitignore`) and never shipped as app assets. This
document is the durable, public record of the visual direction; it is the thing Task 1.5
implements against.

Where the mockup gave an explicit hex value as text, it is used verbatim. Where only a rendered
swatch or screenshot region was visible, the value below was sampled from the image (median of a
small pixel patch, not a single pixel, to avoid anti-aliasing/glare artifacts) and then adjusted
where necessary to pass WCAG AA contrast for its intended use — noted inline. Nothing here is
invented independently of the mockup; adjustments are contrast corrections to an already-chosen
hue, not new color choices.

## Brand

- **Name / wordmark:** "Due Good", set in Playfair Display. Monogram: a navy square/rounded-square
  tile containing a gold open-book glyph ("DG").
- **Tagline:** "Study today. Do good tomorrow." Secondary short form used in compact spaces: "Plan.
  Progress. Do good."
- **Tone:** academic, not institutional; clear, calm, focused; fast and intuitive; accessible to
  all students; honest and transparent; built for real student life. These are behavioral
  constraints, not just copywriting: no gamification pressure, no dark patterns, no invented
  urgency. Sync and completion status must always read as literally true (see States below).

## Typography

| Role | Typeface | Notes |
| --- | --- | --- |
| Headings / brand (`h1`–`h3`, wordmark) | Playfair Display (serif) | Loaded as a licensed local/system-available font per Task 4.1's font strategy; never an unreviewed remote font request in the meantime — fall back to the platform serif stack until that's pinned. |
| UI / body (everything else) | Inter (sans) | System sans fallback stack until Task 4.1 pins the same. |

No decorative type beyond these two roles. No italics-as-emphasis in UI copy; use weight.

## Color tokens

### Brand (explicit in the mockup)

| Token | Hex | Role |
| --- | --- | --- |
| `color-scholar-navy` | `#0E2A47` | Primary brand/action color (light-mode primary button, active nav, primary text on light) |
| `color-classic-gold` | `#B08D57` | Secondary/accent brand color (dark-mode primary button, brand accents) |
| `color-sage` | `#5A6F56` | Tertiary accent, used sparingly (category tag only, never for status) |
| `color-warm-stone` | `#F4EFE6` | Light-mode app background |
| `color-charcoal` | `#1F2937` | Dark-neutral family base; also used as light-mode primary text color where navy would be too saturated for long-form body copy |
| `color-alert-red` | `#D64545` | Single canonical destructive/overdue semantic — see Status below (the mockup's separately-sampled "Overdue" status dot is visually near-identical; using one canonical red avoids two competing error reds) |

### Neutrals (explicit in the mockup)

| Token | Hex | Role |
| --- | --- | --- |
| `color-mist` | `#D7DDE4` | Light-mode borders/dividers, disabled surfaces |
| `color-slate` | `#687280` | Secondary/muted icons, borders, and large-text (≥18px / ≥14px bold) UI labels — see the 4.5:1 text caveat below for body-size text |
| `color-slate-text` | `#646D7B` | Body-size (small) secondary/muted text — a contrast-corrected darkening of `color-slate` for use wherever text is below the large-text threshold |
| `color-ink` | `#0E1620` | Dark-mode app background (sampled from the mockup's rendered dark screens, median-patch; the swatch board's unlabeled fourth "Charcoal" neutral is this same darkest step) |
| `color-ink-surface` | `#16222B` | Dark-mode elevated card/surface background (one step lighter than `color-ink`) |

### Status (sampled from the mockup's status dots, contrast-corrected)

All numbers below were computed directly (sRGB relative-luminance contrast formula, script run
2026-09-16), not estimated — a first pass of this table had transcription errors and was corrected
before this document was treated as final. Status color is **never** the only cue — every status
also carries an icon glyph and a text label (the mockup already does this: calendar/clock/triangle/
check icons plus "Due today" / "This week" / "Overdue" / "Completed" labels).

Each status has up to three forms, because one hue cannot clear every contrast requirement it's put
against:

1. **Fill** — the hue used as an icon-badge circle's background, with a white icon glyph on top.
   Needs ≥3:1 against white (WCAG 1.4.11 non-text). `success` and `warning` needed darkening from
   their as-sampled value to clear this; `overdue`/`info`/`accent` already cleared it as sampled.
2. **Fill-on-light boundary** — the same fill circle's edge against `color-warm-stone` (light-mode
   page/card background), also needs ≥3:1 so the badge shape itself is perceivable, not just its
   glyph. `success` (2.66:1) and `warning` (2.63:1) **fail this** at any fill darkening that still
   clears the white-glyph requirement above — the two constraints pull in opposite directions. Fix:
   every badge gets a 1px `color-charcoal` ring in light mode (charcoal-on-warm-stone is 12.8:1, so
   even a partially-transparent ring clears 3:1 regardless of fill hue). Dark mode doesn't need the
   ring — all five fills already clear 3:1 against both `color-ink` and `color-ink-surface`.
3. **Text** — for a status hue used as text (e.g. a status chip's label) on its own ~12% tint of
   that hue over `color-warm-stone`, darkened further until it clears 4.5:1 against that specific
   tinted background (not just against plain `color-warm-stone`, which is a weaker and wrong test —
   the tint is measurably closer in hue to the text color than the plain background is).

| Token | Fill hex | vs white (badge glyph, ≥3:1) | vs warm-stone (badge boundary, ≥3:1) | Text hex | Tint bg (12% over warm-stone) | Text vs tint (≥4.5:1) |
| --- | --- | --- | --- | --- | --- | --- |
| `color-status-success` | `#2FA860` | 3.05 ✓ | 2.66 ✗ (needs charcoal ring) | `#207241` | `#DCE6D6` | 4.61 ✓ |
| `color-status-warning` | `#CE8509` (darkened from sampled `#E5940A`) | 3.01 ✓ | 2.63 ✗ (needs charcoal ring) | `#8E5C06` | `#F2E4CC` | 4.55 ✓ |
| `color-status-overdue` | `#D64545` (= `color-alert-red`) | 4.38 ✓ | 3.82 ✓ | `#AF3939` | `#F0DBD3` | 4.55 ✓ |
| `color-status-info` | `#2F6FEB` | 4.57 ✓ | 3.99 ✓ | `#275DC5` | `#DCE0E7` | 4.59 ✓ |
| `color-status-accent` | `#7C4DFF` | 4.81 ✓ | 4.20 ✓ | `#6C43DE` | `#E6DCE9` | 4.51 ✓ |

Dark mode: all five **fill** hexes render a white glyph at ≥12.4:1 on a 16%-over-`color-ink-surface`
tint background (checked: success 12.8, warning 12.5, overdue 14.0, info 13.7, accent 13.9), so dark
mode uses the fill hex directly as both fill and tint-text color (white text) with no separate
darkened "text" variant needed.

**Phase-1 scope note:** the This Week page's Assignment row primitive (see Primitives below) has no
chip/badge slot in phase 1 — due date renders as plain text, not a colored chip — so none of the
above boundary/fill/text distinctions are actually on screen yet. They're specified now because
`docs/DESIGN-SYSTEM.md` is the durable forward record for Phase 4 (Tag chip on Courses, Status chip
on Timeline/Needs Attention), the same pattern already used for the full navigation IA below.

### Verified contrast pairs (WCAG AA, 4.5:1 body text / 3:1 large text & UI)

- `color-scholar-navy` on `color-warm-stone`: 12.7:1
- white on `color-scholar-navy` (primary button, light mode): 14.6:1
- `color-charcoal` on `color-warm-stone`: 12.8:1
- `color-slate` on `color-warm-stone`: 4.26:1 — **fails 4.5:1 body-text AA.** Passes the 3:1
  large-text/UI-component threshold, so `color-slate` stays valid for icons, borders, and large
  (≥18px / ≥14px-bold) text; body-size secondary text must use `color-slate-text` (`#646D7B`,
  4.57:1) instead.
- white on `color-ink` (dark mode primary text): 18.2:1
- `color-mist` on `color-ink` (dark mode secondary text): 13.3:1
- `color-classic-gold` on `color-ink` (primary button, dark mode): 5.9:1
- `color-classic-gold` on `color-warm-stone`: 2.7:1 — **fails as text**; Classic Gold is a fill/accent color only in light mode (icon, border, tag), never light-mode body text.

## Responsive shell

- **Desktop (≥1024px):** persistent left sidebar (logo, nav list, footer tagline card) + header bar
  (search field, term/course-count summary, sync-status indicator, avatar) + main content column +
  optional right rail (used by This Week for a "This Week" mini-calendar strip in the mockup —
  deferred past phase 1, see Navigation below).
- **Mobile (<768px):** condensed header (hamburger, wordmark, avatar) + content column + fixed
  bottom tab bar, 5 slots max (icon + 1-word label). Sidebar collapses entirely; no hover-only
  affordances anywhere (every interactive element must have a tap-equivalent).
- **Tablet (768–1023px):** desktop layout with the right rail dropped first, sidebar retained.

No breakpoint below 375px is a target; no breakpoint-specific redesign beyond collapsing the
sidebar/rail — same component set at every size, per "a clean, consistent frame that gets out of
your way" (the mockup's own App Shell goal line).

## Navigation inventory

Full IA as designed, for forward reference. **Phase 1 implements only "This Week."** Every other
destination below is future work (Timeline/Needs Attention/Courses/Completed are explicitly
deferred by Task 1.5's own description; Search/Settings have no phase-1 backing route either) and
must not appear as a nav item, disabled or otherwise — the Task 1.5 "Done when" bar is that the
navigation test contains only available phase-1 destinations, not a preview of unbuilt ones.

| Destination | Phase | Notes |
| --- | --- | --- |
| This Week | **1 (built)** | Sole phase-1 route. Minimal version per Task 1.5: assignment list + truthful sync/recovery status. Phase 4 expands it into the full mockup (stat tiles, Today/Tomorrow grouping, quick actions, mini-calendar rail, quote card). |
| Timeline | 4+ | Week-grid view |
| Needs Attention | 4+ | Change/anomaly feed (deadline changes, new assignments, sync issues) |
| Courses | 4+ | Per-course grouping |
| Completed | 4+ | Completed-history view |
| Search | 4+ | No token-paste field anywhere, per the task's own constraint |
| Settings | later | Account/connection management surface |

Mobile bottom tab bar mirrors the same 5 destinations (Today/Timeline/Attention/Courses/More) once
built; phase 1's mobile shell has a single tab.

## Primitives

- **Button** — 3 variants: Primary (filled, brand color per theme: Scholar Navy on light /
  Classic Gold on dark), Secondary (outlined, 1px `color-mist`/`color-slate` border), Ghost (text
  only, no border/fill). Minimum tap target 44×44px on every viewport.
- **Search input** — icon + placeholder text, `color-mist` border (light) / `color-slate`-on-`color-ink-surface`
  (dark). Not present in phase 1 (no search route yet); the shell's header field is reserved space,
  not a functional control, until Search ships.
- **Tag chip** (course/category) — small pill, colored per category (Assignment/Reading/
  Discussion/Project in the mockup use `color-status-info`/`color-status-success`/`color-alert-red`/
  `color-status-accent` tints respectively) plus the category name as text — never color alone.
- **Status chip** (Due Today / Upcoming / Completed / No Deadline) — same tinted-pill pattern as
  tag chips, using the Status tokens above.
- **Card** — rounded rectangle, 1px border in `color-mist` (light) / `color-ink-surface` fill with
  no visible border (dark), subtle shadow in light mode only (dark mode uses the surface-lightness
  step instead of a shadow).
- **Assignment row** — icon (category) + title + course code + due date/time + right-chevron
  affordance + a completion checkbox that is the *only* control bound to the personal-completion
  route (never a full-row click-to-complete — a checkbox is the explicit, undoable, honestly-stated
  action the task requires).

## This Week — phase-1 content model

Minimal version (what Task 1.5 actually renders):

- Page heading + one-line status line (no personalized greeting copy requiring a display name we
  don't yet store — "This Week" is enough).
- A truthful sync-status line: last-synced timestamp or the specific non-nominal state (see States
  below), always present, always accurate — never a decorative "Synced 2 min ago" placeholder if
  nothing has synced yet.
- The assignment list itself: every imported, available `source_items` row for the student's
  connected course(s), each rendered via the Assignment row primitive, with its personal-completion
  checkbox bound live to `GET`/`POST /api/source-items/:id/completion`.
- No stat tiles, Today/Tomorrow grouping, quick actions panel, mini-calendar rail, or quote card in
  phase 1 — decorative polish and multi-course grouping are deferred per the task description.

## States (all must be renderable, all text + non-color cue, none may be silently skipped)

**Connection / sync:**
- Connected & synced (with timestamp)
- Syncing (in progress)
- Partial import (some items committed, some not — never presented as a clean success)
- Stale (last sync older than the freshness threshold)
- Disconnected (no active Canvas connection)
- Quota-exhausted (`not_refreshed` / budget reason from `importCourse`)
- Retrying (an automatic or user-initiated retry is in flight)

**Course selection:** none selected yet vs. one or more selected — phase 1 has no course-selection
UI (Task 1.4 note: that's a separate, not-yet-built mechanism), so this state only needs "no
course connected yet" handled honestly, not a picker.

**Assignment list / detail:**
- Empty (no assignments imported yet)
- Populated
- Canvas submission: known-submitted, known-not-submitted, **unknown**, **unsupported** — the
  unknown/unsupported states must render distinctly from "not submitted," never collapsed into a
  false negative (this is the same `SourceField` four-state contract Task 1.4 built; the UI must
  not re-introduce the ambiguity the backend was built to avoid).
- Personal completion: complete / incomplete, plus an honest failure/retry state when the mutation
  request itself fails (network error, 401, 403, 404, 429) — the checkbox must visibly revert and
  show a retry affordance, never silently "stick" in the optimistic state.

**Loading:** skeleton/placeholder state for the assignment list while the initial fetch is in
flight; no layout shift once real content arrives.

## Content safety

Imported Canvas title/description/link text is rendered as literal text content (`textContent`,
never `innerHTML`/`insertAdjacentHTML` with untrusted input) — Canvas is a third-party content
source and must never be treated as trusted markup.

## Accessibility primitives

- Every status region uses `role="status"`/`aria-live="polite"` (matching the existing scaffold in
  `src/ui/router.ts`), not a bare color change.
- Full keyboard operability: tab order follows visual order, every interactive control reachable
  and activatable without a pointer, visible focus ring at all times (no `outline: none` without a
  replacement).
- Reduced motion respected by default (`prefers-reduced-motion`) — phase 1 has no motion to speak
  of, but this is a standing constraint for when it does.
- No color-only encoding anywhere (status chips, tag chips, submission state) — text label or icon
  glyph is mandatory alongside every color cue, per the mockup's own icon+label pairing.
