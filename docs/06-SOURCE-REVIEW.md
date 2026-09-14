# Original prototype: evidence and migration notes

## Scope

The owner supplied seven files. The original `coursework.html`, `coursework.css`, and `coursework.js` are copied byte-for-byte into `reference/legacy-ui/` for implementation inspection. They contain fixed course/semester assumptions but no student data records were copied with them.

The personal data files (`courses.json`, `coursework.json`, `coursework-refresh-history.json`) and local launcher (`coursework.sh`) are excluded from the package. Keep any local originals outside the public repository. The supplied data includes private academic/planning content; do not use it as public fixture material.

The original `todo_server.py`, `sync_coursework.py`, Canvas-exporter implementation, original tests, package configuration, and deployment code were **not supplied**. Their correctness, authorization, pagination, token handling, and write atomicity are unverified. References to them in comments are not implementation evidence.

## Verified frontend observations

Line ranges below refer to the original uploaded files. The copied reference code is unchanged, so the local agent can confirm them directly.

| Location | Observation | Proposed response |
| --- | --- | --- |
| `coursework.js:16–28` | Dataset/display logic assumes Eastern timezone-free local strings | Introduce typed dates/instants and a deliberate legacy conversion policy |
| `coursework.js:40–43` | Live deliverables require `source === "canvas"` plus a Canvas ID | Allow personal and accepted child tasks without falsifying Canvas identity |
| `coursework.js:370–393` | Progress depends on live filtering; overdue compares calendar dates only | Define parent/child denominators and compare timed deadlines to actual time |
| `coursework.js:470–474` | Default course filters list three personal keys | Derive course selection from authenticated discovery/preferences |
| `coursework.js:513–538` | Local health sentinel and launcher-based recovery | Replace with hosted API recovery and honest offline state |
| `coursework.js:604–615` | Running-job status polling repeats every 750 ms | Return/stream results or back off status reads |
| `coursework.js:689–729` | Save sends the whole document; 409 reload drops unsaved changes | Separate source facts and idempotent per-task student mutations |
| `coursework.js:735–751` | Checkbox action first checks local server health | Save directly; avoid a network preflight per edit |
| `coursework.js:1064–1116` | Finder/class-folder behavior depends on server-local paths | Remove from hosted product |
| `coursework.js:1175–1196` | Expandable titles have keyboard and ARIA handling | Preserve/test accessible interactions |
| `coursework.js:1442–1455` | Undated panel says “do these whenever” | Replace with “No deadline listed” |
| `coursework.js:1474–1482` | Page heading is fixed to Fall 2026 | Make title/term and timezone display configurable |
| `coursework.css:256–265,395–402` | Desktop grids explicitly use three lanes | Generalize lane/list layout |
| `coursework.css:625–643` | Narrow-screen and reduced-motion styles exist | Retain and extend |
| `coursework.html:6,17–19` | Semester title and direct JSON fallback | Public shell must not expose private JSON paths |

## Source-data lessons, without reproducing records

The original data separates some archived forecast items from live Canvas work, preserves `done`/`doneAt` by stated sync contract, records field-level refresh changes, and has personal ignored-assignment exceptions. One live discussion description refers to a separately archived initial-post task. These motivate retaining provenance and student decisions while avoiding an overly restrictive Canvas-ID-only task model.

These are observations of the submitted snapshots, not proof of how the absent exporter or reconciler operates. Do not infer that all archived forecasts are valid obligations, or restore them automatically. Do not publish the original record content as a bug report.

## Migration boundary

Do not upload the old JSON wholesale into D1 and call that multiuser support. First define identity and ownership, then import only the required source fields and explicitly mapped personal state. Any personal legacy migration should be local/private with a dry-run report and owner review. Preserve rejected or ambiguous rows in private recovery material, not in the public source tree.

The new app should be built outside `reference/legacy-ui/`. That directory is an immutable comparison aid, not the production asset root. Do not serve it as a demo that appears connected or writable.
