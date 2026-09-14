# Sources and evidence

Prepared September 13, 2026. These are primary documentation sources reviewed for this handoff. Source identifiers in the spec refer to this registry. Service limits and APIs must be rechecked during implementation. No institutional approval, account plan, OAuth client, or deployment was verified.

## C1 — Canvas OAuth overview

[Canvas OAuth overview](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)

Public multiuser applications use OAuth; institutional developer-key prerequisite; access and refresh token lifecycle. The userinfo-only flow does not authorize coursework API access.

## C2 — Canvas OAuth endpoints

[Canvas OAuth endpoints](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth_endpoints)

Authorization-code exchange, required client secret and redirect handling, refresh response, token revocation. Verify institution-specific behavior before launch.

## C3 — Canvas developer keys

[Canvas developer keys](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys)

Endpoint scopes, institutional enablement, and the Allow Include Parameters setting for scoped keys.

## C4 — Canvas assignments API

[Canvas assignments API](https://developerdocs.instructure.com/services/canvas/resources/assignments)

Current-student submission inclusion, assignment identities and relations, and effective assignment dates. Missing response properties are not automatically negative facts.

## C5 — Canvas pagination

[Canvas pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)

Default page size, unspecified maximum page size, and following Link pagination rather than assuming a single page is complete.

## C6 — Canvas throttling

[Canvas throttling](https://developerdocs.instructure.com/services/canvas/basics/file.throttling)

Dynamic request-cost limits and HTTP 429; supports bounded concurrency and retry handling.

## C7 — Canvas courses API

[Canvas courses API](https://developerdocs.instructure.com/services/canvas/resources/courses)

GET /api/v1/courses and its scope; paginated current-user course discovery.

## F1 — Cloudflare Workers limits

[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Free request and CPU limits, outbound subrequests, simultaneous connections, and execution lifecycle. Check current limits again before deployment.

## F2 — Cloudflare Workers pricing

[Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Incoming Worker requests versus outbound subrequests and direct static asset delivery. Routing requests through Worker code or enabling other products can change usage accounting.

## F3 — Cloudflare D1 pricing

[Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Rows read/written and storage allowances; indexes can add writes. Count staging, cleanup, and operational writes as well as assignment changes.

## F4 — Cloudflare D1 limits

[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Per-database and per-account limits; the Free plan has a 500 MB per-database size limit despite a larger account allowance.

## F5 — Workers static asset configuration and bindings

[Workers static asset configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)

Asset binding and selective run_worker_first configuration; an example is not a deployed application.

## F6 — Workers secrets

[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Server-side secret bindings and local .dev.vars handling. Do not put secrets into public vars or Git. Some secret commands deploy a version immediately.

## F7 — D1 Database API

[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Prepared statements, batch transaction/rollback semantics, and operation metadata. A batch is not a transaction spanning separate HTTP requests.

## S1 — OWASP OAuth security cheat sheet

[OWASP OAuth security cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)

OAuth security guidance. Browser-bound state, strict redirects, PKCE compatibility checks, and token confidentiality are design requirements, not an audit certification.

## Uploaded prototype evidence

The owner supplied the prototype frontend, launcher, and resulting JSON data. The frontend copies and their checksums are recorded in `MANIFEST.json`; detailed observations and original line references are in `docs/06-SOURCE-REVIEW.md`. The original student JSON and launcher are deliberately not distributed.

This package distinguishes three evidence classes: observations of the supplied prototype, facts from the primary documentation above, and proposed product requirements. Synthetic fixtures are invented examples of the proposed model, not representations of a verified Canvas response. The original backend, importer, exporter, and application test suite were not supplied.

The proposed architecture, defaults, data model, acceptance tests, and implementation sequence are design recommendations. They are not claims that the existing prototype or any deployed application already implements them.
