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
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: TZ,
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
  const unit = abs >= day
    ? `${Math.round(abs / day)}d`
    : `${Math.max(1, Math.round(abs / 3_600_000))}h`;
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
    OPEN:               'open',
    OVERDUE:            'critical',
    SUBMITTED:          'info',
    COMPLETED:          'ok',
    WAIVED:             'muted',
    ACTIVE:             'ok',
    AT_RISK:            'warn',
    ON_HOLD:            'muted',
    ESCALATION_PENDING: 'warn',
    ESCALATED:          'info',
    RESOLVED:           'ok',
    DISMISSED:          'muted',
    PENDING:            'warn',
    APPROVED:           'ok',
    REJECTED:           'critical',
    EXPIRED:            'critical',
    EXECUTED:           'ok',
    OK:                 'ok',
    DEGRADED:           'warn',
    FAILED:             'critical',
    RUNNING:            'info',
    SKIPPED:            'muted',
    MITIGATED:          'ok',
    CLOSED:             'muted',
    ACCEPTED:           'info',
    HIGH:               'high',
    MEDIUM:             'medium',
    LOW:                'low',
    CRITICAL:           'critical',
  };
  const cls = map[status] ?? 'muted';
  return `<span class="tag tag--${cls}"><span class="tag__dot" aria-hidden="true"></span>${esc(status.replace(/_/g, '\u00a0'))}</span>`;
}

const ICONS: Record<string, string> = {
  overview:      `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/></svg>`,
  subsidiaries:  `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1L1 5.5V15h14V5.5L8 1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 15v-5h5v5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  projects:      `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 4h12M2 8h8M2 12h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  compliance:    `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.5L2 4v4.5c0 3 2.5 5.5 6 6 3.5-.5 6-3 6-6V4L8 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 8l2 2 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  documents:     `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 2h7l3 3v9H3V2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 2v3h3M5 7h6M5 10h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  alerts:        `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.5L1 13h14L8 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  activity:      `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 8h2.5L5 4l3 8 2-5 1.5 2.5H15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  admin:         `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M2 14c0-3 2-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  notifications: `<svg class="rail__link-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.5c-3 0-5 2-5 4.5v2l-1 2h12l-1-2V6c0-2.5-2-4.5-5-4.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
};

const NAV: Array<{ href: string; label: string; key: string; roles?: string[] }> = [
  { href: '/',             label: 'Overview',         key: 'overview'      },
  { href: '/subsidiaries', label: 'Subsidiaries',     key: 'subsidiaries'  },
  { href: '/projects',     label: 'Projects',         key: 'projects'      },
  { href: '/compliance',   label: 'Compliance',       key: 'compliance'    },
  { href: '/documents',    label: 'Documents',        key: 'documents'     },
  { href: '/alerts',       label: 'Alerts',           key: 'alerts'        },
  { href: '/activity',     label: 'Agent activity',   key: 'activity'      },
  { href: '/admin',           label: 'Administration',   key: 'admin',           roles: ['ADMIN'] },
  { href: '/admin/notifications', label: 'Notifications', key: 'notifications',  roles: ['ADMIN'] },
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
    .map((item) => {
      const active = item.key === input.active;
      const icon = ICONS[item.key] ?? '';
      return `<a class="rail__link${active ? ' is-active' : ''}" href="${item.href}"${active ? ' aria-current="page"' : ''}>${icon}${esc(item.label)}</a>`;
    }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · ATLAS</title>
<link rel="stylesheet" href="${cssHref}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23315FE9'/%3E%3Ctext x='16' y='22' font-family='system-ui' font-size='18' font-weight='700' fill='white' text-anchor='middle'%3EA%3C/text%3E%3C/svg%3E">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="rail" aria-label="Application navigation">
    <div class="rail__brand">
      <span class="mark" aria-hidden="true">A</span>
      <span class="rail__name">ATLAS</span>
    </div>
    <nav class="rail__nav" aria-label="Primary">
      <span class="rail__nav-section">Navigation</span>
      ${nav}
    </nav>
    <div class="rail__foot">
      <p class="rail__note">Demonstration environment. Fictional portfolio, synthetic documents.</p>
      <a class="rail__link rail__link--quiet" href="/api/docs">API reference</a>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div class="topbar__left">
        <p class="topbar__eyebrow">AI-Powered Executive &amp; Portfolio Intelligence</p>
        <h1 class="topbar__title">${esc(input.title)}</h1>
        ${input.subtitle ? `<p class="topbar__sub">${esc(input.subtitle)}</p>` : ''}
      </div>
      <div class="topbar__right">
        <span class="topbar__role" title="Session role">${esc(input.user.role)}</span>
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
      <span>Times shown in WAT (UTC+1), stored in UTC.</span>
    </footer>
  </div>
</div>
</body>
</html>`;
}

export function notice(kind: 'ok' | 'warn' | 'error' | 'info', text: string): string {
  return `<div class="notice notice--${kind}" role="status" aria-live="polite">${esc(text)}</div>`;
}

export function emptyState(title: string, detail: string): string {
  return `<div class="empty">
    <p class="empty__title">${esc(title)}</p>
    <p class="empty__detail">${esc(detail)}</p>
  </div>`;
}

export function kpi(label: string, value: string, detail?: string, tone?: 'critical' | 'warn'): string {
  return `<div class="kpi${tone ? ` kpi--${tone}` : ''}">
    <p class="kpi__label">${esc(label)}</p>
    <p class="kpi__value">${esc(value)}</p>
    ${detail ? `<p class="kpi__detail">${esc(detail)}</p>` : ''}
  </div>`;
}

export function loginPage(error?: string, next = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ATLAS</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body class="auth">
<main class="auth__panel" aria-label="Sign in">
  <div class="auth__brand">
    <span class="mark" aria-hidden="true">A</span>
    <span>ATLAS</span>
  </div>
  <h1 class="auth__title">Sign in to ATLAS</h1>
  <p class="auth__sub">Portfolio intelligence, compliance monitoring, and controlled escalation for a fictional holding group.</p>
  ${error ? `<div class="notice notice--error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/login" class="stack">
    ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
    <label class="field">
      <span class="field__label">Email address</span>
      <input class="input" type="email" name="email" autocomplete="username" required autofocus spellcheck="false">
    </label>
    <label class="field">
      <span class="field__label">Password</span>
      <input class="input" type="password" name="password" autocomplete="current-password" required>
    </label>
    <button class="btn btn--primary btn--block" type="submit">Sign in</button>
  </form>
  <p class="auth__hint">Demo accounts are listed in the repository README. Data resets with the seed script.</p>
</main>
</body>
</html>`;
}
