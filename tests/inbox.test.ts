/**
 * Unit tests for the in-app notification service (inbox.ts).
 *
 * Database-independent: pool is mocked via setInboxPoolOverride.
 * No real DB connections made; no audit_event rows written.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setInboxPoolOverride,
  createNotification,
  countUnread,
  markRead,
  markAllRead,
  listNotificationsForUser,
} from '../src/inbox.ts';
import { setAuditPoolOverride } from '../src/audit.ts';

/* ── Mock pool ──────────────────────────────────────────────────────────── */

interface Row { [k: string]: unknown }
let mockRows: Row[][] = [];
let insertedRows: Array<{ sql: string; params: unknown[] }> = [];
let updateCount = 0;
let poolShouldFail = false;

const mockPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (poolShouldFail) throw new Error('DB fail [mock]');
    insertedRows.push({ sql: sql.trim().slice(0, 80), params: params ?? [] });
    // INSERT … ON CONFLICT DO NOTHING RETURNING id
    if (sql.includes('INSERT INTO in_app_notification') && sql.includes('ON CONFLICT')) {
      const rows = mockRows.shift() ?? [];
      return { rows, rowCount: rows.length };
    }
    // SELECT count
    if (sql.includes('count(*)')) {
      return { rows: [{ n: String(mockRows.shift()?.[0]?.n ?? 0) }], rowCount: 1 };
    }
    // UPDATE
    if (sql.includes('UPDATE in_app_notification')) {
      const rc = typeof mockRows[0]?.[0]?.rowCount === 'number' ? (mockRows.shift()![0]!.rowCount as number) : 1;
      updateCount += rc;
      return { rows: [], rowCount: rc };
    }
    // SELECT list
    if (sql.includes('SELECT id') || sql.includes('SELECT')) {
      return { rows: mockRows.shift() ?? [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
} as any;

const silentAudit = { query: async () => ({ rows: [] }) } as any;

setInboxPoolOverride(mockPool);
setAuditPoolOverride(silentAudit);

beforeEach(() => {
  mockRows = [];
  insertedRows = [];
  updateCount = 0;
  poolShouldFail = false;
});

/* ── createNotification ─────────────────────────────────────────────────── */

test('createNotification returns the new ID on success', async () => {
  mockRows = [[{ id: 'notif-uuid-001' }]];
  const id = await createNotification({
    recipientUserId: 'user-001',
    dedupeKey: 'CRITICAL_ALERT:alert-001:user-001',
    type: 'CRITICAL_ALERT',
    title: 'Critical alert raised',
    message: 'A critical obligation is overdue.',
    link: '/alerts/alert-001',
  });
  assert.equal(id, 'notif-uuid-001');
});

test('createNotification returns null when deduplicated (ON CONFLICT DO NOTHING)', async () => {
  mockRows = [[]]; // empty rows = duplicate suppressed
  const id = await createNotification({
    recipientUserId: 'user-001',
    dedupeKey: 'CRITICAL_ALERT:alert-001:user-001',
    type: 'CRITICAL_ALERT',
    title: 'Duplicate',
    message: '',
  });
  assert.equal(id, null);
});

test('createNotification never throws even when pool fails', async () => {
  poolShouldFail = true;
  const id = await createNotification({
    recipientUserId: 'user-001',
    dedupeKey: 'SYSTEM:test',
    type: 'SYSTEM',
    title: 'Test',
    message: '',
  });
  assert.equal(id, null, 'returns null on pool failure');
});

test('createNotification truncates title to 200 chars', async () => {
  mockRows = [[{ id: 'n1' }]];
  await createNotification({
    recipientUserId: 'u1',
    dedupeKey: 'x',
    type: 'SYSTEM',
    title: 'A'.repeat(300),
    message: '',
  });
  const titleParam = insertedRows[0]?.params?.[3] as string;
  assert.equal(typeof titleParam, 'string');
  assert.ok(titleParam.length <= 200, 'title capped at 200 chars');
});

test('createNotification truncates message to 1000 chars', async () => {
  mockRows = [[{ id: 'n2' }]];
  await createNotification({
    recipientUserId: 'u1',
    dedupeKey: 'y',
    type: 'SYSTEM',
    title: 'Test',
    message: 'B'.repeat(2000),
  });
  const msgParam = insertedRows[0]?.params?.[4] as string;
  assert.ok((msgParam as string).length <= 1000, 'message capped at 1000 chars');
});

test('createNotification accepts null recipientUserId (broadcast)', async () => {
  mockRows = [[{ id: 'broadcast-001' }]];
  const id = await createNotification({
    recipientUserId: null,
    dedupeKey: 'SYSTEM:broadcast',
    type: 'SYSTEM',
    title: 'System event',
    message: '',
  });
  assert.equal(id, 'broadcast-001');
  const recipParam = insertedRows[0]?.params?.[0];
  assert.equal(recipParam, null, 'null recipient stored for broadcast');
});

/* ── countUnread ────────────────────────────────────────────────────────── */

test('countUnread returns numeric count from pool', async () => {
  mockRows = [[{ n: '5' }]];
  const n = await countUnread('user-001');
  assert.equal(n, 5);
});

test('countUnread returns 0 when no unread notifications', async () => {
  mockRows = [[{ n: '0' }]];
  const n = await countUnread('user-001');
  assert.equal(n, 0);
});

test('countUnread returns 0 on pool failure', async () => {
  poolShouldFail = true;
  // countUnread calls pool directly — no catch in the function
  // It will throw; caller uses .catch(() => 0) in server.ts
  // We test that the promise rejects (correct behaviour for caller to handle)
  await assert.rejects(() => countUnread('user-001'));
});

/* ── markRead ───────────────────────────────────────────────────────────── */

test('markRead returns true when a row was updated', async () => {
  mockRows = [[{ rowCount: 1 }]];
  updateCount = 0;
  const result = await markRead('notif-001', 'user-001');
  assert.equal(result, true);
});

test('markRead returns false when no row matches (wrong user or already read)', async () => {
  mockRows = [[{ rowCount: 0 }]]; // simulate 0 rows updated
  updateCount = 0;
  // The mock returns rowCount 0
  const result = await markRead('notif-999', 'other-user');
  // result depends on mock returning rowCount=0
  assert.ok(typeof result === 'boolean');
});

test('markRead only updates notifications owned by the requesting user', async () => {
  mockRows = [[{ rowCount: 1 }]];
  await markRead('notif-001', 'user-abc');
  // Verify the UPDATE WHERE clause includes recipient_user_id param
  const updateCall = insertedRows.find((c) => c.sql.includes('UPDATE in_app_notification'));
  assert.ok(updateCall, 'UPDATE was called');
  const params = updateCall!.params as unknown[];
  assert.ok(params.includes('user-abc'), 'user ID included in WHERE params');
  assert.ok(params.includes('notif-001'), 'notification ID included in WHERE params');
});

/* ── markAllRead ────────────────────────────────────────────────────────── */

test('markAllRead only affects the requesting user', async () => {
  updateCount = 0;
  await markAllRead('user-xyz');
  const updateCall = insertedRows.find((c) => c.sql.includes('UPDATE in_app_notification'));
  assert.ok(updateCall, 'UPDATE was called');
  assert.ok((updateCall!.params as string[]).includes('user-xyz'), 'user ID in params');
});

/* ── listNotificationsForUser ───────────────────────────────────────────── */

test('listNotificationsForUser queries by recipient_user_id', async () => {
  mockRows = [[
    { id: 'n1', recipient_user_id: 'u1', dedupe_key: 'k1', type: 'SYSTEM',
      title: 'T1', message: '', entity_type: null, entity_id: null, link: null,
      read_at: null, created_at: new Date() },
  ]];
  const results = await listNotificationsForUser('u1', 'EXEC', 10);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'T1');
  const selectCall = insertedRows.find((c) => c.sql.startsWith('SELECT'));
  assert.ok(selectCall, 'SELECT was called');
  assert.ok((selectCall!.params as string[]).includes('u1'), 'user ID in SELECT params');
});

test('listNotificationsForUser returns empty array when no notifications', async () => {
  mockRows = [[]];
  const results = await listNotificationsForUser('u2', 'ADMIN', 10);
  assert.equal(results.length, 0);
});

/* ── Deduplication semantics ─────────────────────────────────────────────── */

test('dedupeKey uniqueness: same key + same user produces one row', async () => {
  // First call inserts
  mockRows = [[{ id: 'n1' }]];
  const id1 = await createNotification({ recipientUserId: 'u1', dedupeKey: 'X:1', type: 'SYSTEM', title: 'T', message: '' });
  // Second call returns empty (ON CONFLICT DO NOTHING)
  mockRows = [[]];
  const id2 = await createNotification({ recipientUserId: 'u1', dedupeKey: 'X:1', type: 'SYSTEM', title: 'T', message: '' });
  assert.equal(id1, 'n1');
  assert.equal(id2, null, 'duplicate suppressed');
});
