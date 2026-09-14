# Due Good

**Your assignments, deadlines, and next steps in one place.**

A planned, independent student assignment tracker, starting with Marymount University students using Canvas. Built for students of any major, not only people comfortable with developer tools.

**Status: specification and local-agent handoff, not a working hosted application.** The public GitHub repository exists, but OAuth approval, infrastructure provisioning, application implementation, and live testing have not been completed by this package.

## Start here

Give your coding agent [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md). It must inspect the local project and write an implementation plan before changing application code.

The owner's requested sequence is fixed:

1. **Canvas OAuth and Cloudflare setup first**, including the smallest safe end-to-end connection and import.
2. **Optimization and durable synchronization.** Measure actual usage and stay on genuinely free services.
3. **Generalization.** Remove personal-course assumptions and support ordinary student workflows.
4. **UI and accessibility.** Keep the useful timeline; add a simple daily/weekly experience.

Security, tenant isolation, honest persistence, and protection from data loss start in phase 1. They are not postponed as later optimization work.

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
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | Current four-phase implementation plan and quality gates |
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

The checks do **not** establish that OAuth, Cloudflare deployment, or a production app works. The estimator is arithmetic using declared assumptions, not a benchmark.

## Public-source precautions

Only the prototype HTML, CSS, and JavaScript are retained as reference code. The original `courses.json`, `coursework.json`, refresh history, and launcher are deliberately excluded. Do not copy the original workspace wholesale into this repository. Synthetic fixture files are clearly labeled and have unrelated IDs.

The config in `templates/wrangler.example.jsonc` deliberately points to application code that an agent still needs to create. It is not a deployable finished app. Never deploy `reference/` or the repository root as a static asset directory.

This project is available under the [MIT License](LICENSE). The license does not claim to clear university trademarks or imply university endorsement.
