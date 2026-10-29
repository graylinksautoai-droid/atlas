/**
 * Critical-alert notification service.
 *
 * Sends a server-side SMTP email when the compliance engine raises a CRITICAL
 * alert — independent of, and never a substitute for, the human-approval
 * workflow in agent.ts.  Approval-controlled escalations and automatic
 * critical notifications are parallel, separate actions:
 *
 *   compliance sweep
 *     └─ raises CRITICAL alert
 *           ├─ agent.ts:  drafts escalation → approval required → human decides
 *           └─ notify.ts: sends critical notification → no approval needed
 *
 * Delivery policy:
 *   - SMTP credentials and recipients are read from environment variables;
 *     nothing is hardcoded.
 *   - When SMTP is not configured the function logs and returns immediately;
 *     it never throws, because a notification failure must not fail the sweep.
 *   - A critical_notification_log row prevents duplicate sends for the same
 *     (alert, recipient group) pair.
 *   - The email body never contains full document text or SMTP credentials.
 *   - The transport object is injectable for testing (see the TEST_TRANSPORT
 *     override and the unit tests).
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { pool as defaultPool } from './db.ts';
import { audit } from './audit.ts';

/* ── Configuration ───────────────────────────────────────────────────────── */

export interface NotifyConfig {
  /** Comma-separated email addresses from ATLAS_CRITICAL_REPORT_RECIPIENTS */
  recipients: string[];
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;    // true = TLS on connect (port 465), false = STARTTLS
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
}

function loadNotifyConfig(): NotifyConfig | null {
  const raw = process.env.ATLAS_CRITICAL_REPORT_RECIPIENTS ?? '';
  const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const host = process.env.SMTP_HOST ?? '';
  const user = process.env.SMTP_USER ?? '';
  const pass = process.env.SMTP_PASS ?? '';
  const from = process.env.SMTP_FROM ?? user;
  if (recipients.length === 0 || !host || !user || !pass) return null;
  return {
    recipients,
    smtpHost: host,
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpSecure: process.env.SMTP_SECURE === '1',
    smtpUser: user,
    smtpPass: pass,
    fromAddress: from,
  };
}

/* Singleton transporter — lazily created, replaced by tests via override. */
let _transport: Transporter | null = null;
let _transportOverride: Transporter | null = null;
let _poolOverride: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null = null;

/** Inject a mock transporter in tests. Pass null to reset. */
export function setTransportOverride(t: Transporter | null): void {
  _transportOverride = t;
}

/** Inject a mock pool in tests. Pass null to reset. */
export function setPoolOverride(p: typeof _poolOverride): void {
  _poolOverride = p;
}

function getPool() {
  return (_poolOverride ?? defaultPool) as typeof defaultPool;
}

function getTransport(cfg: NotifyConfig): Transporter {
  if (_transportOverride) return _transportOverride;
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    connectionTimeout: 8_000,
    greetingTimeout: 5_000,
  });
  return _transport;
}

/* ── Delivery input ──────────────────────────────────────────────────────── */

export interface CriticalAlertNotification {
  alertId: string;
  alertType: string;
  severity: 'CRITICAL';
  subsidiaryName: string;
  obligationTitle: string | null;
  evidenceSummary: string;
  recommendedAction: string;
  dueAt?: Date | null;
  /** AI-generated summary; undefined if model not available. */
  aiSummary?: string;
  /** Model name that produced aiSummary; undefined if deterministic. */
  aiModel?: string;
}

/* ── Delivery log helpers ─────────────────────────────────────────────────── */

const RECIPIENT_GROUP = 'primary';  // label for the configured recipient list

async function isDuplicate(alertId: string): Promise<boolean> {
  const r = await getPool().query<{ id: string }>(
    `SELECT id FROM critical_notification_log
      WHERE alert_id = $1 AND recipient_group = $2 AND status IN ('PENDING','SENT')
      LIMIT 1`,
    [alertId, RECIPIENT_GROUP],
  );
  return r.rows.length > 0;
}

async function insertLog(alertId: string): Promise<string> {
  const r = await getPool().query<{ id: string }>(
    `INSERT INTO critical_notification_log (alert_id, recipient_group, status)
     VALUES ($1, $2, 'PENDING') RETURNING id`,
    [alertId, RECIPIENT_GROUP],
  );
  return r.rows[0]!.id;
}

async function updateLog(logId: string, status: 'SENT' | 'FAILED', error?: string): Promise<void> {
  await getPool().query(
    `UPDATE critical_notification_log
        SET status = $2, error_message = $3, resolved_at = now()
      WHERE id = $1`,
    [logId, status, error ?? null],
  );
}

/* ── Email composition ──────────────────────────────────────────────────── */

function buildEmail(n: CriticalAlertNotification, recipients: string[], from: string) {
  const subject = `[ATLAS CRITICAL] ${n.obligationTitle ?? n.alertType} — ${n.subsidiaryName}`;
  const aiSection = n.aiSummary
    ? `\n— AI-GENERATED SUMMARY (model: ${n.aiModel ?? 'unknown'}) —\n${n.aiSummary}\n(This content was produced by a language model and requires human verification.)`
    : '\n— AI SUMMARY NOT INCLUDED —\nNo AI-generated summary was included with this notification. Deterministic findings only.';

  const body = [
    `ATLAS CRITICAL ALERT NOTIFICATION`,
    `Generated: ${new Date().toISOString()} UTC`,
    ``,
    `Alert type:    ${n.alertType.replace(/_/g, ' ').toLowerCase()}`,
    `Severity:      ${n.severity}`,
    `Subsidiary:    ${n.subsidiaryName}`,
    `Obligation:    ${n.obligationTitle ?? '(portfolio level)'}`,
    n.dueAt ? `Due date:      ${n.dueAt.toISOString().slice(0, 10)}` : '',
    ``,
    `EVIDENCE`,
    n.evidenceSummary,
    ``,
    `RECOMMENDED ACTION`,
    n.recommendedAction,
    aiSection,
    ``,
    `────────────────────────────────────────────────────────────────`,
    `This notification was sent automatically by the ATLAS compliance`,
    `monitoring engine. It does not constitute an approved escalation.`,
    `All consequential actions require explicit human approval in ATLAS.`,
    `Alert ID: ${n.alertId}`,
  ].filter((l) => l !== undefined).join('\n');

  return { from, to: recipients.join(', '), subject, text: body };
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Send (or skip) a critical-alert notification.
 * Never throws — failures are logged to the delivery table and audit trail.
 * Returns 'sent', 'skipped' (not configured or duplicate), or 'failed'.
 */
export async function notifyCriticalAlert(
  n: CriticalAlertNotification,
): Promise<'sent' | 'skipped' | 'failed'> {
  const cfg = loadNotifyConfig();
  if (!cfg) return 'skipped';

  try {
    if (await isDuplicate(n.alertId)) return 'skipped';
  } catch {
    return 'skipped'; // DB failure — do not block the caller
  }

  let logId: string;
  try {
    logId = await insertLog(n.alertId);
  } catch {
    return 'skipped'; // unique constraint means a concurrent send won the race
  }

  const transport = getTransport(cfg);
  const message = buildEmail(n, cfg.recipients, cfg.fromAddress);

  try {
    await transport.sendMail(message);
    await updateLog(logId, 'SENT');
    await audit({
      actorType: 'SYSTEM',
      action: 'notification.critical.sent',
      entityType: 'alert',
      entityId: n.alertId,
      detail: {
        recipientGroup: RECIPIENT_GROUP,
        recipientCount: cfg.recipients.length,
        aiUsed: Boolean(n.aiSummary),
        logId,
      },
    }).catch(() => undefined);
    return 'sent';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Safe message — strip any credential echoes from SMTP error text
    const safe = msg.replace(/\b[\w.+-]+@[\w.-]+\b/g, '[email]').slice(0, 400);
    await updateLog(logId, 'FAILED', safe).catch(() => undefined);
    await audit({
      actorType: 'SYSTEM',
      action: 'notification.critical.failed',
      entityType: 'alert',
      entityId: n.alertId,
      detail: { recipientGroup: RECIPIENT_GROUP, logId, error: safe },
    }).catch(() => undefined);
    return 'failed';
  }
}

/**
 * Test-delivery function — only callable in non-production environments.
 * Sends a clearly labelled test message to confirm transport is working.
 */
export async function sendTestNotification(params: {
  requestedBy: string;
}): Promise<{ status: 'sent' | 'skipped' | 'failed'; recipients: string[]; messageId?: string; error?: string }> {
  if (process.env.NODE_ENV === 'production') {
    return { status: 'skipped', recipients: [], error: 'Test delivery is disabled in production.' };
  }

  const cfg = loadNotifyConfig();
  if (!cfg) {
    return {
      status: 'skipped',
      recipients: [],
      error: 'SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS, ATLAS_CRITICAL_REPORT_RECIPIENTS required).',
    };
  }

  const transport = getTransport(cfg);
  const subject = '[ATLAS DEMO] Critical Report Delivery Test';
  const body = [
    'ATLAS DEMO — Critical Report Delivery Test',
    `Sent at: ${new Date().toISOString()} UTC`,
    `Requested by user: ${params.requestedBy}`,
    '',
    'This is a test message to verify that critical-alert notifications',
    'are delivered correctly. No real alert has been raised.',
    '',
    'If you received this message, SMTP delivery is working.',
    '',
    'Configured recipients: ' + cfg.recipients.join(', '),
    'Environment: ' + (process.env.NODE_ENV ?? 'development'),
  ].join('\n');

  try {
    const info = await transport.sendMail({
      from: cfg.fromAddress,
      to: cfg.recipients.join(', '),
      subject,
      text: body,
    });
    await audit({
      actorType: 'USER',
      actorId: params.requestedBy,
      action: 'notification.test.sent',
      entityType: 'app_user',
      entityId: params.requestedBy,
      detail: { recipientGroup: RECIPIENT_GROUP, recipientCount: cfg.recipients.length },
    }).catch(() => undefined);
    return { status: 'sent', recipients: cfg.recipients, messageId: String(info.messageId ?? '') };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const safe = msg.replace(/\b[\w.+-]+@[\w.-]+\b/g, '[email]').slice(0, 400);
    return { status: 'failed', recipients: cfg.recipients, error: safe };
  }
}

/** Exported for direct inspection in tests. */
export { loadNotifyConfig };

/* =========================================================================
   Notification history and manual send
   ========================================================================= */

export interface NotificationLogEntry {
  id: string;
  alert_id: string;
  status: string;
  error_message: string | null;
  attempted_at: Date;
  resolved_at: Date | null;
  alert_type: string;
  severity: string;
  subsidiary_name: string;
  obligation_title: string | null;
  recipient_group: string;
}

/** Returns the most recent notification log entries, newest first. */
export async function listNotificationLog(limit = 20): Promise<NotificationLogEntry[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT n.id, n.alert_id, n.status, n.error_message, n.attempted_at, n.resolved_at,
            al.type AS alert_type, al.severity,
            s.name AS subsidiary_name, o.title AS obligation_title,
            n.recipient_group
       FROM critical_notification_log n
       JOIN alert al ON al.id = n.alert_id
       JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
      ORDER BY n.attempted_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows as NotificationLogEntry[];
}

/** Returns the current notification status for a specific alert. */
export async function getAlertNotificationStatus(alertId: string): Promise<{ exists: boolean; status: string | null }> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT status FROM critical_notification_log
      WHERE alert_id = $1 AND recipient_group = $2
      ORDER BY attempted_at DESC LIMIT 1`,
    [alertId, RECIPIENT_GROUP],
  );
  if (result.rows.length === 0) return { exists: false, status: null };
  return { exists: true, status: (result.rows[0] as { status: string }).status };
}

export interface SendReportResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
  recipients?: number;
}

/**
 * Manually send a critical-alert report for an existing alert.
 *
 * - If a SENT notification exists and force=false: returns 'skipped' with reason.
 * - If a SENT notification exists and force=true: inserts a new log entry and sends.
 * - If a FAILED notification exists or no record: calls notifyCriticalAlert normally.
 *
 * Never creates a duplicate alert. Never approves or executes an escalation.
 */
export async function sendAlertReport(params: {
  alertId: string;
  actorId: string;
  force?: boolean;
}): Promise<SendReportResult> {
  const cfg = loadNotifyConfig();
  if (!cfg) return { status: 'skipped', reason: 'SMTP is not configured.' };

  const pool = getPool();

  // Load the alert's real persisted data
  const alertResult = await pool.query(
    `SELECT al.id, al.type, al.severity, al.evidence_summary, al.recommended_action,
            s.name AS subsidiary_name, o.title AS obligation_title,
            al.obligation_id, o.due_at
       FROM alert al
       JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
      WHERE al.id = $1`,
    [params.alertId],
  );

  type AlertRow = {
    id: string; type: string; severity: string; evidence_summary: string;
    recommended_action: string; subsidiary_name: string; obligation_title: string | null;
    obligation_id: string | null; due_at: Date | null;
  };

  if (alertResult.rows.length === 0) {
    return { status: 'skipped', reason: 'Alert not found.' };
  }

  const alert = alertResult.rows[0] as AlertRow;

  if (alert.severity !== 'CRITICAL') {
    return { status: 'skipped', reason: 'Only CRITICAL alerts can be manually reported.' };
  }

  // Check existing notification status
  const existing = await getAlertNotificationStatus(params.alertId);

  if (existing.exists && existing.status === 'SENT' && !params.force) {
    return {
      status: 'skipped',
      reason: 'A notification was already sent for this alert. Use "Force resend" to send again.',
    };
  }

  // If force=true and a SENT record exists, we need to bypass isDuplicate.
  // The cleanest way: insert a new PENDING log row directly, then send.
  if (params.force && existing.exists && existing.status === 'SENT') {
    let logId: string;
    try {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO critical_notification_log (alert_id, recipient_group, status)
         VALUES ($1, $2, 'PENDING') RETURNING id`,
        [params.alertId, RECIPIENT_GROUP],
      );
      logId = (ins.rows[0] as { id: string }).id;
    } catch {
      return { status: 'skipped', reason: 'Could not create a resend log entry.' };
    }

    const transport = getTransport(cfg);
    const message = buildEmail(
      {
        alertId: alert.id,
        alertType: alert.type,
        severity: 'CRITICAL',
        subsidiaryName: alert.subsidiary_name,
        obligationTitle: alert.obligation_title,
        evidenceSummary: alert.evidence_summary,
        recommendedAction: alert.recommended_action,
        dueAt: alert.due_at,
      },
      cfg.recipients,
      cfg.fromAddress,
    );

    try {
      await transport.sendMail(message);
      await updateLog(logId, 'SENT');
      await audit({
        actorType: 'USER',
        actorId: params.actorId,
        action: 'notification.critical.resent',
        entityType: 'alert',
        entityId: params.alertId,
        detail: { logId, recipientGroup: RECIPIENT_GROUP, recipientCount: cfg.recipients.length, forced: true },
      }).catch(() => undefined);
      return { status: 'sent', recipients: cfg.recipients.length };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const safe = msg.replace(/\b[\w.+-]+@[\w.-]+\b/g, '[email]').slice(0, 400);
      await updateLog(logId, 'FAILED', safe).catch(() => undefined);
      await audit({
        actorType: 'USER',
        actorId: params.actorId,
        action: 'notification.critical.failed',
        entityType: 'alert',
        entityId: params.alertId,
        detail: { logId, recipientGroup: RECIPIENT_GROUP, forced: true, error: safe },
      }).catch(() => undefined);
      return { status: 'failed', reason: safe };
    }
  }

  // Normal path: no existing SENT record, or last was FAILED.
  // For FAILED records, isDuplicate returns false (only checks PENDING/SENT),
  // so notifyCriticalAlert will create a fresh PENDING and attempt.
  const result = await notifyCriticalAlert({
    alertId: alert.id,
    alertType: alert.type,
    severity: 'CRITICAL',
    subsidiaryName: alert.subsidiary_name,
    obligationTitle: alert.obligation_title,
    evidenceSummary: alert.evidence_summary,
    recommendedAction: alert.recommended_action,
    dueAt: alert.due_at,
  });

  // Record the manual trigger in the audit trail
  if (result === 'sent') {
    await audit({
      actorType: 'USER',
      actorId: params.actorId,
      action: 'notification.critical.manual',
      entityType: 'alert',
      entityId: params.alertId,
      detail: { recipientGroup: RECIPIENT_GROUP, recipientCount: cfg.recipients.length },
    }).catch(() => undefined);
    return { status: 'sent', recipients: cfg.recipients.length };
  }

  return { status: result, reason: result === 'skipped' ? 'Notification already sent or SMTP unavailable.' : 'Delivery failed.' };
}
