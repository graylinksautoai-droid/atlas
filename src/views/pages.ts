import {
  esc, fmtDate, fmtDateTime, relative, money,
  severityTag, statusTag, kpi, emptyState, notice, titleCase,
} from './layout.ts';
import type { SessionUser } from '../auth.ts';
import type {
  ObligationBreakdown,
  AlertSeverityBreakdown,
  PendingApproval,
} from '../portfolio.ts';

/* =========================================================================
   Shared micro-utilities
   ========================================================================= */

const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

function bar(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return `<div class="bar" role="img" aria-label="${clamped} percent"><span style="width:${clamped}%"></span></div>`;
}

/* ── SVG donut chart ────────────────────────────────────────────────────────
 * Renders a pure-SVG donut from real data. Falls back gracefully when total = 0
 * or when a single slice spans the full circle.
 * All SVG is inline; no scripts required. CSP-safe.
 *
 * Accessibility model:
 *  - The <figure> is a plain container (no role="img") so AT descends into it.
 *  - The SVG is aria-hidden; it is purely visual.
 *  - The <ul> legend provides the text alternative for every sighted/AT user.
 * ───────────────────────────────────────────────────────────────────────── */

interface DonutSlice {
  value: number;
  label: string;
  cssVar: string;
}

function svgDonut(
  slices: DonutSlice[],
  total: number,
  centreLabel: string,
  centreValue: string,
  title: string,
): string {
  const R = 44;          // outer radius
  const r = 28;          // inner radius (hole)
  const cx = 52; const cy = 52;
  const size = 104;
  const stroke = R - r;  // annulus stroke width = 16

  /* Empty state — no data at all */
  if (total === 0) {
    return `<figure class="chart chart--donut">
      <svg viewBox="0 0 ${size} ${size}" aria-hidden="true" class="chart__svg">
        <circle cx="${cx}" cy="${cy}" r="${R - stroke / 2}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
        <text x="${cx}" y="${cy - 3}" class="chart__centre-val" text-anchor="middle">—</text>
        <text x="${cx}" y="${cy + 10}" class="chart__centre-lbl" text-anchor="middle">No data</text>
      </svg>
      <p class="chart__legend-empty">No data available.</p>
    </figure>`;
  }

  const activeSlices = slices.filter((s) => s.value > 0);

  /* Single-category shortcut: use a plain circle (SVG arcs at 360° are undefined) */
  if (activeSlices.length === 1) {
    const s = activeSlices[0]!;
    const legendItems = slices
      .filter((sl) => sl.value > 0)
      .map((sl) => `<li class="chart__legend-item">
        <span class="chart__legend-swatch" style="background:var(${sl.cssVar})" aria-hidden="true"></span>
        <span class="chart__legend-label">${esc(sl.label)}</span>
        <span class="chart__legend-value">${sl.value}</span>
      </li>`)
      .join('');
    return `<figure class="chart chart--donut">
      <svg viewBox="0 0 ${size} ${size}" aria-hidden="true" class="chart__svg">
        <title>${esc(title)}</title>
        <circle cx="${cx}" cy="${cy}" r="${R - stroke / 2}" fill="none" stroke="var(${s.cssVar})" stroke-width="${stroke}"/>
        <text x="${cx}" y="${cy - 4}" class="chart__centre-val" text-anchor="middle">${esc(centreValue)}</text>
        <text x="${cx}" y="${cy + 10}" class="chart__centre-lbl" text-anchor="middle">${esc(centreLabel)}</text>
      </svg>
      <ul class="chart__legend" role="list">${legendItems}</ul>
    </figure>`;
  }

  /* Multi-category arc path construction */
  const TAU = 2 * Math.PI;
  let offset = -0.25 * TAU; // start at 12 o'clock
  const paths: string[] = [];
  // Gap of ≈1.2° between adjacent slices so they don't bleed together.
  // A slice whose arc is narrower than 2 × gap (< ~0.67% of total) cannot
  // be drawn without a degenerate path. It is skipped visually but its
  // exact count always appears in the accessible legend below.
  const gap = 0.021;

  for (const slice of activeSlices) {
    const fraction = slice.value / total;
    const angle = fraction * TAU;
    const large = angle > Math.PI ? 1 : 0;

    const aStart = offset + gap;
    const aEnd   = offset + angle - gap;
    offset += angle;

    // Skip slices too narrow to render without a degenerate SVG path.
    if (aEnd <= aStart) continue;

    const gx1  = cx + R * Math.cos(aStart);
    const gy1  = cy + R * Math.sin(aStart);
    const gx2  = cx + R * Math.cos(aEnd);
    const gy2  = cy + R * Math.sin(aEnd);
    const gxi1 = cx + r * Math.cos(aEnd);
    const gyi1 = cy + r * Math.sin(aEnd);
    const gxi2 = cx + r * Math.cos(aStart);
    const gyi2 = cy + r * Math.sin(aStart);

    paths.push(
      `<path d="M ${gx1.toFixed(2)} ${gy1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${gx2.toFixed(2)} ${gy2.toFixed(2)} L ${gxi1.toFixed(2)} ${gyi1.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${gxi2.toFixed(2)} ${gyi2.toFixed(2)} Z" fill="var(${slice.cssVar})"/>`
    );
  }

  const legendItems = slices
    .filter((s) => s.value > 0)
    .map((s) => `<li class="chart__legend-item">
      <span class="chart__legend-swatch" style="background:var(${s.cssVar})" aria-hidden="true"></span>
      <span class="chart__legend-label">${esc(s.label)}</span>
      <span class="chart__legend-value">${s.value}</span>
    </li>`)
    .join('');

  return `<figure class="chart chart--donut">
    <svg viewBox="0 0 ${size} ${size}" aria-hidden="true" class="chart__svg">
      <title>${esc(title)}</title>
      ${paths.join('\n      ')}
      <text x="${cx}" y="${cy - 4}" class="chart__centre-val" text-anchor="middle">${esc(centreValue)}</text>
      <text x="${cx}" y="${cy + 10}" class="chart__centre-lbl" text-anchor="middle">${esc(centreLabel)}</text>
    </svg>
    <ul class="chart__legend" role="list">${legendItems}</ul>
  </figure>`;
}

/* ── SVG horizontal bar chart ───────────────────────────────────────────────
 * Renders proportional horizontal bars. Each row shows label, bar, and value.
 * Zero-value bars are omitted from the fill (track shows empty background).
 * Empty state fires when the sum of all values is zero.
 * ───────────────────────────────────────────────────────────────────────── */

interface BarRow {
  label: string;
  value: number;
  cssVar: string;
}

function svgHBars(rows: BarRow[], title: string): string {
  const totalAlerts = rows.reduce((s, r) => s + r.value, 0);

  if (totalAlerts === 0) {
    return `<figure class="chart chart--hbars" aria-label="${esc(title)}">
      <p class="chart__empty">No active alerts</p>
    </figure>`;
  }

  const maxVal = Math.max(...rows.map((r) => r.value));

  const bars = rows.map((row) => {
    const widthPct = row.value === 0 ? 0 : Math.max(0, Math.round((row.value / maxVal) * 100));
    const display  = row.value === 0 ? '—' : String(row.value);
    const fill     = row.value > 0
      ? `<span class="chart__hbar-fill" style="width:${widthPct}%;background:var(${row.cssVar})" aria-hidden="true"></span>`
      : '';
    return `<li class="chart__hbar-row">
      <span class="chart__hbar-label">${esc(row.label)}</span>
      <span class="chart__hbar-track" aria-label="${esc(row.label)}: ${row.value}">${fill}</span>
      <span class="chart__hbar-value">${display}</span>
    </li>`;
  }).join('');

  return `<figure class="chart chart--hbars">
    <p class="sr-only">${esc(title)}: ${rows.filter((r) => r.value > 0).map((r) => `${esc(r.label)} ${r.value}`).join(', ')}</p>
    <ul class="chart__hbar-list" role="list" aria-label="${esc(title)}">${bars}</ul>
  </figure>`;
}

/* =========================================================================
   Overview / executive dashboard
   ========================================================================= */

export function overviewPage(data: {
  user: SessionUser;
  csrf: string;
  kpis: Record<string, any>;
  subsidiaries: Array<Record<string, any>>;
  upcoming: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
  runs: Array<Record<string, any>>;
  obligationBreakdown: ObligationBreakdown;
  alertBreakdown: AlertSeverityBreakdown;
  pendingApprovals: PendingApproval[];
  canRun: boolean;
  checkedAt: string;
}): string {
  const k = data.kpis;
  const ob = data.obligationBreakdown;
  const ab = data.alertBreakdown;

  /* ── KPI row ─────────────────────────────────────────────────────────── */

  const kpiRow = `
  <section class="section" aria-labelledby="h-kpi">
    <div class="section__head">
      <h2 id="h-kpi" class="section__title">Portfolio position</h2>
      <p class="section__meta">Last compliance sweep: ${esc(data.checkedAt)}</p>
    </div>
    <div class="kpis">
      ${kpi('Subsidiaries',          String(k.subsidiaries),        'Group companies')}
      ${kpi('Active projects',       String(k.activeProjects),      'In flight across the portfolio')}
      ${kpi('Total obligations',     String(k.totalObligations),    `${k.completedObligations} completed · ${k.dueNext7Days} due within 7 days`)}
      ${kpi('Overdue obligations',   String(k.overdueObligations),  'Past due and still open',
             k.overdueObligations > 0 ? 'critical' : undefined)}
      ${kpi('High-priority risks',   String(k.highRisks),           'Open, high or critical severity',
             k.highRisks > 0 ? 'warn' : undefined)}
      ${kpi('Open alerts',           String(k.openAlerts),          'Requiring attention or approval',
             k.openAlerts > 0 ? 'warn' : undefined)}
    </div>
  </section>`;

  /* ── Obligation status donut chart ───────────────────────────────────── */

  const obTotal = ob.open + ob.overdue + ob.submitted + ob.completed + ob.waived;
  const obDonut = svgDonut(
    [
      { value: ob.completed, cssVar: '--ok',       label: 'Completed' },
      { value: ob.open,      cssVar: '--info',      label: 'Open'      },
      { value: ob.submitted, cssVar: '--blue',      label: 'Submitted' },
      { value: ob.overdue,   cssVar: '--crit',      label: 'Overdue'   },
      { value: ob.waived,    cssVar: '--muted-fg',  label: 'Waived'    },
    ],
    obTotal,
    'obligations',
    `${obTotal}`,
    'Obligations by status',
  );

  /* ── Alert severity bars ─────────────────────────────────────────────── */

  const alertBars = svgHBars(
    [
      { label: 'Critical', value: ab.critical, cssVar: '--crit'    },
      { label: 'High',     value: ab.high,     cssVar: '--high'    },
      { label: 'Medium',   value: ab.medium,   cssVar: '--warn'    },
      { label: 'Low',      value: ab.low,      cssVar: '--muted-fg' },
    ],
    'Open alerts by severity',
  );

  /* ── Analytics row ───────────────────────────────────────────────────── */

  const analyticsRow = `
  <div class="split split--even" aria-label="Analytics">
    <section class="panel" aria-labelledby="h-ob-chart">
      <div class="panel__head">
        <h2 id="h-ob-chart" class="panel__title">Obligation status</h2>
        <a class="panel__action" href="/compliance">Compliance centre</a>
      </div>
      <div class="panel__body">
        ${obDonut}
      </div>
    </section>
    <section class="panel" aria-labelledby="h-alert-chart">
      <div class="panel__head">
        <h2 id="h-alert-chart" class="panel__title">Open alerts by severity</h2>
        <a class="panel__action" href="/alerts">All alerts</a>
      </div>
      <div class="panel__body">
        ${alertBars}
      </div>
    </section>
  </div>`;

  /* ── Action queue (pending approvals + overdue obligations) ──────────── */

  const approvalItems = data.pendingApprovals.length
    ? data.pendingApprovals.map((a) => `<li class="queue-item">
        <div class="queue-item__head">
          ${severityTag(a.severity)}
          <span class="queue-item__type">Approval required</span>
        </div>
        <a class="link queue-item__title" href="/alerts/${esc(a.alert_id)}">
          ${esc(titleCase(a.alert_type))}${a.obligation_title ? ` — ${esc(a.obligation_title)}` : ''}
        </a>
        <p class="queue-item__meta">
          ${esc(a.subsidiary_name)} · ${esc(a.proposed_action)} · requested ${esc(relative(a.created_at))}
        </p>
      </li>`).join('')
    : `<li class="queue-item queue-item--empty">${emptyState('No pending approvals', 'All escalations have been reviewed.')}</li>`;

  const upcomingItems = data.upcoming.length
    ? data.upcoming.map((o) => {
        const isOverdue = String(o.status) === 'OVERDUE';
        return `<li class="queue-item">
        <div class="queue-item__head">
          ${statusTag(String(o.status))}
          <span class="queue-item__type">Obligation</span>
        </div>
        <a class="link queue-item__title" href="/obligations/${esc(o.id)}">${esc(o.title)}</a>
        <p class="queue-item__meta">
          ${esc(o.subsidiary_name)} · ${esc(o.project_name)} ·
          <span class="${isOverdue ? 'queue-item__due queue-item__due--overdue' : 'queue-item__due'}">due ${esc(fmtDate(o.due_at))} (${esc(relative(o.due_at))})</span>
        </p>
      </li>`;
      }).join('')
    : `<li class="queue-item queue-item--empty">${emptyState('No upcoming deadlines', 'Every open obligation is either closed or has no imminent deadline.')}</li>`;

  const actionQueue = `
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-queue">
      <div class="panel__head">
        <h2 id="h-queue" class="panel__title">Pending approvals</h2>
        <a class="panel__action" href="/alerts?status=ESCALATION_PENDING">All pending</a>
      </div>
      <ul class="list" role="list">${approvalItems}</ul>
    </section>
    <section class="panel" aria-labelledby="h-upcoming">
      <div class="panel__head">
        <h2 id="h-upcoming" class="panel__title">Upcoming deadlines</h2>
        <a class="panel__action" href="/compliance">View all</a>
      </div>
      <ul class="list" role="list">${upcomingItems}</ul>
    </section>
  </div>`;

  /* ── Subsidiary performance + recent activity ────────────────────────── */

  const subRows = data.subsidiaries
    .map((s) => {
      const total  = Number(s.obligations);
      const done   = Number(s.completed);
      const pctVal = pct(done, total);
      return `<tr>
        <td>
          <a class="link" href="/subsidiaries/${esc(s.id)}">${esc(s.name)}</a>
          <span class="cell__sub">${esc(s.sector)}</span>
        </td>
        <td class="num">${esc(s.projects)}</td>
        <td class="num">${esc(s.obligations)}</td>
        <td class="num${Number(s.overdue) > 0 ? ' num--critical' : ''}">${esc(s.overdue)}</td>
        <td class="num">${esc(s.open_risks)}</td>
        <td>
          <div class="meter">
            <span class="meter__value">${pctVal}%</span>
            ${bar(pctVal)}
          </div>
        </td>
      </tr>`;
    })
    .join('');

  const runItems = data.runs.length
    ? data.runs.map((r) => `<li class="feed">
        <div class="feed__head">
          ${statusTag(String(r.status))}
          <span class="feed__type">${esc(String(r.trigger).toLowerCase())}</span>
        </div>
        <p class="feed__body">${esc(r.summary ?? 'Run in progress.')}</p>
        <p class="feed__sub">
          ${esc(fmtDateTime(r.started_at))}
          ${r.model ? ` · <span class="mono">${esc(r.model)}</span>` : ''}
          ${r.finished_at
            ? ` · ${((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
            : ''}
        </p>
      </li>`).join('')
    : `<li>${emptyState('No agent activity yet', 'Run a compliance check to produce the first recorded run.')}</li>`;

  const bottomRow = `
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-subs">
      <div class="panel__head">
        <h2 id="h-subs" class="panel__title">Subsidiary performance</h2>
        <a class="panel__action" href="/subsidiaries">All subsidiaries</a>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Subsidiary</th>
              <th scope="col" class="num">Projects</th>
              <th scope="col" class="num">Obligations</th>
              <th scope="col" class="num">Overdue</th>
              <th scope="col" class="num">Open risks</th>
              <th scope="col">Completion</th>
            </tr>
          </thead>
          <tbody>${subRows || `<tr><td colspan="6">${emptyState('No subsidiaries', 'Seed the database to populate the portfolio.')}</td></tr>`}</tbody>
        </table>
      </div>
      <div class="panel__foot">
        <form method="post" action="/compliance/run" class="inline">
          <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
          <button class="btn btn--primary btn--small" type="submit"
            ${data.canRun ? '' : 'disabled aria-disabled="true"'}>
            Run compliance check
          </button>
        </form>
        <p class="panel__meta">
          ${data.canRun ? 'Triggers the same sweep the scheduler runs automatically.' : 'Your role is read-only.'}
        </p>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-agent">
      <div class="panel__head">
        <h2 id="h-agent" class="panel__title">Recent agent runs</h2>
        <a class="panel__action" href="/activity">Full audit trail</a>
      </div>
      <ul class="list">${runItems}</ul>
    </section>
  </div>`;

  return kpiRow + analyticsRow + actionQueue + bottomRow;
}

/* =========================================================================
   Subsidiaries list
   ========================================================================= */

export function subsidiariesPage(_user: SessionUser, _csrf: string, rows: Array<Record<string, any>>): string {
  const body = rows.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Subsidiary</th>
              <th scope="col">Sector</th>
              <th scope="col" class="num">Projects</th>
              <th scope="col" class="num">Obligations</th>
              <th scope="col" class="num">Overdue</th>
              <th scope="col">Standing</th>
            </tr>
          </thead>
          <tbody>${rows.map((s) => `<tr>
            <td>
              <a class="link" href="/subsidiaries/${esc(s.id)}">${esc(s.name)}</a>
              <span class="cell__sub">${esc(s.code)}</span>
            </td>
            <td>${esc(s.sector)}</td>
            <td class="num">${esc(s.projects)}</td>
            <td class="num">${esc(s.obligations)}</td>
            <td class="num${Number(s.overdue) > 0 ? ' num--critical' : ''}">${esc(s.overdue)}</td>
            <td>${Number(s.overdue) > 0 ? statusTag('AT_RISK') : statusTag('ACTIVE')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No subsidiaries', 'Seed the database to populate the portfolio.');

  return `<section class="panel" aria-labelledby="h-subs">
    <div class="panel__head">
      <h2 id="h-subs" class="panel__title">Group companies</h2>
      <p class="panel__meta">${rows.length} registered</p>
    </div>
    ${body}
  </section>`;
}

/* =========================================================================
   Subsidiary detail
   ========================================================================= */

export function subsidiaryPage(_user: SessionUser, data: Record<string, any>): string {
  const s = data.subsidiary;

  const projectRows = data.projects.length
    ? data.projects.map((p: any) => `<tr>
        <td>
          <a class="link" href="/projects/${esc(p.id)}">${esc(p.name)}</a>
          <span class="cell__sub">${esc(p.code)} · ${money(p.budget_ngn)}</span>
        </td>
        <td>${statusTag(String(p.status))}</td>
        <td class="num">${esc(p.obligations)}</td>
        <td class="num${Number(p.overdue) > 0 ? ' num--critical' : ''}">${esc(p.overdue)}</td>
        <td class="num">${fmtDate(p.target_date)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No projects', 'This subsidiary has no projects on record.')}</td></tr>`;

  const obligationRows = data.obligations.length
    ? data.obligations.map((o: any) => `<tr>
        <td>
          <a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a>
          <span class="cell__sub">${esc(o.owner_name)}</span>
        </td>
        <td>${esc(o.kind)}</td>
        <td>${statusTag(String(o.status))}</td>
        <td class="num">${fmtDate(o.due_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4">${emptyState('No obligations', 'Nothing is due from this subsidiary.')}</td></tr>`;

  const riskItems = data.risks.length
    ? `<ul class="list">${data.risks.map((r: any) => `<li class="feed">
        <div class="feed__head">
          ${severityTag(String(r.severity))}
          ${statusTag(String(r.status))}
        </div>
        <p class="feed__body">${esc(r.title)}</p>
        <p class="feed__sub">${esc(r.rationale)}</p>
      </li>`).join('')}</ul>`
    : emptyState('No risks recorded', 'The risk register is clear for this subsidiary.');

  return `<nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/subsidiaries">Subsidiaries</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(s.name)}</span>
  </nav>

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-sub-info">
      <div class="panel__head">
        <h2 id="h-sub-info" class="panel__title">${esc(s.name)}</h2>
        <p class="panel__meta">${esc(s.code)} · ${esc(s.sector)}</p>
      </div>
      <p class="prose panel__body--top">${esc(s.description)}</p>
    </section>
    <section class="panel" aria-labelledby="h-risks">
      <div class="panel__head">
        <h2 id="h-risks" class="panel__title">Risk register</h2>
        <p class="panel__meta">${data.risks.length} recorded</p>
      </div>
      ${riskItems}
    </section>
  </div>

  <section class="panel" aria-labelledby="h-projects">
    <div class="panel__head">
      <h2 id="h-projects" class="panel__title">Projects</h2>
      <p class="panel__meta">${data.projects.length} total</p>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Obligations</th>
            <th scope="col" class="num">Overdue</th>
            <th scope="col" class="num">Target</th>
          </tr>
        </thead>
        <tbody>${projectRows}</tbody>
      </table>
    </div>
  </section>

  <section class="panel" aria-labelledby="h-obligations">
    <div class="panel__head">
      <h2 id="h-obligations" class="panel__title">Obligations</h2>
      <p class="panel__meta">Most recent first · ${data.obligations.length} shown</p>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Obligation</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Due</th>
          </tr>
        </thead>
        <tbody>${obligationRows}</tbody>
      </table>
    </div>
  </section>`;
}

/* =========================================================================
   Projects list
   ========================================================================= */

export function projectsPage(
  _user: SessionUser,
  rows: Array<Record<string, any>>,
  filter: Record<string, string>,
  subs: Array<Record<string, any>>,
): string {
  const options = subs.map((s) =>
    `<option value="${esc(s.id)}"${filter.subsidiary === s.id ? ' selected' : ''}>${esc(s.name)}</option>`
  ).join('');

  const body = rows.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Subsidiary</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Budget</th>
              <th scope="col" class="num">Obligations</th>
              <th scope="col" class="num">Overdue</th>
            </tr>
          </thead>
          <tbody>${rows.map((p) => `<tr>
            <td>
              <a class="link" href="/projects/${esc(p.id)}">${esc(p.name)}</a>
              <span class="cell__sub">${esc(p.code)}</span>
            </td>
            <td>${esc(p.subsidiary_name)}</td>
            <td>${statusTag(String(p.status))}</td>
            <td class="num">${money(p.budget_ngn)}</td>
            <td class="num">${esc(p.obligations)}</td>
            <td class="num${Number(p.overdue) > 0 ? ' num--critical' : ''}">${esc(p.overdue)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No projects match the filter', 'Clear the filters to see the full portfolio.');

  const activeFilters = filter.status || filter.subsidiary;
  return `<form class="filters" method="get" action="/projects" role="search" aria-label="Filter projects">
    <label class="field field--inline">
      <span class="field__label">Status</span>
      <select class="input input--select" name="status">
        <option value="">Any status</option>
        ${['ACTIVE', 'AT_RISK', 'ON_HOLD', 'COMPLETED'].map((s) =>
          `<option value="${s}"${filter.status === s ? ' selected' : ''}>${s.replace('_', '\u00a0')}</option>`
        ).join('')}
      </select>
    </label>
    <label class="field field--inline">
      <span class="field__label">Subsidiary</span>
      <select class="input input--select" name="subsidiary">
        <option value="">All subsidiaries</option>
        ${options}
      </select>
    </label>
    <button class="btn btn--ghost" type="submit">Apply filters</button>
    ${activeFilters ? `<a class="btn btn--ghost" href="/projects">Clear</a>` : ''}
  </form>

  <section class="panel" aria-labelledby="h-projects">
    <div class="panel__head">
      <h2 id="h-projects" class="panel__title">Portfolio projects</h2>
      <p class="panel__meta">${rows.length} shown${activeFilters ? ' (filtered)' : ''}</p>
    </div>
    ${body}
  </section>`;
}

/* =========================================================================
   Project detail
   ========================================================================= */

export function projectPage(_user: SessionUser, data: Record<string, any>): string {
  const p = data.project;
  const open    = data.obligations.filter((o: any) => o.status !== 'COMPLETED' && o.status !== 'WAIVED').length;
  const closed  = data.obligations.filter((o: any) => o.status === 'COMPLETED').length;
  const overdue = data.obligations.filter((o: any) => o.status === 'OVERDUE').length;

  const rows = data.obligations.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Documents</th>
              <th scope="col" class="num">Due</th>
            </tr>
          </thead>
          <tbody>${data.obligations.map((o: any) => `<tr>
            <td>
              <a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a>
              <span class="cell__sub">${esc(o.owner_name)}</span>
            </td>
            <td>${esc(o.kind)}</td>
            <td>${statusTag(String(o.status))}</td>
            <td class="num">${esc(o.documents)}</td>
            <td class="num">${fmtDate(o.due_at)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No obligations yet', 'Add one through the seed or the API.');

  return `<nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/projects">Projects</a>
    <span aria-hidden="true">/</span>
    <a class="link" href="/subsidiaries/${esc(p.subsidiary_id)}">${esc(p.subsidiary_name)}</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(p.name)}</span>
  </nav>

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-project">
      <div class="panel__head">
        <h2 id="h-project" class="panel__title">${esc(p.name)}</h2>
        ${statusTag(String(p.status))}
      </div>
      <dl class="facts">
        <div><dt>Code</dt><dd>${esc(p.code)}</dd></div>
        <div><dt>Budget</dt><dd>${money(p.budget_ngn)}</dd></div>
        <div><dt>Started</dt><dd>${fmtDate(p.start_date)}</dd></div>
        <div><dt>Target date</dt><dd>${fmtDate(p.target_date)}</dd></div>
      </dl>
    </section>
    <section class="panel" aria-labelledby="h-delivery">
      <div class="panel__head">
        <h2 id="h-delivery" class="panel__title">Delivery summary</h2>
      </div>
      <dl class="facts">
        <div><dt>Open obligations</dt><dd>${open}</dd></div>
        <div><dt>Completed</dt><dd>${closed}</dd></div>
        <div><dt>Overdue</dt><dd>${overdue > 0 ? `<span class="text-crit">${overdue}</span>` : '0'}</dd></div>
        <div><dt>Total</dt><dd>${data.obligations.length}</dd></div>
      </dl>
    </section>
  </div>

  <section class="panel" aria-labelledby="h-obligations">
    <div class="panel__head">
      <h2 id="h-obligations" class="panel__title">Obligations</h2>
      <p class="panel__meta">${data.obligations.length} total</p>
    </div>
    ${rows}
  </section>`;
}

/* =========================================================================
   Obligation detail
   ========================================================================= */

export function obligationPage(
  _user: SessionUser,
  csrf: string,
  data: Record<string, any>,
  canAct: boolean,
): string {
  const o = data.obligation;

  const documents = data.documents.length
    ? `<ul class="list">${data.documents.map((d: any) => `<li class="feed">
        <div class="feed__head">
          <a class="link" href="/documents/${esc(d.id)}">${esc(d.filename)}</a>
          ${statusTag('RECEIVED')}
        </div>
        <p class="feed__sub">
          ${esc(fmtDateTime(d.created_at))} · ${esc(d.findings)} findings
          · ${Math.round(Number(d.size_bytes) / 1024)} KB
        </p>
      </li>`).join('')}</ul>`
    : emptyState('No submission filed', 'Upload a text submission to trigger deterministic checks and a model assessment.');

  const alerts = data.alerts.length
    ? `<ul class="list">${data.alerts.map((a: any) => `<li class="feed">
        <div class="feed__head">
          ${severityTag(String(a.severity))}
          ${statusTag(String(a.status))}
        </div>
        <a class="link" href="/alerts/${esc(a.id)}">${esc(String(a.type).replace(/_/g, ' '))}</a>
        <p class="feed__sub">${esc(a.evidence_summary)}</p>
      </li>`).join('')}</ul>`
    : emptyState('No alerts', 'No compliance alert has been raised against this obligation.');

  const approvals = data.approvals.length
    ? `<ul class="list">${data.approvals.map((a: any) => `<li class="feed">
        <div class="feed__head">
          ${statusTag(String(a.status))}
          <span class="feed__type">${esc(a.proposed_action)}</span>
        </div>
        <p class="feed__sub">
          Requested ${esc(fmtDateTime(a.created_at))}
          ${a.decided_at ? ` · decided ${esc(fmtDateTime(a.decided_at))}` : ''}
        </p>
      </li>`).join('')}</ul>`
    : emptyState('No approvals', 'Approvals appear when policy requires a human decision.');

  const transitions = canAct
    ? `<form method="post" action="/obligations/${esc(o.id)}/status" class="panel__transitions">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label class="field field--inline">
          <span class="field__label">Record outcome</span>
          <select class="input input--select" name="status">
            <option value="COMPLETED">Completed</option>
            <option value="WAIVED">Waived</option>
            <option value="OPEN">Reopen</option>
          </select>
        </label>
        <button class="btn btn--ghost" type="submit">Apply</button>
      </form>`
    : '';

  return `<nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/subsidiaries/${esc(o.subsidiary_id)}">${esc(o.subsidiary_name)}</a>
    <span aria-hidden="true">/</span>
    <a class="link" href="/projects/${esc(o.project_id)}">${esc(o.project_name)}</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(o.title)}</span>
  </nav>

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-obligation">
      <div class="panel__head">
        <h2 id="h-obligation" class="panel__title">${esc(o.title)}</h2>
        ${statusTag(String(o.status))}
      </div>
      <dl class="facts">
        <div><dt>Kind</dt><dd>${esc(o.kind)}</dd></div>
        <div><dt>Owner</dt><dd>${esc(o.owner_name)}</dd></div>
        <div><dt>Due</dt><dd>${fmtDateTime(o.due_at)}</dd></div>
        <div><dt>Document required</dt><dd>${o.requires_document ? 'Yes' : 'No'}</dd></div>
        <div><dt>Version</dt><dd>${esc(o.version)}</dd></div>
        <div><dt>Last updated</dt><dd>${esc(fmtDateTime(o.updated_at))}</dd></div>
      </dl>
      ${transitions}
    </section>
    <section class="panel" aria-labelledby="h-approvals">
      <div class="panel__head">
        <h2 id="h-approvals" class="panel__title">Approvals</h2>
        <p class="panel__meta">${data.approvals.length} on record</p>
      </div>
      ${approvals}
    </section>
  </div>

  <div class="split">
    <section class="panel" aria-labelledby="h-docs">
      <div class="panel__head">
        <h2 id="h-docs" class="panel__title">Submissions</h2>
        <a class="panel__action" href="/documents?obligation=${esc(o.id)}">Upload document</a>
      </div>
      ${documents}
    </section>
    <section class="panel" aria-labelledby="h-alerts">
      <div class="panel__head">
        <h2 id="h-alerts" class="panel__title">Alerts</h2>
        <p class="panel__meta">${data.alerts.length} raised</p>
      </div>
      ${alerts}
    </section>
  </div>`;
}

/* =========================================================================
   Compliance centre
   ========================================================================= */

export function compliancePage(data: {
  user: SessionUser;
  csrf: string;
  checks: Array<Record<string, any>>;
  overdue: Array<Record<string, any>>;
  canRun: boolean;
  kpis: Record<string, any>;
  schedulerIntervalMinutes: number;
  noticeText?: string;
}): string {
  const lastStatus = data.checks[0]?.status as string | undefined;
  const lastStatusTag = lastStatus ? statusTag(lastStatus) : '';

  const checks = data.checks.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Trigger</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Scanned</th>
              <th scope="col" class="num">Overdue found</th>
              <th scope="col" class="num">Alerts created</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>${data.checks.map((c) => `<tr>
            <td>${fmtDateTime(c.started_at)}</td>
            <td>${esc(c.trigger)}</td>
            <td>${statusTag(String(c.status))}</td>
            <td class="num">${esc(c.scanned)}</td>
            <td class="num">${esc(c.overdue)}</td>
            <td class="num">${esc(c.alerts_created)}</td>
            <td><span class="cell__sub cell__detail">${esc(c.error ?? '—')}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No checks recorded', 'Run the first sweep to establish a baseline.');

  const overdue = data.overdue.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col">Subsidiary</th>
              <th scope="col">Owner</th>
              <th scope="col" class="num">Due</th>
              <th scope="col" class="num">Days late</th>
            </tr>
          </thead>
          <tbody>${data.overdue.map((o) => {
            const days = Math.max(0, Math.floor((Date.now() - new Date(o.due_at).getTime()) / 86_400_000));
            return `<tr>
              <td>
                <a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a>
                <span class="cell__sub">${esc(o.project_name)}</span>
              </td>
              <td>${esc(o.subsidiary_name)}</td>
              <td>${esc(o.owner_name)}</td>
              <td class="num">${fmtDate(o.due_at)}</td>
              <td class="num num--critical">${days}d</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`
    : emptyState('Nothing overdue', 'Every open obligation is still within its deadline.');

  return `${data.noticeText ? notice('ok', data.noticeText) : ''}

  <section class="section" aria-labelledby="h-monitoring">
    <div class="section__head">
      <h2 id="h-monitoring" class="section__title">Monitoring status</h2>
      <p class="section__meta">Scheduler runs every ${data.schedulerIntervalMinutes} minutes · Last sweep ${lastStatusTag}</p>
    </div>
    <div class="kpis kpis--four">
      ${kpi('Overdue now',      String(data.kpis.overdueObligations),
             'Confirmed by deterministic rules',
             data.kpis.overdueObligations > 0 ? 'critical' : undefined)}
      ${kpi('Open alerts',     String(data.kpis.openAlerts), 'Includes approvals pending',
             data.kpis.openAlerts > 0 ? 'warn' : undefined)}
      ${kpi('Completion rate', `${data.kpis.complianceRate}%`,
             `${data.kpis.completedObligations} of ${data.kpis.totalObligations} closed`)}
      ${kpi('Due in 7 days',   String(data.kpis.dueNext7Days),
             'Open or overdue obligations',
             data.kpis.dueNext7Days > 0 ? 'warn' : undefined)}
    </div>
  </section>

  <div class="panel panel--action" aria-labelledby="h-run">
    <div>
      <h2 id="h-run" class="panel__title">Run a compliance sweep</h2>
      <p class="panel__meta">
        The manual trigger calls exactly the same service as the scheduler.
        Duplicate runs are refused with an advisory lock; duplicate alerts are suppressed by a partial unique index.
      </p>
    </div>
    <form method="post" action="/compliance/run" class="inline">
      <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
      <button class="btn btn--primary" type="submit"
        ${data.canRun ? '' : 'disabled aria-disabled="true"'}>
        Run compliance check
      </button>
    </form>
  </div>

  <section class="panel" aria-labelledby="h-overdue">
    <div class="panel__head">
      <h2 id="h-overdue" class="panel__title">Overdue obligations</h2>
      <p class="panel__meta">${data.overdue.length} past due</p>
    </div>
    ${overdue}
  </section>

  <section class="panel" aria-labelledby="h-history">
    <div class="panel__head">
      <h2 id="h-history" class="panel__title">Sweep history</h2>
      <p class="panel__meta">${data.checks.length} most recent</p>
    </div>
    ${checks}
  </section>`;
}

/* =========================================================================
   Documents list
   ========================================================================= */

export function documentsPage(data: {
  user: SessionUser;
  csrf: string;
  docs: Array<Record<string, any>>;
  options: Array<Record<string, any>>;
  canUpload: boolean;
  modelLabel: string;
  noticeText?: string;
  noticeKind?: 'ok' | 'warn' | 'error';
  selected?: string;
}): string {
  const rows = data.docs.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Obligation</th>
              <th scope="col">Subsidiary</th>
              <th scope="col" class="num">AI findings</th>
              <th scope="col">Uploaded</th>
            </tr>
          </thead>
          <tbody>${data.docs.map((d) => `<tr>
            <td>
              <a class="link" href="/documents/${esc(d.id)}">${esc(d.filename)}</a>
              <span class="cell__sub">${esc(d.uploader ?? 'system')}</span>
            </td>
            <td>
              <a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a>
            </td>
            <td>${esc(d.subsidiary_name)}</td>
            <td class="num">${esc(d.ai_findings)}</td>
            <td>${esc(fmtDateTime(d.created_at))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No documents yet', 'Upload a governance or regulatory submission to see the assessment pipeline.');

  const obligationOptions = data.options.map((o) =>
    `<option value="${esc(o.id)}"${data.selected === o.id ? ' selected' : ''}>
      ${esc(o.title)} · ${esc(o.subsidiary_name)} (${esc(o.status)})
    </option>`
  ).join('');

  const form = data.canUpload
    ? `<form class="stack" method="post" action="/documents" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">Obligation</span>
          <select class="input input--select" name="obligationId" required>
            <option value="">Select an obligation</option>
            ${obligationOptions}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Submission file (.txt or .md, up to 256 KB)</span>
          <input class="input" type="file" name="file" accept=".txt,.md,text/plain,text/markdown" required>
        </label>
        <button class="btn btn--primary" type="submit">Upload and assess</button>
      </form>`
    : '<p class="prose panel__body">Your role can view documents but cannot upload.</p>';

  return `${data.noticeText ? notice(data.noticeKind ?? 'info', data.noticeText) : ''}

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-upload">
      <div class="panel__head">
        <h2 id="h-upload" class="panel__title">New submission</h2>
        <p class="panel__meta">Model: ${esc(data.modelLabel)}</p>
      </div>
      ${form}
      <p class="panel__note">
        Text files only. The parser does not execute files. Document text is treated as untrusted data by the model prompt.
      </p>
    </section>
    <section class="panel" aria-labelledby="h-provenance">
      <div class="panel__head">
        <h2 id="h-provenance" class="panel__title">How findings are labelled</h2>
      </div>
      <ul class="prose-list panel__body">
        <li><strong>Fact</strong> — extracted mechanically from the text, such as length or a stated reporting period.</li>
        <li><strong>Rule</strong> — from deterministic checks, such as missing required sections.</li>
        <li><strong>Interpretation</strong> — produced by the model; never promoted to fact automatically.</li>
        <li><strong>Recommendation</strong> — requires human judgement before any action is taken.</li>
      </ul>
    </section>
  </div>

  <section class="panel" aria-labelledby="h-submissions">
    <div class="panel__head">
      <h2 id="h-submissions" class="panel__title">Submissions</h2>
      <p class="panel__meta">${data.docs.length} on record</p>
    </div>
    ${rows}
  </section>`;
}

/* =========================================================================
   Document detail
   ========================================================================= */

export function documentPage(data: Record<string, any>, _user: SessionUser): string {
  const d = data.document;

  const groups = [
    ['FACT',           'Facts extracted from the document'],
    ['RULE',           'Deterministic rule findings'],
    ['AI',             'Model interpretation (unverified)'],
    ['RECOMMENDATION', 'Recommendations for review'],
  ] as const;

  const sections = groups.map(([key, label]) => {
    const items = data.findings.filter((f: any) => f.provenance === key);
    if (items.length === 0) return '';
    return `<section class="panel" aria-labelledby="h-${key.toLowerCase()}">
      <div class="panel__head">
        <h2 id="h-${key.toLowerCase()}" class="panel__title">${label}</h2>
        <span class="pill pill--quiet">${items.length}</span>
      </div>
      <ul class="list">${items.map((f: any) => `<li class="feed">
        <div class="feed__head">
          <span class="feed__type">${esc(String(f.code).replace(/_/g, ' ').toLowerCase())}</span>
          ${f.confidence ? `<span class="pill pill--quiet">confidence ${Number(f.confidence).toFixed(2)}</span>` : ''}
        </div>
        <p class="feed__body">${esc(f.label)}: ${esc(f.detail)}</p>
        ${f.evidence_quote ? `<blockquote class="quote">${esc(f.evidence_quote)}</blockquote>` : ''}
      </li>`).join('')}</ul>
    </section>`;
  }).join('');

  return `<nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/documents">Documents</a>
    <span aria-hidden="true">/</span>
    <a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(d.filename)}</span>
  </nav>

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-doc">
      <div class="panel__head">
        <h2 id="h-doc" class="panel__title">${esc(d.filename)}</h2>
        <p class="panel__meta">${esc(d.mime)} · ${Math.round(Number(d.size_bytes) / 1024)} KB</p>
      </div>
      <dl class="facts">
        <div><dt>Obligation</dt><dd><a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a></dd></div>
        <div><dt>Subsidiary</dt><dd>${esc(d.subsidiary_name)}</dd></div>
        <div><dt>Uploaded by</dt><dd>${esc(d.uploader ?? 'system')}</dd></div>
        <div><dt>Uploaded at</dt><dd>${esc(fmtDateTime(d.created_at))}</dd></div>
        <div><dt>Content hash</dt><dd class="mono">${esc(String(d.sha256).slice(0, 24))}…</dd></div>
      </dl>
    </section>
    <section class="panel" aria-labelledby="h-source">
      <div class="panel__head">
        <h2 id="h-source" class="panel__title">Source text</h2>
        <p class="panel__meta">Stored as submitted, never executed</p>
      </div>
      <pre class="source">${esc(String(d.body_text).slice(0, 4000))}${String(d.body_text).length > 4000 ? '\n\n[truncated for display]' : ''}</pre>
    </section>
  </div>

  ${sections || emptyState('No findings', 'This document produced no findings.')}`;
}

/* =========================================================================
   Alerts list
   ========================================================================= */

export function alertsPage(data: {
  user: SessionUser;
  csrf: string;
  rows: Array<Record<string, any>>;
  filter: Record<string, string>;
  noticeText?: string;
  noticeKind?: 'ok' | 'warn' | 'error';
}): string {
  const rows = data.rows.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Alert</th>
              <th scope="col">Subsidiary</th>
              <th scope="col">Severity</th>
              <th scope="col">Status</th>
              <th scope="col">Raised</th>
            </tr>
          </thead>
          <tbody>${data.rows.map((a) => `<tr>
            <td>
              <a class="link" href="/alerts/${esc(a.id)}">${esc(String(a.type).replace(/_/g, ' ').toLowerCase())}</a>
              <span class="cell__sub">${esc(a.obligation_title ?? 'Portfolio level')}</span>
            </td>
            <td>${esc(a.subsidiary_name)}</td>
            <td>${severityTag(String(a.severity))}</td>
            <td>
              ${statusTag(String(a.status))}
              ${a.pending_approval ? '<span class="cell__sub">approval pending</span>' : ''}
            </td>
            <td>
              ${esc(relative(a.created_at))}
              <span class="cell__sub">${fmtDateTime(a.created_at)}</span>
            </td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No alerts match', 'Adjust the filters or run a compliance sweep.');

  const activeFilters = data.filter.status || data.filter.severity;
  return `${data.noticeText ? notice(data.noticeKind ?? 'info', data.noticeText) : ''}

  <form class="filters" method="get" action="/alerts" role="search" aria-label="Filter alerts">
    <label class="field field--inline">
      <span class="field__label">Status</span>
      <select class="input input--select" name="status">
        <option value="">Any status</option>
        ${['OPEN', 'ESCALATION_PENDING', 'ESCALATED', 'RESOLVED', 'DISMISSED'].map((s) =>
          `<option value="${s}"${data.filter.status === s ? ' selected' : ''}>${s.replace(/_/g, '\u00a0').toLowerCase()}</option>`
        ).join('')}
      </select>
    </label>
    <label class="field field--inline">
      <span class="field__label">Severity</span>
      <select class="input input--select" name="severity">
        <option value="">Any severity</option>
        ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) =>
          `<option value="${s}"${data.filter.severity === s ? ' selected' : ''}>${s.toLowerCase()}</option>`
        ).join('')}
      </select>
    </label>
    <button class="btn btn--ghost" type="submit">Apply filters</button>
    ${activeFilters ? `<a class="btn btn--ghost" href="/alerts">Clear</a>` : ''}
  </form>

  <section class="panel" aria-labelledby="h-alerts">
    <div class="panel__head">
      <h2 id="h-alerts" class="panel__title">Alert centre</h2>
      <p class="panel__meta">${data.rows.length} shown — open cases first${activeFilters ? ' (filtered)' : ''}</p>
    </div>
    ${rows}
  </section>`;
}

/* =========================================================================
   Alert detail
   ========================================================================= */

export function alertPage(
  data: Record<string, any>,
  _user: SessionUser,
  csrf: string,
  canApprove: boolean,
  noticeText?: string,
  noticeKind?: 'ok' | 'warn' | 'error',
): string {
  const a = data.alert;
  const pending = data.approvals.find((row: any) => row.status === 'PENDING');

  const approvalBlock = pending
    ? `<div class="approval" aria-labelledby="h-escalation">
        <div class="approval__head">
          <div>
            <span class="approval__label">Awaiting decision</span>
            <h2 id="h-escalation" class="approval__title">Escalation pending review</h2>
          </div>
          <span class="pill pill--quiet">
            ${pending.payload.generated_by === 'deterministic-rules'
              ? 'Policy text — no model'
              : esc(String(pending.payload.generated_by ?? 'model'))}
          </span>
        </div>
        <p class="approval__subject">${esc(pending.payload.subject ?? '')}</p>
        <p class="approval__body">${esc(pending.payload.body ?? '')}</p>
        ${pending.payload.rationale
          ? `<p class="approval__rationale"><strong>Rationale:</strong> ${esc(pending.payload.rationale)}</p>`
          : ''}
        <hr class="approval__divider">
        ${canApprove
          ? `<div class="approval__actions">
              <form method="post" action="/alerts/${esc(a.id)}/decide" class="stack">
                <input type="hidden" name="_csrf" value="${esc(csrf)}">
                <input type="hidden" name="approvalId" value="${esc(pending.id)}">
                <label class="field">
                  <span class="field__label">Reviewer note (optional — recorded with the decision)</span>
                  <input class="input" name="comment" maxlength="400" placeholder="Add a note for the audit trail">
                </label>
                <div class="row">
                  <button class="btn btn--primary" type="submit" name="decision" value="APPROVED">
                    Approve and record
                  </button>
                  <button class="btn btn--ghost" type="submit" name="decision" value="REJECTED">
                    Reject
                  </button>
                </div>
                <p class="panel__meta">
                  Approval executes application-level delivery only. No email or external message is sent by this build; the audit record states this explicitly.
                </p>
              </form>
            </div>`
          : '<p class="prose">Your role can review this case but not approve it.</p>'}
      </div>`
    : '';

  const history = data.approvals.length
    ? `<ul class="list">${data.approvals.map((row: any) => `<li class="feed">
        <div class="feed__head">
          ${statusTag(String(row.status))}
          <span class="feed__type">${esc(row.proposed_action)}</span>
        </div>
        <p class="feed__sub">
          Requested ${esc(fmtDateTime(row.created_at))}
          ${row.decided_at ? ` · ${esc(fmtDateTime(row.decided_at))}` : ''}
          ${row.decided_by_name ? ` · ${esc(row.decided_by_name)}` : ''}
        </p>
        ${row.payload?.subject ? `<p class="feed__body"><strong>${esc(row.payload.subject)}</strong></p>` : ''}
        ${row.payload?.body    ? `<p class="feed__sub">${esc(row.payload.body)}</p>` : ''}
        ${row.comment          ? `<p class="feed__body">${esc(row.comment)}</p>` : ''}
      </li>`).join('')}</ul>`
    : emptyState('No approvals requested', 'Policy did not require a human decision for this alert.');

  const actions = data.actions.length
    ? `<ul class="list">${data.actions.map((row: any) => `<li class="feed">
        <div class="feed__head">
          ${statusTag(String(row.status))}
          <span class="feed__type">${esc(row.kind)} · ${esc(row.channel)}</span>
        </div>
        <p class="feed__sub">${esc(fmtDateTime(row.executed_at))}</p>
        <p class="feed__body">${esc(row.result.subject ?? '')}</p>
        <p class="feed__sub">Simulated delivery: ${esc(row.result.external_delivery ?? 'none')}</p>
      </li>`).join('')}</ul>`
    : emptyState('Nothing executed', 'No action has been executed for this alert.');

  return `<nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/alerts">Alerts</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(titleCase(String(a.type)))}</span>
  </nav>

  ${noticeText ? notice(noticeKind ?? 'info', noticeText) : ''}

  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-alert">
      <div class="panel__head">
        <h2 id="h-alert" class="panel__title">${esc(titleCase(String(a.type)))}</h2>
        <div class="row row--tags">
          ${severityTag(String(a.severity))}
          ${statusTag(String(a.status))}
        </div>
      </div>
      <dl class="facts">
        <div><dt>Subsidiary</dt>
          <dd><a class="link" href="/subsidiaries/${esc(a.subsidiary_id)}">${esc(a.subsidiary_name)}</a></dd>
        </div>
        ${a.obligation_id
          ? `<div><dt>Obligation</dt>
              <dd><a class="link" href="/obligations/${esc(a.obligation_id)}">${esc(a.obligation_title)}</a></dd>
             </div>`
          : ''}
        ${a.obligation_status
          ? `<div><dt>Obligation status</dt><dd>${statusTag(String(a.obligation_status))}</dd></div>`
          : ''}
        <div><dt>Raised</dt><dd>${esc(fmtDateTime(a.created_at))}</dd></div>
      </dl>
      <div class="panel__body">
        <p class="prose">${esc(a.evidence_summary)}</p>
        <p class="prose prose--muted"><strong>Recommended action:</strong> ${esc(a.recommended_action)}</p>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-approval-history">
      <div class="panel__head">
        <h2 id="h-approval-history" class="panel__title">Approval history</h2>
        <p class="panel__meta">${data.approvals.length} recorded</p>
      </div>
      ${history}
    </section>
  </div>

  ${approvalBlock}

  <section class="panel" aria-labelledby="h-actions">
    <div class="panel__head">
      <h2 id="h-actions" class="panel__title">Executed actions</h2>
      <p class="panel__meta">${data.actions.length} recorded</p>
    </div>
    ${actions}
  </section>`;
}

/* =========================================================================
   Activity and audit trail
   ========================================================================= */

export function activityPage(data: {
  user: SessionUser;
  runs: Array<Record<string, any>>;
  audit: Array<Record<string, any>>;
  modelLabel: string;
}): string {
  const runs = data.runs.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Trigger</th>
              <th scope="col">Status</th>
              <th scope="col">Model</th>
              <th scope="col">Summary</th>
              <th scope="col" class="num">Duration</th>
            </tr>
          </thead>
          <tbody>${data.runs.map((r) => {
            const ms = r.finished_at
              ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
              : null;
            return `<tr>
              <td>${fmtDateTime(r.started_at)}</td>
              <td>${esc(String(r.trigger).toLowerCase())}</td>
              <td>${statusTag(String(r.status))}</td>
              <td><span class="cell__sub cell__model">${esc(r.model ?? 'deterministic')}</span></td>
              <td>
                ${esc(r.summary ?? '—')}
                ${r.error ? `<span class="cell__sub cell__sub--warn">${esc(r.error).slice(0, 160)}</span>` : ''}
              </td>
              <td class="num">${ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No agent runs recorded', 'The agent writes a run record every time it evaluates an alert or a document.');

  const auditRows = data.audit.length
    ? `<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">At</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>${data.audit.map((e) => `<tr>
            <td>${fmtDateTime(e.at)}</td>
            <td>
              ${esc(e.actor_type)}
              ${e.actor_id ? `<span class="cell__sub mono">${esc(String(e.actor_id).slice(0, 8))}</span>` : ''}
            </td>
            <td>${esc(e.action)}</td>
            <td>
              ${esc(e.entity_type)}
              <span class="cell__sub mono">${esc(String(e.entity_id ?? '').slice(0, 8))}</span>
            </td>
            <td><span class="cell__sub cell__detail">${esc(JSON.stringify(e.detail).slice(0, 150))}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : emptyState('No audit events', 'Audit records are appended by the system, the agent, and users.');

  return `<section class="section" aria-labelledby="h-obs">
    <div class="section__head">
      <h2 id="h-obs" class="section__title">Observability</h2>
      <p class="section__meta">Model: ${esc(data.modelLabel)}</p>
    </div>
  </section>

  <section class="panel" aria-labelledby="h-runs">
    <div class="panel__head">
      <h2 id="h-runs" class="panel__title">Agent runs</h2>
      <p class="panel__meta">${data.runs.length} most recent</p>
    </div>
    ${runs}
  </section>

  <section class="panel" aria-labelledby="h-audit">
    <div class="panel__head">
      <h2 id="h-audit" class="panel__title">Audit trail</h2>
      <p class="panel__meta">Append-only at application and database level · ${data.audit.length} events shown</p>
    </div>
    ${auditRows}
  </section>`;
}

/* =========================================================================
   Error page fragment
   ========================================================================= */

export function errorPage(status: number, message: string): string {
  return `<section class="panel" aria-labelledby="h-err">
    <div class="panel__head">
      <h2 id="h-err" class="panel__title">${status} — ${status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorised' : 'Error'}</h2>
    </div>
    <div class="panel__body">
      <p class="prose">${esc(message)}</p>
      <p><a class="btn btn--ghost" href="/">Return to overview</a></p>
    </div>
  </section>`;
}

/* =========================================================================
   Administration pages
   All admin pages are only rendered after the server has verified 'manage'.
   No sensitive data (hashes, raw keys) is ever passed to these functions.
   ========================================================================= */

import type {
  AdminUser,
  SubsidiaryRow,
  ProjectAdminRow,
  ObligationAdminRow,
} from '../admin.ts';

/* ── User management ─────────────────────────────────────────────────────── */

export function adminUsersPage(data: {
  csrf: string;
  users: AdminUser[];
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const rows = data.users.length
    ? data.users.map((u) => `<tr>
        <td>
          <a class="link" href="/admin/users/${esc(u.id)}/edit">${esc(u.name)}</a>
          <span class="cell__sub">${esc(u.email)}</span>
        </td>
        <td>${statusTag(u.role)}</td>
        <td>${u.is_active ? statusTag('ACTIVE') : statusTag('ON_HOLD')}</td>
        <td class="num">${fmtDateTime(u.created_at)}</td>
        <td>
          <a class="btn btn--ghost btn--small" href="/admin/users/${esc(u.id)}/edit">Edit</a>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No users', 'Create the first account below.')}</td></tr>`;

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-users">
      <div class="panel__head">
        <h2 id="h-users" class="panel__title">User accounts</h2>
        <p class="panel__meta">${data.users.length} registered</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Name / email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-new-user">
      <div class="panel__head">
        <h2 id="h-new-user" class="panel__title">Create user</h2>
      </div>
      <form method="post" action="/admin/users" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">Full name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="name" required minlength="2" maxlength="120" autocomplete="off">
        </label>
        <label class="field">
          <span class="field__label">Email address <span aria-hidden="true">*</span></span>
          <input class="input" type="email" name="email" required autocomplete="off" spellcheck="false">
        </label>
        <label class="field">
          <span class="field__label">Role <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="role" required>
            <option value="">Choose a role</option>
            <option value="EXEC">EXEC — read only</option>
            <option value="COMPLIANCE">COMPLIANCE — sweeps, uploads, approvals</option>
            <option value="ADMIN">ADMIN — full access</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">Temporary password <span aria-hidden="true">*</span></span>
          <input class="input" type="password" name="password" required minlength="12"
            autocomplete="new-password"
            aria-describedby="pw-hint">
          <span id="pw-hint" class="panel__meta">Minimum 12 characters. The user should change this on first sign-in.</span>
        </label>
        <button class="btn btn--primary" type="submit">Create user</button>
      </form>
    </section>
  </div>`;
}

export function adminUserEditPage(data: {
  csrf: string;
  user: AdminUser;
  isSelf: boolean;
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const u = data.user;
  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/admin/users">Users</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(u.name)}</span>
  </nav>
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-edit-user">
      <div class="panel__head">
        <h2 id="h-edit-user" class="panel__title">Edit account</h2>
        <p class="panel__meta">${esc(u.email)}</p>
      </div>
      <form method="post" action="/admin/users/${esc(u.id)}" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <input type="hidden" name="_method" value="PUT">
        <label class="field">
          <span class="field__label">Full name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="name" value="${esc(u.name)}" required minlength="2" maxlength="120">
        </label>
        <label class="field">
          <span class="field__label">Role <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="role" required ${data.isSelf ? 'disabled' : ''}>
            <option value="EXEC"   ${u.role === 'EXEC' ? 'selected' : ''}>EXEC — read only</option>
            <option value="COMPLIANCE" ${u.role === 'COMPLIANCE' ? 'selected' : ''}>COMPLIANCE — sweeps, uploads, approvals</option>
            <option value="ADMIN"  ${u.role === 'ADMIN' ? 'selected' : ''}>ADMIN — full access</option>
          </select>
          ${data.isSelf ? `<input type="hidden" name="role" value="${esc(u.role)}">` : ''}
          ${data.isSelf ? '<p class="panel__meta">You cannot change your own role.</p>' : ''}
        </label>
        <label class="field">
          <span class="field__label">Account status</span>
          <select class="input input--select" name="is_active" ${data.isSelf ? 'disabled' : ''}>
            <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
            <option value="0" ${!u.is_active ? 'selected' : ''}>Deactivated</option>
          </select>
          ${data.isSelf ? `<input type="hidden" name="is_active" value="${u.is_active ? '1' : '0'}">` : ''}
          ${data.isSelf ? '<p class="panel__meta">You cannot deactivate your own account.</p>' : ''}
        </label>
        <button class="btn btn--primary" type="submit">Save changes</button>
        <a class="btn btn--ghost" href="/admin/users">Cancel</a>
      </form>
    </section>
    <section class="panel" aria-labelledby="h-reset-pw">
      <div class="panel__head">
        <h2 id="h-reset-pw" class="panel__title">Reset password</h2>
      </div>
      <form method="post" action="/admin/users/${esc(u.id)}/password" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">New password <span aria-hidden="true">*</span></span>
          <input class="input" type="password" name="password" required minlength="12"
            autocomplete="new-password" aria-describedby="pw2-hint">
          <span id="pw2-hint" class="panel__meta">Minimum 12 characters. All existing sessions for this user will be invalidated.</span>
        </label>
        <button class="btn btn--ghost" type="submit">Set new password</button>
      </form>
    </section>
  </div>`;
}

/* ── Subsidiary admin ─────────────────────────────────────────────────────── */

export function adminSubsidiariesPage(data: {
  csrf: string;
  subsidiaries: SubsidiaryRow[];
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const rows = data.subsidiaries.length
    ? data.subsidiaries.map((s) => `<tr>
        <td>
          <a class="link" href="/admin/subsidiaries/${esc(s.id)}/edit">${esc(s.name)}</a>
          <span class="cell__sub">${esc(s.code)}</span>
        </td>
        <td>${esc(s.sector)}</td>
        <td>
          <a class="btn btn--ghost btn--small" href="/admin/subsidiaries/${esc(s.id)}/edit">Edit</a>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="3">${emptyState('No subsidiaries', 'Add the first one.')}</td></tr>`;

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-subs-admin">
      <div class="panel__head">
        <h2 id="h-subs-admin" class="panel__title">Subsidiaries</h2>
        <p class="panel__meta">${data.subsidiaries.length} registered</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Name / code</th>
              <th scope="col">Sector</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-new-sub">
      <div class="panel__head">
        <h2 id="h-new-sub" class="panel__title">Add subsidiary</h2>
      </div>
      <form method="post" action="/admin/subsidiaries" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">Code <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="code" required minlength="2" maxlength="20"
            style="text-transform:uppercase" placeholder="e.g. ATLNRG">
        </label>
        <label class="field">
          <span class="field__label">Name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="name" required minlength="2" maxlength="120">
        </label>
        <label class="field">
          <span class="field__label">Sector <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="sector" required minlength="2" maxlength="80"
            placeholder="e.g. Energy, Finance, Technology">
        </label>
        <label class="field">
          <span class="field__label">Description</span>
          <input class="input" type="text" name="description" maxlength="400">
        </label>
        <button class="btn btn--primary" type="submit">Add subsidiary</button>
      </form>
    </section>
  </div>`;
}

export function adminSubsidiaryEditPage(data: {
  csrf: string;
  subsidiary: SubsidiaryRow;
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const s = data.subsidiary;
  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/admin/subsidiaries">Subsidiaries</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(s.name)}</span>
  </nav>
  <section class="panel" aria-labelledby="h-edit-sub">
    <div class="panel__head">
      <h2 id="h-edit-sub" class="panel__title">Edit subsidiary</h2>
      <p class="panel__meta">${esc(s.code)}</p>
    </div>
    <form method="post" action="/admin/subsidiaries/${esc(s.id)}" class="stack">
      <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
      <input type="hidden" name="_method" value="PUT">
      <label class="field">
        <span class="field__label">Name <span aria-hidden="true">*</span></span>
        <input class="input" type="text" name="name" value="${esc(s.name)}" required minlength="2" maxlength="120">
      </label>
      <label class="field">
        <span class="field__label">Sector <span aria-hidden="true">*</span></span>
        <input class="input" type="text" name="sector" value="${esc(s.sector)}" required minlength="2" maxlength="80">
      </label>
      <label class="field">
        <span class="field__label">Description</span>
        <input class="input" type="text" name="description" value="${esc(s.description)}" maxlength="400">
      </label>
      <div class="row">
        <button class="btn btn--primary" type="submit">Save changes</button>
        <a class="btn btn--ghost" href="/admin/subsidiaries">Cancel</a>
      </div>
    </form>
  </section>`;
}

/* ── Project admin ───────────────────────────────────────────────────────── */

export function adminProjectsPage(data: {
  csrf: string;
  projects: ProjectAdminRow[];
  subsidiaries: Array<{ id: string; name: string; code: string }>;
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const rows = data.projects.length
    ? data.projects.map((p) => `<tr>
        <td>
          <a class="link" href="/admin/projects/${esc(p.id)}/edit">${esc(p.name)}</a>
          <span class="cell__sub">${esc(p.code)}</span>
        </td>
        <td>${esc(p.subsidiary_name)}</td>
        <td>${statusTag(p.status)}</td>
        <td class="num">${esc(p.obligation_count)}</td>
        <td>
          <a class="btn btn--ghost btn--small" href="/admin/projects/${esc(p.id)}/edit">Edit</a>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No projects', 'Add the first one.')}</td></tr>`;

  const subOptions = data.subsidiaries.map((s) =>
    `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)})</option>`
  ).join('');

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-projects-admin">
      <div class="panel__head">
        <h2 id="h-projects-admin" class="panel__title">Projects</h2>
        <p class="panel__meta">${data.projects.length} total</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Subsidiary</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Obligations</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-new-project">
      <div class="panel__head">
        <h2 id="h-new-project" class="panel__title">Add project</h2>
      </div>
      <form method="post" action="/admin/projects" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">Subsidiary <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="subsidiaryId" required>
            <option value="">Select subsidiary</option>
            ${subOptions}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Code <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="code" required minlength="2" maxlength="20"
            style="text-transform:uppercase" placeholder="e.g. ATLNRG-001">
        </label>
        <label class="field">
          <span class="field__label">Name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="name" required minlength="2" maxlength="120">
        </label>
        <label class="field">
          <span class="field__label">Status</span>
          <select class="input input--select" name="status">
            <option value="ACTIVE" selected>Active</option>
            <option value="AT_RISK">At risk</option>
            <option value="ON_HOLD">On hold</option>
            <option value="COMPLETED">Completed</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">Budget (₦)</span>
          <input class="input" type="number" name="budgetNgn" min="0" step="0.01" placeholder="Leave blank if unknown">
        </label>
        <label class="field">
          <span class="field__label">Start date <span aria-hidden="true">*</span></span>
          <input class="input" type="date" name="startDate" required>
        </label>
        <label class="field">
          <span class="field__label">Target completion</span>
          <input class="input" type="date" name="targetDate">
        </label>
        <button class="btn btn--primary" type="submit">Add project</button>
      </form>
    </section>
  </div>`;
}

export function adminProjectEditPage(data: {
  csrf: string;
  project: ProjectAdminRow & { start_date: Date; target_date: Date | null; budget_ngn: string | null };
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const p = data.project;
  const startVal = p.start_date ? new Date(p.start_date).toISOString().slice(0, 10) : '';
  const targetVal = p.target_date ? new Date(p.target_date).toISOString().slice(0, 10) : '';

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/admin/projects">Projects</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(p.name)}</span>
  </nav>
  <section class="panel" aria-labelledby="h-edit-project">
    <div class="panel__head">
      <h2 id="h-edit-project" class="panel__title">Edit project</h2>
      <p class="panel__meta">${esc(p.code)} · ${esc(p.subsidiary_name)}</p>
    </div>
    <form method="post" action="/admin/projects/${esc(p.id)}" class="stack">
      <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
      <input type="hidden" name="_method" value="PUT">
      <label class="field">
        <span class="field__label">Name <span aria-hidden="true">*</span></span>
        <input class="input" type="text" name="name" value="${esc(p.name)}" required minlength="2" maxlength="120">
      </label>
      <label class="field">
        <span class="field__label">Status</span>
        <select class="input input--select" name="status">
          ${['ACTIVE','AT_RISK','ON_HOLD','COMPLETED'].map((s) =>
            `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s.replace('_',' ').toLowerCase()}</option>`
          ).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Budget (₦)</span>
        <input class="input" type="number" name="budgetNgn" min="0" step="0.01"
          value="${esc(p.budget_ngn ?? '')}">
      </label>
      <label class="field">
        <span class="field__label">Start date <span aria-hidden="true">*</span></span>
        <input class="input" type="date" name="startDate" value="${esc(startVal)}" required>
      </label>
      <label class="field">
        <span class="field__label">Target completion</span>
        <input class="input" type="date" name="targetDate" value="${esc(targetVal)}">
      </label>
      <div class="row">
        <button class="btn btn--primary" type="submit">Save changes</button>
        <a class="btn btn--ghost" href="/admin/projects">Cancel</a>
      </div>
    </form>
  </section>`;
}

/* ── Obligation admin ────────────────────────────────────────────────────── */

export function adminObligationsPage(data: {
  csrf: string;
  obligations: ObligationAdminRow[];
  projects: Array<{ id: string; name: string; code: string; subsidiary_name: string }>;
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const rows = data.obligations.length
    ? data.obligations.map((o) => `<tr>
        <td>
          <a class="link" href="/admin/obligations/${esc(o.id)}/edit">${esc(o.title)}</a>
          <span class="cell__sub">${esc(o.kind)}</span>
        </td>
        <td>${esc(o.project_name)}<span class="cell__sub">${esc(o.subsidiary_name)}</span></td>
        <td>${statusTag(o.status)}</td>
        <td class="num">${fmtDate(o.due_at)}</td>
        <td>
          <a class="btn btn--ghost btn--small" href="/admin/obligations/${esc(o.id)}/edit">Edit</a>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No obligations', 'Add the first one.')}</td></tr>`;

  const projOptions = data.projects.map((p) =>
    `<option value="${esc(p.id)}">${esc(p.subsidiary_name)} — ${esc(p.name)} (${esc(p.code)})</option>`
  ).join('');

  const kindOptions = ['REGULATORY','BOARD','AUDIT','REPORT','TAX','LICENCE'].map((k) =>
    `<option value="${k}">${k.toLowerCase()}</option>`
  ).join('');

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-obs-admin">
      <div class="panel__head">
        <h2 id="h-obs-admin" class="panel__title">Obligations</h2>
        <p class="panel__meta">${data.obligations.length} total</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col">Project</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Due</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-new-ob">
      <div class="panel__head">
        <h2 id="h-new-ob" class="panel__title">Add obligation</h2>
      </div>
      <form method="post" action="/admin/obligations" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field">
          <span class="field__label">Project <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="projectId" required>
            <option value="">Select project</option>
            ${projOptions}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Title <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="title" required minlength="3" maxlength="200">
        </label>
        <label class="field">
          <span class="field__label">Kind <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="kind" required>
            <option value="">Select kind</option>
            ${kindOptions}
          </select>
        </label>
        <label class="field">
          <span class="field__label">Due date <span aria-hidden="true">*</span></span>
          <input class="input" type="date" name="dueAt" required>
        </label>
        <label class="field">
          <span class="field__label">Owner name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="ownerName" required minlength="2" maxlength="120">
        </label>
        <label class="field">
          <span class="field__label">Requires documentary evidence</span>
          <select class="input input--select" name="requiresDocument">
            <option value="1" selected>Yes</option>
            <option value="0">No</option>
          </select>
        </label>
        <button class="btn btn--primary" type="submit">Add obligation</button>
      </form>
    </section>
  </div>`;
}

export function adminObligationEditPage(data: {
  csrf: string;
  obligation: ObligationAdminRow;
  notice?: { kind: 'ok' | 'error' | 'warn'; text: string };
}): string {
  const o = data.obligation;
  const dueVal = o.due_at ? new Date(o.due_at).toISOString().slice(0, 10) : '';

  const kindOptions = ['REGULATORY','BOARD','AUDIT','REPORT','TAX','LICENCE'].map((k) =>
    `<option value="${k}" ${o.kind === k ? 'selected' : ''}>${k.toLowerCase()}</option>`
  ).join('');

  return `${data.notice ? notice(data.notice.kind, data.notice.text) : ''}
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="link" href="/admin/obligations">Obligations</a>
    <span aria-hidden="true">/</span>
    <span aria-current="page">${esc(o.title)}</span>
  </nav>
  <div class="split split--lead">
    <section class="panel" aria-labelledby="h-edit-ob">
      <div class="panel__head">
        <h2 id="h-edit-ob" class="panel__title">Edit obligation</h2>
        <p class="panel__meta">${esc(o.project_name)} · ${esc(o.subsidiary_name)}</p>
      </div>
      <form method="post" action="/admin/obligations/${esc(o.id)}" class="stack">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <input type="hidden" name="_method" value="PUT">
        <label class="field">
          <span class="field__label">Title <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="title" value="${esc(o.title)}" required minlength="3" maxlength="200">
        </label>
        <label class="field">
          <span class="field__label">Kind <span aria-hidden="true">*</span></span>
          <select class="input input--select" name="kind" required>${kindOptions}</select>
        </label>
        <label class="field">
          <span class="field__label">Due date <span aria-hidden="true">*</span></span>
          <input class="input" type="date" name="dueAt" value="${esc(dueVal)}" required>
        </label>
        <label class="field">
          <span class="field__label">Owner name <span aria-hidden="true">*</span></span>
          <input class="input" type="text" name="ownerName" value="${esc(o.owner_name)}" required minlength="2" maxlength="120">
        </label>
        <label class="field">
          <span class="field__label">Requires documentary evidence</span>
          <select class="input input--select" name="requiresDocument">
            <option value="1" ${o.requires_document ? 'selected' : ''}>Yes</option>
            <option value="0" ${!o.requires_document ? 'selected' : ''}>No</option>
          </select>
        </label>
        <div class="row">
          <button class="btn btn--primary" type="submit">Save changes</button>
          <a class="btn btn--ghost" href="/admin/obligations">Cancel</a>
        </div>
      </form>
    </section>
    <section class="panel" aria-labelledby="h-ob-status">
      <div class="panel__head">
        <h2 id="h-ob-status" class="panel__title">Current status</h2>
      </div>
      <div class="panel__body">
        <p class="prose">Current status: ${statusTag(o.status)}</p>
        <p class="prose prose--muted">
          To record a compliance outcome (completed, waived, reopen), use the
          <a class="link" href="/obligations/${esc(o.id)}">obligation detail page</a>.
          Status transitions are governed by the compliance workflow and are
          tracked in the audit trail.
        </p>
      </div>
    </section>
  </div>`;
}

/* ── Admin hub page ──────────────────────────────────────────────────────── */

export function adminHubPage(_csrf: string): string {
  return `<section class="section" aria-labelledby="h-admin">
    <div class="section__head">
      <h2 id="h-admin" class="section__title">Administration</h2>
      <p class="section__meta">Manage portfolio records and user accounts</p>
    </div>
    <div class="kpis kpis--four">
      <a class="kpi kpi--link" href="/admin/users" style="text-decoration:none">
        <p class="kpi__label">User accounts</p>
        <p class="kpi__value">→</p>
        <p class="kpi__detail">Create, edit, deactivate</p>
      </a>
      <a class="kpi kpi--link" href="/admin/subsidiaries" style="text-decoration:none">
        <p class="kpi__label">Subsidiaries</p>
        <p class="kpi__value">→</p>
        <p class="kpi__detail">Add and edit group companies</p>
      </a>
      <a class="kpi kpi--link" href="/admin/projects" style="text-decoration:none">
        <p class="kpi__label">Projects</p>
        <p class="kpi__value">→</p>
        <p class="kpi__detail">Add and edit portfolio projects</p>
      </a>
      <a class="kpi kpi--link" href="/admin/obligations" style="text-decoration:none">
        <p class="kpi__label">Obligations</p>
        <p class="kpi__value">→</p>
        <p class="kpi__detail">Add and edit compliance obligations</p>
      </a>
    </div>
  </section>`;
}
