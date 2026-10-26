import type { Tx } from './db.ts';
import { pool, query, one, many, tx } from './db.ts';
import { audit } from './audit.ts';
import { config } from './config.ts';
import {
  daysOverdue,
  dedupeKey,
  severityForDueSoon,
  severityForOverdue,
  stateFingerprint,
  type ObligationRow,
  type Severity,
} from './rules.ts';
import { handleAlert } from './agent.ts';

const LOCK_KEY = 727_001;

export interface CheckResult {
  checkId: string | null;
  trigger: 'SCHEDULER' | 'MANUAL';
  status: 'OK' | 'FAILED' | 'SKIPPED';
  scanned: number;
  overdue: number;
  alertsCreated: number;
  agentRuns: number;
  error?: string;
  durationMs: number;
}

interface AlertInsert {
  type: 'OVERDUE_OBLIGATION' | 'DUE_SOON' | 'MISSING_DOCUMENT' | 'DOCUMENT_INCONSISTENCY';
  severity: Severity;
  evidence: string;
  action: string;
}

/**
 * The single compliance service. Both the scheduler and the manual button call
 * this function; there is no second code path to drift.
 *
 * Concurrency: a session level advisory lock means a second run returns SKIPPED
 * instead of racing the first one and duplicating alerts.
 */
export async function runComplianceCheck(opts: {
  trigger: 'SCHEDULER' | 'MANUAL';
  actorId?: string | null;
  checkId?: string;
}): Promise<CheckResult> {
  const started = performance.now();
  const client = await pool.connect();
  let locked = false;
  let checkId: string | null = null;
  let scanned = 0;
  let overdueCount = 0;
  let alertsCreated = 0;
  let agentRuns = 0;

  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        checkId: null,
        trigger: opts.trigger,
        status: 'SKIPPED',
        scanned: 0,
        overdue: 0,
        alertsCreated: 0,
        agentRuns: 0,
        error: 'Another compliance check is already running.',
        durationMs: Math.round(performance.now() - started),
      };
    }

    if (opts.checkId) {
      checkId = opts.checkId;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO compliance_check (trigger, status) VALUES ($1, 'RUNNING') RETURNING id`,
        [opts.trigger],
      );
      checkId = inserted.rows[0].id;
    }

    const dueSoonCutoff = new Date(Date.now() + config.dueSoonHours * 3_600_000);

    const rows = await client.query<ObligationRow>(
      `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status, o.requires_document,
              o.owner_name, o.version, o.updated_at, o.project_id,
              p.name AS project_name, p.subsidiary_id, s.name AS subsidiary_name,
              (SELECT count(*)::int FROM document d WHERE d.obligation_id = o.id) AS document_count
         FROM obligation o
         JOIN project p ON p.id = o.project_id
         JOIN subsidiary s ON s.id = p.subsidiary_id
        WHERE o.status IN ('OPEN', 'OVERDUE', 'SUBMITTED')
          AND (o.due_at <= $1 OR o.status = 'OVERDUE')
        ORDER BY o.due_at ASC`,
      [dueSoonCutoff],
    );

    const now = new Date();
    for (const row of rows.rows) {
      scanned += 1;
      const days = daysOverdue(row.due_at, now);
      if (row.status === 'OVERDUE' || (days > 0 && row.status === 'OPEN')) overdueCount += 1;
      try {
        const created = await evaluateObligation(row, now, days, checkId);
        alertsCreated += created.alerts;
        agentRuns += created.runs;
      } catch (error) {
        // One bad obligation must not abort the whole sweep. Record and continue.
        await audit(
          {
            actorType: 'SYSTEM',
            action: 'compliance.obligation.failed',
            entityType: 'obligation',
            entityId: row.id,
            detail: { checkId, error: error instanceof Error ? error.message : String(error) },
          },
          client,
        );
      }
    }

    await client.query(
      `UPDATE compliance_check
          SET status = 'OK', finished_at = now(), scanned = $2, overdue = $3, alerts_created = $4
        WHERE id = $1`,
      [checkId, scanned, overdueCount, alertsCreated],
    );

    await audit(
      {
        actorType: opts.actorId ? 'USER' : 'SYSTEM',
        actorId: opts.actorId ?? null,
        action: 'compliance.check.completed',
        entityType: 'compliance_check',
        entityId: checkId,
        detail: { trigger: opts.trigger, scanned, overdue: overdueCount, alertsCreated, agentRuns },
      },
      client,
    );

    return {
      checkId,
      trigger: opts.trigger,
      status: 'OK',
      scanned,
      overdue: overdueCount,
      alertsCreated,
      agentRuns,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (checkId) {
      await pool
        .query(`UPDATE compliance_check SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1`, [checkId, message])
        .catch(() => undefined);
    }
    await audit({
      actorType: 'SYSTEM',
      action: 'compliance.check.failed',
      entityType: 'compliance_check',
      entityId: checkId,
      detail: { trigger: opts.trigger, error: message },
    }).catch(() => undefined);
    return {
      checkId,
      trigger: opts.trigger,
      status: 'FAILED',
      scanned,
      overdue: overdueCount,
      alertsCreated,
      agentRuns,
      error: message,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
    client.release();
  }
}

async function evaluateObligation(
  row: ObligationRow,
  now: Date,
  days: number,
  checkId: string | null,
): Promise<{ alerts: number; runs: number }> {
  const candidates: AlertInsert[] = [];

  if (days > 0 && (row.status === 'OPEN' || row.status === 'OVERDUE')) {
    const severity = severityForOverdue(days);
    candidates.push({
      type: 'OVERDUE_OBLIGATION',
      severity,
      evidence: `${row.title} for ${row.project_name} (${row.subsidiary_name}) was due ${row.due_at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} and is ${days} day(s) overdue. Status ${row.status}.` +
        (row.requires_document && row.document_count === 0 ? ' No documentary evidence has been filed.' : ''),
      action: severity === 'HIGH' || severity === 'CRITICAL'
        ? 'Escalate to the subsidiary lead with a dated recovery plan.'
        : 'Remind the obligation owner and request a submission date.',
    });
  }

  if (row.requires_document && row.document_count === 0 && row.status === 'SUBMITTED') {
    candidates.push({
      type: 'MISSING_DOCUMENT',
      severity: 'HIGH',
      evidence: `${row.title} is recorded as submitted, but no document is attached to the obligation.`,
      action: 'Ask the owner to attach the submission, or correct the obligation state.',
    });
  }

  if (days <= 0 && now.getTime() < row.due_at.getTime()) {
    const hours = Math.floor((row.due_at.getTime() - now.getTime()) / 3_600_000);
    if (hours <= config.dueSoonHours) {
      candidates.push({
        type: 'DUE_SOON',
        severity: severityForDueSoon(hours),
        evidence: `${row.title} (${row.subsidiary_name}) is due in ${hours} hour(s), on ${row.due_at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}, 17:00 UTC.`,
        action: 'Confirm the owner has everything needed to file on time.',
      });
    }
  }

  const inconsistent = await many<{ id: string; title: string; missing: string }>(
    `SELECT d.id, o.title, f.detail AS missing
       FROM document d
       JOIN obligation o ON o.id = d.obligation_id
       JOIN document_finding f ON f.document_id = d.id AND f.code = 'MISSING_SECTIONS'
      WHERE d.obligation_id = $1`,
    [row.id],
  );
  for (const finding of inconsistent) {
    candidates.push({
      type: 'DOCUMENT_INCONSISTENCY',
      severity: 'MEDIUM',
      evidence: `Submission for ${finding.title} does not contain the required sections: ${finding.missing}.`,
      action: 'Return the submission to the owner and request a complete version.',
    });
  }

  let alerts = 0;
  let runs = 0;
  for (const candidate of candidates) {
    const result = await raiseAlert(row, candidate, checkId);
    if (!result.created) continue;
    alerts += 1;
    // The agent runs after the alert transaction commits: a slow model call must
    // never hold a row lock or stretch an open transaction.
    if (result.escalate && result.alertId) {
      // The overdue transition happens inside raiseAlert, so the approval must
      // be fingerprinted against the row as it stands now, not the pre-sweep copy.
      const fresh = await one<{ status: ObligationRow['status']; version: number; updated_at: Date }>(
        `SELECT status::text AS status, version, updated_at FROM obligation WHERE id = $1`,
        [row.id],
      );
      await handleAlert({
        alertId: result.alertId,
        alertType: candidate.type,
        severity: candidate.severity,
        evidenceSummary: candidate.evidence,
        recommendedAction: candidate.action,
        obligation: fresh ? { ...row, ...fresh } : row,
        daysLate: daysOverdue(row.due_at, new Date()),
        checkId,
      });
      runs += 1;
    }
  }
  return { alerts, runs };
}

async function raiseAlert(
  row: ObligationRow,
  candidate: AlertInsert,
  checkId: string | null,
): Promise<{ created: boolean; alertId?: string; escalate: boolean }> {
  const key = dedupeKey(candidate.type, row.id);

  return tx(async (client: Tx) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM alert WHERE dedupe_key = $1 AND status NOT IN ('RESOLVED', 'DISMISSED') LIMIT 1`,
      [key],
    );
    if (existing.rows.length > 0) {
      // Refresh the evidence on the live alert without creating a duplicate.
      await client.query(
        `UPDATE alert SET evidence_summary = $2, recommended_action = $3, severity = $4, updated_at = now() WHERE id = $1`,
        [existing.rows[0].id, candidate.evidence, candidate.action, candidate.severity],
      );
      return { created: false, escalate: false };
    }

    let alertId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO alert (type, severity, subsidiary_id, obligation_id, dedupe_key, evidence_summary, recommended_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [candidate.type, candidate.severity, row.subsidiary_id, row.id, key, candidate.evidence, candidate.action],
      );
      alertId = inserted.rows[0].id;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return { created: false, escalate: false };
      throw error;
    }

    // Overdue obligations move to OVERDUE (from OPEN) exactly once per version.
    if (candidate.type === 'OVERDUE_OBLIGATION' && row.status === 'OPEN') {
      await client.query(
        `UPDATE obligation
            SET status = 'OVERDUE', version = version + 1, updated_at = now(), last_evaluated_at = now()
          WHERE id = $1`,
        [row.id],
      );
    }

    if (candidate.type === 'OVERDUE_OBLIGATION') {
      await client.query(
        `INSERT INTO risk (subsidiary_id, obligation_id, title, severity, status, rationale)
         VALUES ($1, $2, $3, $4, 'OPEN', $5)
         ON CONFLICT (obligation_id, title) DO UPDATE
           SET severity = EXCLUDED.severity, updated_at = now(), rationale = EXCLUDED.rationale
         WHERE risk.status = 'OPEN'`,
        [row.subsidiary_id, row.id, `Compliance: ${row.title}`, candidate.severity, candidate.evidence],
      );
    }

    await audit(
      {
        actorType: 'SYSTEM',
        action: 'alert.created',
        entityType: 'alert',
        entityId: alertId,
        detail: { type: candidate.type, severity: candidate.severity, obligationId: row.id, checkId },
      },
      client,
    );

    const agentRun = candidate.type === 'OVERDUE_OBLIGATION'
      && (candidate.severity === 'HIGH' || candidate.severity === 'CRITICAL');

    return { created: true, alertId, escalate: agentRun };
  });
}

export async function latestChecks(limit = 10): Promise<
  Array<{ id: string; trigger: string; status: string; started_at: Date; finished_at: Date | null; scanned: number; overdue: number; alerts_created: number; error: string | null }>
> {
  return many(
    `SELECT id, trigger, status, started_at, finished_at, scanned, overdue, alerts_created, error
       FROM compliance_check ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
}

export async function obligationFingerprint(obligationId: string): Promise<string | null> {
  const row = await one<{ id: string; status: string; due_at: Date; version: number; updated_at: Date }>(
    `SELECT id, status::text AS status, due_at, version, updated_at FROM obligation WHERE id = $1`,
    [obligationId],
  );
  return row ? stateFingerprint(row) : null;
}

export async function countActiveAlerts(): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM alert WHERE status NOT IN ('RESOLVED', 'DISMISSED')`,
  );
  return Number(row?.count ?? 0);
}

export { query as rawQuery };
