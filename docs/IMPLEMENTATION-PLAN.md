# Due Good local Marymount replacement plan

## Outcome

Replace the private Marymount coursework page with a local Due Good app. The immediate sequence is: capture the private contract read-only, build and verify the local source/server against public synthetic tests and the private document read-only, add the daily interface and fixed refresh control, then rehearse and perform a reversible launcher cutover. Cloud UI, OAuth, Cloudflare, and a separate Due Good model credential path are deferred and do not block the local replacement.

## Authority and evidence boundaries

- David's current local-replacement instruction overrides the repository's earlier cloud-first ordering. The first implementation documentation task records that override in `AGENTS.md`; it does not weaken any security, privacy, ownership, or testing rule.
- No Cloudflare mutation, commit, push, or publication is authorized. The owner explicitly approved local retention of Canvas Inbox metadata and activation of read-only Inbox synchronization on 2026-09-20.
- `workers_dev: false` proves only that the default public route is disabled. It does not prove that production secrets, D1 rows, or credentials were deleted. This plan performs no production query or mutation; any retention, revocation, deletion, or re-enablement decision is a separate Red owner action.
- The legacy server, exporter, reconciliation script, original tests, and private coursework document are not repository evidence. Before local adapter work, an attended host-only preflight must inspect them read-only and produce only a synthetic schema/behavior contract. No real coursework, grades, names, schedules, messages, credentials, private paths, or provider responses enter Git, prompts, logs, fixtures, or container mounts.
- The untracked `main` file is owner state and remains preserved. This reviewed document is the owner-modified in-repository plan of record; Task 0.1 adopts its exact bytes into the integrity baseline before any application edit.

## Verified repository and host baseline

- The Worker exposes an authenticated, CSRF-protected `POST /api/connections/:id/courses/:courseId/import` route. Import outcomes are discriminated by the JSON body, not HTTP status alone.
- The owner-scoped course list exposes course identity and sync state. The current UI reads only the first course and has no import trigger.
- The current browser suite shares seeded Worker state, so Sync-now browser tests must intercept the client APIs rather than mutate that shared database. Worker tests exercise the real route with a mocked server-side fetch.
- `test:all` now includes the Node local-source suite. Container qualification remains an explicit host-only gate.
- OrbStack Docker is available on Apple Silicon. OpenCode CLI `1.18.30` reports `opencode-go/deepseek-v4.1-flash` with the `high` variant. The provider does not expose an immutable backing-model digest, so each run must record and compare the CLI-reported model metadata; this detects observed drift but cannot prove provider-side immutability.
- No reviewed reusable container kit or Due Good-specific OpenCode BWS consumer exists.

## Architecture decisions

1. **Host orchestration and source boundary.** Sol remains the host orchestrator. For each Linux-safe task, the host records the accepted tracked working tree as an immutable Git tree object using a host-controlled temporary index, excluding untracked owner files, then materializes that exact tree with `git archive` into a new disposable source directory. This requires no commit and carries accepted output between tasks. The mounted source contains no `.git` directory or file. Host-owned clean and changed trees are compared with system/global Git configuration disabled, external diff and textconv disabled, and no project-controlled executable invoked.
2. **Executor identity.** Build a Linux/arm64 image from digest-pinned bases with OpenCode `1.18.30`. Run the executor with a fixed non-root UID/GID, no supplementary groups, all capability sets empty, `NoNewPrivs=1`, seccomp enabled, a read-only root filesystem, and writable tmpfs only where proven necessary. The exact model and `high` variant are explicit; autoupdate, sharing, default plugins, tool-driven web access, subagents, external directories, and interactive questions are disabled.
3. **Network boundary.** Build Stripe Smokescreen from a pinned source revision in a digest-pinned Go build image; do not depend on an unreviewed third-party container. Run it non-root and capability-free. The executor joins only an internal Docker network; Smokescreen alone is dual-homed. Runtime policy is enforce-mode hostname allowlisting, port 443 only, plus default non-public-address denial and injected denies for every discovered host, Docker/OrbStack gateway, DNS, LAN, VPN, and global IPv6 address. A separate preparation policy permits only lockfile-declared HTTPS registries and source hosts. Direct executor egress, SOCKS, arbitrary TCP, HTTP port 80, TLS interception, and proxy administration are absent.
4. **Persistent concerns.** Source is disposable. Credential, per-project session, and dependency-cache volumes are separate. Credentials mount read-only during an agent run. Caches are namespaced by executor-image and lockfile digests, contain only package-manager content-addressed data, undergo integrity verification, and never supply executable helper paths.
5. **Execution route.** The project-contained executor remains credential-free evidence. The now-working owner-approved Switchyard/PlanRun route handles later bounded implementation tasks; a separate Due Good model credential is no longer a local-app prerequisite.
6. **Progress, stop, and recovery.** The runner emits sanitized heartbeats, records attempt/deadline state, sends bounded graceful then forced termination, proves the container is gone, and preserves only bounded session/recovery evidence. It checks free disk before launch and removes expired disposable sources, task caches, and layers after verified patch export.
7. **Patch handoff.** The host exporter rejects empty patches when changes are required; symlinks, submodules, special files, absolute or traversing paths, out-of-scope paths, unsafe patch headers, unexpected file-count deltas, and any source whose baseline tree OID differs from the task contract. Integration requires the canonical tracked-tree OID, recomputed through the same temporary-index procedure, to equal the recorded baseline exactly; a merely cleanly applying patch is insufficient. Untracked owner files remain excluded and untouched. Host tests run again after explicit integration.
8. **Local UI contract.** The local server presents the existing source-neutral assignment and completion API to the browser, so the daily interface uses the verified local document without cloud authentication or Worker import calls. The fixed refresh control exists only when the launcher explicitly enables it.
9. **Local concurrency.** The local document version is the SHA-256 of the exact bytes read, never a field added to the private file and never mtime. Completion and refresh commits take the same advisory lock on a dedicated persistent lockfile adjacent to the coursework document; the lockfile is never the atomically replaced data file. A write re-reads and compares the hash, creates its temp file beside the target on the same filesystem, fsyncs the file, atomically renames it, then fsyncs the parent directory. The local server binds the contract-selected loopback port so both servers cannot run concurrently. Port exclusion covers servers only; the private preflight identifies every non-server writer, cutover disables standalone writers, and the byte-hash conflict path detects an unexpected write.
10. **Refresh supervision.** A fixed host supervisor owns the shared lock, subprocess group, bounded progress, deadline, staged refresh output, and terminal receipt. The refresh child never writes the authoritative document directly; the supervisor validates and commits its staged output under the same lock as completion changes. The OS releases the lock on supervisor death; a restarted server can distinguish an active supervisor from an abandoned receipt without deleting a live lock. The attended private preflight verifies the real broker and fixed-consumer identity. Before the legacy server stops, the attended cutover proves the exact non-TTY spawn shape and failure handling against the disposable copy; a real Canvas refresh remains separately Red-authorized.
11. **Local browser boundary.** The local server accepts only the injected loopback Host value, rejects cross-origin `Origin` and non-local `Sec-Fetch-Site` requests, and requires a launch-scoped CSRF token for every mutation. Tests cover DNS rebinding, hostile browser origins, missing/invalid CSRF, and valid same-origin requests.
12. **Approved dashboard contract.** The owner-approved mockups are the production target: a dark-default interface, equal-height consecutive calendar days, stable course lanes, multiple same-day items, directly visible assignment completion, discussion-specific post/reply checks, and eight reachable pages (Timeline, Grades, Inbox, Completed, Courses, Library, Activity, More). Assignments, class sessions, Canvas-reported scores, library metadata, refresh history, and local progress state come from the private local source. Grades remains read-only and never infers a weighted or final course grade. Synthetic records never appear in the live UI.
13. **Read-only Inbox.** Canvas Conversations are fetched account-wide with `auto_mark_as_read=false`; Due Good implements no send, reply, delete, archive, star, or mark-read mutation. Same-origin pagination, request/time/count limits, inert-text normalization, credential-value redaction, explicit safety-limit flags, and incomplete-snapshot merge prevent credential disclosure, silent clipping, and false removal while preserving ordinary URLs as visible text. Activation uses the existing fixed BWS consumer only after the private wrapper and every imported sync source are hash-pinned.

## Phase 0 — Qualify the isolated executor (complete, not a cutover dependency)

Adopt this file's exact reviewed bytes into `SHA256SUMS`, then implement the project-contained image, Smokescreen policy, host runner, lifecycle controls, safe exporter, disk retention, and automated isolation suite. The Switchyard worker authors the files without Docker access; the host captain alone builds images and runs container/network qualification. Add a named `test:container` runner, a concrete executor-receipt verifier, and a `container` membership category. Every later executor task checks a lightweight environment fingerprint; any image, proxy, route, DNS, VPN, LAN, OrbStack, Docker, model-metadata, or policy change requires the route-sensitive qualification suite again.

Gate: the credential-free containment suite passes. A live model request is deferred because Switchyard/PlanRun is the active implementation route.

## Phase 1 — Cloud Sync now interaction (deferred)

This cloud-facing increment is outside the local replacement path. It remains available for later product work but no local task depends on it.

## Phase 2 — Capture the local legacy contract (implemented)

In an attended host-only, read-only preflight, inspect the current private launcher/server/exporter/reconciler, document shape, stable identifiers, all server and non-server writers, refresh broker, bind address/socket options, and rollback command. Generate a reviewed synthetic contract fixture with no derived personal values. Establish that a private loopback port is externally injected without recording its value, and record which legacy components are retired, retained only as supervised children, or used only for rollback. If the stable ID, completion-field, writer, refresh-consumer, or preservation assumptions differ, revise the plan before local-adapter edits.

Gate: private sources remain outside Git and provider prompts; a redacted receipt identifies only checks passed/failed; the synthetic fixture and contract tests are owner-reviewed.

## Phase 3 — Build the local source adapter and server (implemented vertical slice)

Add a Node build pipeline, Node-specific Vitest config, `local` membership category, and `test:local` in `test:all`. Implement the byte-hash concurrency token, shared adjacent lockfile, same-directory temp replacement including parent-directory fsync, unknown-field/order preservation, externally required loopback port with no personal default, Host/Origin/fetch-metadata/CSRF enforcement, body/static-path limits, and crash-recoverable refresh supervisor. Automated tests inject an ephemeral port. The local API implements the `CourseworkSource` contract and never accepts arbitrary paths or commands.

Current gate evidence: built-server launch, 22 local tests, exact-byte conflicts, duplicate IDs, unknown-field preservation, same-directory atomic replacement with file/directory synchronization, Host and CSRF rejection, private-document read-only compatibility, refresh failure/recovery, launcher exclusion, and headless completion/discussion walkthroughs all pass.

## Phase 4 — Run the interface on the local source (implemented vertical slice)

The local server supplies the existing source-neutral browser API, with no cloud authentication or Worker import call. The UI renders current assignments, truthful sync age, personal completion, and an explicitly enabled fixed refresh control on desktop and mobile.

Gate: focused UI tests and one accumulated Playwright batch cover every reachable state/control on desktop and mobile; existing Canvas-source tests remain valid; local tests are present in membership and `test:all`; milestone-specific evidence checks pass.

## Phase 5 — Rehearse and cut over reversibly

Run mutation and refresh tests only against a disposable private copy. While the legacy server is still running, prove a Due Good launch on the captured bind address/port fails, then stop it and prove Due Good alone can bind. Prove the fixed refresh consumer can be spawned by the local supervisor in its non-TTY process context and that failure is bounded and redacted; do not perform a real Canvas refresh without its separate authority. Disable every standalone writer identified by the private contract; retained refresh code runs only as a supervised child producing staged output. Then run the real-file walkthrough read-only. After exact-candidate owner acceptance, update the private launcher and retain an inverse exclusive rollback command.

Gate: disposable-copy before/after preservation, two-process port exclusion, byte-hash conflict, power-loss limitation documented, refresh-supervisor recovery, exact-candidate full suite, working-tree public scan plus candidate-byte scan through a throwaway Git index, read-only real-data walkthrough, rollback proof, and owner acceptance.

## Phase 6 — Approved coursework dashboard and Canvas Inbox

Replace the vertical-slice This Week screen with the approved dark-default eight-page dashboard. Project the existing class sessions and assignments into real calendar-day rows and stable course lanes; expose assignment completion and discussion post/reply progress directly on cards; show Canvas-reported scores and points in a read-only Grades page without calculating a final course grade; project the already-sanitized course exports into Library; project the private refresh ledger into Activity; preserve the local coursework document as the sole progress authority. Add a bounded Canvas Conversations sync and private full-thread snapshot that never changes Canvas state, silently clips ordinary content, or removes retained threads after an incomplete fetch.

Gate: descriptor tests, local store/server tests, Canvas conversation normalization/sync tests, test-membership coverage, typecheck, lint, browser tests for every route at desktop/mobile widths, public-tree scan, read-only live-source walkthrough, and explicit owner approval before account-wide Inbox capture is enabled or run. Owner approval was recorded and the protected live sync completed on 2026-09-20 with 10 threads and zero rejected records.

## Red boundaries

- Any authoritative private-file write outside the already accepted completion workflow.
- Expanding the approved read-only Inbox capture to message mutations, additional data classes, or external storage.
- Any production query, credential revocation, D1 deletion, Cloudflare change, or re-enablement.
- Replacing the private launcher.
- Commit, push, deployment, or publication.

## Completion boundary

Completion requires the verified local contract, local source/server, daily interface, disposable-copy refresh rehearsal, exclusive launcher, rollback proof, and owner acceptance as the daily replacement. It does not require the deferred cloud Sync now increment or a separate Due Good model credential, and it does not establish cloud, OAuth, or public-pilot readiness.
