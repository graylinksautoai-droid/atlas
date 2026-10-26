# Architecture

## Shape

```
            ┌──────────────────────────────────────────────────────────┐
            │ Single Node process (Fastify, TypeScript via node --strip)│
            │                                                          │
  Browser ──▶  routes ──▶ portfolio.ts ───────────────▶ PostgreSQL 16  │
            │    │            ▲                              ▲        │
            │    │            │                              │        │
            │    ├──▶ compliance.ts ── rules ── alerts ──────┤        │
            │    │        │                                  │        │
            │    │        └──▶ agent.ts ── ai.ts ─────────────┘        │
            │    │                 │                                   │
            │    ├──▶ documents.ts ─┘                                  │
            │    │                                                    │
            │    └──▶ views/ (server rendered HTML, one CSS file)      │
            │                                                          │
            │ scheduler.ts: setInterval ──▶ compliance.ts (same call)  │
            └──────────────────────────────────────────────────────────┘
```

One deployable. No client bundle, no second service, no queue. The browser receives HTML and posts forms; the only JavaScript on the page is none at all.

## Responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| `server.ts` | HTTP, session, RBAC, CSRF, rate limits, headers, error shape | business rules |
| `portfolio.ts` | read models and aggregates | writes |
| `compliance.ts` | detection, severity policy, alert and risk creation, idempotency, locking | approvals, delivery |
| `agent.ts` | evidence assembly, escalation drafting, approval lifecycle, execution | detection policy |
| `documents.ts` | intake, extraction, provenance-labelled findings | approval |
| `ai.ts` | provider calls, schema validation, prompt hardening, fallback | persistence |
| `rules.ts` | pure functions: severity, dedupe keys, fingerprints, required sections | I/O |
| `obligations.ts` | guarded status transitions | detection |
| `audit.ts` | append only writes | reads (queries live in portfolio) |

The separation that matters most is decision versus execution. `compliance.ts` decides that something is late. `agent.ts` decides what to propose. Neither can act. Only `decideApproval` writes an `action`, and only after a human decision and a fingerprint check.

## The sweep

```
POST /compliance/run ─┐
scheduler tick ───────┴──▶ runComplianceCheck({ trigger })
                              │
                              ├─ pg_try_advisory_lock(727001)   → SKIPPED if held
                              ├─ INSERT compliance_check RUNNING
                              ├─ SELECT open/submitted/overdue obligations due ≤ now + 72h
                              ├─ for each obligation, in its own transaction:
                              │     ├─ overdue?      → severity from days late
                              │     ├─ missing doc?  → only when state claims submitted with no file
                              │     ├─ due soon?     → severity from hours remaining
                              │     └─ incomplete?   → deterministic section check on submissions
                              │     ├─ raise alert (dedupe → update evidence if already open)
                              │     ├─ move obligation OPEN → OVERDUE, version + 1
                              │     ├─ upsert risk for overdue conditions
                              │     └─ audit alert.created
                              ├─ for new HIGH/CRITICAL overdue alerts:
                              │     └─ agent.ts → agent_run → draft → approval PENDING
                              └─ UPDATE compliance_check OK, counters, audit check.completed
```

Concurrency has two layers. The advisory lock stops two sweeps overlapping across connections or processes that share the database. The partial unique index on `alert (dedupe_key) WHERE status NOT IN ('RESOLVED','DISMISSED')` stops duplicates even if a future caller bypasses the service. A per-run `running` flag in the scheduler prevents piling up intervals.

Failure containment: each obligation is evaluated in its own transaction, so one bad row cannot abort the sweep. A failed run writes `FAILED` and the error onto `compliance_check`, plus an audit event. The next run is safe because nothing partial was committed.

## The agent

```
trigger ──▶ evidence ──▶ deterministic policy ──▶ model (optional) ──▶ schema ──▶ policy ──▶ approval ──▶ audit
```

- The agent has no tools. Its only writes are through `handleAlert`.
- The model receives a JSON evidence block and returns a draft escalation. The draft must satisfy a zod schema with length and confidence bounds.
- If the provider is missing, slow, erroring, or returns invalid JSON, the deterministic template is used, the run is recorded as `DEGRADED`, and the approval payload records `generated_by: deterministic-rules`. The UI shows that string.
- Policy decides whether approval is needed: only HIGH or CRITICAL overdue obligations escalate. The model never decides that.
- The approval payload is frozen at request time, including the obligation version.

## Approval and execution

```
decideApproval(approvalId, user, decision)
   │
   ├─ SELECT ... FOR UPDATE, status must be PENDING
   ├─ REJECTED → approval REJECTED, alert OPEN, audit, return
   └─ APPROVED
        ├─ recompute fingerprint from the obligation row
        ├─ mismatch → approval EXPIRED, alert OPEN, audit, re-run agent, return EXPIRED
        └─ match → INSERT action (IN_APP, simulated), approval EXECUTED, alert ESCALATED, audits
```

The row lock makes the transition single use: a double click or retried request finds `EXECUTED` and returns `CONFLICT`. The fingerprint makes the approval single purpose: if the obligation changed in any material way after the reviewer loaded the page, the decision is refused and a new assessment is requested. The action record states, in its own result JSON, that no external message was sent.

## Documents

```
upload → extension/MIME/size → utf8 decode → sha256 → duplicate? return existing
       → INSERT document
       → FACT findings (length, stated period)
       → RULE findings (missing required sections, attestation presence)
       → obligation OPEN/OVERDUE → SUBMITTED, version + 1
       → model assessment (optional) → schema → AI findings + RECOMMENDATION
       → agent_run DOCUMENT OK / DEGRADED
       → audit
```

Provenance is a column, not a convention. The page groups findings by it: facts, rules, model interpretation, recommendation. A model claim cannot appear under facts.

## Scheduling

`setInterval` in process, started with the server, 15 minutes by default, plus one sweep ten seconds after boot. Each tick calls the same exported function the button calls. The interval is `unref`'d so it never holds the process open on shutdown.

This is a deliberate, documented trade-off: it is real scheduled execution, but it is not durable. On a host that sleeps, use platform cron against `POST /api/compliance/run` with a service account. Nothing in the business logic changes.

## Scaling path, if it were needed

Not built, because there is no load to justify it:

1. Move the scheduler to a separate worker process, keep the advisory lock, and the API becomes stateless.
2. Replace the in-process interval with a job table and a `SELECT ... FOR UPDATE SKIP LOCKED` poller.
3. Add read replicas for `portfolio.ts` aggregates.
4. Split document parsing into a worker if PDF or OCR intake is added.

None of these change the domain code, which is the point of keeping the compliance and approval logic free of transport concerns.
