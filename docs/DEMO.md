# Demonstration script and acceptance status

Run this from a clean reset. Times are WAT.

```bash
npm run reset
npm start
```

Sign in as `tunde.bello@atlas.demo` with the password from the README.

## The thirteen step workflow

| # | Criterion | How to see it | Evidence |
| --- | --- | --- | --- |
| 1 | A fictional subsidiary and obligation exist | Overview lists Northgate Energy, Kestrel Property, Sahel GovTech | `scripts/seed.ts`, seed counts printed on reset |
| 2 | An obligation's deadline is in the past | Next deadlines shows Fire safety certificate submission, due three weeks ago | relative dates at seed time |
| 3 | Scheduler or manual trigger runs | Compliance, then Run compliance check | `compliance_check` row, counters on the page |
| 4 | Obligation identified as overdue | Status becomes OVERDUE, appears in Overdue obligations | `tests/acceptance.test.ts` case 1 |
| 5 | A compliance assessment is recorded | The check history row carries scanned, overdue, alerts, and status | `compliance_check` |
| 6 | An alert is created | Alert centre, newest overdue obligation | `alert` with dedupe key |
| 7 | An agent run is recorded | Agent activity shows trigger, status, model, duration | `agent_run` |
| 8 | An escalation draft is created | Alert detail, "Escalation awaiting your decision" with subject and body | `approval.payload` |
| 9 | Approval is required | The draft cannot be sent from that page without a decision | status ESCALATION_PENDING |
| 10 | An authorised user approves | Press Approve and record escalation | approval EXECUTED, decided_by set |
| 11 | The action executes through the handler | Executed actions shows SEND_ESCALATION, channel IN_APP | `action` row, `simulated: true` |
| 12 | The outcome appears in the audit trail | Agent activity, audit table: approval.approved, action.executed | `audit_event` |
| 13 | Re-running creates no duplicate | Run compliance check again: 0 new alerts, 0 new runs | `tests/acceptance.test.ts` case 3 |

All thirteen are covered by automated tests as well as by the UI path.

## Negative cases

| Case | Expected behaviour | Verified by |
| --- | --- | --- |
| Missing or invalid API key | Document stored, rules run, run marked DEGRADED with the provider error, deterministic draft used | `agent.ts` fallback, `documents.ts` degraded path, HTTP test with no key |
| Model timeout | Same as above, error recorded as TimeoutError | `AbortSignal.timeout`, degraded path |
| Malformed model output | Schema rejection, one repair attempt, then DEGRADED; nothing invalid is stored | `tests/rules.test.ts`, `ai.ts` |
| Invalid upload type | 400 before parsing, nothing stored | `tests/acceptance.test.ts`, `tests/rules.test.ts` |
| Missing required fields | 400 with a specific message, no write | CSRF and obligation validation in `server.ts` |
| Unauthorised access | 401 for no session, 403 for wrong role | `tests/http.test.ts` |
| Rejected approval | Status REJECTED, alert back to OPEN, zero action rows | `tests/acceptance.test.ts` |
| Duplicate action attempt | Second decision returns CONFLICT, one action row only | `tests/acceptance.test.ts` |
| State changed after approval | EXPIRED, execution refused, fresh assessment queued | `tests/acceptance.test.ts` |
| Invalid state transition | Refused with the current and requested status named | `tests/acceptance.test.ts` |
| Concurrent sweeps | Second returns SKIPPED, zero records written | `tests/acceptance.test.ts` |
| Database unavailable | `/healthz` 503 with latency and error, pages return a generic 500 | manual, `healthCheck()` |

## What to say if asked what is simulated

Everything external. The portfolio, the documents, and the people are synthetic. Approved escalations are delivered to an in application queue; no email, Teams message, or SMS is sent, and the action record says `simulated: true` and `external_delivery: none`. The model is real when a provider key is configured, and its output is labelled `AI` and never promoted to fact. When no key is configured, every draft is labelled `deterministic-rules` and the run is `DEGRADED`.

The audit trail is append only at the application and database level. It is not cryptographically tamper proof, and the documentation says so.

## Questions a reviewer is likely to ask, with short answers

**Why not Next.js and NestJS?** One deployable was the lower risk bet for the window, and the compliance logic is transport agnostic. Recorded in `docs/DECISIONS.md` ADR 1.

**How do you stop duplicate alerts when two sweeps overlap?** Advisory lock for the run, partial unique index for the alert, plus a running flag in the scheduler. Tested.

**What stops the model from doing something harmful?** It has no tools, its output is schema validated, it can only produce a draft, and execution requires a human decision plus a fingerprint match.

**What happens if the reviewer approves something that has changed?** Execution is refused, the approval expires, and a fresh assessment with a new fingerprint is queued. Demonstrated in the tests.

**How would this handle PDFs?** Not built. The intake boundary is text only today; PDF parsing belongs in a worker so a slow parser cannot hold a request, and it needs a sandbox because parsers are an attack surface.

**Is it compliant with the NDPA?** No. It is designed to make compliance achievable: minimisation, role based access, retention via reset, audit. A real deployment needs a DPIA, a DPO where required, and legal review. `docs/SECURITY.md` is explicit about the gap.

**What is not production ready?** No MFA, no user administration, no durable scheduler on hosts that sleep, no PDF intake, no external delivery, no CI pipeline.
