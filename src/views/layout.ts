import type { SessionUser } from '../auth.ts';
import { cssHref } from '../config.ts';

export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TZ = 'Africa/Lagos';

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return 'Not set';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }).format(date);
}

export function fmtDateTime(value: Date | string | null | undefined): string {
  if (!value) return 'Not yet';
  const date = typeof value === 'string' ? new Date(value) : value;
  const text = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  }).format(date);
  return `${text} WAT`;
}

export function relative(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const day = 86_400_000;
  if (abs < 90_000) return 'just now';
  const unit = abs >= day ? `${Math.round(abs / day)}d` : `${Math.max(1, Math.round(abs / 3_600_000))}h`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function money(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  return `₦${new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(Number(value))}`;
}

export function titleCase(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function severityTag(severity: string): string {
  const level = severity.toLowerCase();
  return `<span class="tag tag--${esc(level)}"><span class="tag__dot" aria-hidden="true"></span>${esc(severity)}</span>`;
}

export function statusTag(status: string): string {
  const map: Record<string, string> = {
    OPEN: 'open', OVERDUE: 'critical', SUBMITTED: 'info', COMPLETED: 'ok', WAIVED: 'muted',
    ACTIVE: 'ok', AT_RISK: 'warn', ON_HOLD: 'muted',
    ESCALATION_PENDING: 'warn', ESCALATED: 'info', RESOLVED: 'ok', DISMISSED: 'muted',
    PENDING: 'warn', APPROVED: 'ok', REJECTED: 'critical', EXPIRED: 'critical', EXECUTED: 'ok',
    OK: 'ok', DEGRADED: 'warn', FAILED: 'critical', RUNNING: 'info', SKIPPED: 'muted',
    MITIGATED: 'ok', CLOSED: 'muted', ACCEPTED: 'info',
    HIGH: 'high', MEDIUM: 'medium', LOW: 'low', CRITICAL: 'critical',
  };
  return `<span class="tag tag--${map[status] ?? 'muted'}">${esc(status.replace(/_/g, ' '))}</span>`;
}

const NAV: Array<{ href: string; label: string; key: string; roles?: string[] }> = [
  { href: '/', label: 'Overview', key: 'overview' },
  { href: '/subsidiaries', label: 'Subsidiaries', key: 'subsidiaries' },
  { href: '/projects', label: 'Projects', key: 'projects' },
  { href: '/compliance', label: 'Compliance', key: 'compliance' },
  { href: '/documents', label: 'Documents', key: 'documents' },
  { href: '/alerts', label: 'Alerts and approvals', key: 'alerts' },
  { href: '/activity', label: 'Agent activity', key: 'activity' },
];

export function layout(input: {
  user: SessionUser;
  title: string;
  active: string;
  body: string;
  subtitle?: string;
  csrf?: string;
  wide?: boolean;
}): string {
  const nav = NAV.filter((item) => !item.roles || item.roles.includes(input.user.role))
    .map(
      (item) =>
        `<a class="rail__link${item.key === input.active ? ' is-active' : ''}" href="${item.href}"${item.key === input.active ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · ATLAS</title>
<link rel="stylesheet" href="${cssHref}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23101114'/%3E%3Cpath d='M9 23 16 9l7 14' stroke='%23e9e6dc' stroke-width='2.2' fill='none' stroke-linejoin='round'/%3E%3C/svg%3E">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="rail">
    <div class="rail__brand"><span class="mark" aria-hidden="true">A</span><span class="rail__name">ATLAS</span></div>
    <nav class="rail__nav" aria-label="Primary">${nav}</nav>
    <div class="rail__foot">
      <p class="rail__note">Demonstration environment. Fictional portfolio, synthetic documents.</p>
      <a class="rail__link rail__link--quiet" href="/api/docs">API reference</a>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div>
        <p class="topbar__eyebrow">Portfolio intelligence and compliance</p>
        <h1 class="topbar__title">${esc(input.title)}</h1>
        ${input.subtitle ? `<p class="topbar__sub">${esc(input.subtitle)}</p>` : ''}
      </div>
      <div class="topbar__right">
        <span class="pill pill--quiet" title="Session expires automatically">${esc(input.user.role)}</span>
        <span class="topbar__user">${esc(input.user.name)}</span>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${esc(input.csrf ?? input.user.csrfToken)}">
          <button class="btn btn--ghost btn--small" type="submit">Sign out</button>
        </form>
      </div>
    </header>
    <main id="main" class="content${input.wide ? ' content--wide' : ''}">
      ${input.body}
    </main>
    <footer class="foot">
      <span>ATLAS demonstration build. Not affiliated with any holding company. Data is synthetic.</span>
      <span>Times shown in WAT, stored in UTC.</span>
    </footer>
  </div>
</div>
</body>
</html>`;
}

export function notice(kind: 'ok' | 'warn' | 'error' | 'info', text: string): string {
  return `<div class="notice notice--${kind}" role="status">${esc(text)}</div>`;
}

export function emptyState(title: string, detail: string): string {
  return `<div class="empty"><p class="empty__title">${esc(title)}</p><p class="empty__detail">${esc(detail)}</p></div>`;
}

export function kpi(label: string, value: string, detail?: string, tone?: 'critical' | 'warn'): string {
  return `<div class="kpi${tone ? ` kpi--${tone}` : ''}">
    <p class="kpi__label">${esc(label)}</p>
    <p class="kpi__value">${esc(value)}</p>
    ${detail ? `<p class="kpi__detail">${esc(detail)}</p>` : ''}
  </div>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ATLAS</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body class="auth">
<main class="auth__panel">
  <div class="auth__brand"><span class="mark" aria-hidden="true">A</span><span>ATLAS</span></div>
  <h1 class="auth__title">Executive command centre</h1>
  <p class="auth__sub">Portfolio intelligence, compliance monitoring, and controlled escalation for a fictional holding group.</p>
  ${error ? `<div class="notice notice--error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/login" class="stack">
    <label class="field"><span class="field__label">Email</span>
      <input class="input" type="email" name="email" autocomplete="username" required autofocus></label>
    <label class="field"><span class="field__label">Password</span>
      <input class="input" type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn btn--primary btn--block" type="submit">Sign in</button>
  </form>
  <p class="auth__hint">Demo accounts are listed in the repository README. Data resets with the seed script.</p>
</main>
</body>
</html>`;
}
