# Generalization and UI, after the platform and sync foundation

## Preserve the good parts

The prototype already has a chronological timeline, course-color cues, change history, collapsible completed work, keyboard interaction, and narrow-screen styles. Preserve behaviors that test well. Do not require a new framework merely to replace strings or storage wiring.

## Remove personal assumptions

- Course keys/IDs, three fixed desktop lanes, fixed filter defaults, and semester title/dates become data driven.
- Course selection supports zero, one, several, and many courses; long titles and empty/stale courses are normal.
- Institution configuration and student display time zones replace a hardcoded universal Eastern zone.
- “Open class folder,” local-server health sentinels, launcher instructions, and the shared funding-dashboard dependency do not belong in the public flow.
- Sessions and institutional milestones are optional context, not mandatory work or completeness evidence.
- Grade displays are optional details. Do not calculate a misleading overall course grade from incomplete Canvas information.
- Zero-point and undated items remain discoverable. Student-created tasks and accepted subtasks do not require Canvas IDs.
- Prior-term work is archived by a user-understandable policy, not abruptly deleted by an enrollment filter.

A configurable institution adapter is sufficient initially. Do not build a marketplace of LMS plugins before another school has a real integration need and OAuth enablement.

## Onboarding

Landing page: name, one sentence, independent-project disclosure, privacy link, and “Connect Marymount Canvas.” After authorization, present discovered courses and a useful default selection. No syllabus upload, manual token, install prompt, or notification-permission prompt is required.

If approval is pending, display that truth and offer only an explicitly labeled synthetic demo. A disabled button must not masquerade as a real connection. Do not publicly expose a developer mode that authenticates arbitrary users.

## Main views

**This Week:** upcoming and overdue work with compact title, course, actual due time, and remaining steps. Provide a path to later/undated work without making everything compete for attention.

**Timeline:** semester overview with optional class sessions and institutional dates. Desktop lanes can adapt or switch to a list rather than squeezing ten unreadable columns. Narrow screens should not require horizontal scrolling to read a task.

**Needs attention:** changed deadlines, newly available work, missing permissions, disconnected accounts, partial sync, and conflicting accepted instructions. Avoid warning fatigue from a permanent generic “confirmed” chip on every ordinary task.

## Interface copy contracts

| Situation | Appropriate wording |
| --- | --- |
| No authoritative due date | “No deadline listed” |
| Course inventory empty | “No published assignments found” |
| Some course imports fail | “Updated 3 of 4 courses. One course is still showing saved information.” |
| Device write succeeded but server has not acknowledged | “Saved on this device. Waiting to sync.” |
| Server write acknowledged | “Saved and synced” |
| Personal checkbox, no provider receipt | “Finished” alongside separate Canvas submission status |
| Connection genuinely invalid | “Reconnect Canvas” |
| App/provider capacity exhausted | “Sync unavailable. Showing information last checked …” |

Use exact timestamps in details, localized human descriptions in the main view, and a visible zone when it can change interpretation. A midnight/all-day date is not automatically a precise due instant.

## Offline progression

First ship truthful server persistence. Then add a per-account IndexedDB cache/outbox with operation IDs. Persist an action before claiming device-saved state. Queue only student-owned mutations, never pretend an offline action submitted work to Canvas.

Resume using idempotent server operations, handle conflicts without discarding notes, and expose permanently rejected writes for recovery. Purge or isolate caches/outboxes on logout/account switch. A shared device must not display the prior student's tasks or replay their pending edit into a different account.

Cache the app shell deliberately. Do not put credential responses or raw authenticated API responses into an indiscriminate service-worker cache. Version data formats and service-worker updates to avoid stranding pending mutations. Browser storage is not guaranteed backup; offer export and tolerate quota/eviction failures.

## Usability acceptance

Test a technical-course profile, a political-science writing/discussion profile, and an art/studio profile. Test keyboard-only use, screen-reader announcements, large text, reduced motion, narrow phones, and long assignment titles. Color alone must never indicate course or status. Re-renders must preserve focus and not scroll away from the active task.

Ask pilot students to connect, find the next deadline, add a task that is not in Canvas, understand a changed deadline, and recover from disconnection. Fix observed stumbling points before adding dashboards or AI features.
