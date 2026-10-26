# Data model

Fourteen tables, three of which exist only to make accountability legible: `compliance_check`, `agent_run`, `audit_event`. Money is `numeric(16,2)`. Every timestamp is `timestamptz`, written in UTC, displayed in `Africa/Lagos` and labelled WAT.

## Relationships

```
subsidiary 1───n project 1───n obligation 1───n document 1───n document_finding
     │                            │
     │                            ├───n alert 1───n approval 1───n action
     │                            └───n risk
     └───n risk

app_user 1───n session
app_user 1───n document (uploaded_by)
app_user 1───n approval  (decided_by)
compliance_check 1───n agent_run
alert 1───n agent_run
document 1───n agent_run
```

`audit_event` sits outside the graph on purpose: its `entity_type` and `entity_id` are strings so it can record anything without foreign keys that would block deletion of the referenced row.

## Tables

### app_user
Purpose: the three demonstration identities and their roles.
Key: `id uuid`. Fields: `email text` unique (lowercase enforced), `name`, `role` in EXEC/COMPLIANCE/ADMIN, `password_hash` (scrypt), `is_active`, `created_at`.
Rules: email must be lowercase. Deactivating a user keeps their audit history.

### session
Purpose: server side sessions. `id text` (64 hex characters, opaque), `user_id`, `csrf_token`, `expires_at`.
Rules: expired rows are rejected on read and purged hourly. Deleting a user cascades.

### subsidiary
`id`, `code` (unique, case insensitive), `name`, `sector`, `description`.
Self contained by design: deleting a subsidiary with projects is refused by `ON DELETE RESTRICT` on `project`.

### project
`id`, `subsidiary_id`, `code` unique, `name`, `status` (ACTIVE, AT_RISK, ON_HOLD, COMPLETED), `budget_ngn numeric(16,2)`, `start_date`, `target_date`, timestamps.
Index: `(subsidiary_id, status)` for portfolio rollups.

### obligation
The unit of compliance. `id`, `project_id`, `title`, `kind` (REGULATORY, BOARD, AUDIT, REPORT, TAX, LICENCE), `due_at`, `status` (OPEN, SUBMITTED, OVERDUE, COMPLETED, WAIVED), `owner_name`, `requires_document`, `completed_at`, `last_evaluated_at`, `version`, timestamps.
Constraint: `completed_at IS NOT NULL` exactly when status is COMPLETED.
Index: `(status, due_at)` for the sweep.
Lifecycle:

```
OPEN ──past due──▶ OVERDUE ──document──▶ SUBMITTED ──approval/closure──▶ COMPLETED
  │                   │                      │
  ├──document────────▶└──────────────────────┘
  └──waive──▶ WAIVED            any closed state ──reopen──▶ OPEN
```

`version` increments on every material change and feeds the approval fingerprint.

### document
`id`, `obligation_id`, `filename` (truncated to 180), `mime`, `size_bytes`, `sha256 char(64)`, `body_text`, `uploaded_by`, `created_at`.
Unique: `(obligation_id, sha256)`. The same bytes cannot be assessed twice against one obligation, but the same document may be submitted against a different obligation.

### document_finding
`id`, `document_id`, `provenance` (FACT, RULE, AI, RECOMMENDATION), `code`, `label`, `detail`, `evidence_quote` (verbatim excerpt, nullable), `confidence numeric(4,3)` bounded 0 to 1.
Why a table rather than JSON on `document`: findings are queried (alerts are raised from `MISSING_SECTIONS`), counted, and grouped by provenance in the interface. The confidence column would be meaningless inside an opaque blob.

### compliance_check
One row per sweep. `trigger` (SCHEDULER, MANUAL), `status` (RUNNING, OK, FAILED), `started_at`, `finished_at`, `scanned`, `overdue`, `alerts_created`, `error`.
This is the observability record for the engine; it is deliberately separate from `agent_run`, which records reasoning.

### agent_run
`id`, `trigger` (SCHEDULER, MANUAL, DOCUMENT), `status` (RUNNING, OK, DEGRADED, FAILED), `model` (null when deterministic), `started_at`, `finished_at`, `summary`, `evidence jsonb`, `proposed_actions jsonb`, `completed_actions jsonb`, `error`, `check_id`, `alert_id`, `document_id`.
JSON is justified here: evidence and action lists vary by trigger and are read as a whole record, never joined or filtered. `DEGRADED` is a first class status because "the model did not answer and policy text was used" must be visible, not inferred.

### alert
`id`, `type` (OVERDUE_OBLIGATION, DUE_SOON, MISSING_DOCUMENT, DOCUMENT_INCONSISTENCY), `severity`, `subsidiary_id`, `obligation_id`, `dedupe_key`, `evidence_summary`, `recommended_action`, `status` (OPEN, ESCALATION_PENDING, ESCALATED, RESOLVED, DISMISSED), timestamps.
Partial unique index: `dedupe_key` unique among rows whose status is not RESOLVED or DISMISSED. That is the whole idempotency guarantee, enforced by the database rather than by application politeness.
Lifecycle: OPEN → ESCALATION_PENDING (approval requested) → ESCALATED (executed) or back to OPEN (rejected, expired); → RESOLVED when the obligation closes.

### risk
`id`, `subsidiary_id`, `obligation_id` nullable, `title`, `severity`, `status` (OPEN, MITIGATED, ACCEPTED, CLOSED), `rationale`, timestamps.
Unique `(obligation_id, title)` so re-running a sweep updates severity instead of stacking duplicates.

### approval
`id`, `alert_id`, `proposed_action` (SEND_ESCALATION), `payload jsonb` (subject, body, rationale, confidence, channel, generator, obligation version), `state_fingerprint`, `status` (PENDING, APPROVED, REJECTED, EXPIRED, EXECUTED), `requested_by_run`, `decided_by`, `decided_at`, `comment`, `executed_at`, `created_at`.
Partial unique index: one PENDING approval per alert.
Constraint: a decided status must have a decision timestamp; PENDING must not.
Payload is frozen at request time, so the reviewer's decision applies to exactly the text they read.

### action
`id`, `approval_id`, `alert_id`, `kind`, `channel` (IN_APP today), `status` (EXECUTED, FAILED), `result jsonb`, `executed_at`.
The result JSON always carries `simulated: true` and `external_delivery: none` in this build. This table is what makes "an action happened" auditable rather than asserted.

### audit_event
`id bigserial`, `at`, `actor_type` (USER, AGENT, SYSTEM), `actor_id`, `action`, `entity_type`, `entity_id`, `detail jsonb`, `request_id`.
Append only via trigger. Indexed by time and by entity.
JSON is justified because detail differs per action and is read by humans, not joined.

## Deliberate omissions

- No `Role` table. Three fixed roles are a `CHECK` constraint; a permission matrix would be theatre at this size.
- No `Deliverable` table. A deliverable without its own deadline is an obligation with `requires_document` and a kind. Two tables would duplicate the due date and drift.
- No `ComplianceAssessment` table. The per obligation outcome is represented by the alert, the risk row, and the check counters; a fourth copy would need reconciling.
- No `PortfolioMetric` table. Every KPI is an aggregate over live rows. Storing them would create a second truth.
- No soft deletes. Domain rows are not deleted by the application at all; the only deletion path is the reset script.

## Time and money

- All writes use `now()` on the database, in UTC. The application never formats a date for storage.
- Display converts to `Africa/Lagos` and appends `WAT`, so a reviewer cannot mistake a stored UTC value for local time.
- `due_at` is an instant, not a date, because "due by 17:00" matters for ticketing the same day.
- Budgets are `numeric`; there is no currency column because the portfolio is single currency by construction in this demonstration.

## Reset

`npm run reset` truncates in dependency order and reseeds with dates relative to now. It restarts identity sequences. It is the only supported way to wipe the demonstration, and it is never called from the application.
