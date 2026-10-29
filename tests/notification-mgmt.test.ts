/**
 * Tests for the notification-management feature.
 *
 * Covers:
 * - sendAlertReport() input validation and flow control
 * - Duplicate suppression (existing SENT → skipped without force)
 * - Force-resend path records a distinct attempt
 * - Retry path when last delivery failed
 * - Non-CRITICAL alert rejected
 * - AI summary and model provenance in notification email
 * - Accurate fallback wording when no AI summary
 * - Human approval disclaimer always present
 *
 * Uses mocked transport and pool — no real emails sent, no DB required.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTransportOverride,
  setPoolOverride,
  sendAlertReport,
  notifyCriticalAlert,
  loadNotifyConfig,
} from '../src/notify.ts';
import { setAuditPoolOverride } from '../src/audit.ts';
import { can } from '../src/auth.ts';
import type { SessionUser } from '../src/auth.ts';

/* ── Mock transport ─────────────────────────────────────────────────────── */

interface SentMsg { from: string; to: string; subject: string; text: string; }
const sentMessages: SentMsg[] = [];
let transportShouldFail = false;

setTransportOverride({
  sendMail: async (msg: SentMsg) => {
    if (transportShouldFail) throw new Error('SMTP connection refused [mock]');
    sentMessages.push({ ...msg });
    return { messageId: 'mock-id-mgmt' };
  },
} as any);

/* ── Mock pool ──────────────────────────────────────────────────────────── */

// Controls for pool mock
let mockAlertSeverity = 'CRITICAL';
let mockAlertExists = true;
let mockNotifStatus: { status: string } | null = null;
let mockInsertFails = false;
let poolShouldFail = false;

setPoolOverride({
  query: async (sql: string, params?: unknown[]) => {
    if (poolShouldFail) throw new Error('DB connection lost [mock]');
    const s = sql.trim();

    // Alert lookup
    if (s.startsWith('SELECT al.id, al.type')) {
      if (!mockAlertExists) return { rows: [] };
      return { rows: [{
        id: params?.[0] ?? 'alert-001',
        type: 'OVERDUE_OBLIGATION',
        severity: mockAlertSeverity,
        evidence_summary: 'Test evidence',
        recommended_action: 'Test action',
        subsidiary_name: 'Test Subsidiary',
        obligation_title: 'Test Obligation',
        obligation_id: 'ob-001',
        due_at: new Date('2026-10-01'),
      }] };
    }

    // Existing notification status check (isDuplicate or getAlertNotificationStatus)
    if (s.includes('critical_notification_log') && s.includes('SELECT status')) {
      return { rows: mockNotifStatus ? [mockNotifStatus] : [] };
    }
    if (s.includes('critical_notification_log') && s.includes('LIMIT 1') && s.includes('status IN')) {
      // isDuplicate — returns rows if PENDING or SENT
      if (mockNotifStatus && ['PENDING','SENT'].includes(mockNotifStatus.status)) {
        return { rows: [{ id: 'log-001' }] };
      }
      return { rows: [] };
    }

    // Insert notification log
    if (s.includes('INSERT INTO critical_notification_log')) {
      if (mockInsertFails) throw Object.assign(new Error('unique violation'), { code: '23505' });
      return { rows: [{ id: 'new-log-001' }] };
    }

    // Update log row
    if (s.includes('UPDATE critical_notification_log')) return { rows: [] };

    // Audit insert
    if (s.includes('INSERT INTO audit_event')) return { rows: [] };

    return { rows: [] };
  },
} as any);

// Prevent audit() calls from writing test-fixture IDs to the real database.
setAuditPoolOverride({
  query: async (_sql: string, _params?: unknown[]) => ({ rows: [] }),
} as any);

/* ── Helpers ────────────────────────────────────────────────────────────── */

function setSmtpEnv() {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'atlas@example.com';
  process.env.SMTP_PASS = 'test-password';
  process.env.SMTP_FROM = 'atlas@example.com';
  process.env.ATLAS_CRITICAL_REPORT_RECIPIENTS = 'graylinksauto.ai@gmail.com,godwingeorge.contact@gmail.com';
}

function clearSmtpEnv() {
  for (const k of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','ATLAS_CRITICAL_REPORT_RECIPIENTS']) {
    delete process.env[k];
  }
}

function makeUser(role: 'EXEC' | 'COMPLIANCE' | 'ADMIN'): SessionUser {
  return { id: 'u1', email: 'u@test.com', name: 'Test', role, sessionId: 's1', csrfToken: 'tok' };
}

beforeEach(() => {
  sentMessages.length = 0;
  transportShouldFail = false;
  mockAlertSeverity = 'CRITICAL';
  mockAlertExists = true;
  mockNotifStatus = null;
  mockInsertFails = false;
  poolShouldFail = false;
});

/* =========================================================================
   Role authorization
   ========================================================================= */

test('COMPLIANCE role can send critical reports (run_check permission)', () => {
  assert.equal(can(makeUser('COMPLIANCE'), 'run_check'), true);
});

test('EXEC role cannot send critical reports', () => {
  assert.equal(can(makeUser('EXEC'), 'run_check'), false);
});

test('ADMIN role can send critical reports', () => {
  assert.equal(can(makeUser('ADMIN'), 'run_check'), true);
});

test('ADMIN role can access notification management (manage permission)', () => {
  assert.equal(can(makeUser('ADMIN'), 'manage'), true);
});

test('COMPLIANCE cannot access admin notification management page', () => {
  assert.equal(can(makeUser('COMPLIANCE'), 'manage'), false);
});

test('EXEC cannot access admin notification management page', () => {
  assert.equal(can(makeUser('EXEC'), 'manage'), false);
});

/* =========================================================================
   sendAlertReport — input validation
   ========================================================================= */

test('sendAlertReport returns skipped when SMTP is not configured', async () => {
  clearSmtpEnv();
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001' });
  assert.equal(r.status, 'skipped');
  assert.ok(r.reason?.includes('SMTP'));
});

test('sendAlertReport returns skipped when alert is not found', async () => {
  setSmtpEnv();
  mockAlertExists = false;
  const r = await sendAlertReport({ alertId: 'no-such-alert', actorId: 'user-001' });
  assert.equal(r.status, 'skipped');
  assert.ok(r.reason?.includes('not found'));
  clearSmtpEnv();
});

test('sendAlertReport rejects non-CRITICAL alerts', async () => {
  setSmtpEnv();
  mockAlertSeverity = 'HIGH';
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001' });
  assert.equal(r.status, 'skipped');
  assert.ok(r.reason?.includes('CRITICAL'));
  clearSmtpEnv();
});

/* =========================================================================
   Duplicate suppression
   ========================================================================= */

test('sendAlertReport returns skipped when notification already sent (no force)', async () => {
  setSmtpEnv();
  mockNotifStatus = { status: 'SENT' };
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001', force: false });
  assert.equal(r.status, 'skipped');
  assert.ok(r.reason?.includes('already sent'));
  assert.equal(sentMessages.length, 0, 'no email sent');
  clearSmtpEnv();
});

test('sendAlertReport sends when forced even if SENT record exists', async () => {
  setSmtpEnv();
  mockNotifStatus = { status: 'SENT' };
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001', force: true });
  assert.equal(r.status, 'sent');
  assert.equal(sentMessages.length, 1, 'one email sent on force');
  assert.equal(r.recipients, 2);
  clearSmtpEnv();
});

test('sendAlertReport retries when last attempt failed (no force required)', async () => {
  setSmtpEnv();
  mockNotifStatus = { status: 'FAILED' };
  // isDuplicate checks for PENDING/SENT only, so FAILED → not a duplicate
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001', force: false });
  assert.equal(r.status, 'sent');
  assert.equal(sentMessages.length, 1, 'email sent on retry');
  clearSmtpEnv();
});

test('sendAlertReport sends on first attempt (no existing record)', async () => {
  setSmtpEnv();
  mockNotifStatus = null;
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001' });
  assert.equal(r.status, 'sent');
  assert.equal(sentMessages.length, 1);
  clearSmtpEnv();
});

/* =========================================================================
   Delivery failures
   ========================================================================= */

test('sendAlertReport returns failed when transport throws', async () => {
  setSmtpEnv();
  mockNotifStatus = { status: 'SENT' }; // forced resend
  transportShouldFail = true;
  const r = await sendAlertReport({ alertId: 'alert-001', actorId: 'user-001', force: true });
  assert.equal(r.status, 'failed');
  assert.ok(r.reason !== undefined, 'reason is present');
  assert.ok(!r.reason!.includes('test-password'), 'password not in error');
  clearSmtpEnv();
});

/* =========================================================================
   Email content — AI context and fallback
   ========================================================================= */

test('notification email with aiSummary labels it AI-generated and includes model name', async () => {
  setSmtpEnv();
  await notifyCriticalAlert({
    alertId: 'a1',
    alertType: 'OVERDUE_OBLIGATION',
    severity: 'CRITICAL',
    subsidiaryName: 'Test Sub',
    obligationTitle: 'Annual Filing',
    evidenceSummary: 'Filing is 20 days overdue.',
    recommendedAction: 'Escalate immediately.',
    aiSummary: 'The obligation is critically overdue with no mitigation recorded.',
    aiModel: 'gemini-3.5-flash-lite',
  });
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('AI-GENERATED SUMMARY'), 'AI section present');
  assert.ok(body.includes('gemini-3.5-flash-lite'), 'model name present');
  assert.ok(body.includes('requires human verification'), 'AI caveat present');
  clearSmtpEnv();
});

test('notification email without aiSummary uses accurate fallback wording', async () => {
  setSmtpEnv();
  await notifyCriticalAlert({
    alertId: 'a2',
    alertType: 'OVERDUE_OBLIGATION',
    severity: 'CRITICAL',
    subsidiaryName: 'Test Sub',
    obligationTitle: 'Annual Filing',
    evidenceSummary: 'Filing is 20 days overdue.',
    recommendedAction: 'Escalate immediately.',
    // no aiSummary
  });
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('AI SUMMARY NOT INCLUDED'), 'accurate fallback label');
  assert.ok(body.includes('No AI-generated summary was included'), 'accurate explanation');
  assert.ok(!body.includes('No model is configured'), 'old misleading text removed');
  clearSmtpEnv();
});

test('human approval disclaimer is present in all notification variants', async () => {
  setSmtpEnv();

  // With AI
  await notifyCriticalAlert({
    alertId: 'a3', alertType: 'OVERDUE_OBLIGATION', severity: 'CRITICAL',
    subsidiaryName: 'Sub', obligationTitle: 'Ob', evidenceSummary: 'ev', recommendedAction: 'act',
    aiSummary: 'summary', aiModel: 'gemini',
  });
  assert.ok(sentMessages[0]!.text.includes('does not constitute an approved escalation'));

  // Without AI
  sentMessages.length = 0;
  await notifyCriticalAlert({
    alertId: 'a4', alertType: 'OVERDUE_OBLIGATION', severity: 'CRITICAL',
    subsidiaryName: 'Sub', obligationTitle: 'Ob', evidenceSummary: 'ev', recommendedAction: 'act',
  });
  assert.ok(sentMessages[0]!.text.includes('does not constitute an approved escalation'));

  clearSmtpEnv();
});

/* =========================================================================
   SMTP configuration detection
   ========================================================================= */

test('loadNotifyConfig returns null when SMTP variables are absent', () => {
  clearSmtpEnv();
  assert.equal(loadNotifyConfig(), null);
});

test('loadNotifyConfig returns config with both recipients when configured', () => {
  setSmtpEnv();
  const cfg = loadNotifyConfig();
  assert.ok(cfg !== null);
  assert.equal(cfg.recipients.length, 2);
  assert.ok(cfg.recipients.includes('graylinksauto.ai@gmail.com'));
  assert.ok(cfg.recipients.includes('godwingeorge.contact@gmail.com'));
  clearSmtpEnv();
});
