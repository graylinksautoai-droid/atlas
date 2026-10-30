/**
 * Unit tests for the administrator communication service (comms.ts).
 *
 * Fully database-independent: pool is mocked via setCommsPoolOverride.
 * Fully SMTP-independent: nodemailer transport is mocked via setCommsTransportOverride.
 * Audit events are silenced via setAuditPoolOverride.
 *
 * No real database connections, no real SMTP calls, no .env mutations.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setCommsPoolOverride,
  setCommsTransportOverride,
  createDraft,
  updateDraft,
  sendCommunication,
  getCommunication,
  listCommunications,
  type CommunicationEntry,
} from '../src/comms.ts';
import { setAuditPoolOverride } from '../src/audit.ts';

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const SUB_ID   = 'sub-001';
const CONTACT_ID = 'contact-001';
const ACTOR_ID = 'user-admin-001';
const COMM_ID  = 'comm-001';

const activeContact = {
  id: CONTACT_ID,
  name: 'Jane Regulatory',
  email: 'jane@example.com',
  subsidiary_id: SUB_ID,
  is_active: true,
};

const subsidiary = { id: SUB_ID, name: 'Test Sub Ltd', sector: 'Finance' };

const obligation = {
  id: 'obl-001',
  title: 'Annual GDPR Report',
  kind: 'REGULATORY',
  due_at: new Date('2026-09-01T00:00:00Z'),
  status: 'OVERDUE',
  owner_name: 'Alice Owner',
};

const alert = {
  id: 'alert-001',
  type: 'OVERDUE_OBLIGATION',
  severity: 'HIGH',
  evidence_summary: 'Annual GDPR Report is 57 days overdue.',
  recommended_action: 'Escalate to subsidiary lead.',
};

const draftEntry: CommunicationEntry = {
  id: COMM_ID,
  subsidiary_id: SUB_ID,
  subsidiary_name: 'Test Sub Ltd',
  initiated_by: ACTOR_ID,
  initiator_name: 'Admin User',
  recipient_contact_id: CONTACT_ID,
  recipient_name: 'Jane Regulatory',
  recipient_email: 'jane@example.com',
  subject: 'Overdue notice: Annual GDPR Report — Test Sub Ltd',
  message_body: 'Dear Jane Regulatory,\n\nThis is a compliance notice.',
  related_alert_id: 'alert-001',
  related_obligation_id: 'obl-001',
  ai_assisted: false,
  ai_model: null,
  status: 'DRAFT',
  transport_message_id: null,
  error_message: null,
  sent_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

/* ── Mock transport ─────────────────────────────────────────────────────── */

interface SentMail { from: unknown; to: unknown; subject: unknown; text: unknown }
let sentMails: SentMail[] = [];
let transportShouldFail = false;

const mockTransport = {
  sendMail: async (msg: object) => {
    if (transportShouldFail) throw new Error('SMTP connection refused [mock]');
    sentMails.push(msg as SentMail);
    return { messageId: '<mock-msg-001@test>' };
  },
};

/* ── Mock pool ──────────────────────────────────────────────────────────── */

/**
 * The mock pool is driven by a queue of row-sets (mockRows).
 * Each call to pool.query() shifts one row-set from the front of the queue.
 *
 * This mirrors the pattern used in inbox.test.ts and notify.test.ts.
 */
type Row = Record<string, unknown> | CommunicationEntry;
let mockRows: Row[][] = [];
let poolCalls: Array<{ sql: string; params: unknown[] }> = [];
let poolShouldFail = false;

const mockPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (poolShouldFail) throw new Error('DB connection lost [mock]');
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    poolCalls.push({ sql: trimmed.slice(0, 120), params: params ?? [] });
    const rows = mockRows.shift() ?? [];
    return { rows, rowCount: rows.length };
  },
} as Parameters<typeof setCommsPoolOverride>[0];

const silentAudit = { query: async () => ({ rows: [] }) } as Parameters<typeof setAuditPoolOverride>[0];

// Install overrides once for the entire module
setCommsPoolOverride(mockPool);
setCommsTransportOverride(mockTransport);
setAuditPoolOverride(silentAudit);

beforeEach(() => {
  mockRows = [];
  poolCalls = [];
  sentMails = [];
  transportShouldFail = false;
  poolShouldFail = false;
  // Clear SMTP env to prevent real transport creation in sendCommunication
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
    delete process.env[k];
  }
});

/* ── createDraft — basic success ────────────────────────────────────────── */

test('createDraft returns ok:true with DRAFT entry on success (deterministic)', async () => {
  // Sequence: contact, subsidiary, obligation, alert, INSERT RETURNING id, getCommunication (JOIN SELECT)
  mockRows = [
    [activeContact],
    [subsidiary],
    [obligation],
    [alert],
    [{ id: COMM_ID }],          // INSERT RETURNING id
    [draftEntry],               // getCommunication SELECT
  ];

  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    relatedAlertId: 'alert-001',
    relatedObligationId: 'obl-001',
    actorId: ACTOR_ID,
  });

  assert.equal(result.ok, true, 'should succeed');
  assert.equal(result.id, COMM_ID);
  assert.equal(result.draft?.status, 'DRAFT');
  assert.equal(result.draft?.recipient_email, 'jane@example.com');
});

test('createDraft with no obligation/alert still succeeds (generic draft)', async () => {
  mockRows = [
    [activeContact],
    [subsidiary],
    // no obligation query, no alert query — skipped
    [{ id: COMM_ID }],
    [{ ...draftEntry, related_alert_id: null, related_obligation_id: null }],
  ];

  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    actorId: ACTOR_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, COMM_ID);
});

/* ── createDraft — validation failures ──────────────────────────────────── */

test('createDraft rejects when contact is not found', async () => {
  mockRows = [[]]; // empty → contact not found
  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: 'missing-contact',
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /not found/i);
});

test('createDraft rejects when contact is deactivated', async () => {
  mockRows = [[{ ...activeContact, is_active: false }]];
  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /deactivated/i);
});

test('createDraft rejects when contact belongs to a different subsidiary', async () => {
  mockRows = [[{ ...activeContact, subsidiary_id: 'sub-999' }]];
  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /does not belong/i);
});

/* ── createDraft — AI-assisted path ─────────────────────────────────────── */

test('createDraft falls back to deterministic draft when AI model is not configured', async () => {
  // Ensure AI is not configured for this test
  const origKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;

  mockRows = [
    [activeContact],
    [subsidiary],
    [obligation],
    [alert],
    [{ id: COMM_ID }],
    [draftEntry],
  ];

  const result = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    relatedAlertId: 'alert-001',
    relatedObligationId: 'obl-001',
    actorId: ACTOR_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.draft?.ai_assisted, false, 'AI-assisted should be false without a key');

  if (origKey) process.env.AI_API_KEY = origKey;
});

/* ── updateDraft ─────────────────────────────────────────────────────────── */

test('updateDraft succeeds on a DRAFT record', async () => {
  mockRows = [[{ id: COMM_ID }]]; // UPDATE returns rowCount=1
  // We simulate rowCount via rows.length in the mock (rows=[{id}] → rowCount=1)

  const result = await updateDraft({
    id: COMM_ID,
    subject: 'Updated Subject',
    messageBody: 'Updated body text, at least ten characters.',
    actorId: ACTOR_ID,
  });

  assert.equal(result.ok, true);
});

test('updateDraft rejects empty subject', async () => {
  const result = await updateDraft({
    id: COMM_ID,
    subject: '   ',
    messageBody: 'Valid body text here.',
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /subject/i);
});

test('updateDraft rejects body shorter than 10 chars', async () => {
  const result = await updateDraft({
    id: COMM_ID,
    subject: 'Valid Subject',
    messageBody: 'Too short',
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /10 char/i);
});

test('updateDraft rejects when record is not in DRAFT status', async () => {
  mockRows = [[]]; // UPDATE finds no DRAFT row → rowCount=0
  const result = await updateDraft({
    id: COMM_ID,
    subject: 'Valid Subject',
    messageBody: 'Valid body text, at least 10 chars.',
    actorId: ACTOR_ID,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /already sent/i);
});

/* ── sendCommunication ───────────────────────────────────────────────────── */

test('sendCommunication sends successfully and returns messageId', async () => {
  // SELECT comm JOIN subsidiary, UPDATE PENDING, UPDATE SENT
  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Test subject', message_body: 'Body',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [{ rowCount: 1 }],   // UPDATE PENDING
    [{ rowCount: 1 }],   // UPDATE SENT
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);

  assert.equal(result.ok, true);
  assert.equal(result.messageId, '<mock-msg-001@test>');
  assert.equal(sentMails.length, 1, 'exactly one mail sent');
  assert.equal((sentMails[0] as { to: string }).to, 'jane@example.com');
});

test('sendCommunication records FAILED status on SMTP error', async () => {
  transportShouldFail = true;

  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Test subject', message_body: 'Body',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [{ rowCount: 1 }],   // UPDATE PENDING
    [{ rowCount: 1 }],   // UPDATE FAILED
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);

  assert.equal(result.ok, false, 'should fail');
  assert.match(result.reason ?? '', /delivery failed/i);
  assert.equal(sentMails.length, 0, 'no mail should be sent on SMTP error');

  // Verify the FAILED update SQL was queued
  const updateFailed = poolCalls.find(c => c.sql.includes("'FAILED'") || c.sql.includes('FAILED'));
  assert.ok(updateFailed, 'should have issued a FAILED status update');
});

test('sendCommunication rejects communication that is not in DRAFT status', async () => {
  mockRows = [
    [{ id: COMM_ID, status: 'SENT', subject: 'Test', message_body: 'Body',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /SENT/);
  assert.equal(sentMails.length, 0, 'should not attempt SMTP for non-DRAFT');
});

test('sendCommunication returns error when communication is not found', async () => {
  mockRows = [[]]; // SELECT returns no rows

  const result = await sendCommunication('nonexistent-id', ACTOR_ID);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /not found/i);
  assert.equal(sentMails.length, 0);
});

/* ── Retry: FAILED → DRAFT → send ───────────────────────────────────────── */

test('retry: can send after resetting FAILED back to DRAFT', async () => {
  // First send — SMTP fails
  transportShouldFail = true;
  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Retry subject', message_body: 'Body text',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [],   // UPDATE PENDING
    [],   // UPDATE FAILED
  ];
  const failResult = await sendCommunication(COMM_ID, ACTOR_ID);
  assert.equal(failResult.ok, false);

  // Reset transport, simulate reset to DRAFT in DB via pool response
  transportShouldFail = false;

  // Second send — now succeeds
  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Retry subject', message_body: 'Body text',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [],  // UPDATE PENDING
    [],  // UPDATE SENT
  ];

  const retryResult = await sendCommunication(COMM_ID, ACTOR_ID);
  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.messageId, '<mock-msg-001@test>');
  assert.equal(sentMails.length, 1, 'exactly one mail on retry');
});

/* ── Preview never sends ──────────────────────────────────────────────────── */

test('getCommunication does not trigger SMTP (preview is read-only)', async () => {
  mockRows = [[draftEntry]];
  const comm = await getCommunication(COMM_ID);
  assert.ok(comm, 'should return the entry');
  assert.equal(sentMails.length, 0, 'preview must never call SMTP');
});

test('listCommunications does not trigger SMTP', async () => {
  mockRows = [[draftEntry, { ...draftEntry, id: 'comm-002' }]];
  const list = await listCommunications();
  assert.equal(list.length, 2);
  assert.equal(sentMails.length, 0, 'listing must never call SMTP');
});

/* ── Audit events are written ────────────────────────────────────────────── */

test('createDraft calls audit pool with draft.created action', async () => {
  const auditCalls: Array<{ sql: string; params: unknown[] }> = [];
  const trackingAudit = {
    query: async (sql: string, params?: unknown[]) => {
      auditCalls.push({ sql, params: params ?? [] });
      return { rows: [{ id: 'audit-001' }] };
    },
  } as Parameters<typeof setAuditPoolOverride>[0];
  setAuditPoolOverride(trackingAudit);

  mockRows = [
    [activeContact],
    [subsidiary],
    [obligation],
    [alert],
    [{ id: COMM_ID }],
    [draftEntry],
  ];

  await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    relatedAlertId: 'alert-001',
    relatedObligationId: 'obl-001',
    actorId: ACTOR_ID,
  });

  const auditInsert = auditCalls.find(c => c.sql.includes('audit_event'));
  assert.ok(auditInsert, 'an audit_event INSERT should have been issued');

  const actionParam = (auditInsert?.params ?? []).find(
    (p) => typeof p === 'string' && (p as string).includes('draft.created'),
  );
  assert.ok(actionParam, 'audit action should contain "draft.created"');

  // Restore silent audit
  setAuditPoolOverride(silentAudit);
});

test('sendCommunication calls audit with sent action on success', async () => {
  const auditCalls: Array<{ sql: string; params: unknown[] }> = [];
  const trackingAudit = {
    query: async (sql: string, params?: unknown[]) => {
      auditCalls.push({ sql, params: params ?? [] });
      return { rows: [{ id: 'audit-002' }] };
    },
  } as Parameters<typeof setAuditPoolOverride>[0];
  setAuditPoolOverride(trackingAudit);

  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Audit test', message_body: 'Body text',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [],
    [],
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);
  assert.equal(result.ok, true);

  const sentAudit = auditCalls.find(c =>
    c.sql.includes('audit_event') &&
    (c.params ?? []).some((p) => typeof p === 'string' && (p as string).includes('communication.sent')),
  );
  assert.ok(sentAudit, 'audit_event INSERT for communication.sent should be present');

  setAuditPoolOverride(silentAudit);
});

test('sendCommunication calls audit with failed action on SMTP error', async () => {
  transportShouldFail = true;
  const auditCalls: Array<{ sql: string; params: unknown[] }> = [];
  const trackingAudit = {
    query: async (sql: string, params?: unknown[]) => {
      auditCalls.push({ sql, params: params ?? [] });
      return { rows: [{ id: 'audit-003' }] };
    },
  } as Parameters<typeof setAuditPoolOverride>[0];
  setAuditPoolOverride(trackingAudit);

  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Fail test', message_body: 'Body text',
       recipient_email: 'jane@example.com', recipient_name: 'Jane', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [],
    [],
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);
  assert.equal(result.ok, false);

  const failedAudit = auditCalls.find(c =>
    c.sql.includes('audit_event') &&
    (c.params ?? []).some((p) => typeof p === 'string' && (p as string).includes('communication.failed')),
  );
  assert.ok(failedAudit, 'audit_event INSERT for communication.failed should be present');

  setAuditPoolOverride(silentAudit);
});

/* ── No real SMTP connections ────────────────────────────────────────────── */

test('mock transport intercepts all sendMail calls — no real connections made', async () => {
  // This test verifies the transport override is active.
  // If the override were not set, sendCommunication would try to use real SMTP.
  // Because we have setCommsTransportOverride(mockTransport) above, this call
  // goes to mockTransport.sendMail and never opens a socket.
  mockRows = [
    [{ id: COMM_ID, status: 'DRAFT', subject: 'Socket test', message_body: 'No socket opened',
       recipient_email: 'no-socket@example.com', recipient_name: 'No Socket', subsidiary_id: SUB_ID,
       subsidiary_name: 'Test Sub Ltd' }],
    [],
    [],
  ];

  const result = await sendCommunication(COMM_ID, ACTOR_ID);

  // If we reach here without a real SMTP connect attempt, the mock is working.
  assert.equal(result.ok, true);
  assert.equal(sentMails.length, 1);
  assert.equal((sentMails[0] as { to: string }).to, 'no-socket@example.com');
});

/* ── DB pool isolation ───────────────────────────────────────────────────── */

test('all pool queries go through the mock — no real DB calls', async () => {
  // Track all sql patterns across a full createDraft → updateDraft → send lifecycle
  const sqlLog: string[] = [];
  const trackingPool = {
    query: async (sql: string, params?: unknown[]) => {
      sqlLog.push(sql.trim().split('\n')[0]);
      // Wire up appropriate response based on query type
      if (sql.includes('subsidiary_contact')) return { rows: [activeContact], rowCount: 1 };
      if (sql.includes('FROM subsidiary')) return { rows: [subsidiary], rowCount: 1 };
      if (sql.includes('FROM obligation')) return { rows: [obligation], rowCount: 1 };
      if (sql.includes('FROM alert')) return { rows: [alert], rowCount: 1 };
      if (sql.includes('INSERT INTO communication_log')) return { rows: [{ id: COMM_ID }], rowCount: 1 };
      if (sql.includes('FROM communication_log') || sql.includes('JOIN subsidiary')) return { rows: [draftEntry], rowCount: 1 };
      if (sql.includes('UPDATE communication_log')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as Parameters<typeof setCommsPoolOverride>[0];

  setCommsPoolOverride(trackingPool);

  const draft = await createDraft({
    subsidiaryId: SUB_ID,
    recipientContactId: CONTACT_ID,
    relatedAlertId: 'alert-001',
    relatedObligationId: 'obl-001',
    actorId: ACTOR_ID,
  });
  assert.equal(draft.ok, true);

  const update = await updateDraft({
    id: COMM_ID,
    subject: 'Updated Subject',
    messageBody: 'Updated body text that is long enough.',
    actorId: ACTOR_ID,
  });
  assert.equal(update.ok, true);

  // SQL log should contain only mock-resolved queries
  assert.ok(sqlLog.length > 0, 'queries should have been issued');
  // None should be aimed at a real pg socket; the mock intercepts everything.

  // Restore default mock
  setCommsPoolOverride(mockPool);
});
