# Invariants — Due Good

Due Good has one product surface: the macOS Tauri app. Its embedded WebView assets are part of
that app. The local Node service remains a temporary migration source until an attended native
cutover; it is not a supported product lane. Historical web and Worker work stays in HISTORY and
the implementation status archive. Here, `area:` maps code to the current contract.

### INV-1 — Long work reports progress and outcome
area: ["src/ui/app.ts", "src/ui/pages/dashboard.ts", "src/ui/transport.ts", "src-tauri/src/commands.rs", "src-tauri/src/ical_receiver.rs", "src-tauri/src/refresh.rs", "src-tauri/src/snapshots.rs"]
gate_test: test/ui/dashboard.test.ts, test/native/playwright/desktop-first-run.spec.ts, src-tauri/src/ical_receiver.rs, src-tauri/src/refresh.rs
threshold: 3
rationale: Network, process, import, snapshot, and refresh work surfaces content-free progress and a terminal result. A timeout or incomplete source cannot appear as success.

### INV-2 — Private data and credentials stay out of client, logs, and Git
area: ["scripts/check-public-tree.mjs", "scripts/sync-canvas-ical.mjs", "scripts/stage-tauri-candidate.mjs", "src-tauri/src/ical_receiver.rs", "src-tauri/src/commands.rs", "src-tauri/src/commands_ical.rs", "src-tauri/src/config.rs", "src-tauri/src/documents.rs", "src-tauri/src/resources.rs", "src-tauri/src/export.rs", "src/ui/transport.ts"]
gate_test: npm run check:public-tree, npm run test:ui, npm run test:tauri
threshold: 1
always_active: true
rationale: Private coursework, grades, messages, schedules, feeds, and credentials remain in the owner's private stores. The WebView receives bounded documents through fixed commands, not filesystem paths or secrets. The fixed BWS broker injects the feed URL only into its pinned helper; progress and errors carry no feed content.

### INV-3 — Source facts cannot overwrite student progress
area: ["src-tauri/src/import.rs", "src-tauri/src/store.rs", "src-tauri/src/reconcile.rs", "src-tauri/src/ical_apply.rs", "src-tauri/src/ical_apply_bootstrap.rs", "src/shared/dashboard-projection.ts"]
gate_test: npm run test:tauri, npm run test:ui
threshold: 3
rationale: Canvas and calendar facts, Canvas submission state, local completion, notes, discussion checks, and manual grades are separate. Native import copies the legacy source without changing it; refresh preserves student fields and unknown extensions.

### INV-4 — Incomplete source reads retain existing records
area: ["src-tauri/src/capture.rs", "src-tauri/src/refresh.rs", "src-tauri/src/ical.rs", "src-tauri/src/ical_apply.rs", "src-tauri/src/history.rs"]
gate_test: npm run test:tauri
threshold: 3
rationale: Failed, unsafe, partial, timed-out, or ambiguous source reads never delete retained coursework or claim a complete refresh. Rolling calendar windows do not imply deletion.

### INV-5 — Tauri is the only supported runtime
area: ["package.json", "src/ui/app.ts", "src/ui/transport.ts", "src-tauri/capabilities/default.json", "scripts/build-ui.mjs"]
gate_test: npm run typecheck, npm run test:ui, npm run deadcode, npm run check:public-tree
threshold: 1
rationale: The interface runs inside Tauri and calls native commands. Browser authentication, Worker deployment, and HTTP dashboard routes do not ship as product lanes. The temporary migration listener is retired only after a verified native handoff.

### INV-6 — Native writes are durable and preserve unmanaged data
area: ["src-tauri/src/store.rs", "src-tauri/src/locking.rs", "src-tauri/src/import.rs", "src-tauri/src/snapshots.rs", "src-tauri/src/export.rs", "src-tauri/src/ical_apply.rs", "src-tauri/src/ical_apply_bootstrap.rs"]
gate_test: npm run test:tauri
threshold: 3
rationale: Writes use an OS lock, exact-byte preconditions, temporary files, fsync, and atomic rename. Import leaves the source unchanged, archives a replaced preview, and refuses to replace an authoritative store. Snapshots and owner-selected exports preserve recovery options.

### INV-7 — No cloud runtime or public onboarding
area: ["package.json", "README.md", "docs/IMPLEMENTATION-PLAN.md", "src-tauri/tauri.conf.json"]
gate_test: npm run check:public-tree, npm run check:package
threshold: 1
always_active: true
rationale: Cloudflare Worker, D1, public OAuth, browser sessions, and public deployment are outside the Tauri-only product. Historic cloud evidence does not establish a current live service or university approval.

### INV-8 — One native store writer
area: ["src-tauri/src/locking.rs", "src-tauri/src/store.rs", "src-tauri/src/commands.rs", "src-tauri/src/commands_ical.rs", "src-tauri/src/refresh.rs", "src-tauri/src/ical_apply.rs"]
gate_test: npm run test:tauri
threshold: 1
always_active: true
rationale: One app instance owns the store. Native refresh and calendar import share the refresh guard and write lock; a second instance or concurrent writer cannot silently race.

### INV-9 — Preview stores never refresh
area: ["src-tauri/src/commands.rs", "src-tauri/src/commands_ical.rs", "src-tauri/src/ical_apply.rs", "src/ui/app.ts", "src/ui/pages/dashboard.ts"]
gate_test: npm run test:tauri, npm run test:ui
threshold: 1
always_active: true
rationale: A preview is an isolated copy. Its local edits remain available, but Canvas and calendar refresh are denied until the owner completes guarded promotion.

### INV-10 — Authoritative stores never receive legacy import
area: ["src-tauri/src/import.rs", "src-tauri/src/store.rs", "src-tauri/src/commands.rs"]
gate_test: npm run test:tauri
threshold: 1
always_active: true
rationale: Import cannot replace an authoritative store. Preview replacement first archives the prior copy, and interrupted replacement can be recovered.

### INV-11 — Installed bytes must match the tested candidate
area: ["scripts/stage-tauri-candidate.mjs", "scripts/build-tauri.mjs", "scripts/verify-tauri-assets.mjs", "scripts/install-desktop-app.mjs", "src-tauri/build.rs"]
gate_test: npm run test:tauri, npm run verify:tauri-assets, npm run check:production-launch
threshold: 1
always_active: true
rationale: Build and tests run in a private staged candidate. Installation verifies the candidate, signature, bundle identity, and embedded frontend hashes. Tests, installation, launch, live behavior, and owner acceptance are distinct evidence.

### INV-12 — Store authority changes only through the owner flow
area: ["src-tauri/src/commands.rs", "src-tauri/src/commands_ical.rs", "src-tauri/src/store.rs", "src-tauri/src/export.rs", "src-tauri/src/ical_apply_bootstrap.rs", "src/ui/app.ts", "src/ui/transport.ts"]
gate_test: npm run test:tauri, npm run test:ui, npm run test:desktop-ui
threshold: 1
always_active: true
rationale: An empty store may become authoritative only from a user-started, useful validated iCal fetch staged before adoption. Existing stores cannot be overwritten by that path. Legacy preview promotion still requires a frozen backup comparison, one-use proof, and native confirmation; demotion retains recovery bytes. The WebView cannot provide a path or confirmation flag.

### INV-13 — Source identity never replaces local identity
area: ["src-tauri/src/reconcile.rs", "src-tauri/src/ical_apply.rs", "src-tauri/src/ical_apply_refs.rs", "src/shared/pending-links.ts"]
gate_test: npm run test:tauri, npm run test:ui
threshold: 1
always_active: true
rationale: References are scoped by institution and course. Duplicate claims fail closed; unverified cross-source candidates are held for review. Local IDs, progress, notes, and unknown fields survive source updates.
