# First local-agent work order

You are implementing **Due Good**, an independent, public student assignment tracker, starting with Marymount Canvas. The owner wants a free-to-use hosted web app and does not authorize personal out-of-pocket hosting costs. Students of any major should connect without managing tokens, secrets, scripts, or local servers.

Read `AGENTS.md`, `SPEC.md`, and `docs/01-SETUP.md` first. Inspect the actual local repository. The bundled `reference/legacy-ui/` files are the original frontend only, not an audited or working hosted application; the original backend and exporter were not provided. Private source data is intentionally absent.

**Before editing application code:** write `docs/IMPLEMENTATION-PLAN.md`. Map the current tree to this specification, validate relevant Canvas/Cloudflare documentation, identify security and free-tier blockers, and propose a small sequence of commits with acceptance tests. Do not rewrite the interface first.

## First milestone: OAuth and Cloudflare

Establish a minimal Cloudflare Workers + static-assets foundation and a D1 database only on the free plan. Confirm actual account plan and shared quota use, select a stable free HTTPS origin, and prepare exact OAuth callback configuration. A deployment is not authorized to incur charges. Do not purchase a domain.

Prepare the Marymount Canvas API developer-key request using `templates/MARYMOUNT-ADMIN-REQUEST.md`. This is the Canvas REST API authorization-code flow, not an LTI integration or a generic client-credentials grant. Approval has not been obtained. Record the chosen origin and requested scopes, but not secrets, in setup status.

Implement secure session/state handling and encrypted credential persistence. Keep OAuth disabled until prerequisites exist. Implement token refresh, disconnect, logout, and identity-scoped course selection. Never ship a student-token input or expose credentials in the browser. Do not configure production OAuth callbacks to arbitrary preview deployments.

Use synthetic Canvas responses to build the first assignment-list import. Once enabled, prove a single consenting student's connection can list their courses, import one selected course, display basic assignments, preserve a personal completion action, and safely reconnect. Tenant isolation and complete-page/non-destructive writes are required even in this early milestone.

**Gate:** report separately what works in mocks, what works on Cloudflare, and what has been verified against Marymount. If Marymount enablement is pending, finish the mock and deployment setup without describing OAuth as live. Leave a clear blocked acceptance case, not a fake success.

## Then, in order

1. Measure and optimize incoming Worker requests, outbound Canvas calls, CPU, D1 rows read/written, storage, and transient staging overhead. Remove rapid polling. Make sync resumable, bounded, idempotent, and non-destructive. Do not assume the illustrative ten Canvas calls / six app requests is a measured guarantee.
2. Generalize beyond the original courses: student-owned tasks, discussions/checkpoints, personal exceptions, date zones, course/term selection, and deterministic rules with previews. No required LLM.
3. Improve UI: This Week + Timeline, progressive detail, narrow screens, accessible controls, source/freshness labels, and durable offline edits. Keep syllabus parsing and optional installation out of first-run requirements.

Produce an implementation plan, actual setup status, small tested changes, and a final summary of what remains. No issue comment is required by this handoff. Do not modify unrelated projects, publish private data, purchase services, or silently expand scope.
