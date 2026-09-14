# Proposed data model and deterministic rules

This is a schema design to validate, not an executable migration. Avoid implementing future entities before the phase that needs them. All example IDs in `fixtures/` are invented.

## Identity and ownership

| Entity | Essential fields / boundary |
| --- | --- |
| `institutions` | Internal ID, approved origin, adapter/capabilities, developer-key reference; no client secret in public config |
| `accounts` | Internal account ID, institution ID, Canvas user ID as a string; unique institution + Canvas user |
| `connections` | Account ID, encrypted tokens, expiry, credential/key version, status, revocation/sync generation |
| `sessions` | Hashed session ID, account, expiry, revocation; never store plaintext cookie values |
| `oauth_attempts` | Hashed state, pre-auth binding, institution, exact redirect, expiry, consumed state |
| `courses` | Owner + institution + Canvas course ID, selected state, display metadata, term context |
| `source_items` | Owner/course/type/source ID, normalized facts, field-presence metadata, fingerprint, availability/version |
| `tasks` | Stable internal ID, owner, course or unassigned, optional source item, parent, kind |
| `task_state` | Owner/task, progress, personal title/notes/target, dismissal and reason, mutation version |
| `task_rules` | Owner/course, versioned parameters, preview/acceptance, exceptions |
| `suggestions` | Owner, candidate fields, evidence, rule/parser version, acceptance/rejection |
| `sync_runs/resources` | Owner, generation/fence, resource completion, cursors, budgets, error class, timestamps |
| `change_events` | Owner, source/task, meaningful before/after projection, observed time, acknowledgement |
| `mutation_receipts` | Owner + idempotency key, result/version, bounded expiry |

IDs arriving from Canvas should be handled without JavaScript integer precision loss; normalize the provider's supported ID representation carefully. Do not convert an already rounded number back to a string and claim the original was preserved. Test large IDs or explicitly request/validate a safe representation supported by the API.

Ownership must exist in every query path. Join conditions and unique indexes should prevent attaching one account's child to another account's parent. Names/emails are presentation data, not identity keys. A second school may issue an identical Canvas numeric ID and still represents a different identity.

## Source projection

For basic assignments retain the source identifiers, title, safe source link, kind/relationship metadata, effective due instant, availability instants, points if needed, and the current student's relevant submission fields. Ignore unnecessary rosters, full attachments, comments, instructor data, and external-tool payloads. Do not persist entire raw responses by default.

Represent a source field with an explicit state where needed: `known(value)`, `known-null`, `not-returned`, or `unsupported`. A plain null cannot express all of those. Submission omission may have different meanings depending on endpoint/capability; verify the contract rather than guessing [C3, C4].

Fingerprint a canonical, versioned projection of meaningful source fields. A new sync timestamp or reordered JSON keys should not produce a change. Changing a student's applicable deadline should. Sort order of semantically unordered arrays must be canonicalized.

Track `last_successful_check_at` on the complete resource snapshot, not as a required write to every unchanged assignment. Preserve original timestamps when available. A field's observation time and the source's own update time are distinct.

## Personal mutation contract

An application mutation proposes `taskId`, `operationId`, `expectedVersion`, and allowed field changes. The backend supplies the owner from the session and validates a field allowlist; client-provided `ownerId`, official deadlines, grades, and source identity are not writable personal fields.

Replaying the same operation must not create a duplicate event or a second task. A conflicting personal edit returns a conflict response with current state. Do not reload and discard unsaved notes. Safely merge independent fields when possible; show conflicts for simultaneous edits to the same note. Device clocks are not trusted ordering authorities.

A Canvas sync updates source fields independently of `task_state`, so it cannot reset a checkbox or notes. Local completion, Canvas submission, and optional student dismissal are separate dimensions. Default progress values might be `not_started`, `working`, and `finished`; dismissal remains orthogonal.

## Deadlines

Use typed values: timed instant; all-day civil date; unknown. Keep the relevant IANA zone for interpretation and display. Personal target dates never overwrite official due dates. Explicitly distinguish a date-only completion record imported from the old app from a precise completion timestamp.

For calendar-based rules, use civil-date arithmetic in the course's configured zone, not a fixed 24-hour subtraction that breaks around daylight-saving changes. An ambiguous or nonexistent local time must not silently move. Validate impossible dates and source timestamps.

## Discussion and compound-work rule

One parent assignment can have an initial-response child and reply children or a reply-count obligation. Parent points are not copied onto every child. Progress denominators must not count both the parent and all children as independent graded work. Present a clear aggregate such as “1 of 3 steps complete.”

Prefer actual structured checkpoints when the institution/API exposes and authorizes them. Do not fabricate a checkpoint API shape from the synthetic fixture. The fixture uses normalized proposed objects for this reason; verify raw provider fields during implementation.

Fallback template example, accepted by a student:

```json
{
  "ruleType": "discussion_week_split",
  "version": 1,
  "weekStartsOn": "monday",
  "anchor": "parent_effective_due_date",
  "initialPost": {"weekday": "wednesday", "localTime": "23:59"},
  "replies": {"count": 2, "due": "parent_effective_due_at"},
  "timeZone": "America/New_York"
}
```

Preview actual dates before accepting. Reject or request clarification when the rule puts an initial post after the reply deadline, lacks an anchor, or contradicts explicit accepted information. No blanket rule applies to every assignment just because its title contains “discussion.” Scope it to typed relationships and selected courses.

Generated children use stable rule/parent identities. Re-running a rule does not duplicate them. A rule edit previews affected future work and preserves completed or individually edited children. An official checkpoint arriving later prompts safe reconciliation; do not erase personal work or double-create obligations.

## Exceptions and other majors

“Instructor canceled it” is a personal decision with provenance unless Canvas itself supplies a relevant fact. Store the explanation privately and preserve it after refresh. A meaningful later change can set `needs_review`, not force the task back to unfinished.

A personal studio-material reminder, a policy-paper research step, or a lab preparation task may have no `canvasId`. These belong in the task model and UI. A syllabus forecast remains only a suggestion until accepted, even if old source text called it “confirmed.”

Later module-completion support must distinguish view, contribute, submit, and score requirements. A resource link is not automatically an assignment. Do not fetch classmates' discussion bodies to infer completion; use authorized student/checkpoint status or ask the student to track the remaining steps.
