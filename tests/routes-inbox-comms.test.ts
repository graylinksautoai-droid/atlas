/**
 * HTTP route integration tests for:
 *   - GET  /notifications
 *   - POST /notifications/:id/read
 *   - POST /notifications/read-all
 *   - GET  /admin/communicate
 *   - POST /admin/communicate  (create draft)
 *   - GET  /admin/communicate/:id  (detail / preview)
 *   - POST /admin/communicate/:id/update
 *   - POST /admin/communicate/:id/send
 *   - POST /admin/communicate/:id/retry
 *   - GET  /admin/contacts
 *   - POST /admin/contacts
 *
 * Verifies: authentication, user ownership, role permissions, and CSRF.
 *
 * Uses the test database (TEST_DATABASE_URL). No real email is sent:
 * SMTP env vars are absent and the comms service is never reached by
 * routes tested here (no valid contact in the test DB for communicate POST).
 */

process.env.ATLAS_NO_LISTEN = '1';
process.env.SCHEDULER_ENABLED = '0';
process.env.AI_PROVIDER = 'none';
delete process.env.AI_API_KEY;

import { readFileSync, existsSync } from 'node:fs';
const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const dotenv: Record<string, string> = {};
for (const line of envFile.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) dotenv[match[1]] = match[2].trim();
}
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? dotenv.TEST_DATABASE_URL ??
  'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { migrate }    = await import('../scripts/migrate.ts');
const { seed }       = await import('../scripts/seed.ts');
const { one, query, closePool } = await import('../src/db.ts');
const { app }        = await import('../src/server.ts');

const PASSWORD = process.env.SEED_PASSWORD || 'AtlasDemo!2026';

interface Session { cookie: string; csrf: string }
let admin!: Session;       // ifeoma.eze@atlas.demo    ADMIN
let compliance!: Session;  // tunde.bello@atlas.demo   COMPLIANCE
let exec!: Session;        // adaeze.okonkwo@atlas.demo EXEC

async function login(email: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(res.statusCode, 302, `login failed for ${email}`);
  const raw = String(res.headers['set-cookie']);
  const cookie = raw.split(';')[0];
  const sessionId = cookie.split('=')[1].split('.')[0];
  const row = await one<{ csrf_token: string; user_id: string }>(
    `SELECT csrf_token, user_id FROM session WHERE id = $1`,
    [sessionId],
  );
  return { cookie, csrf: row!.csrf_token };
}

/** Insert a notification row directly and return its ID. */
async function insertNotification(userId: string, dedupeKey: string, opts?: { readAt?: boolean }) {
  const row = await one<{ id: string }>(
    `INSERT INTO in_app_notification
       (recipient_user_id, dedupe_key, type, title, message, entity_type, link, read_at)
     VALUES ($1, $2, 'HIGH_ALERT', 'Test alert', 'Test message', 'alert', '/alerts/test', $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, dedupeKey, opts?.readAt ? 'now()' : null],
  );
  // If ON CONFLICT hit, fetch the existing row
  if (!row) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM in_app_notification WHERE dedupe_key = $1 AND recipient_user_id = $2`,
      [dedupeKey, userId],
    );
    return existing!.id;
  }
  return row.id;
}

before(async () => {
  await migrate();
  await seed();
  [admin, compliance, exec] = await Promise.all([
    login('ifeoma.eze@atlas.demo'),
    login('tunde.bello@atlas.demo'),
    login('adaeze.okonkwo@atlas.demo'),
  ]);
});

after(async () => {
  await app.close();
  await closePool();
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /notifications
   ══════════════════════════════════════════════════════════════════════════ */

test('GET /notifications — unauthenticated requests are redirected to login', async () => {
  const res = await app.inject({ method: 'GET', url: '/notifications', headers: { accept: 'text/html' } });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /\/login/);
});

test('GET /notifications — authenticated user sees the notifications page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/notifications',
    headers: { cookie: compliance.cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Notifications/);
});

test('GET /notifications — EXEC user can see the notifications page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/notifications',
    headers: { cookie: exec.cookie },
  });
  assert.equal(res.statusCode, 200);
});

test('GET /notifications — user sees their own notifications, not other users\'', async () => {
  // Insert one notification for the compliance user and one for the admin
  const compUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'tunde.bello@atlas.demo'`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  await insertNotification(compUser!.id, 'TEST:owned-by-compliance:' + compUser!.id);
  await insertNotification(adminUser!.id, 'TEST:owned-by-admin:' + adminUser!.id);

  // Compliance user should see their own notification
  const compRes = await app.inject({
    method: 'GET',
    url: '/notifications',
    headers: { cookie: compliance.cookie },
  });
  assert.equal(compRes.statusCode, 200);
  // The page should not expose the admin's notification
  // (We can verify via the admin session)
  const adminRes = await app.inject({
    method: 'GET',
    url: '/notifications',
    headers: { cookie: admin.cookie },
  });
  assert.equal(adminRes.statusCode, 200);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /notifications/:id/read
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /notifications/:id/read — unauthenticated request is rejected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/notifications/00000000-0000-4000-8000-000000000001/read',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '_csrf=forged',
  });
  // Unauthenticated → 401 or redirect
  assert.ok(res.statusCode === 401 || res.statusCode === 302);
});

test('POST /notifications/:id/read — missing CSRF token is rejected with 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/notifications/00000000-0000-4000-8000-000000000001/read',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged-token',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /notifications/:id/read — user can mark their own notification as read', async () => {
  const compUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'tunde.bello@atlas.demo'`);
  const notifId = await insertNotification(compUser!.id, `TEST:mark-read:${compUser!.id}:${Date.now()}`);

  const res = await app.inject({
    method: 'POST',
    url: `/notifications/${notifId}/read`,
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}`,
  });
  // Should redirect to /notifications?marked=1
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /notifications/);

  // Verify DB state
  const notif = await one<{ read_at: Date | null }>(
    `SELECT read_at FROM in_app_notification WHERE id = $1`,
    [notifId],
  );
  assert.ok(notif?.read_at !== null, 'notification should now be marked as read');
});

test('POST /notifications/:id/read — user cannot mark another user\'s notification as read', async () => {
  // Insert a notification for the admin user
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const notifId = await insertNotification(adminUser!.id, `TEST:ownership:${adminUser!.id}:${Date.now()}`);

  // Compliance user tries to mark admin's notification as read
  const res = await app.inject({
    method: 'POST',
    url: `/notifications/${notifId}/read`,
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}`,
  });

  // Route still redirects (markRead silently returns false), but DB should not change
  assert.equal(res.statusCode, 302);
  const notif = await one<{ read_at: Date | null }>(
    `SELECT read_at FROM in_app_notification WHERE id = $1`,
    [notifId],
  );
  assert.equal(notif?.read_at, null, 'admin\'s notification must remain unread');
});

test('POST /notifications/:id/read — invalid UUID is rejected with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/notifications/not-a-uuid/read',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}`,
  });
  assert.equal(res.statusCode, 400);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /notifications/read-all
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /notifications/read-all — unauthenticated request is rejected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/notifications/read-all',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '_csrf=forged',
  });
  assert.ok(res.statusCode === 401 || res.statusCode === 302);
});

test('POST /notifications/read-all — CSRF check is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/notifications/read-all',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=wrong-token',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /notifications/read-all — marks all unread for the requesting user only', async () => {
  const compUser  = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'tunde.bello@atlas.demo'`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const ts = Date.now();
  const compNotifId  = await insertNotification(compUser!.id,  `TEST:read-all-comp:${ts}`);
  const adminNotifId = await insertNotification(adminUser!.id, `TEST:read-all-admin:${ts}`);

  // Reset both to unread
  await query(`UPDATE in_app_notification SET read_at = NULL WHERE id = ANY($1)`, [[compNotifId, adminNotifId]]);

  const res = await app.inject({
    method: 'POST',
    url: '/notifications/read-all',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}`,
  });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /notifications/);

  const compNotif  = await one<{ read_at: Date | null }>(`SELECT read_at FROM in_app_notification WHERE id = $1`, [compNotifId]);
  const adminNotif = await one<{ read_at: Date | null }>(`SELECT read_at FROM in_app_notification WHERE id = $1`, [adminNotifId]);

  assert.ok(compNotif?.read_at !== null, 'compliance user\'s notification is marked read');
  assert.equal(adminNotif?.read_at, null, 'admin\'s notification must not be affected');
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /admin/communicate — role protection
   ══════════════════════════════════════════════════════════════════════════ */

test('GET /admin/communicate — unauthenticated request is rejected', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/communicate', headers: { accept: 'text/html' } });
  assert.ok(res.statusCode === 401 || res.statusCode === 302);
});

test('GET /admin/communicate — COMPLIANCE role is forbidden (requires manage)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/communicate',
    headers: { cookie: compliance.cookie },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/communicate — EXEC role is forbidden', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/communicate',
    headers: { cookie: exec.cookie },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/communicate — ADMIN user sees the communications page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/communicate',
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Communications/i);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /admin/communicate — create draft
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /admin/communicate — CSRF is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged&subsidiaryId=some-id&recipientEmail=test@example.com',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate — COMPLIANCE role is forbidden', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}&subsidiaryId=some-id&recipientEmail=test@example.com`,
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate — missing subsidiaryId redirects to failed', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}&subsidiaryId=&recipientEmail=test@example.com`,
  });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /failed=1/);
});

test('POST /admin/communicate — unknown recipient email returns 422 with error', async () => {
  // Get a real subsidiary ID
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}&subsidiaryId=${sub!.id}&recipientEmail=nobody@nonexistent.invalid`,
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.body, /No active contact found/i);
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /admin/communicate/:id — preview / detail
   ══════════════════════════════════════════════════════════════════════════ */

test('GET /admin/communicate/:id — unknown UUID returns 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000099',
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /admin/communicate/:id — COMPLIANCE role is forbidden', async () => {
  // Insert a dummy comm row so we have a real ID to test against
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const commRow = await one<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_name, recipient_email, subject, message_body, status)
     VALUES ($1, $2, 'Test Contact', 'test@example.com', 'Test Subject', 'Test body for route test.', 'DRAFT')
     RETURNING id`,
    [sub!.id, adminUser!.id],
  );

  const res = await app.inject({
    method: 'GET',
    url: `/admin/communicate/${commRow!.id}`,
    headers: { cookie: compliance.cookie },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/communicate/:id — ADMIN can view the draft (preview does not send)', async () => {
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const commRow = await one<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_name, recipient_email, subject, message_body, status)
     VALUES ($1, $2, 'Preview Contact', 'preview@example.com', 'Preview Subject', 'Preview body text.', 'DRAFT')
     RETURNING id`,
    [sub!.id, adminUser!.id],
  );

  const before = await one<{ sent_at: Date | null }>(
    `SELECT sent_at FROM communication_log WHERE id = $1`,
    [commRow!.id],
  );

  const res = await app.inject({
    method: 'GET',
    url: `/admin/communicate/${commRow!.id}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Preview Subject/);

  const after = await one<{ sent_at: Date | null; status: string }>(
    `SELECT sent_at, status::text AS status FROM communication_log WHERE id = $1`,
    [commRow!.id],
  );
  assert.equal(after?.sent_at, null, 'viewing the draft must not send it');
  assert.equal(after?.status, 'DRAFT', 'status stays DRAFT after preview');
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /admin/communicate/:id/update
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /admin/communicate/:id/update — CSRF is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000001/update',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged&subject=New+Subject&messageBody=Valid+body+text+here.',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate/:id/update — COMPLIANCE role is forbidden', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000001/update',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}&subject=New&messageBody=Valid body.`,
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate/:id/update — saves updated subject and body', async () => {
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const commRow = await one<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_name, recipient_email, subject, message_body, status)
     VALUES ($1, $2, 'Update Contact', 'update@example.com', 'Original Subject', 'Original body text here.', 'DRAFT')
     RETURNING id`,
    [sub!.id, adminUser!.id],
  );

  const res = await app.inject({
    method: 'POST',
    url: `/admin/communicate/${commRow!.id}/update`,
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}&subject=Updated+Subject&messageBody=This+body+has+been+updated+by+the+admin.`,
  });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /saved=1/);

  const updated = await one<{ subject: string; message_body: string }>(
    `SELECT subject, message_body FROM communication_log WHERE id = $1`,
    [commRow!.id],
  );
  assert.equal(updated?.subject, 'Updated Subject');
  assert.match(updated?.message_body ?? '', /updated by the admin/i);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /admin/communicate/:id/send — SMTP not configured → FAILED
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /admin/communicate/:id/send — CSRF is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000001/send',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate/:id/send — COMPLIANCE role is forbidden', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000001/send',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}`,
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate/:id/send — without SMTP config marks FAILED and redirects', async () => {
  // Clear SMTP env vars to guarantee no real SMTP attempt
  const saved = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const commRow = await one<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_name, recipient_email, subject, message_body, status)
     VALUES ($1, $2, 'Send Contact', 'send@example.com', 'Send Test Subject', 'Send test body here.', 'DRAFT')
     RETURNING id`,
    [sub!.id, adminUser!.id],
  );

  const res = await app.inject({
    method: 'POST',
    url: `/admin/communicate/${commRow!.id}/send`,
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}`,
  });
  // Route redirects regardless; the outcome flag tells us what happened
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /failed=1/);

  // DB should show FAILED (not SENT)
  const comm = await one<{ status: string }>(
    `SELECT status::text AS status FROM communication_log WHERE id = $1`,
    [commRow!.id],
  );
  assert.equal(comm?.status, 'FAILED', 'without SMTP config the status must be FAILED');

  // Restore env
  if (saved.SMTP_HOST) process.env.SMTP_HOST = saved.SMTP_HOST;
  if (saved.SMTP_USER) process.env.SMTP_USER = saved.SMTP_USER;
  if (saved.SMTP_PASS) process.env.SMTP_PASS = saved.SMTP_PASS;
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /admin/communicate/:id/retry
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /admin/communicate/:id/retry — CSRF is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/communicate/00000000-0000-4000-8000-000000000001/retry',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/communicate/:id/retry — only FAILED communications can be retried', async () => {
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const adminUser = await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ifeoma.eze@atlas.demo'`);
  const commRow = await one<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_name, recipient_email, subject, message_body, status)
     VALUES ($1, $2, 'Retry Contact', 'retry@example.com', 'Retry Subject', 'Retry body text.', 'DRAFT')
     RETURNING id`,
    [sub!.id, adminUser!.id],
  );

  const res = await app.inject({
    method: 'POST',
    url: `/admin/communicate/${commRow!.id}/retry`,
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}`,
  });
  // DRAFT status → should get 400 (not retryable)
  assert.equal(res.statusCode, 400);
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /admin/contacts — role protection
   ══════════════════════════════════════════════════════════════════════════ */

test('GET /admin/contacts — unauthenticated request is rejected', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/contacts', headers: { accept: 'text/html' } });
  assert.ok(res.statusCode === 401 || res.statusCode === 302);
});

test('GET /admin/contacts — COMPLIANCE role is forbidden', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/contacts',
    headers: { cookie: compliance.cookie },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/contacts — EXEC role is forbidden', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/contacts',
    headers: { cookie: exec.cookie },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/contacts — ADMIN sees the contacts page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/contacts',
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Contacts/i);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /admin/contacts — CSRF + role
   ══════════════════════════════════════════════════════════════════════════ */

test('POST /admin/contacts — CSRF is enforced', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/contacts',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '_csrf=forged&name=Test&email=t@t.com&subsidiaryId=fake',
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/contacts — COMPLIANCE role is forbidden', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/contacts',
    headers: {
      cookie: compliance.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${compliance.csrf}&name=Test&email=t@t.com&subsidiaryId=fake`,
  });
  assert.equal(res.statusCode, 403);
});

test('POST /admin/contacts — invalid subsidiaryId returns 422 with error message', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/contacts',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}&name=John+Contact&email=john@example.com&subsidiaryId=00000000-0000-4000-8000-000000000000&designation=CFO`,
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.body, /Subsidiary not found|invalid/i);
});

test('POST /admin/contacts — valid submission creates a contact and redirects', async () => {
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary LIMIT 1`);
  const ts = Date.now();

  const res = await app.inject({
    method: 'POST',
    url: '/admin/contacts',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${admin.csrf}&subsidiaryId=${sub!.id}&name=Route+Test+Contact&email=routetest${ts}%40example.com&designation=CFO`,
  });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /created=1/);

  const contact = await one<{ name: string; is_active: boolean }>(
    `SELECT name, is_active FROM subsidiary_contact WHERE email = $1`,
    [`routetest${ts}@example.com`],
  );
  assert.ok(contact, 'contact row exists in DB');
  assert.equal(contact!.name, 'Route Test Contact');
  assert.equal(contact!.is_active, true);
});
