# Architecture decisions

Each entry records the decision, the alternative, and what it costs. Dates are omitted deliberately; these are the decisions as they stand.

## ADR 1: one Fastify process, server rendered HTML

**Chosen.** A single Node process serves pages, forms, and the JSON API. HTML is rendered on the server from template literals. The only stylesheet is hand written.

**Rejected.** Next.js front end plus NestJS API, as the brief suggested as a default.

**Why.** The value of this demonstration is the compliance logic, the approval guard, and the audit trail. Splitting them across two deployables and a client bundle adds two build pipelines, CORS and cookie configuration, and a second failure surface on a deadline. On a 2 GB host, a Next build is also a real risk of running out of memory. Server rendering also removes an entire class of bug: there is no duplicated client state that can disagree with the database.

**Cost.** Filtering and navigation are full page loads. Optimistic UI is not possible. If the product grew to heavy interactive tables, this would be revisited, and the read models in `portfolio.ts` already return JSON so a client could be added without touching the domain code.

## ADR 2: SQL migrations, no ORM

**Chosen.** Versioned `.sql` files applied by a small runner that records versions in `schema_migrations`. A thin `pg` wrapper with typed query helpers.

**Rejected.** Prisma, which the brief listed as default.

**Why.** The interesting constraints here are partial unique indexes, a check constraint tying `completed_at` to status, a row level trigger on the audit table, and numeric money types. Those are clearer in SQL than in a schema DSL, and the generated client adds a download, a generate step, and an engine to the deploy. For fourteen tables, hand written SQL with typed helpers is smaller and more legible to a reviewer.

**Cost.** No automatic type generation from the schema, so row types are declared by hand where they matter. No relation loading convenience; joins are written explicitly, which is also why the aggregates are easy to audit.

## ADR 3: schedule inside the process, with an honest limitation

**Chosen.** `setInterval` calls the same `runComplianceCheck` service as the button, guarded by an advisory lock and a local running flag.

**Rejected.** A durable job queue or a separate worker for the MVP.

**Why.** The requirement is that monitoring does not depend on a user loading a page. An interval satisfies that on a long lived host without new infrastructure. The lock makes it safe if two processes ever exist. The README and `/healthz` state the limitation rather than claiming continuous monitoring.

**Cost.** If the host sleeps, sweeps stop. The documented path is platform cron against `POST /api/compliance/run`, which is the same service, so no business logic forks.

## ADR 4: deterministic policy, model only for language

**Chosen.** Severity, escalation requirement, dedupe keys, and required sections are pure functions. The model drafts prose and interprets documents. Every model output is schema validated and stored under `AI` provenance.

**Rejected.** Letting the model decide severity or whether to escalate.

**Why.** A hiring panel, an auditor, or a regulator will ask why an action was taken. "The model said so" is not an answer. Policy that is testable in `tests/rules.test.ts` is. The model is used where it is genuinely better: reading a document and writing a clear note.

**Cost.** The system is only as good as its thresholds. A real deployment would need those thresholds agreed with the business, and probably per obligation kind.

## ADR 5: approvals are single use and fingerprinted

**Chosen.** An approval stores a hash of the obligation id, status, due date, version, and updated timestamp. Execution recomputes it and refuses on mismatch, marking the approval EXPIRED and requesting a fresh assessment.

**Rejected.** Executing on approval alone, on the grounds that a human already looked.

**Why.** The reviewer approved a specific state. If a submission arrived while the page was open, the escalation may be wrong, or unnecessary. Refusing is the safe direction, and the reviewer sees why.

**Cost.** A busy obligation can expire an approval legitimately. That is a feature: it forces a second look at the current facts.

## ADR 6: application level delivery, labelled

**Chosen.** Approved escalations are written to `action` with `channel = IN_APP`, `simulated: true`, and `external_delivery: none`. The UI says so next to the action.

**Rejected.** Wiring a real email or Teams integration for the demonstration.

**Why.** A half configured integration that silently fails is worse than an honest in application queue, and claiming a message was sent when it was not is the one thing that would undermine every other claim in the build.

**Cost.** The demonstration cannot show a real inbox receiving the escalation. The audit record is the artefact instead.

## ADR 7: text only uploads for now

**Chosen.** `.txt` and `.md`, 256 KB, explicit MIME check.

**Rejected.** PDF and DOCX parsing with OCR.

**Why.** Every added parser is an attack surface and a failure mode, and the assessment logic is identical once text exists. Given the delivery window, the intake boundary was worth more than format coverage.

**Cost.** A reviewer with a PDF must paste the text. The README lists PDF intake as the first post MVP item, alongside a worker to do the parsing off the request path.

## ADR 8: relative dates in seed data

**Chosen.** Every seeded due date is computed from `now()` at seed time, so the demonstration always contains overdue, due soon, submitted, and completed obligations.

**Rejected.** Fixed dates, which make a portfolio demo stale within a week and produce a dashboard where nothing is ever late.

**Why.** The product is about deadlines. A demo where all deadlines are in the past cannot show the product.

**Cost.** Screenshots age; `npm run reset` is the answer, and it is documented.

## ADR 9: no client JavaScript

**Chosen.** Forms and links only. No hydration, no bundle.

**Why.** The interaction model is: read a page, take a decision, see the result. That is a form. It also means the Content Security Policy can be `script-src 'none'`, which removes the largest class of web vulnerability from the demonstration entirely.

**Cost.** No inline validation, no live filters. Server round trips for everything. Acceptable at this scale, and the CSP is worth more than the polish.
