import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.ts';
import { config } from './config.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type Role = 'EXEC' | 'COMPLIANCE' | 'ADMIN';
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  csrfToken: string;
}

const SCRYPT_N = 16_384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scrypt(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export async function findUserByEmail(email: string): Promise<{ id: string; email: string; name: string; role: Role; password_hash: string; is_active: boolean } | null> {
  return one(
    `SELECT id, email, name, role::text AS role, password_hash, is_active FROM app_user WHERE email = lower($1)`,
    [email.trim()],
  );
}

export async function createSession(userId: string): Promise<{ id: string; csrfToken: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60_000);
  await query(`INSERT INTO session (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)`, [id, userId, csrfToken, expiresAt]);
  return { id, csrfToken, expiresAt };
}

export async function loadSession(sessionId: string | undefined): Promise<SessionUser | null> {
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return null;
  const row = await one<{ id: string; email: string; name: string; role: Role; csrf_token: string }>(
    `SELECT u.id, u.email, u.name, u.role::text AS role, s.csrf_token
       FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [sessionId],
  );
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, sessionId, csrfToken: row.csrf_token };
}

export async function destroySession(sessionId: string): Promise<void> {
  await query(`DELETE FROM session WHERE id = $1`, [sessionId]);
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await query(`DELETE FROM session WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}

export function can(user: SessionUser, action: 'read' | 'run_check' | 'upload' | 'approve' | 'manage'): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'COMPLIANCE') return action !== 'manage';
  return action === 'read';
}

/** Cookie value is sessionId.signature so a forged id cannot be replayed. */
export function signSession(sessionId: string): string {
  const signature = createHmac('sha256', config.sessionSecret).update(sessionId).digest('base64url');
  return `${sessionId}.${signature}`;
}

export function unsignSession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const sessionId = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  const expected = createHmac('sha256', config.sessionSecret).update(sessionId).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return sessionId;
}
