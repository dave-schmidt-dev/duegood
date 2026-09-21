# Local executor environment

The Phase 0 executor is a credential-free, project-contained qualification target. It is not an alternate production runtime and is not authorized to contact a model provider until Task 0.2 records an approved credential path.

## Fixed inputs

- OpenCode CLI: `1.18.30`
- Model selector: `opencode-go/deepseek-v4.1-flash`
- Variant: `high`
- Smokescreen source: `609eb8931420453daf5893509be0b25b21bd9edb`
- Executor base: `node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85`
- Proxy build base: `golang:1.25.1-bookworm@sha256:c423747fbd96fd8f0b1102d947f51f9b266060217478e5f9bf86f145969562ee`
- Proxy runtime base: `debian:bookworm-20250908-slim@sha256:df52e55e3361a81ac1bead266f3373ee55d29aa50cf0975d440c2be3483d8ed3`

Every executor receipt records the observable OpenCode version, model selector, variant, source-tree identity, proxy revision, patch digest, and network-policy identity. The provider exposes no immutable backing-model digest, so matching metadata detects observable drift but does not prove provider-side immutability.

## Boundaries

The executor is non-root, capability-free, `NoNewPrivs`, seccomp-confined, and read-only except for declared tmpfs, one disposable source bind, and separate session/cache volumes. The credential directory is a separate read-only bind. The source is materialized from a temporary Git index and archive and contains no `.git` path. The untracked owner file `main` is never selected implicitly.

The executor joins only the internal `executor` network. Smokescreen is the sole dual-homed service and uses an enforce-mode hostname allowlist. A project-owned wrapper assigns the fixed `duegood` role to clients on that internal network and rejects every CONNECT destination except port 443 before Smokescreen resolves or dials it. Direct egress, unlisted hosts, non-HTTPS ports, private/link-local/metadata destinations, and address-form bypasses are qualification failures.

## Commands

Static and self-tests do not use credentials or make provider calls:

```sh
bash -n scripts/opencode-task.sh dev/opencode/entrypoint.sh test/container/*.sh
node scripts/check-local-first-override.mjs
node scripts/check-local-contract-receipt.mjs --self-test
node scripts/verify-executor-receipt.mjs --self-test
npm run test:membership
```

The host captain owns the live credential-free Docker gate:

```sh
npm run test:container -- --credential-free
```

Any executor image, proxy source or policy, route, DNS, VPN, LAN, Docker/OrbStack, model metadata, or host-network change invalidates route-sensitive qualification and requires that gate again. A real OpenCode request remains blocked pending Task 0.2 authority.
