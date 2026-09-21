# Due Good

**Your assignments, deadlines, and next steps in one place.**

A planned, independent student assignment tracker, starting with Marymount University students using Canvas. Built for students of any major, not only people comfortable with developer tools.

**Status: the private coursework launcher opens the persistent local Due Good service.** The dark-default dashboard includes Timeline, Grades, Inbox, Completed, Courses, Library, Activity, and More. Grades shows read-only Canvas-reported scores without guessing a weighted or final course grade. Timeline cards have direct local completion controls, discussions have separate post/reply progress checks, Inbox shows read-only full threads, and the sidebar uses the locally cached Canvas profile picture when available. The shared legacy funding server remains separate and healthy. The cloud Worker remains offline.

## Start here

Give your coding agent [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md). It must inspect the local project and write an implementation plan before changing application code.

The current owner-authorized sequence is:

1. **Qualify the isolated local executor.**
2. **Capture a redacted synthetic contract for the private legacy source.**
3. **Build the local coursework source and daily interface.**
4. **Rehearse a reversible cutover.**

OAuth and Cloudflare work are deferred. Security, data separation, honest persistence, and protection from data loss remain mandatory.

## Constraints

- Public project, free student use, **$0 out-of-pocket recurring operating budget for the owner**.
- Hosted web app is the intended distribution. Students do not install a local server or manage API keys.
- Canvas OAuth, subject to institutional developer-key enablement. No public personal-token onboarding.
- No LLM dependency, advertising, SMS service, or paid model/API requirement.
- Free-tier limits may pause synchronization. Do not upgrade billing automatically or promise unlimited capacity.
- Original student records and secrets must never become public repository assets.
- Independent project; no university endorsement or official branding is implied.

## Package map

| File | Purpose |
| --- | --- |
| [`SPEC.md`](SPEC.md) | Product specification, boundaries, success criteria, decisions |
| [`AGENTS.md`](AGENTS.md) | Persistent implementation-agent guardrails |
| [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) | Copy-ready first work order |
| [`docs/01-SETUP.md`](docs/01-SETUP.md) | OAuth + Cloudflare first milestone and operator checklist |
| [`docs/02-SYNC-AND-BUDGET.md`](docs/02-SYNC-AND-BUDGET.md) | Safe imports, capacity assumptions, request/write accounting |
| [`docs/03-DATA-AND-RULES.md`](docs/03-DATA-AND-RULES.md) | Proposed schema, student state, non-LLM intelligence |
| [`docs/04-GENERALIZATION-AND-UI.md`](docs/04-GENERALIZATION-AND-UI.md) | Cross-course usability and progressive offline support |
| [`docs/05-ROADMAP-AND-TESTS.md`](docs/05-ROADMAP-AND-TESTS.md) | Ordered tickets and acceptance cases |
| [`docs/06-SOURCE-REVIEW.md`](docs/06-SOURCE-REVIEW.md) | Evidence from the uploaded prototype, with limits of the review |
| [`docs/07-SECURITY-AND-RELEASE.md`](docs/07-SECURITY-AND-RELEASE.md) | Security, privacy, publishing, and operational gates |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | Current local replacement plan and quality gates |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | Pinned executor inputs, isolation boundary, and qualification commands |
| `dev/opencode/` | Pinned OpenCode and Smokescreen container kit |
| [`docs/SOURCES.md`](docs/SOURCES.md) | Official documentation checked for this handoff |
| `templates/` | Inert configuration examples and a Marymount administrator request |
| `reference/legacy-ui/` | Original HTML/CSS/JS for inspection, not deployment |
| `fixtures/` | Entirely synthetic examples, not student exports |
| `scripts/` and `tests/` | Offline package checks and a usage estimator |

## Local checks

Python 3.10+ is sufficient for the package utilities. No third-party dependencies, authentication, networking, or cloud accounts are required to run them.

```sh
python3 scripts/check_package.py
python3 -m unittest discover -s tests -v
python3 scripts/estimate_usage.py --students 100 --syncs 4
```

The explicit credential-free executor gate is host-owned and separate from `test:all`:

```sh
npm run test:container -- --credential-free
npm run verify:executor-receipt -- --self-test
```

These checks do **not** authorize a provider call or establish OAuth, deployment, private-data compatibility, or cutover readiness. The estimator is arithmetic using declared assumptions, not a benchmark.

## Run the local replacement

Build the browser bundle and local server, then supply the coursework document
and a loopback port explicitly. The project never stores either personal value.

```sh
npm run build:local
npm run start:local -- --coursework /absolute/path/to/private-coursework.json --port 43127 --enable-refresh
```

Open the printed loopback address. The server rejects a mismatched Host or
Origin, requires its launch-scoped CSRF token for completion and discussion-progress changes, checks the
exact source bytes before writing, and replaces the document atomically after
file and directory synchronization. Use `--read-only` for a walkthrough that
must not permit any completion update. Omit `--enable-refresh` unless the fixed
`canvas-course-refresh` BWS consumer is configured on the host.

The Timeline reads assignments and class sessions from the private coursework
document. Every assignment card has a direct `Done` checkbox. Discussion cards
visually separate `Main post` and `Replies` into two full-width requirement rows,
while keeping overall assignment completion distinct;
the same two checks appear in the `Due soon` rail. An open tab automatically
renews its local CSRF token once after a service restart; a concurrent source
change reloads authoritative state before asking the user to retry. None of
these local controls changes Canvas submission state. Library reads the
already-sanitized local Canvas exports and only
offers downloads for manifested files under the matching course `materials/`
directory. Activity reads the private refresh ledger; Due Good now writes a
bounded atomic audit event for each local refresh, including grade-only changes
and human-readable old-to-new field transitions in the Activity detail while
excluding completion state and notes. Inbox reads a separate
bounded local conversation snapshot and renders complete inert-text threads,
including authors, times, and attachment metadata. Ordinary links remain visible
as text. Explicit warnings identify incomplete history or a reached safety limit.
Inbox is strictly read-only: no Canvas
send, reply, delete, archive, star, or mark-read actions are implemented.

Account-wide Inbox capture was explicitly owner-approved and activated on
2026-09-20. The fixed BWS refresh wrapper hash-pins and runs
`scripts/sync-canvas-conversations.mjs` after the course refresh; an
`--inbox-only` recovery mode avoids repeating a completed course refresh. The
private snapshot is atomically written outside this repository with mode `600`.

Canvas profile-picture capture was explicitly owner-approved on 2026-09-21. The
same fixed wrapper hash-pins `scripts/sync-canvas-profile.mjs`, downloads the
image without forwarding the Canvas token, and supports `--profile-only`
recovery. Metadata and image bytes are atomically stored outside this repository
with mode `600`; the browser receives only `/api/local/profile/avatar`, never the
remote URL or credential.

The local verification commands use only the public synthetic contract:

```sh
npm run test:local
npm run test:membership
```

## Public-source precautions

Only the prototype HTML, CSS, and JavaScript are retained as reference code. The original `courses.json`, `coursework.json`, refresh history, and launcher are deliberately excluded. Do not copy the original workspace wholesale into this repository. Synthetic fixture files are clearly labeled and have unrelated IDs.

The config in `templates/wrangler.example.jsonc` deliberately points to application code that an agent still needs to create. It is not a deployable finished app. Never deploy `reference/` or the repository root as a static asset directory.

This project is available under the [MIT License](LICENSE). The license does not claim to clear university trademarks or imply university endorsement.
