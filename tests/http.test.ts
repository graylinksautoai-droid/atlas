process.env.ATLAS_NO_LISTEN = '1';
process.env.SCHEDULER_ENABLED = '0';
// Hermetic: the suite must never depend on a live model or spend tokens.
process.env.AI_PROVIDER = 'none';
delete process.env.AI_API_KEY;

import { readFileSync, existsSync } from 'node:fs';
const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const dotenv: Record<string, string> = {};
for (const line of envFile.split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) dotenv[match[1]] = match[2].trim();
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? dotenv.TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../scripts/migrate.ts');
const { seed } = await import('../scripts/seed.ts');
const { one, closePool } = await import('../src/db.ts');
const { app } = await import('../src/server.ts');

const PASSWORD = process.env.SEED_PASSWORD ?? 'AtlasDemo!2026';
let execCookie = '';
let complianceCookie = '';
let execCsrf = '';

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(response.statusCode, 302, `login for ${email}`);
  const raw = String(response.headers['set-cookie']);
  const cookie = raw.split(';')[0];
  const sessionId = cookie.split('=')[1].split('.')[0];
  const row = await one<{ csrf_token: string }>(`SELECT csrf_token FROM session WHERE id = $1`, [sessionId]);
  return { cookie, csrf: row!.csrf_token };
}

before(async () => {
  await migrate();
  await seed();
  const exec = await login('adaeze.okonkwo@atlas.demo');
  execCookie = exec.cookie;
  execCsrf = exec.csrf;
  const compliance = await login('tunde.bello@atlas.demo');
  complianceCookie = compliance.cookie;
});

after(async () => {
  await app.close();
  await closePool();
});

test('unauthenticated page requests are refused rather than rendered', async () => {
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /Sign in to continue/);
});

test('unauthenticated API requests return a JSON error, not a stack trace', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/summary' });
  assert.equal(response.statusCode, 401);
  const body = response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'unauthorised');
  assert.ok(!response.body.includes('at ') || !response.body.includes('.ts:'), 'no stack trace in the response');
});

test('bad credentials are rejected with a generic message', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'email=adaeze.okonkwo%40atlas.demo&password=wrong-password',
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /credentials were not accepted/);
  assert.ok(!response.body.includes('wrong-password'));
});

test('security headers are present on every response', async () => {
  const response = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy']), /script-src 'none'/);
});

test('an executive can read the dashboard but cannot run a compliance check', async () => {
  const page = await app.inject({ method: 'GET', url: '/', headers: { cookie: execCookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Portfolio position/);

  const run = await app.inject({
    method: 'POST',
    url: '/compliance/run',
    headers: { cookie: execCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${execCsrf}`,
  });
  assert.equal(run.statusCode, 403);
});

test('a submission without a valid CSRF token is refused', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/compliance/run',
    headers: { cookie: complianceCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: '_csrf=forged-token',
  });
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /expired or was tampered/);
});

test('a compliance user can run the sweep through the API with a valid token', async () => {
  const session = await one<{ csrf_token: string }>(`SELECT csrf_token FROM session WHERE csrf_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  const page = await app.inject({ method: 'GET', url: '/compliance', headers: { cookie: complianceCookie } });
  assert.equal(page.statusCode, 200);
  const match = page.body.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'the page carries a csrf token');
  const response = await app.inject({
    method: 'POST',
    url: '/api/compliance/run',
    headers: { cookie: complianceCookie, 'x-csrf-token': String(match![1]) },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: { status: string } };
  assert.equal(body.data.status, 'OK');
  assert.ok(session);
});

test('unknown records return a clean 404', async () => {
  const response = await app.inject({ method: 'GET', url: '/subsidiaries/00000000-0000-4000-8000-000000000000', headers: { cookie: complianceCookie } });
  assert.equal(response.statusCode, 404);
  assert.match(response.body, /Subsidiary not found/);
});

test('malformed identifiers fail validation before reaching the database', async () => {
  const response = await app.inject({ method: 'GET', url: '/obligations/not-a-uuid', headers: { cookie: complianceCookie } });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /identifier is not valid/);
  assert.ok(!response.body.includes('invalid input syntax'), 'database error text is not exposed');
});

test('logout clears the session and the cookie can no longer read data', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/logout',
    headers: { cookie: execCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${execCsrf}`,
  });
  assert.equal(response.statusCode, 302);
  const after = await app.inject({ method: 'GET', url: '/', headers: { cookie: execCookie } });
  assert.equal(after.statusCode, 401);
});
