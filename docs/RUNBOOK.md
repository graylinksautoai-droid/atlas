# Runbook

## First run

```bash
sudo -u postgres psql -c "CREATE ROLE atlas LOGIN PASSWORD 'atlas'"
sudo -u postgres psql -c "CREATE DATABASE atlas OWNER atlas"
sudo -u postgres psql -c "CREATE DATABASE atlas_test OWNER atlas"
cp .env.example .env            # then edit DATABASE_URL, SESSION_SECRET
npm ci
npm run migrate
npm run seed
npm start
```

Check `http://127.0.0.1:8090/healthz`. It reports database latency, whether the scheduler is enabled, the interval, and whether a model is configured. A degraded database returns 503 with the error message, which is safe to expose because it contains no credentials.

## Routine operations

| Task | Command |
| --- | --- |
| Apply new migrations | `npm run migrate` (idempotent) |
| Reset the demonstration | `npm run reset` |
| Full check | `npm test && npm run typecheck` |
| Tail logs when run by systemd | `journalctl -u atlas -f` |
| Confirm scheduler health | `curl -s localhost:8090/healthz` |
| Manual sweep without the UI | `POST /api/compliance/run` with a session and CSRF header |

Migrations are applied inside a transaction per file and recorded in `schema_migrations`. A failed migration rolls back and names the file. Never edit an applied migration; add a new one.

## Deploying

1. Managed PostgreSQL. Set `DATABASE_URL` with `sslmode=require` if the provider requires TLS.
2. Environment: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` from the platform, `SESSION_SECRET` from a secret manager, `COOKIE_SECURE=1`.
3. Release step: `npm ci && npm run migrate`.
4. One time: `npm run seed`, or leave it empty and create data through SQL. The demonstration is more convincing with seed data.
5. Start: `npm start`. Health check: `/healthz`.
6. Put TLS in front. Keep `trustProxy` enabled only when the proxy is under your control.

The process holds no local state. Restarting it is safe; sessions live in the database and the scheduler resumes on boot.

## If the scheduler does not run

Symptom: `/healthz` shows `scheduler.enabled: false`, or the host sleeps between requests.

Options, in order of preference:

1. Set `SCHEDULER_ENABLED=1` and run the process on an always on host.
2. Leave the internal scheduler off and schedule `POST /api/compliance/run` from the platform's cron with a dedicated COMPLIANCE session. Same service, same audit records.
3. Run the sweep from a separate worker that imports `runComplianceCheck`. The advisory lock makes concurrent workers safe.

Do not claim continuous monitoring while option 2 or 3 is running from a host that itself sleeps.

## If the model is failing

`/healthz` shows `model: configured | not configured`. Agent runs marked `DEGRADED` in Agent activity carry the provider error in `agent_run.error`, truncated.

- `AI provider is not configured`: missing `AI_PROVIDER` or `AI_API_KEY`.
- `AI request failed (TimeoutError)`: raise `AI_TIMEOUT_MS` or pick a faster model.
- `AI provider returned 401`: bad key.
- `AI provider returned 429`: quota. The sweep still works; drafts fall back to deterministic text.
- `Model output failed schema validation`: the provider returned prose or the wrong shape. The repair attempt already ran once; if it persists, change model. Findings from deterministic checks are unaffected.

The system never blocks on the model: the document is stored, rules run, and the run is labelled DEGRADED.

## Database operations

Backup:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=atlas-$(date +%F).dump
```

Restore into a fresh database:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" atlas-2026-10-26.dump
```

Audit rows cannot be deleted through SQL because of the trigger. To prune (a deliberate, privileged act), an operator must disable the trigger, which is exactly the kind of action that should require a change record. That limitation is described in `docs/SECURITY.md`.

## Incidents worth knowing

**Duplicate alerts after a restart.** Should be impossible: the partial unique index is in the database. If it happens, check that migrations ran and that `alert_active_dedupe_key` exists (`\d alert`).

**Two sweeps at once.** The second returns SKIPPED with a message. That is correct. If it persists, a previous run died holding the lock; advisory locks are released when the connection closes, so look for a stuck transaction (`pg_stat_activity`).

**Approval immediately EXPIRED.** The obligation changed between page load and decision, usually because a document was uploaded in another tab. Reload the alert: a fresh approval should exist with the new fingerprint.

**Action executed twice.** Should be impossible: `SELECT ... FOR UPDATE` plus a status check. If it is observed, capture `approval_id`, the audit rows, and the action rows before doing anything else.

**Disk full.** The app writes nothing to disk except logs. Check `journalctl` rotation and the PostgreSQL WAL directory.

## Demo reset before a review

```bash
npm run reset
# then, in the UI, press Run compliance check once
```

This produces a portfolio with a mixture of overdue, due soon, submitted, and completed obligations, plus one historical escalation that was already approved and executed, so the audit trail is not empty on first load.
