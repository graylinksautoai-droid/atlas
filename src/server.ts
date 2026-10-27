import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { config, modelConfigured, ROOT, cssHref } from './config.ts';
import { closePool, healthCheck } from './db.ts';
import {
  createSession,
  destroySession,
  findUserByEmail,
  can,
  loadSession,
  purgeExpiredSessions,
  signSession,
  unsignSession,
  verifyPassword,
  type SessionUser,
} from './auth.ts';
import { audit } from './audit.ts';
import { runComplianceCheck, latestChecks } from './compliance.ts';
import { confirmObligationStatus } from './obligations.ts';
import { decideApproval } from './agent.ts';
import { ingestDocument, documentDetail, validateTextUpload } from './documents.ts';
import * as portfolio from './portfolio.ts';
import { sendTestNotification } from './notify.ts';
import * as adminSvc from './admin.ts';
import { layout, loginPage, esc, fmtDateTime, notice, titleCase } from './views/layout.ts';
import {
  overviewPage,
  subsidiariesPage,
  subsidiaryPage,
  projectsPage,
  projectPage,
  obligationPage,
  compliancePage,
  documentsPage,
  documentPage,
  alertsPage,
  alertPage,
  activityPage,
  errorPage,
  adminHubPage,
  adminUsersPage,
  adminUserEditPage,
  adminSubsidiariesPage,
  adminSubsidiaryEditPage,
  adminProjectsPage,
  adminProjectEditPage,
  adminObligationsPage,
  adminObligationEditPage,
} from './views/pages.ts';
import { startScheduler } from './scheduler.ts';

const COOKIE = 'atlas_session';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true,
  bodyLimit: 512 * 1024,
});

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: config.upload.maxBytes, files: 1, fields: 8 } });
await app.register(rateLimit, { global: false, max: 240, timeWindow: '1 minute' });
await app.register(fastifyStatic, {
  root: join(ROOT, 'public'),
  prefix: '/static/',
  // Development must never serve a stale stylesheet after an edit.
  maxAge: config.env === 'production' ? '1h' : 0,
});

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'same-origin');
  reply.header('x-frame-options', 'DENY');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  return payload;
});

function clientIp(req: FastifyRequest): string {
  return req.ip;
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const raw = req.cookies[COOKIE];
  const sessionId = unsignSession(raw);
  if (!sessionId) return null;
  return loadSession(sessionId);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Only same-site paths are accepted as a post-login destination. */
function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '';
  return value.slice(0, 200);
}

function requireUser(user: SessionUser | null): SessionUser {
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  return user;
}

function requireCan(user: SessionUser, action: 'run_check' | 'upload' | 'approve' | 'manage', message?: string): void {
  if (!can(user, action)) throw new HttpError(403, message ?? 'Your role does not permit this action.');
}

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'That identifier is not valid.');
  }
  return value;
}

function checkCsrf(req: FastifyRequest, user: SessionUser): void {
  const header = req.headers['x-csrf-token'];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof header === 'string' ? header : typeof body._csrf === 'string' ? body._csrf : '';
  if (!token || token !== user.csrfToken) throw new HttpError(403, 'The form expired or was tampered with. Reload the page and try again.');
}

function page(reply: FastifyReply, html: string, status = 200): FastifyReply {
  reply.code(status).type('text/html; charset=utf-8');
  return reply.send(html);
}

app.setErrorHandler((error, req, reply) => {
  const status = error instanceof HttpError ? error.status : (error as { statusCode?: number }).statusCode ?? 500;
  const message = error instanceof HttpError
    ? error.message
    : status >= 500
      ? 'Something went wrong while handling that request. The failure was logged, no partial action was recorded.'
      : (error as Error).message;

  if (status >= 500) req.log.error({ err: error, url: req.url }, 'request failed');

  // A browser hitting a protected page should land on the sign-in form, not an error page.
  if (status === 401 && wantsHtml(req) && !req.url.startsWith('/api')) {
    const next = req.url.startsWith('/') && !req.url.startsWith('/login') ? req.url : '';
    return reply.code(302).header('location', next ? `/login?next=${encodeURIComponent(next)}` : '/login').send();
  }

  if (wantsHtml(req) || req.url.startsWith('/static')) {
    return page(reply, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${status} · ATLAS</title><link rel="stylesheet" href="${cssHref}"></head><body class="auth"><main class="auth__panel">${errorPage(status, message)}</main></body></html>`, status);
  }
  return reply.code(status).send({ error: { code: status === 401 ? 'unauthorised' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'request_failed', message } });
});

app.setNotFoundHandler((req, reply) => {
  if (wantsHtml(req)) return page(reply, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 · ATLAS</title><link rel="stylesheet" href="${cssHref}"></head><body class="auth"><main class="auth__panel">${errorPage(404, 'That page does not exist.')}</main></body></html>`, 404);
  return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown route.' } });
});

/* Authentication ---------------------------------------------------------- */

app.get('/login', async (req, reply) => {
  const user = await currentUser(req);
  if (user) return reply.redirect('/');
  const next = typeof (req.query as { next?: string })?.next === 'string' ? safeNext((req.query as { next?: string }).next) : '';
  return page(reply, loginPage(undefined, next));
});

app.post(
  '/login',
  { config: { rateLimit: { max: config.limits.loginPerMinute, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    if (!email || !password) return page(reply, loginPage('Enter your email and password.', safeNext(body.next)), 400);

    const user = await findUserByEmail(email);
    const ok = user && user.is_active ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !ok) {
      await audit({
        actorType: 'SYSTEM',
        action: 'auth.login.failed',
        entityType: 'app_user',
        entityId: user?.id ?? null,
        detail: { email: email.slice(0, 120) },
        requestId: req.id,
      });
      return page(reply, loginPage('Those credentials were not accepted.', safeNext(body.next)), 401);
    }

    const session = await createSession(user.id);
    reply.setCookie(COOKIE, signSession(session.id), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      expires: session.expiresAt,
    });
    await audit({
      actorType: 'USER',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'app_user',
      entityId: user.id,
      detail: { role: user.role },
      requestId: req.id,
    });
    return reply.redirect(safeNext(body.next) || '/');
  },
);

app.post('/logout', async (req, reply) => {
  const user = await currentUser(req);
  if (user) {
    await destroySession(user.sessionId);
    await audit({ actorType: 'USER', actorId: user.id, action: 'auth.logout', entityType: 'app_user', entityId: user.id });
  }
  reply.clearCookie(COOKIE, { path: '/' });
  return reply.redirect('/login');
});

/* Pages ------------------------------------------------------------------- */

app.get('/', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const [kpis, subs, upcoming, alerts, runs, obligationBreakdown, alertBreakdown, pendingApprovals] = await Promise.all([
    portfolio.dashboardKpis(),
    portfolio.subsidiaryPerformance(),
    portfolio.upcomingObligations(10),
    portfolio.recentAlerts(5),
    portfolio.recentAgentActivity(5),
    portfolio.obligationStatusBreakdown(),
    portfolio.alertSeverityBreakdown(),
    portfolio.pendingApprovals(6),
  ]);
  const checkedAt = kpis.lastCheckAt ? fmtDateTime(kpis.lastCheckAt) : 'not run yet';
  // Email is configured only when all three SMTP credentials are present.
  const emailConfigured = Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  );
  return page(
    reply,
    layout({
      user,
      title: 'Executive overview',
      active: 'overview',
      body: overviewPage({
        user,
        csrf: user.csrfToken,
        kpis,
        subsidiaries: subs,
        upcoming,
        alerts,
        runs,
        obligationBreakdown,
        alertBreakdown,
        pendingApprovals,
        canRun: can(user, 'run_check'),
        checkedAt,
        modelConfigured,
        emailConfigured,
      }),
    }),
  );
});

app.get('/subsidiaries', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const rows = await portfolio.subsidiaries();
  return page(reply, layout({ user, title: 'Subsidiaries', active: 'subsidiaries', body: subsidiariesPage(user, user.csrfToken, rows) }));
});

app.get('/subsidiaries/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const id = requireUuid((req.params as { id: string }).id);
  const data = await portfolio.subsidiaryDetail(id);
  if (!data.subsidiary) throw new HttpError(404, 'Subsidiary not found.');
  return page(reply, layout({ user, title: data.subsidiary.name, active: 'subsidiaries', body: subsidiaryPage(user, data) }));
});

app.get('/projects', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const query = req.query as Record<string, string | undefined>;
  const filter = { status: query.status ?? '', subsidiary: query.subsidiary ?? '' };
  const [rows, subs] = await Promise.all([portfolio.projectList(filter), portfolio.subsidiaries()]);
  return page(
    reply,
    layout({
      user,
      title: 'Projects',
      active: 'projects',
      subtitle: 'Filters apply on the server, not in the browser.',
      body: projectsPage(user, rows, filter, subs),
    }),
  );
});

app.get('/projects/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const id = requireUuid((req.params as { id: string }).id);
  const data = await portfolio.projectDetail(id);
  if (!data.project) throw new HttpError(404, 'Project not found.');
  return page(reply, layout({ user, title: data.project.name, active: 'projects', body: projectPage(user, data) }));
});

app.get('/obligations/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const id = requireUuid((req.params as { id: string }).id);
  const data = await portfolio.obligationDetail(id);
  if (!data.obligation) throw new HttpError(404, 'Obligation not found.');
  return page(
    reply,
    layout({
      user,
      title: data.obligation.title,
      active: 'compliance',
      body: obligationPage(user, user.csrfToken, data, can(user, 'run_check')),
    }),
  );
});

app.post('/obligations/:id/status', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'run_check', 'Your role cannot record obligation outcomes.');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const status = String(body.status ?? '').toUpperCase();
  const result = await confirmObligationStatus({ obligationId: id, status, actorId: user.id });
  const message = result.ok
    ? `Obligation marked ${status.toLowerCase()}. The change is in the audit trail.`
    : result.reason ?? 'That change was refused.';
  const data = await portfolio.obligationDetail(id);
  if (!data.obligation) throw new HttpError(404, 'Obligation not found.');
  return page(
    reply,
    layout({
      user,
      title: data.obligation.title,
      active: 'compliance',
      body: notice(result.ok ? 'ok' : 'error', message) + obligationPage(user, user.csrfToken, data, can(user, 'run_check')),
    }),
    result.ok ? 200 : 409,
  );
});

app.get('/compliance', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const query = req.query as Record<string, string | undefined>;
  const [kpis, checks, overdueOnly] = await Promise.all([
    portfolio.dashboardKpis(),
    latestChecks(12),
    portfolio.overdueList(50),
  ]);
  const noticeText = query.ran === '1'
    ? `Sweep completed: ${query.scanned ?? 0} obligations scanned, ${query.alerts ?? 0} new alert(s), ${query.runs ?? 0} agent run(s).`
    : query.skipped === '1'
      ? 'A sweep is already running, so this request was skipped. Nothing was duplicated.'
      : query.failed === '1'
        ? 'The sweep failed. The error is recorded in the check history and the audit trail.'
        : undefined;
  return page(
    reply,
    layout({
      user,
      title: 'Compliance centre',
      active: 'compliance',
      subtitle: 'Deterministic monitoring of deadlines, submissions, and required evidence.',
      body: compliancePage({
        user,
        csrf: user.csrfToken,
        checks,
        overdue: overdueOnly,
        canRun: can(user, 'run_check'),
        kpis,
        schedulerIntervalMinutes: Math.round(config.complianceIntervalMs / 60_000),
        noticeText,
      }),
    }),
  );
});

app.post('/compliance/run', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'run_check', 'Your role cannot run compliance checks.');
  const result = await runComplianceCheck({ trigger: 'MANUAL', actorId: user.id });
  if (result.status === 'SKIPPED') return reply.redirect('/compliance?skipped=1');
  if (result.status === 'FAILED') return reply.redirect('/compliance?failed=1');
  return reply.redirect(`/compliance?ran=1&scanned=${result.scanned}&alerts=${result.alertsCreated}&runs=${result.agentRuns}`);
});

app.get('/documents', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const query = req.query as Record<string, string | undefined>;
  const [docs, options] = await Promise.all([portfolio.documentList(), portfolio.obligationOptions()]);
  const noticeText = query.uploaded === 'ok' ? 'Submission stored and assessed. Findings are labelled by provenance.' : undefined;
  return page(
    reply,
    layout({
      user,
      title: 'Documents',
      active: 'documents',
      subtitle: 'Controlled intake, deterministic checks, validated model assessment.',
      body: documentsPage({
        user,
        csrf: user.csrfToken,
        docs,
        options,
        canUpload: can(user, 'upload'),
        modelLabel: modelConfigured ? `${config.ai.model}` : 'not configured, deterministic checks only',
        noticeText,
        selected: query.obligation,
      }),
    }),
  );
});

app.post(
  '/documents',
  { config: { rateLimit: { max: config.limits.uploadPerMinute, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const user = requireUser(await currentUser(req));
    requireCan(user, 'upload', 'Your role cannot upload documents.');
    let data;
    try {
      data = await req.file();
    } catch {
      throw new HttpError(400, 'The upload was rejected. Files must be text under 256 KB.');
    }
    if (!data) throw new HttpError(400, 'Attach a file.');

    const fields = (data.fields ?? {}) as Record<string, { value?: unknown }>;
    const csrfField = fields._csrf?.value;
    if (typeof csrfField !== 'string' || csrfField !== user.csrfToken) {
      throw new HttpError(403, 'The form expired or was tampered with. Reload and try again.');
    }

    const obligationId = typeof fields.obligationId?.value === 'string' ? String(fields.obligationId.value) : '';
    if (!/^[0-9a-f-]{36}$/.test(obligationId)) throw new HttpError(400, 'Choose an obligation.');

    const buffer = await data.toBuffer();
    const invalid = validateTextUpload({ filename: data.filename, mime: data.mimetype, bytes: buffer.byteLength });
    if (invalid) throw new HttpError(400, invalid);

    const result = await ingestDocument({
      obligationId,
      filename: data.filename,
      mime: data.mimetype,
      buffer,
      userId: user.id,
    });
    if (result.ai === 'DEGRADED') {
      const docs = await portfolio.documentList();
      const options = await portfolio.obligationOptions();
      const detail = await documentDetail(result.documentId);
      return page(
        reply,
        layout({
          user,
          title: 'Documents',
          active: 'documents',
          body:
            notice('warn', `Stored, but the model assessment failed: ${result.aiNote ?? 'unknown error'}. Deterministic findings are available.`) +
            documentsPage({ user, csrf: user.csrfToken, docs, options, canUpload: can(user, 'upload'), modelLabel: config.ai.model }) +
            documentPage(detail, user),
        }),
        200,
      );
    }
    return reply.redirect(`/documents/${result.documentId}`);
  },
);

app.get('/documents/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const id = requireUuid((req.params as { id: string }).id);
  const detail = await documentDetail(id);
  if (!detail.document) throw new HttpError(404, 'Document not found.');
  return page(reply, layout({ user, title: detail.document.filename, active: 'documents', body: documentPage(detail, user), wide: true }));
});

app.get('/alerts', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const q = req.query as Record<string, string | undefined>;
  const filter = { status: q.status ?? '', severity: q.severity ?? '' };
  const rows = await portfolio.alertList(filter);
  return page(
    reply,
    layout({
      user,
      title: 'Alerts and approvals',
      active: 'alerts',
      subtitle: 'Every alert carries its evidence, and every consequential action needs a reviewer.',
      body: alertsPage({ user, csrf: user.csrfToken, rows, filter }),
    }),
  );
});

app.get('/alerts/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const id = requireUuid((req.params as { id: string }).id);
  const q = req.query as Record<string, string | undefined>;
  const data = await portfolio.alertDetail(id);
  if (!data.alert) throw new HttpError(404, 'Alert not found.');
  const noticeText = q.decided === 'executed'
    ? 'Approved and recorded. Delivery was in application only, and the audit trail says so.'
    : q.decided === 'rejected'
      ? 'Rejected. No action was executed.'
      : q.decided === 'expired'
        ? 'The obligation changed after review, so execution was refused and the case was queued for reassessment.'
        : undefined;
  return page(
    reply,
    layout({
      user,
      title: titleCase(String(data.alert.type)),
      active: 'alerts',
      body: alertPage(data, user, user.csrfToken, can(user, 'approve'), noticeText, q.decided === 'rejected' ? 'warn' : 'ok'),
    }),
  );
});

app.post('/alerts/:id/decide', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'approve', 'Your role cannot approve escalations.');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const decision = String(body.decision ?? '').toUpperCase();
  const approvalId = String(body.approvalId ?? '');
  if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new HttpError(400, 'Choose approve or reject.');
  if (!/^[0-9a-f-]{36}$/.test(approvalId)) throw new HttpError(400, 'Unknown approval.');

  const result = await decideApproval({
    approvalId,
    actorId: user.id,
    decision: decision as 'APPROVED' | 'REJECTED',
    comment: typeof body.comment === 'string' ? body.comment.slice(0, 400) : null,
  });

  const flag = result.outcome === 'EXECUTED' ? 'executed' : result.outcome === 'REJECTED' ? 'rejected' : result.outcome === 'EXPIRED' ? 'expired' : 'conflict';
  return reply.redirect(`/alerts/${id}?decided=${flag}`);
});

app.get('/activity', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  const [runs, trail] = await Promise.all([portfolio.recentAgentActivity(30), portfolio.auditTrail({ limit: 120 })]);
  return page(
    reply,
    layout({
      user,
      title: 'Agent activity and audit',
      active: 'activity',
      subtitle: 'What ran, what it saw, what it decided, and what a human then did.',
      body: activityPage({
        user,
        runs,
        audit: trail,
        modelLabel: modelConfigured ? config.ai.model : 'not configured, deterministic only',
      }),
      wide: true,
    }),
  );
});

/* Administration routes --------------------------------------------------- */

function adminLayout(user: SessionUser, title: string, active: string, body: string, subtitle?: string) {
  return layout({ user, title, active, body, subtitle });
}

app.get('/admin', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  return page(reply, adminLayout(user, 'Administration', 'admin', adminHubPage(user.csrfToken)));
});

/* ── User management ─────────────────────────────────────────────────────── */

app.get('/admin/users', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const q = req.query as Record<string, string | undefined>;
  const users = await adminSvc.listUsers();
  const n = q.created ? { kind: 'ok' as const, text: 'User created.' }
    : q.updated ? { kind: 'ok' as const, text: 'User updated.' }
    : q.pwreset ? { kind: 'ok' as const, text: 'Password reset. All existing sessions for that user were invalidated.' }
    : undefined;
  return page(reply, adminLayout(user, 'Users', 'admin',
    adminUsersPage({ csrf: user.csrfToken, users, notice: n }),
    'Manage application user accounts',
  ));
});

app.post('/admin/users', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.createUser({
    email: String(body.email ?? ''),
    name: String(body.name ?? ''),
    role: String(body.role ?? '') as 'EXEC' | 'COMPLIANCE' | 'ADMIN',
    password: String(body.password ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect('/admin/users?created=1');
  const users = await adminSvc.listUsers();
  return page(reply, adminLayout(user, 'Users', 'admin',
    adminUsersPage({ csrf: user.csrfToken, users, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

app.get('/admin/users/:id/edit', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const target = await adminSvc.getUser(id);
  if (!target) throw new HttpError(404, 'User not found.');
  const q = req.query as Record<string, string | undefined>;
  const n = q.updated ? { kind: 'ok' as const, text: 'Changes saved.' }
    : q.pwreset ? { kind: 'ok' as const, text: 'Password reset successfully.' }
    : undefined;
  return page(reply, adminLayout(user, target.name, 'admin',
    adminUserEditPage({ csrf: user.csrfToken, user: target, isSelf: target.id === user.id, notice: n }),
  ));
});

app.post('/admin/users/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.updateUser({
    id,
    name: String(body.name ?? ''),
    role: String(body.role ?? '') as 'EXEC' | 'COMPLIANCE' | 'ADMIN',
    is_active: body.is_active === '1',
    actorId: user.id,
  });
  if (result.ok) return reply.redirect(`/admin/users/${id}/edit?updated=1`);
  const target = await adminSvc.getUser(id);
  if (!target) throw new HttpError(404, 'User not found.');
  return page(reply, adminLayout(user, target.name, 'admin',
    adminUserEditPage({ csrf: user.csrfToken, user: target, isSelf: target.id === user.id, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

app.post('/admin/users/:id/password', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.setUserPassword({
    userId: id,
    newPassword: String(body.password ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect(`/admin/users/${id}/edit?pwreset=1`);
  const target = await adminSvc.getUser(id);
  if (!target) throw new HttpError(404, 'User not found.');
  return page(reply, adminLayout(user, target.name, 'admin',
    adminUserEditPage({ csrf: user.csrfToken, user: target, isSelf: target.id === user.id, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

/* ── Subsidiary admin ─────────────────────────────────────────────────────── */

app.get('/admin/subsidiaries', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const q = req.query as Record<string, string | undefined>;
  const subs = await adminSvc.listSubsidiariesAdmin();
  const n = q.created ? { kind: 'ok' as const, text: 'Subsidiary added.' }
    : q.updated ? { kind: 'ok' as const, text: 'Changes saved.' }
    : undefined;
  return page(reply, adminLayout(user, 'Subsidiaries', 'admin',
    adminSubsidiariesPage({ csrf: user.csrfToken, subsidiaries: subs, notice: n }),
    'Add and edit group companies',
  ));
});

app.post('/admin/subsidiaries', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.createSubsidiary({
    code: String(body.code ?? ''),
    name: String(body.name ?? ''),
    sector: String(body.sector ?? ''),
    description: String(body.description ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect('/admin/subsidiaries?created=1');
  const subs = await adminSvc.listSubsidiariesAdmin();
  return page(reply, adminLayout(user, 'Subsidiaries', 'admin',
    adminSubsidiariesPage({ csrf: user.csrfToken, subsidiaries: subs, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

app.get('/admin/subsidiaries/:id/edit', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const subs = await adminSvc.listSubsidiariesAdmin();
  const sub = subs.find((s) => s.id === id);
  if (!sub) throw new HttpError(404, 'Subsidiary not found.');
  const q = req.query as Record<string, string | undefined>;
  const n = q.updated ? { kind: 'ok' as const, text: 'Changes saved.' } : undefined;
  return page(reply, adminLayout(user, sub.name, 'admin',
    adminSubsidiaryEditPage({ csrf: user.csrfToken, subsidiary: sub, notice: n }),
  ));
});

app.post('/admin/subsidiaries/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.updateSubsidiary({
    id,
    name: String(body.name ?? ''),
    sector: String(body.sector ?? ''),
    description: String(body.description ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect(`/admin/subsidiaries/${id}/edit?updated=1`);
  const subs = await adminSvc.listSubsidiariesAdmin();
  const sub = subs.find((s) => s.id === id);
  if (!sub) throw new HttpError(404, 'Subsidiary not found.');
  return page(reply, adminLayout(user, sub.name, 'admin',
    adminSubsidiaryEditPage({ csrf: user.csrfToken, subsidiary: sub, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

/* ── Project admin ───────────────────────────────────────────────────────── */

app.get('/admin/projects', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const q = req.query as Record<string, string | undefined>;
  const [projects, subs] = await Promise.all([adminSvc.listProjectsAdmin(), adminSvc.subsidiarySelectorOptions()]);
  const n = q.created ? { kind: 'ok' as const, text: 'Project added.' }
    : q.updated ? { kind: 'ok' as const, text: 'Changes saved.' }
    : undefined;
  return page(reply, adminLayout(user, 'Projects', 'admin',
    adminProjectsPage({ csrf: user.csrfToken, projects, subsidiaries: subs, notice: n }),
    'Add and edit portfolio projects',
  ));
});

app.post('/admin/projects', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.createProject({
    subsidiaryId: String(body.subsidiaryId ?? ''),
    code: String(body.code ?? ''),
    name: String(body.name ?? ''),
    status: String(body.status ?? 'ACTIVE'),
    budgetNgn: String(body.budgetNgn ?? ''),
    startDate: String(body.startDate ?? ''),
    targetDate: String(body.targetDate ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect('/admin/projects?created=1');
  const [projects, subs] = await Promise.all([adminSvc.listProjectsAdmin(), adminSvc.subsidiarySelectorOptions()]);
  return page(reply, adminLayout(user, 'Projects', 'admin',
    adminProjectsPage({ csrf: user.csrfToken, projects, subsidiaries: subs, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

app.get('/admin/projects/:id/edit', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const projects = await adminSvc.listProjectsAdmin();
  const proj = projects.find((p) => p.id === id);
  if (!proj) throw new HttpError(404, 'Project not found.');
  // Fetch full date fields for the edit form
  const full = await adminSvc.getProjectDates(id);
  const q = req.query as Record<string, string | undefined>;
  const n = q.updated ? { kind: 'ok' as const, text: 'Changes saved.' } : undefined;
  return page(reply, adminLayout(user, proj.name, 'admin',
    adminProjectEditPage({ csrf: user.csrfToken, project: { ...proj, ...full! }, notice: n }),
  ));
});

app.post('/admin/projects/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.updateProject({
    id,
    name: String(body.name ?? ''),
    status: String(body.status ?? ''),
    budgetNgn: String(body.budgetNgn ?? ''),
    startDate: String(body.startDate ?? ''),
    targetDate: String(body.targetDate ?? ''),
    actorId: user.id,
  });
  if (result.ok) return reply.redirect(`/admin/projects/${id}/edit?updated=1`);
  const projects = await adminSvc.listProjectsAdmin();
  const proj = projects.find((p) => p.id === id);
  if (!proj) throw new HttpError(404, 'Project not found.');
  const full = await adminSvc.getProjectDates(id);
  return page(reply, adminLayout(user, proj.name, 'admin',
    adminProjectEditPage({ csrf: user.csrfToken, project: { ...proj, ...full! }, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

/* ── Obligation admin ────────────────────────────────────────────────────── */

app.get('/admin/obligations', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const q = req.query as Record<string, string | undefined>;
  const [obligations, projs] = await Promise.all([adminSvc.listObligationsAdmin(), adminSvc.projectSelectorOptions()]);
  const n = q.created ? { kind: 'ok' as const, text: 'Obligation added.' }
    : q.updated ? { kind: 'ok' as const, text: 'Changes saved.' }
    : undefined;
  return page(reply, adminLayout(user, 'Obligations', 'admin',
    adminObligationsPage({ csrf: user.csrfToken, obligations, projects: projs, notice: n }),
    'Add and edit compliance obligations',
  ));
});

app.post('/admin/obligations', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.createObligation({
    projectId: String(body.projectId ?? ''),
    title: String(body.title ?? ''),
    kind: String(body.kind ?? ''),
    dueAt: String(body.dueAt ?? ''),
    ownerName: String(body.ownerName ?? ''),
    requiresDocument: body.requiresDocument !== '0',
    actorId: user.id,
  });
  if (result.ok) return reply.redirect('/admin/obligations?created=1');
  const [obligations, projs] = await Promise.all([adminSvc.listObligationsAdmin(), adminSvc.projectSelectorOptions()]);
  return page(reply, adminLayout(user, 'Obligations', 'admin',
    adminObligationsPage({ csrf: user.csrfToken, obligations, projects: projs, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

app.get('/admin/obligations/:id/edit', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const obligations = await adminSvc.listObligationsAdmin();
  const ob = obligations.find((o) => o.id === id);
  if (!ob) throw new HttpError(404, 'Obligation not found.');
  const q = req.query as Record<string, string | undefined>;
  const n = q.updated ? { kind: 'ok' as const, text: 'Changes saved.' } : undefined;
  return page(reply, adminLayout(user, ob.title, 'admin',
    adminObligationEditPage({ csrf: user.csrfToken, obligation: ob, notice: n }),
  ));
});

app.post('/admin/obligations/:id', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  checkCsrf(req, user);
  requireCan(user, 'manage');
  const id = requireUuid((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Record<string, string>;
  const result = await adminSvc.updateObligation({
    id,
    title: String(body.title ?? ''),
    kind: String(body.kind ?? ''),
    dueAt: String(body.dueAt ?? ''),
    ownerName: String(body.ownerName ?? ''),
    requiresDocument: body.requiresDocument !== '0',
    actorId: user.id,
  });
  if (result.ok) return reply.redirect(`/admin/obligations/${id}/edit?updated=1`);
  const obligations = await adminSvc.listObligationsAdmin();
  const ob = obligations.find((o) => o.id === id);
  if (!ob) throw new HttpError(404, 'Obligation not found.');
  return page(reply, adminLayout(user, ob.title, 'admin',
    adminObligationEditPage({ csrf: user.csrfToken, obligation: ob, notice: { kind: 'error', text: result.reason! } }),
  ), 422);
});

/* Admin / development routes --------------------------------------------- */

/** Test-delivery endpoint. Disabled in production; requires ADMIN role + CSRF. */
app.post('/admin/test-notification', async (req, reply) => {
  if (config.env === 'production') throw new HttpError(404, 'Not found.');
  const user = requireUser(await currentUser(req));
  requireCan(user, 'manage', 'Only administrators can send test notifications.');
  checkCsrf(req, user);
  const result = await sendTestNotification({ requestedBy: user.id });
  const kind = result.status === 'sent' ? 'ok' : result.status === 'failed' ? 'error' : 'warn';
  const message = result.status === 'sent'
    ? `Test notification sent to ${result.recipients.length} recipient(s). Message ID: ${result.messageId ?? 'n/a'}`
    : result.status === 'failed'
      ? `Delivery failed: ${result.error ?? 'unknown error'}`
      : `Skipped: ${result.error ?? 'SMTP not configured'}`;
  const [runs, trail] = await Promise.all([portfolio.recentAgentActivity(30), portfolio.auditTrail({ limit: 120 })]);
  return page(
    reply,
    layout({
      user,
      title: 'Agent activity and audit',
      active: 'activity',
      subtitle: 'What ran, what it saw, what it decided, and what a human then did.',
      wide: true,
      body: notice(kind, message) + activityPage({
        user,
        runs,
        audit: trail,
        modelLabel: modelConfigured ? config.ai.model : 'not configured, deterministic only',
      }),
    }),
  );
});

/* JSON API --------------------------------------------------------------- */

function apiOk(reply: FastifyReply, data: unknown): FastifyReply {
  return reply.send({ data, meta: { generatedAt: new Date().toISOString() } });
}

app.get('/api/summary', async (req, reply) => {
  requireUser(await currentUser(req));
  const kpis = await portfolio.dashboardKpis();
  return apiOk(reply, kpis);
});

app.get('/api/subsidiaries', async (req, reply) => {
  requireUser(await currentUser(req));
  return apiOk(reply, await portfolio.subsidiaryPerformance());
});

app.get('/api/projects', async (req, reply) => {
  requireUser(await currentUser(req));
  const q = req.query as Record<string, string | undefined>;
  return apiOk(reply, await portfolio.projectList({ status: q.status ?? '', subsidiary: q.subsidiary ?? '' }));
});

app.get('/api/obligations/:id', async (req, reply) => {
  requireUser(await currentUser(req));
  const data = await portfolio.obligationDetail((req.params as { id: string }).id);
  if (!data.obligation) throw new HttpError(404, 'Obligation not found.');
  return apiOk(reply, data);
});

app.get('/api/alerts', async (req, reply) => {
  requireUser(await currentUser(req));
  const q = req.query as Record<string, string | undefined>;
  return apiOk(reply, await portfolio.alertList({ status: q.status ?? '', severity: q.severity ?? '' }));
});

app.get('/api/checks', async (req, reply) => {
  requireUser(await currentUser(req));
  return apiOk(reply, await latestChecks(20));
});

app.get('/api/runs', async (req, reply) => {
  requireUser(await currentUser(req));
  return apiOk(reply, await portfolio.recentAgentActivity(50));
});

app.get('/api/audit', async (req, reply) => {
  requireUser(await currentUser(req));
  const q = req.query as Record<string, string | undefined>;
  if (q.entityType !== undefined && !/^[a-z_]{3,40}$/.test(q.entityType)) throw new HttpError(400, 'Invalid entityType.');
  return apiOk(reply, await portfolio.auditTrail({ entityType: q.entityType, limit: Number(q.limit ?? 100) }));
});

app.post('/api/compliance/run', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'run_check');
  checkCsrf(req, user);
  const result = await runComplianceCheck({ trigger: 'MANUAL', actorId: user.id });
  return reply.code(result.status === 'FAILED' ? 500 : 200).send({ data: result });
});

app.post('/api/documents', async (req, reply) => {
  const user = requireUser(await currentUser(req));
  requireCan(user, 'upload');
  const data = await req.file();
  if (!data) throw new HttpError(400, 'Attach a file in the file field.');
  const fields = (data.fields ?? {}) as Record<string, { value?: unknown }>;
  const csrfToken = req.headers['x-csrf-token'];
  if (typeof csrfToken !== 'string' || csrfToken !== user.csrfToken) throw new HttpError(403, 'Missing or invalid x-csrf-token header.');
  const obligationId = typeof fields.obligationId?.value === 'string' ? String(fields.obligationId.value) : '';
  const buffer = await data.toBuffer();
  const invalid = validateTextUpload({ filename: data.filename, mime: data.mimetype, bytes: buffer.byteLength });
  if (invalid) throw new HttpError(400, invalid);
  const result = await ingestDocument({ obligationId, filename: data.filename, mime: data.mimetype, buffer, userId: user.id });
  return reply.code(201).send({ data: result });
});

app.get('/api/docs', async (_req, reply) => {
  reply.type('text/plain; charset=utf-8').send(`ATLAS API, session authenticated with the atlas_session cookie.
POST requests also require header x-csrf-token, the token embedded in each page form.

GET  /api/summary              Portfolio KPIs
GET  /api/subsidiaries         Subsidiary performance rows
GET  /api/projects             ?status=&subsidiary=
GET  /api/obligations/:id      Obligation, documents, alerts, approvals
GET  /api/alerts               ?status=&severity=
GET  /api/checks               Recent compliance check history
GET  /api/runs                 Recent agent runs
GET  /api/audit                ?entityType=&limit=
POST /api/compliance/run       Runs the same service as the scheduler
POST /api/documents            multipart: file, obligationId
GET  /healthz                  Liveness, database latency, scheduler state
`);
});

app.get('/healthz', async (_req, reply) => {
  const db = await healthCheck();
  return reply.code(db.ok ? 200 : 503).send({
    status: db.ok ? 'ok' : 'degraded',
    database: db,
    scheduler: { enabled: config.schedulerEnabled, intervalMinutes: Math.round(config.complianceIntervalMs / 60_000) },
    model: modelConfigured ? 'configured' : 'not configured',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/* Startup ---------------------------------------------------------------- */

if (process.env.ATLAS_NO_LISTEN !== '1') {
  const address = await app.listen({ port: config.port, host: config.host });
  app.log.info({ address, env: config.env, model: modelConfigured ? config.ai.model : 'none' }, 'ATLAS listening');

  const purgeTimer = setInterval(() => {
    purgeExpiredSessions().catch((error) => app.log.warn({ err: error }, 'session purge failed'));
  }, 3_600_000);
  purgeTimer.unref?.();

  const scheduler = startScheduler((result) => {
    app.log.info({ result }, 'scheduled compliance sweep');
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    scheduler.stop();
    clearInterval(purgeTimer);
    await app.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export { app };
