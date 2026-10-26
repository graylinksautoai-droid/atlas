import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env loader. A dependency is not worth it for eight variables.
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

// Stylesheet URLs carry the file mtime so a redeploy can never serve stale CSS.
function assetStamp(file: string): string {
  try {
    return String(Math.round(statSync(join(ROOT, 'public', file)).mtimeMs));
  } catch {
    return '0';
  }
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 8090),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? required('TEST_DATABASE_URL'),
  sessionSecret: process.env.SESSION_SECRET ?? 'demo-session-secret-change-me',
  sessionTtlMinutes: int('SESSION_TTL_MINUTES', 720),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  complianceIntervalMs: int('COMPLIANCE_INTERVAL_MS', 15 * 60 * 1000),
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== '0',
  dueSoonHours: int('DUE_SOON_HOURS', 72),
  ai: {
    provider: (process.env.AI_PROVIDER ?? 'none').toLowerCase(),
    apiKey: process.env.AI_API_KEY ?? '',
    baseUrl: process.env.AI_BASE_URL ?? 'https://openrouter.ai/api/v1',
    model: process.env.AI_MODEL ?? 'google/gemini-2.0-flash-001',
    timeoutMs: int('AI_TIMEOUT_MS', 25_000),
    maxInputChars: int('AI_MAX_INPUT_CHARS', 18_000),
  },
  upload: {
    maxBytes: int('UPLOAD_MAX_BYTES', 256 * 1024),
    allowedMime: ['text/plain', 'text/markdown'],
  },
  limits: {
    loginPerMinute: int('LOGIN_RATE_LIMIT', 8),
    uploadPerMinute: int('UPLOAD_RATE_LIMIT', 12),
  },
} as const;

export const cssHref = `/static/app.css?v=${assetStamp('app.css')}`;

export const modelConfigured = config.ai.provider !== 'none' && config.ai.apiKey.length > 0;
