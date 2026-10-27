/**
 * Unit tests for the critical-alert notification service.
 *
 * Database-independent: a mock pool and mock SMTP transport are injected via
 * the override APIs exported by notify.ts. No real network connections are made.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  notifyCriticalAlert,
  sendTestNotification,
  setTransportOverride,
  setPoolOverride,
  loadNotifyConfig,
} from '../src/notify.ts';

/* ── Mock transport ─────────────────────────────────────────────────────── */

interface SentMessage { from: string; to: string; subject: string; text: string; }
const sentMessages: SentMessage[] = [];
let transportShouldFail = false;

const mockTransport = {
  sendMail: async (msg: SentMessage) => {
    if (transportShouldFail) throw new Error('SMTP connection refused [mock]');
    sentMessages.push({ ...msg });
    return { messageId: 'mock-id-001' };
  },
} as any;

/* ── Mock pool ──────────────────────────────────────────────────────────── */

let duplicateExists = false;
let poolShouldFail = false;

const mockPool = {
  query: async (sql: string, _params?: unknown[]) => {
    if (poolShouldFail) throw new Error('DB connection lost [mock]');
    if (sql.includes('SELECT id') && sql.includes('critical_notification_log')) {
      return { rows: duplicateExists ? [{ id: 'existing-log-uuid' }] : [] };
    }
    if (sql.includes('INSERT INTO critical_notification_log')) {
      return { rows: [{ id: 'new-log-uuid-001' }] };
    }
    return { rows: [] };
  },
} as any;

/* ── Setup ──────────────────────────────────────────────────────────────── */

setTransportOverride(mockTransport);
setPoolOverride(mockPool);

function setSmtpEnv(overrides: Partial<Record<string,string>> = {}) {
  process.env.SMTP_HOST  = overrides.SMTP_HOST  ?? 'smtp.example.com';
  process.env.SMTP_PORT  = overrides.SMTP_PORT  ?? '587';
  process.env.SMTP_USER  = overrides.SMTP_USER  ?? 'atlas@example.com';
  process.env.SMTP_PASS  = overrides.SMTP_PASS  ?? 'test-pass';
  process.env.SMTP_FROM  = overrides.SMTP_FROM  ?? 'atlas@example.com';
  process.env.ATLAS_CRITICAL_REPORT_RECIPIENTS =
    overrides.ATLAS_CRITICAL_REPORT_RECIPIENTS ??
    'graylinksauto.ai@gmail.com,godwingeorge.contact@gmail.com';
}

function clearSmtpEnv() {
  for (const k of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM',
                   'ATLAS_CRITICAL_REPORT_RECIPIENTS']) {
    delete process.env[k];
  }
}

beforeEach(() => {
  sentMessages.length = 0;
  transportShouldFail = false;
  duplicateExists = false;
  poolShouldFail = false;
});

const baseAlert = {
  alertId:          '00000000-0000-0000-0000-000000000001',
  alertType:        'OVERDUE_OBLIGATION',
  severity:         'CRITICAL' as const,
  subsidiaryName:   'Atlas Energy Ltd',
  obligationTitle:  'Annual Structural Integrity Audit',
  evidenceSummary:  'Obligation is 18 days overdue. No documentary evidence filed.',
  recommendedAction: 'Escalate to subsidiary lead with a dated recovery plan.',
  dueAt:            new Date('2026-10-01T00:00:00Z'),
};

/* ── Config tests ───────────────────────────────────────────────────────── */

test('loadNotifyConfig returns null when SMTP env vars are absent', () => {
  clearSmtpEnv();
  assert.equal(loadNotifyConfig(), null);
});

test('loadNotifyConfig parses recipients and SMTP settings correctly', () => {
  setSmtpEnv();
  const cfg = loadNotifyConfig();
  assert.ok(cfg !== null, 'config should be non-null');
  assert.equal(cfg.smtpHost, 'smtp.example.com');
  assert.equal(cfg.smtpPort, 587);
  assert.equal(cfg.recipients.length, 2);
  assert.ok(cfg.recipients.includes('graylinksauto.ai@gmail.com'));
  assert.ok(cfg.recipients.includes('godwingeorge.contact@gmail.com'));
  clearSmtpEnv();
});

test('loadNotifyConfig returns null when recipients are missing', () => {
  setSmtpEnv({ ATLAS_CRITICAL_REPORT_RECIPIENTS: '' });
  assert.equal(loadNotifyConfig(), null);
  clearSmtpEnv();
});

/* ── notifyCriticalAlert ─────────────────────────────────────────────────── */

test('notifyCriticalAlert returns skipped when SMTP is not configured', async () => {
  clearSmtpEnv();
  const result = await notifyCriticalAlert(baseAlert);
  assert.equal(result, 'skipped');
  assert.equal(sentMessages.length, 0);
});

test('notifyCriticalAlert sends email when configured correctly', async () => {
  setSmtpEnv();
  const result = await notifyCriticalAlert(baseAlert);
  assert.equal(result, 'sent');
  assert.equal(sentMessages.length, 1);
  clearSmtpEnv();
});

test('notifyCriticalAlert addresses both configured recipients', async () => {
  setSmtpEnv();
  await notifyCriticalAlert(baseAlert);
  const msg = sentMessages[0]!;
  assert.ok(msg.to.includes('graylinksauto.ai@gmail.com'),  'first recipient in To:');
  assert.ok(msg.to.includes('godwingeorge.contact@gmail.com'), 'second recipient in To:');
  clearSmtpEnv();
});

test('notifyCriticalAlert subject includes CRITICAL and obligation title', async () => {
  setSmtpEnv();
  await notifyCriticalAlert(baseAlert);
  const subject = sentMessages[0]!.subject;
  assert.ok(subject.includes('CRITICAL'),                          'subject contains CRITICAL');
  assert.ok(subject.includes('Annual Structural Integrity Audit'), 'subject contains obligation title');
  clearSmtpEnv();
});

test('notifyCriticalAlert body labels AI-generated content clearly', async () => {
  setSmtpEnv();
  await notifyCriticalAlert({
    ...baseAlert,
    aiSummary: 'The obligation appears severely overdue with no mitigation in place.',
    aiModel: 'google/gemma-4-31b-it',
  });
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('AI-GENERATED SUMMARY'),    'AI section is labelled');
  assert.ok(body.includes('google/gemma-4-31b-it'),   'model name is included');
  assert.ok(body.includes('requires human verification'), 'AI caveat is present');
  clearSmtpEnv();
});

test('notifyCriticalAlert body marks output as non-AI when model unavailable', async () => {
  setSmtpEnv();
  await notifyCriticalAlert({ ...baseAlert }); // no aiSummary
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('AI SUMMARY UNAVAILABLE'),    'unavailability is labelled');
  assert.ok(!body.includes('AI-GENERATED SUMMARY'),     'does not claim AI content');
  clearSmtpEnv();
});

test('notifyCriticalAlert body contains evidence and recommended action', async () => {
  setSmtpEnv();
  await notifyCriticalAlert(baseAlert);
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('EVIDENCE'),           'evidence section present');
  assert.ok(body.includes('RECOMMENDED ACTION'), 'recommended action section present');
  assert.ok(body.includes(baseAlert.evidenceSummary), 'actual evidence text present');
  clearSmtpEnv();
});

test('notifyCriticalAlert body never exposes SMTP credentials', async () => {
  setSmtpEnv({ SMTP_PASS: 'super-secret-password-xyz' });
  await notifyCriticalAlert(baseAlert);
  const body = sentMessages[0]!.text;
  assert.ok(!body.includes('super-secret-password-xyz'), 'SMTP password not in body');
  clearSmtpEnv();
});

test('notifyCriticalAlert includes disclaimer that this is not an approved escalation', async () => {
  setSmtpEnv();
  await notifyCriticalAlert(baseAlert);
  const body = sentMessages[0]!.text;
  assert.ok(body.includes('does not constitute an approved escalation'), 'approval disclaimer present');
  clearSmtpEnv();
});

test('notifyCriticalAlert skips duplicate: same alert sent before returns skipped', async () => {
  setSmtpEnv();
  duplicateExists = true;
  const result = await notifyCriticalAlert(baseAlert);
  assert.equal(result, 'skipped');
  assert.equal(sentMessages.length, 0, 'no email sent for duplicate');
  clearSmtpEnv();
});

test('notifyCriticalAlert returns failed when transport throws', async () => {
  setSmtpEnv();
  transportShouldFail = true;
  const result = await notifyCriticalAlert(baseAlert);
  assert.equal(result, 'failed');
  assert.equal(sentMessages.length, 0);
  clearSmtpEnv();
});

test('notifyCriticalAlert never throws even when pool is unavailable', async () => {
  setSmtpEnv();
  poolShouldFail = true;
  // Must not throw — compliance sweep cannot be aborted by notification failures
  const result = await notifyCriticalAlert(baseAlert);
  assert.ok(['skipped','failed','sent'].includes(result), 'returns a valid status without throwing');
  clearSmtpEnv();
});

test('notifyCriticalAlert severity guard: only CRITICAL severity accepted by type', async () => {
  // TypeScript enforces this at compile time; verify the value passes through
  setSmtpEnv();
  await notifyCriticalAlert(baseAlert); // severity: 'CRITICAL'
  assert.equal(sentMessages[0]!.subject.includes('CRITICAL'), true);
  clearSmtpEnv();
});

/* ── sendTestNotification ────────────────────────────────────────────────── */

test('sendTestNotification is disabled in production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  setSmtpEnv();
  const result = await sendTestNotification({ requestedBy: 'user-001' });
  assert.equal(result.status, 'skipped');
  assert.equal(sentMessages.length, 0);
  process.env.NODE_ENV = prev;
  clearSmtpEnv();
});

test('sendTestNotification skips when SMTP is not configured', async () => {
  clearSmtpEnv();
  process.env.NODE_ENV = 'development';
  const result = await sendTestNotification({ requestedBy: 'user-001' });
  assert.equal(result.status, 'skipped');
  assert.ok(result.error?.includes('SMTP not configured'));
});

test('sendTestNotification sends a DEMO-labelled message to both recipients', async () => {
  process.env.NODE_ENV = 'development';
  setSmtpEnv();
  const result = await sendTestNotification({ requestedBy: 'user-001' });
  assert.equal(result.status, 'sent');
  assert.equal(result.recipients.length, 2);
  assert.ok(result.recipients.includes('graylinksauto.ai@gmail.com'));
  assert.ok(result.recipients.includes('godwingeorge.contact@gmail.com'));
  assert.equal(sentMessages.length, 1);
  const msg = sentMessages[0]!;
  assert.ok(msg.subject.includes('DEMO'),                    'subject is labelled DEMO');
  assert.ok(msg.text.includes('Critical Report Delivery Test'), 'body identifies as a test');
  assert.ok(msg.text.includes('graylinksauto.ai@gmail.com'), 'body lists first recipient');
  clearSmtpEnv();
});

test('sendTestNotification returns failed and safe error when transport fails', async () => {
  process.env.NODE_ENV = 'development';
  setSmtpEnv();
  transportShouldFail = true;
  const result = await sendTestNotification({ requestedBy: 'user-001' });
  assert.equal(result.status, 'failed');
  assert.ok(result.error !== undefined, 'error message is present');
  assert.ok(!result.error!.includes('test-pass'), 'error does not expose SMTP password');
  clearSmtpEnv();
});
