import { cssHref } from '../config.ts';
import { esc, fmtDate, fmtDateTime, relative, money, severityTag, statusTag, kpi, emptyState, notice, titleCase } from './layout.ts';
import type { SessionUser } from '../auth.ts';

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100));

function bar(value: number): string {
  return `<div class="bar" role="img" aria-label="${value} percent"><span style="width:${Math.max(0, Math.min(100, value))}%"></span></div>`;
}

export function overviewPage(data: {
  user: SessionUser;
  csrf: string;
  kpis: Record<string, any>;
  subsidiaries: Array<Record<string, any>>;
  upcoming: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
  runs: Array<Record<string, any>>;
  canRun: boolean;
  checkedAt: string;
}): string {
  const k = data.kpis;
  const subs = data.subsidiaries
    .map((s) => {
      const total = Number(s.obligations);
      const done = Number(s.completed);
      return `<tr>
        <td><a class="link" href="/subsidiaries/${esc(s.id)}">${esc(s.name)}</a><span class="cell__sub">${esc(s.sector)}</span></td>
        <td class="num">${esc(s.projects)}</td>
        <td class="num">${esc(s.obligations)}</td>
        <td class="num${Number(s.overdue) > 0 ? ' num--critical' : ''}">${esc(s.overdue)}</td>
        <td><div class="meter"><span class="meter__value">${pct(done, total)}%</span>${bar(pct(done, total))}</div></td>
      </tr>`;
    })
    .join('');

  const upcoming = data.upcoming.length
    ? data.upcoming
        .map(
          (o) => `<tr>
            <td><a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a><span class="cell__sub">${esc(o.project_name)}</span></td>
            <td>${esc(o.subsidiary_name)}</td>
            <td>${statusTag(String(o.status))}</td>
            <td class="num">${fmtDate(o.due_at)}<span class="cell__sub">${esc(relative(o.due_at))}</span></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="4">${emptyState('Nothing outstanding', 'Every obligation in the portfolio is closed or waived.')}</td></tr>`;

  const alerts = data.alerts.length
    ? data.alerts
        .map(
          (a) => `<li class="feed">
            <div class="feed__head">${severityTag(String(a.severity))}<span class="feed__type">${esc(String(a.type).replace(/_/g, ' ').toLowerCase())}</span></div>
            <a class="link" href="/alerts/${esc(a.id)}">${esc(a.obligation_title ?? 'Portfolio alert')}</a>
            <p class="feed__sub">${esc(a.subsidiary_name)} · ${esc(relative(a.created_at))}</p>
          </li>`,
        )
        .join('')
    : `<li>${emptyState('No open alerts', 'The compliance sweep has not raised anything that needs attention.')}</li>`;

  const runs = data.runs.length
    ? data.runs
        .map(
          (r) => `<li class="feed">
            <div class="feed__head">${statusTag(String(r.status))}<span class="feed__type">${esc(String(r.trigger).toLowerCase())}</span></div>
            <p class="feed__body">${esc(r.summary ?? 'Run in progress.')}</p>
            <p class="feed__sub">${esc(fmtDateTime(r.started_at))}${r.model ? ` · ${esc(r.model)}` : ''}</p>
          </li>`,
        )
        .join('')
    : `<li>${emptyState('No agent activity yet', 'Run a compliance check to produce the first recorded run.')}</li>`;

  return `<section class="section" aria-labelledby="h-kpi">
    <div class="section__head">
      <h2 id="h-kpi" class="section__title">Portfolio position</h2>
      <p class="section__meta">Last compliance sweep ${esc(data.checkedAt)}</p>
    </div>
    <div class="kpis">
      ${kpi('Subsidiaries', String(k.subsidiaries), 'Fictional group companies')}
      ${kpi('Active projects', String(k.activeProjects), 'In flight across the group')}
      ${kpi('Overdue obligations', String(k.overdueObligations), 'Past due and still open', k.overdueObligations > 0 ? 'critical' : undefined)}
      ${kpi('High priority risks', String(k.highRisks), 'Open, high or critical', k.highRisks > 0 ? 'warn' : undefined)}
      ${kpi('Completion rate', `${k.complianceRate}%`, `${k.completedObligations} of ${k.totalObligations} obligations closed`)}
      ${kpi('Alerts needing attention', String(k.openAlerts), 'Open, escalated or awaiting approval', k.openAlerts > 0 ? 'warn' : undefined)}
    </div>
  </section>

  <div class="split">
    <section class="panel" aria-labelledby="h-subs">
      <div class="panel__head"><h2 id="h-subs" class="panel__title">Subsidiary performance</h2>
        <p class="panel__meta">Completion is computed from live obligation records</p></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th scope="col">Subsidiary</th><th scope="col" class="num">Projects</th><th scope="col" class="num">Obligations</th><th scope="col" class="num">Overdue</th><th scope="col">Completion</th></tr></thead>
          <tbody>${subs}</tbody>
        </table>
      </div>
    </section>

    <section class="panel" aria-labelledby="h-alerts">
      <div class="panel__head"><h2 id="h-alerts" class="panel__title">Needs attention</h2>
        <a class="panel__action" href="/alerts">All alerts</a></div>
      <ul class="list">${alerts}</ul>
    </section>
  </div>

  <div class="split">
    <section class="panel" aria-labelledby="h-due">
      <div class="panel__head"><h2 id="h-due" class="panel__title">Next deadlines</h2>
        <p class="panel__meta">Ordered by due date</p></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th scope="col">Obligation</th><th scope="col">Subsidiary</th><th scope="col">Status</th><th scope="col" class="num">Due</th></tr></thead>
          <tbody>${upcoming}</tbody>
        </table>
      </div>
      <div class="panel__foot">
        <form method="post" action="/compliance/run" class="inline">
          <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
          <button class="btn btn--primary" type="submit" ${data.canRun ? '' : 'disabled aria-disabled="true"'}>Run compliance check</button>
        </form>
        <p class="panel__meta">${data.canRun ? 'Runs the same service the scheduler calls every 15 minutes.' : 'Your role is read only.'}</p>
      </div>
    </section>

    <section class="panel" aria-labelledby="h-agent">
      <div class="panel__head"><h2 id="h-agent" class="panel__title">Recent agent activity</h2>
        <a class="panel__action" href="/activity">Audit trail</a></div>
      <ul class="list">${runs}</ul>
    </section>
  </div>`;
}

export function subsidiariesPage(user: SessionUser, csrf: string, rows: Array<Record<string, any>>): string {
  const body = rows.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Subsidiary</th><th scope="col">Sector</th><th scope="col" class="num">Projects</th><th scope="col" class="num">Overdue</th><th scope="col">Standing</th></tr></thead>
        <tbody>${rows
          .map(
            (s) => `<tr>
              <td><a class="link" href="/subsidiaries/${esc(s.id)}">${esc(s.name)}</a><span class="cell__sub">${esc(s.code)}</span></td>
              <td>${esc(s.sector)}</td>
              <td class="num">${esc(s.projects)}</td>
              <td class="num${Number(s.overdue) > 0 ? ' num--critical' : ''}">${esc(s.overdue)}</td>
              <td>${Number(s.overdue) > 0 ? statusTag('AT_RISK') : statusTag('ACTIVE')}</td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No subsidiaries', 'Seed the database to populate the portfolio.');

  return `<section class="panel"><div class="panel__head"><h2 class="panel__title">Group companies</h2>
    <p class="panel__meta">${rows.length} registered</p></div>${body}</section>`;
}

export function subsidiaryPage(user: SessionUser, data: Record<string, any>): string {
  const s = data.subsidiary;
  const projects = data.projects.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col" class="num">Obligations</th><th scope="col" class="num">Overdue</th><th scope="col" class="num">Target</th></tr></thead>
        <tbody>${data.projects
          .map(
            (p: any) => `<tr><td><a class="link" href="/projects/${esc(p.id)}">${esc(p.name)}</a><span class="cell__sub">${esc(p.code)} · ${money(p.budget_ngn)}</span></td>
              <td>${statusTag(String(p.status))}</td><td class="num">${esc(p.obligations)}</td>
              <td class="num${Number(p.overdue) > 0 ? ' num--critical' : ''}">${esc(p.overdue)}</td>
              <td class="num">${fmtDate(p.target_date)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No projects', 'This subsidiary has no projects on record.');

  const obligations = data.obligations.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Obligation</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col" class="num">Due</th></tr></thead>
        <tbody>${data.obligations
          .map(
            (o: any) => `<tr><td><a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a><span class="cell__sub">${esc(o.owner_name)}</span></td>
              <td>${esc(o.kind)}</td><td>${statusTag(String(o.status))}</td><td class="num">${fmtDate(o.due_at)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No obligations', 'Nothing is due from this subsidiary.');

  const risks = data.risks.length
    ? `<ul class="list">${data.risks
        .map(
          (r: any) => `<li class="feed"><div class="feed__head">${severityTag(String(r.severity))}${statusTag(String(r.status))}</div>
            <p class="feed__body">${esc(r.title)}</p><p class="feed__sub">${esc(r.rationale)}</p></li>`,
        )
        .join('')}</ul>`
    : emptyState('No risks recorded', 'The risk register is clear for this subsidiary.');

  return `<nav class="crumbs"><a class="link" href="/subsidiaries">Subsidiaries</a><span aria-hidden="true">/</span><span>${esc(s.name)}</span></nav>
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">${esc(s.name)}</h2>
      <p class="panel__meta">${esc(s.code)} · ${esc(s.sector)}</p></div>
      <p class="prose">${esc(s.description)}</p></section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Risk register</h2></div>${risks}</section>
  </div>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Projects</h2></div>${projects}</section>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Obligations</h2>
    <p class="panel__meta">Most recent first</p></div>${obligations}</section>`;
}

export function projectsPage(user: SessionUser, rows: Array<Record<string, any>>, filter: Record<string, string>, subs: Array<Record<string, any>>): string {
  const options = subs.map((s) => `<option value="${esc(s.id)}"${filter.subsidiary === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const body = rows.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Project</th><th scope="col">Subsidiary</th><th scope="col">Status</th><th scope="col" class="num">Budget</th><th scope="col" class="num">Obligations</th><th scope="col" class="num">Overdue</th></tr></thead>
        <tbody>${rows
          .map(
            (p) => `<tr><td><a class="link" href="/projects/${esc(p.id)}">${esc(p.name)}</a><span class="cell__sub">${esc(p.code)}</span></td>
              <td>${esc(p.subsidiary_name)}</td><td>${statusTag(String(p.status))}</td>
              <td class="num">${money(p.budget_ngn)}</td><td class="num">${esc(p.obligations)}</td>
              <td class="num${Number(p.overdue) > 0 ? ' num--critical' : ''}">${esc(p.overdue)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No projects match the filter', 'Clear the filters to see the full portfolio.');

  return `<form class="filters" method="get" action="/projects" role="search">
      <label class="field field--inline"><span class="field__label">Status</span>
        <select class="input input--select" name="status">
          <option value="">Any</option>
          ${['ACTIVE', 'AT_RISK', 'ON_HOLD', 'COMPLETED'].map((s) => `<option value="${s}"${filter.status === s ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
        </select></label>
      <label class="field field--inline"><span class="field__label">Subsidiary</span>
        <select class="input input--select" name="subsidiary"><option value="">All</option>${options}</select></label>
      <button class="btn btn--ghost" type="submit">Apply</button>
    </form>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Portfolio projects</h2>
      <p class="panel__meta">${rows.length} shown</p></div>${body}</section>`;
}

export function projectPage(user: SessionUser, data: Record<string, any>): string {
  const p = data.project;
  const rows = data.obligations.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Obligation</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col" class="num">Documents</th><th scope="col" class="num">Due</th></tr></thead>
        <tbody>${data.obligations
          .map(
            (o: any) => `<tr><td><a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a><span class="cell__sub">${esc(o.owner_name)}</span></td>
              <td>${esc(o.kind)}</td><td>${statusTag(String(o.status))}</td><td class="num">${esc(o.documents)}</td>
              <td class="num">${fmtDate(o.due_at)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No obligations yet', 'Add one through the seed or the API.');

  return `<nav class="crumbs"><a class="link" href="/projects">Projects</a><span aria-hidden="true">/</span>
      <a class="link" href="/subsidiaries/${esc(p.subsidiary_id)}">${esc(p.subsidiary_name)}</a><span aria-hidden="true">/</span><span>${esc(p.name)}</span></nav>
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">${esc(p.name)}</h2>${statusTag(String(p.status))}</div>
      <dl class="facts">
        <div><dt>Code</dt><dd>${esc(p.code)}</dd></div>
        <div><dt>Budget</dt><dd>${money(p.budget_ngn)}</dd></div>
        <div><dt>Started</dt><dd>${fmtDate(p.start_date)}</dd></div>
        <div><dt>Target</dt><dd>${fmtDate(p.target_date)}</dd></div>
      </dl></section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Delivery</h2></div>
      <dl class="facts">
        <div><dt>Open obligations</dt><dd>${data.obligations.filter((o: any) => o.status !== 'COMPLETED' && o.status !== 'WAIVED').length}</dd></div>
        <div><dt>Closed</dt><dd>${data.obligations.filter((o: any) => o.status === 'COMPLETED').length}</dd></div>
        <div><dt>Overdue</dt><dd>${data.obligations.filter((o: any) => o.status === 'OVERDUE').length}</dd></div>
      </dl></section>
  </div>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Obligations</h2></div>${rows}</section>`;
}

export function obligationPage(user: SessionUser, csrf: string, data: Record<string, any>, canAct: boolean): string {
  const o = data.obligation;
  const documents = data.documents.length
    ? `<ul class="list">${data.documents
        .map(
          (d: any) => `<li class="feed"><div class="feed__head"><a class="link" href="/documents/${esc(d.id)}">${esc(d.filename)}</a>${statusTag('RECEIVED')}</div>
            <p class="feed__sub">${esc(fmtDateTime(d.created_at))} · ${esc(d.findings)} findings · ${Math.round(Number(d.size_bytes) / 1024)} KB</p></li>`,
        )
        .join('')}</ul>`
    : emptyState('No submission filed', 'Upload a text submission to trigger deterministic checks and a model assessment.');

  const alerts = data.alerts.length
    ? `<ul class="list">${data.alerts
        .map(
          (a: any) => `<li class="feed"><div class="feed__head">${severityTag(String(a.severity))}${statusTag(String(a.status))}</div>
            <a class="link" href="/alerts/${esc(a.id)}">${esc(String(a.type).replace(/_/g, ' '))}</a>
            <p class="feed__sub">${esc(a.evidence_summary)}</p></li>`,
        )
        .join('')}</ul>`
    : emptyState('No alerts', 'No compliance alert has been raised against this obligation.');

  const approvals = data.approvals.length
    ? `<ul class="list">${data.approvals
        .map(
          (a: any) => `<li class="feed"><div class="feed__head">${statusTag(String(a.status))}<span class="feed__type">${esc(a.proposed_action)}</span></div>
            <p class="feed__sub">Requested ${esc(fmtDateTime(a.created_at))}${a.decided_at ? ` · decided ${esc(fmtDateTime(a.decided_at))}` : ''}</p></li>`,
        )
        .join('')}</ul>`
    : emptyState('No approvals', 'Approvals appear when policy requires a human decision.');

  const transitions = canAct
    ? `<form method="post" action="/obligations/${esc(o.id)}/status" class="inline">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label class="field field--inline"><span class="field__label">Record outcome</span>
          <select class="input input--select" name="status">
            <option value="COMPLETED">Completed</option>
            <option value="WAIVED">Waived</option>
            <option value="OPEN">Reopen</option>
          </select></label>
        <button class="btn btn--ghost" type="submit">Apply</button>
      </form>`
    : '';

  return `<nav class="crumbs"><a class="link" href="/subsidiaries/${esc(o.subsidiary_id)}">${esc(o.subsidiary_name)}</a><span aria-hidden="true">/</span>
      <a class="link" href="/projects/${esc(o.project_id)}">${esc(o.project_name)}</a><span aria-hidden="true">/</span><span>${esc(o.title)}</span></nav>
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">${esc(o.title)}</h2>${statusTag(String(o.status))}</div>
      <dl class="facts">
        <div><dt>Kind</dt><dd>${esc(o.kind)}</dd></div>
        <div><dt>Owner</dt><dd>${esc(o.owner_name)}</dd></div>
        <div><dt>Due</dt><dd>${fmtDateTime(o.due_at)}</dd></div>
        <div><dt>Document required</dt><dd>${o.requires_document ? 'Yes' : 'No'}</dd></div>
        <div><dt>Version</dt><dd>${esc(o.version)} · updated ${esc(fmtDateTime(o.updated_at))}</dd></div>
      </dl>
      ${transitions}
    </section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Approvals</h2></div>${approvals}</section>
  </div>
  <div class="split">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Submissions</h2>
      <a class="panel__action" href="/documents?obligation=${esc(o.id)}">Upload</a></div>${documents}</section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Alerts</h2></div>${alerts}</section>
  </div>`;
}

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
  const checks = data.checks.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Status</th><th scope="col" class="num">Scanned</th><th scope="col" class="num">Overdue</th><th scope="col" class="num">Alerts</th><th scope="col">Error</th></tr></thead>
        <tbody>${data.checks
          .map(
            (c) => `<tr><td>${fmtDateTime(c.started_at)}</td><td>${esc(c.trigger)}</td><td>${statusTag(String(c.status))}</td>
              <td class="num">${esc(c.scanned)}</td><td class="num">${esc(c.overdue)}</td><td class="num">${esc(c.alerts_created)}</td>
              <td class="cell__sub">${esc(c.error ?? '')}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No checks recorded', 'Run the first sweep to establish a baseline.');

  const overdue = data.overdue.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Obligation</th><th scope="col">Subsidiary</th><th scope="col">Owner</th><th scope="col" class="num">Due</th><th scope="col" class="num">Late</th></tr></thead>
        <tbody>${data.overdue
          .map((o) => {
            const days = Math.max(0, Math.floor((Date.now() - new Date(o.due_at).getTime()) / 86_400_000));
            return `<tr><td><a class="link" href="/obligations/${esc(o.id)}">${esc(o.title)}</a><span class="cell__sub">${esc(o.project_name)}</span></td>
              <td>${esc(o.subsidiary_name)}</td><td>${esc(o.owner_name)}</td><td class="num">${fmtDate(o.due_at)}</td>
              <td class="num num--critical">${days}d</td></tr>`;
          })
          .join('')}</tbody></table></div>`
    : emptyState('Nothing overdue', 'Every open obligation is still within its deadline.');

  return `${data.noticeText ? notice('ok', data.noticeText) : ''}
  <section class="section"><div class="section__head"><h2 class="section__title">Monitoring</h2>
    <p class="section__meta">Scheduler runs every ${data.schedulerIntervalMinutes} minutes while the process is up</p></div>
    <div class="kpis kpis--four">
      ${kpi('Overdue now', String(data.kpis.overdueObligations), 'Confirmed by deterministic rules', data.kpis.overdueObligations > 0 ? 'critical' : undefined)}
      ${kpi('Open alerts', String(data.kpis.openAlerts), 'Includes approvals pending')}
      ${kpi('Last sweep', data.checks[0] ? fmtDateTime(data.checks[0].started_at).replace(' WAT', '') : 'Never', data.checks[0] ? `Status ${data.checks[0].status}` : 'No runs yet')}
      ${kpi('Completion rate', `${data.kpis.complianceRate}%`, `${data.kpis.completedObligations} of ${data.kpis.totalObligations} closed`)}
    </div>
  </section>
  <div class="panel panel--action">
    <div>
      <h2 class="panel__title">Run a compliance sweep</h2>
      <p class="panel__meta">The manual trigger calls exactly the same service as the scheduler. Duplicate runs are refused with an advisory lock, and duplicate alerts are suppressed by a partial unique index.</p>
    </div>
    <form method="post" action="/compliance/run" class="inline">
      <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
      <button class="btn btn--primary" type="submit" ${data.canRun ? '' : 'disabled aria-disabled="true"'}>Run compliance check</button>
    </form>
  </div>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Overdue obligations</h2>
    <p class="panel__meta">${data.overdue.length} past due</p></div>${overdue}</section>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Check history</h2></div>${checks}</section>`;
}

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
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Document</th><th scope="col">Obligation</th><th scope="col">Subsidiary</th><th scope="col" class="num">AI findings</th><th scope="col">Uploaded</th></tr></thead>
        <tbody>${data.docs
          .map(
            (d) => `<tr><td><a class="link" href="/documents/${esc(d.id)}">${esc(d.filename)}</a><span class="cell__sub">${esc(d.uploader ?? 'system')}</span></td>
              <td><a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a></td>
              <td>${esc(d.subsidiary_name)}</td><td class="num">${esc(d.ai_findings)}</td>
              <td>${esc(fmtDateTime(d.created_at))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No documents yet', 'Upload a governance or regulatory submission to see the assessment pipeline.');

  const options = data.options.map((o) => `<option value="${esc(o.id)}"${data.selected === o.id ? ' selected' : ''}>${esc(o.title)} · ${esc(o.subsidiary_name)} (${esc(o.status)})</option>`).join('');

  const form = data.canUpload
    ? `<form class="stack" method="post" action="/documents" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="${esc(data.csrf)}">
        <label class="field"><span class="field__label">Obligation</span>
          <select class="input input--select" name="obligationId" required><option value="">Select an obligation</option>${options}</select></label>
        <label class="field"><span class="field__label">Submission (.txt or .md, up to 256 KB)</span>
          <input class="input" type="file" name="file" accept=".txt,.md,text/plain,text/markdown" required></label>
        <button class="btn btn--primary" type="submit">Upload and assess</button>
      </form>`
    : '<p class="prose">Your role can view documents but not upload.</p>';

  return `${data.noticeText ? notice(data.noticeKind ?? 'info', data.noticeText) : ''}
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">New submission</h2>
      <p class="panel__meta">Model: ${esc(data.modelLabel)}</p></div>${form}
      <p class="panel__meta panel__note">Text only. The parser does not execute files, and document text is treated as untrusted data by the model prompt.</p></section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">How findings are labelled</h2></div>
      <ul class="prose-list">
        <li><strong>Fact</strong> extracted mechanically from the text, such as length or a stated reporting period.</li>
        <li><strong>Rule</strong> from deterministic checks, such as missing required sections.</li>
        <li><strong>Interpretation</strong> produced by the model, never promoted to fact automatically.</li>
        <li><strong>Recommendation</strong> requiring human judgement before anything happens.</li>
      </ul></section>
  </div>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Submissions</h2>
    <p class="panel__meta">${data.docs.length} on record</p></div>${rows}</section>`;
}

export function documentPage(data: Record<string, any>, user: SessionUser): string {
  const d = data.document;
  const groups = [
    ['FACT', 'Facts extracted from the document'],
    ['RULE', 'Deterministic rule findings'],
    ['AI', 'Model interpretation, unverified'],
    ['RECOMMENDATION', 'Recommendations for review'],
  ] as const;

  const sections = groups
    .map(([key, label]) => {
      const items = data.findings.filter((f: any) => f.provenance === key);
      if (items.length === 0) return '';
      return `<section class="panel"><div class="panel__head"><h2 class="panel__title">${label}</h2>
        <span class="pill pill--quiet">${items.length}</span></div>
        <ul class="list">${items
          .map(
            (f: any) => `<li class="feed">
              <div class="feed__head"><span class="feed__type">${esc(String(f.code).replace(/_/g, ' ').toLowerCase())}</span>
                ${f.confidence ? `<span class="pill pill--quiet">confidence ${Number(f.confidence).toFixed(2)}</span>` : ''}</div>
              <p class="feed__body">${esc(f.label)}: ${esc(f.detail)}</p>
              ${f.evidence_quote ? `<blockquote class="quote">${esc(f.evidence_quote)}</blockquote>` : ''}
            </li>`,
          )
          .join('')}</ul></section>`;
    })
    .join('');

  return `<nav class="crumbs"><a class="link" href="/documents">Documents</a><span aria-hidden="true">/</span>
      <a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a><span aria-hidden="true">/</span><span>${esc(d.filename)}</span></nav>
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">${esc(d.filename)}</h2>
      <p class="panel__meta">${esc(d.mime)} · ${Math.round(Number(d.size_bytes) / 1024)} KB</p></div>
      <dl class="facts">
        <div><dt>Obligation</dt><dd><a class="link" href="/obligations/${esc(d.obligation_id)}">${esc(d.obligation_title)}</a></dd></div>
        <div><dt>Subsidiary</dt><dd>${esc(d.subsidiary_name)}</dd></div>
        <div><dt>Uploaded by</dt><dd>${esc(d.uploader ?? 'system')}</dd></div>
        <div><dt>Uploaded at</dt><dd>${esc(fmtDateTime(d.created_at))}</dd></div>
        <div><dt>Content hash</dt><dd class="mono">${esc(String(d.sha256).slice(0, 24))}…</dd></div>
      </dl>
    </section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Source text</h2>
      <p class="panel__meta">Stored as submitted, never executed</p></div>
      <pre class="source">${esc(String(d.body_text).slice(0, 4000))}${String(d.body_text).length > 4000 ? '\n\n[truncated for display]' : ''}</pre>
    </section>
  </div>
  ${sections || emptyState('No findings', 'This document produced no findings.')}`;
}

export function alertsPage(data: {
  user: SessionUser;
  csrf: string;
  rows: Array<Record<string, any>>;
  filter: Record<string, string>;
  noticeText?: string;
  noticeKind?: 'ok' | 'warn' | 'error';
}): string {
  const rows = data.rows.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Alert</th><th scope="col">Subsidiary</th><th scope="col">Severity</th><th scope="col">Status</th><th scope="col">Raised</th></tr></thead>
        <tbody>${data.rows
          .map(
            (a) => `<tr>
              <td><a class="link" href="/alerts/${esc(a.id)}">${esc(String(a.type).replace(/_/g, ' ').toLowerCase())}</a>
                <span class="cell__sub">${esc(a.obligation_title ?? 'Portfolio level')}</span></td>
              <td>${esc(a.subsidiary_name)}</td>
              <td>${severityTag(String(a.severity))}</td>
              <td>${statusTag(String(a.status))}${a.pending_approval ? '<span class="cell__sub">approval pending</span>' : ''}</td>
              <td>${esc(relative(a.created_at))}<span class="cell__sub">${fmtDateTime(a.created_at)}</span></td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No alerts match', 'Adjust the filters or run a compliance sweep.');

  return `${data.noticeText ? notice(data.noticeKind ?? 'info', data.noticeText) : ''}
  <form class="filters" method="get" action="/alerts" role="search">
    <label class="field field--inline"><span class="field__label">Status</span>
      <select class="input input--select" name="status"><option value="">Any</option>
        ${['OPEN', 'ESCALATION_PENDING', 'ESCALATED', 'RESOLVED', 'DISMISSED'].map((s) => `<option value="${s}"${data.filter.status === s ? ' selected' : ''}>${s.replace(/_/g, ' ').toLowerCase()}</option>`).join('')}
      </select></label>
    <label class="field field--inline"><span class="field__label">Severity</span>
      <select class="input input--select" name="severity"><option value="">Any</option>
        ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => `<option value="${s}"${data.filter.severity === s ? ' selected' : ''}>${s.toLowerCase()}</option>`).join('')}
      </select></label>
    <button class="btn btn--ghost" type="submit">Apply</button>
  </form>
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Alert centre</h2>
    <p class="panel__meta">${data.rows.length} shown, open cases first</p></div>${rows}</section>`;
}

export function alertPage(data: Record<string, any>, user: SessionUser, csrf: string, canApprove: boolean, noticeText?: string, noticeKind?: 'ok' | 'warn' | 'error'): string {
  const a = data.alert;
  const pending = data.approvals.find((row: any) => row.status === 'PENDING');

  const approvalBlock = pending
    ? `<div class="approval">
        <div class="approval__head"><h3 class="approval__title">Escalation awaiting your decision</h3>
          <span class="pill">${pending.payload.generated_by === 'deterministic-rules' ? 'Policy text, no model' : esc(String(pending.payload.generated_by ?? 'model'))}</span></div>
        <p class="approval__subject">${esc(pending.payload.subject ?? '')}</p>
        <p class="approval__body">${esc(pending.payload.body ?? '')}</p>
        ${pending.payload.rationale ? `<p class="approval__rationale"><strong>Rationale.</strong> ${esc(pending.payload.rationale)}</p>` : ''}
        ${canApprove
          ? `<div class="approval__actions">
              <form method="post" action="/alerts/${esc(a.id)}/decide" class="stack">
                <input type="hidden" name="_csrf" value="${esc(csrf)}">
                <input type="hidden" name="approvalId" value="${esc(pending.id)}">
                <label class="field"><span class="field__label">Reviewer note (optional)</span>
                  <input class="input" name="comment" maxlength="400" placeholder="Recorded with the decision"></label>
                <div class="row">
                  <button class="btn btn--primary" type="submit" name="decision" value="APPROVED">Approve and record escalation</button>
                  <button class="btn btn--ghost" type="submit" name="decision" value="REJECTED">Reject</button>
                </div>
                <p class="panel__meta">Approval executes application delivery only. No email or chat message is sent by this build, and the audit record states that.</p>
              </form>
            </div>`
          : '<p class="prose">Your role can review this case but not approve it.</p>'}
      </div>`
    : '';

  const history = data.approvals.length
    ? `<ul class="list">${data.approvals
        .map(
          (row: any) => `<li class="feed"><div class="feed__head">${statusTag(String(row.status))}<span class="feed__type">${esc(row.proposed_action)}</span></div>
            <p class="feed__sub">Requested ${esc(fmtDateTime(row.created_at))}${row.decided_at ? ` · ${esc(fmtDateTime(row.decided_at))}` : ''}${row.decided_by_name ? ` · ${esc(row.decided_by_name)}` : ''}</p>
            ${row.payload?.subject ? `<p class="feed__body"><strong>${esc(row.payload.subject)}</strong></p>` : ''}
            ${row.payload?.body ? `<p class="feed__sub">${esc(row.payload.body)}</p>` : ''}
            ${row.comment ? `<p class="feed__body">${esc(row.comment)}</p>` : ''}</li>`,
        )
        .join('')}</ul>`
    : emptyState('No approvals requested', 'Policy did not require a human decision for this alert.');

  const actions = data.actions.length
    ? `<ul class="list">${data.actions
        .map(
          (row: any) => `<li class="feed"><div class="feed__head">${statusTag(String(row.status))}<span class="feed__type">${esc(row.kind)} · ${esc(row.channel)}</span></div>
            <p class="feed__sub">${esc(fmtDateTime(row.executed_at))}</p>
            <p class="feed__body">${esc(row.result.subject ?? '')}</p>
            <p class="feed__sub">Simulated delivery: ${esc(row.result.external_delivery ?? 'none')}</p></li>`,
        )
        .join('')}</ul>`
    : emptyState('Nothing executed', 'No action has been executed for this alert.');

  return `<nav class="crumbs"><a class="link" href="/alerts">Alerts</a><span aria-hidden="true">/</span><span>${esc(titleCase(String(a.type)))}</span></nav>
  ${noticeText ? notice(noticeKind ?? 'info', noticeText) : ''}
  <div class="split split--lead">
    <section class="panel"><div class="panel__head"><h2 class="panel__title">${esc(titleCase(String(a.type)))}</h2>
      <div class="row row--tags">${severityTag(String(a.severity))}${statusTag(String(a.status))}</div></div>
      <dl class="facts">
        <div><dt>Subsidiary</dt><dd><a class="link" href="/subsidiaries/${esc(a.subsidiary_id)}">${esc(a.subsidiary_name)}</a></dd></div>
        ${a.obligation_id ? `<div><dt>Obligation</dt><dd><a class="link" href="/obligations/${esc(a.obligation_id)}">${esc(a.obligation_title)}</a></dd></div>` : ''}
        ${a.obligation_status ? `<div><dt>Obligation status</dt><dd>${statusTag(String(a.obligation_status))}</dd></div>` : ''}
        <div><dt>Raised</dt><dd>${esc(fmtDateTime(a.created_at))}</dd></div>
      </dl>
      <p class="prose">${esc(a.evidence_summary)}</p>
      <p class="prose prose--muted"><strong>Recommended action.</strong> ${esc(a.recommended_action)}</p>
    </section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Approval history</h2></div>${history}</section>
  </div>
  ${approvalBlock}
  <section class="panel"><div class="panel__head"><h2 class="panel__title">Executed actions</h2></div>${actions}</section>`;
}

export function activityPage(data: { user: SessionUser; runs: Array<Record<string, any>>; audit: Array<Record<string, any>>; modelLabel: string }): string {
  const runs = data.runs.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Summary</th><th scope="col" class="num">Duration</th></tr></thead>
        <tbody>${data.runs
          .map((r) => {
            const ms = r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;
            return `<tr><td>${fmtDateTime(r.started_at)}</td><td>${esc(String(r.trigger).toLowerCase())}</td>
              <td>${statusTag(String(r.status))}</td><td><span class="cell__sub cell__model">${esc(r.model ?? 'deterministic')}</span></td>
              <td>${esc(r.summary ?? '—')}${r.error ? `<span class="cell__sub cell__sub--warn">${esc(r.error).slice(0, 160)}</span>` : ''}</td>
              <td class="num">${ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
    : emptyState('No agent runs', 'The agent writes a run record every time it evaluates an alert or a document.');

  const audit = data.audit.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">At</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Detail</th></tr></thead>
        <tbody>${data.audit
          .map(
            (e) => `<tr><td>${fmtDateTime(e.at)}</td><td>${esc(e.actor_type)}${e.actor_id ? `<span class="cell__sub mono">${esc(String(e.actor_id).slice(0, 8))}</span>` : ''}</td>
              <td>${esc(e.action)}</td><td>${esc(e.entity_type)}<span class="cell__sub mono">${esc(String(e.entity_id ?? '').slice(0, 8))}</span></td>
              <td><span class="cell__sub cell__detail">${esc(JSON.stringify(e.detail).slice(0, 150))}</span></td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : emptyState('No audit events', 'Audit records are appended by the system, the agent, and users.');

  return `<section class="section"><div class="section__head"><h2 class="section__title">Observability</h2>
    <p class="section__meta">Model: ${esc(data.modelLabel)}</p></div></section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Agent runs</h2>
      <p class="panel__meta">${data.runs.length} most recent</p></div>${runs}</section>
    <section class="panel"><div class="panel__head"><h2 class="panel__title">Audit trail</h2>
      <p class="panel__meta">Append only at the application and database level</p></div>${audit}</section>`;
}

export function errorPage(status: number, message: string, user?: SessionUser, csrf?: string): string {
  const body = `<section class="panel"><div class="panel__head"><h2 class="panel__title">${status}</h2></div>
    <p class="prose">${esc(message)}</p>
    <p class="panel__meta"><a class="link" href="/">Return to overview</a></p></section>`;
  if (!user) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${status} · ATLAS</title>
      <link rel="stylesheet" href="${cssHref}"></head><body class="auth"><main class="auth__panel">${body}</main></body></html>`;
  }
  return `<section>${body}</section>`;
}
