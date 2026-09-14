# Security, privacy, and public-release checklist

These are proposed controls, not a certification or a claim of legal compliance. The application will hold personal academic information and credentials; an independent public project still needs a responsible operator and institutional review where required.

## Threats to design for

**Credential leakage:** token accidentally embedded in HTML, JS, logs, source maps, status output, exceptions, backups, or a public issue. Use server-only secrets and encrypted credentials; minimize data collection and redact by construction.

**Cross-student access:** checking ownership on the task list but forgetting history, export, sync progress, continuation, parent/child links, or deletion. Resolve owner from the session and enforce it in every query and mutation.

**OAuth login attacks:** callbacks not bound to the browser and institution, replayed state, open redirects, or wrong-user account association. Use short-lived one-time state, session binding, exact redirects, and validated identity. Do not log sensitive callback URLs [S1].

**Outbound bearer leakage / SSRF:** arbitrary Canvas host input, malicious pagination URL, or auto-followed redirect. Use explicitly configured HTTPS origins and endpoint paths; reject unexpected schemes, ports, userinfo, IP/private destinations, and cross-origin redirects before sending a bearer credential. Student-provided external links are never authenticated Canvas fetch destinations.

**Content injection:** assignment text and URLs are untrusted input. Prefer text rendering. If rich HTML is later allowed, sanitize with a maintained allowlist, constrain protocols, and use a restrictive content-security policy. No raw instructor content becomes executable frontend markup.

**Data loss:** failed page interpreted as deletion, old job overwriting new state, refresh racing a checkbox, account deletion racing a background continuation, or unknown fields normalized to false. Apply the explicit sync and mutation contracts.

**Quota abuse:** unauthorized people or repeated tabs exhausting free backend capacity. Authenticate early; rate-limit beginnings of auth/sync; bound all work; use a pilot admission cap and operator switches. Never fail open around auth when capacity is exhausted.

**Shared devices:** cached tasks or pending mutations shown to the next user. Isolate storage by account and clear appropriately on logout/switch; never persist Canvas tokens in browser storage.

## Publication hygiene

- Choose a project license before advertising the code as licensed open source. Keep branding distinct from official university marks.
- Commit synthetic fixtures only. Do not put student names, grades, actual assignments, private schedules, instructor messages, personal funding details, real course exports, screenshots, or private feed URLs into a public repo.
- Inspect both the Git index/history and deployment output, not only `.gitignore`. Ignoring a file does not remove a file already committed or deployed.
- Use a dedicated static-output directory and fail-closed authenticated routes. Never publish a shared local server's directory tree.
- Enable the chosen repository's appropriate secret/dependency checks after creation. Revoke/rotate exposed credentials; deleting a file from the latest commit is not a remedy.
- Keep production secrets away from pull-request/preview environments, logs, and third-party issue bots. Restrict CI permissions and pin deployment tooling.
- This package does not include a live `LICENSE`, support mailbox, approved privacy policy, or evidence of university approval. Resolve these before the public pilot.

## Data policy to decide before accepting students

Collect only the course/task/submission fields the features actually need. Do not retain coursework attachments, classmates' submissions, or complete course archives as a side effect of API responses. Prefer no third-party analytics initially. Explain hosting/processing boundaries and that server operators can decrypt connection credentials; do not promise end-to-end encryption.

Choose and publish: what is stored; why; whether numeric grades are optional; retention for source snapshots, change history, and dormant accounts; export behavior; disconnect versus delete behavior; backup retention; and an actual support/security contact. Retention jobs consume free capacity and need a budget.

A proposed policy is that disconnect removes credentials and stops imports but retains the student's saved planner until explicit deletion. Confirm this with the owner rather than silently imposing it. Existing session access after disconnect must be deliberate, bounded, and documented; do not invent unauthenticated recovery links.

Deletion must stop sync, invalidate sessions/jobs as appropriate, remove all live personal rows and browser caches under app control, and document any backup-retention delay. Ensure a restore cannot resurrect a deleted account without applying deletion records. Test export/deletion rather than merely adding buttons.

## Incident and availability plan

Provide a server-side switch to stop new authorization and another to stop sync while retaining safe reads where resources permit. Know how to revoke a developer key, rotate the encryption key safely, invalidate sessions, and notify affected users through an agreed channel. Do not put a student's incident evidence in a public GitHub issue.

Document recovery from a bad deployment and database migration, with a tested backup/export path that does not add an unauthorized paid service. Do not guarantee immediate automatic restoration or indefinite history.

At provider exhaustion, backend code may not run at all. Use static/cached messaging when available, label saved freshness, and preserve local pending work if the device can persist it. Do not issue a false “all synced” acknowledgement to improve appearances.

## Release gate

Require evidence for live institution OAuth, scoped permissions, ownership isolation, denied/revoked grants, absent refresh-token handling, race-safe mutations, partial import safety, quota behavior, clean published assets, dependency review, truthful user copy, accessible core journeys, and export/deletion. No broad public signups until these gates pass; use a bounded pilot first.
