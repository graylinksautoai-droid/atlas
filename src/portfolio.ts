import { one, many } from './db.ts';

export interface Kpis {
  subsidiaries: number;
  activeProjects: number;
  overdueObligations: number;
  highRisks: number;
  openAlerts: number;
  complianceRate: number;
  dueNext7Days: number;
  totalObligations: number;
  completedObligations: number;
  lastCheckAt: Date | null;
  lastCheckStatus: string | null;
}

export async function dashboardKpis(): Promise<Kpis> {
  const row = await one<{
    subsidiaries: string;
    active_projects: string;
    overdue: string;
    high_risks: string;
    open_alerts: string;
    due_7: string;
    total: string;
    completed: string;
    last_check_at: Date | null;
    last_check_status: string | null;
  }>(`
    SELECT
      (SELECT count(*) FROM subsidiary)::text AS subsidiaries,
      (SELECT count(*) FROM project WHERE status IN ('ACTIVE','AT_RISK'))::text AS active_projects,
      (SELECT count(*) FROM obligation WHERE status = 'OVERDUE')::text AS overdue,
      (SELECT count(*) FROM risk WHERE status = 'OPEN' AND severity IN ('HIGH','CRITICAL'))::text AS high_risks,
      (SELECT count(*) FROM alert WHERE status NOT IN ('RESOLVED','DISMISSED'))::text AS open_alerts,
      (SELECT count(*) FROM obligation WHERE status IN ('OPEN','OVERDUE') AND due_at BETWEEN now() AND now() + interval '7 days')::text AS due_7,
      (SELECT count(*) FROM obligation WHERE status <> 'WAIVED')::text AS total,
      (SELECT count(*) FROM obligation WHERE status = 'COMPLETED')::text AS completed,
      (SELECT started_at FROM compliance_check ORDER BY started_at DESC LIMIT 1) AS last_check_at,
      (SELECT status FROM compliance_check ORDER BY started_at DESC LIMIT 1) AS last_check_status
  `);
  const total = Number(row?.total ?? 0);
  const completed = Number(row?.completed ?? 0);
  return {
    subsidiaries: Number(row?.subsidiaries ?? 0),
    activeProjects: Number(row?.active_projects ?? 0),
    overdueObligations: Number(row?.overdue ?? 0),
    highRisks: Number(row?.high_risks ?? 0),
    openAlerts: Number(row?.open_alerts ?? 0),
    dueNext7Days: Number(row?.due_7 ?? 0),
    totalObligations: total,
    completedObligations: completed,
    complianceRate: total === 0 ? 0 : Math.round((completed / total) * 1000) / 10,
    lastCheckAt: row?.last_check_at ?? null,
    lastCheckStatus: row?.last_check_status ?? null,
  };
}

export async function subsidiaryPerformance(): Promise<
  Array<{
    id: string;
    name: string;
    code: string;
    sector: string;
    projects: string;
    obligations: string;
    overdue: string;
    completed: string;
    open_risks: string;
    budget_ngn: string | null;
  }>
> {
  return many(`
    SELECT s.id, s.name, s.code, s.sector,
           (SELECT count(*) FROM project p WHERE p.subsidiary_id = s.id AND p.status IN ('ACTIVE','AT_RISK'))::text AS projects,
           (SELECT count(*) FROM obligation o JOIN project p ON p.id = o.project_id WHERE p.subsidiary_id = s.id)::text AS obligations,
           (SELECT count(*) FROM obligation o JOIN project p ON p.id = o.project_id WHERE p.subsidiary_id = s.id AND o.status = 'OVERDUE')::text AS overdue,
           (SELECT count(*) FROM obligation o JOIN project p ON p.id = o.project_id WHERE p.subsidiary_id = s.id AND o.status = 'COMPLETED')::text AS completed,
           (SELECT count(*) FROM risk r WHERE r.subsidiary_id = s.id AND r.status = 'OPEN')::text AS open_risks,
           (SELECT sum(p.budget_ngn) FROM project p WHERE p.subsidiary_id = s.id)::text AS budget_ngn
      FROM subsidiary s
     ORDER BY s.name
  `);
}

export async function upcomingObligations(limit = 8): Promise<
  Array<{ id: string; title: string; kind: string; due_at: Date; status: string; subsidiary_name: string; project_name: string; owner_name: string }>
> {
  return many(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status,
            s.name AS subsidiary_name, p.name AS project_name, o.owner_name
       FROM obligation o
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE o.status IN ('OPEN','OVERDUE','SUBMITTED')
      ORDER BY o.due_at ASC
      LIMIT $1`,
    [limit],
  );
}

export async function overdueList(limit = 50): Promise<
  Array<{ id: string; title: string; kind: string; due_at: Date; status: string; subsidiary_name: string; project_name: string; owner_name: string }>
> {
  return many(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status,
            s.name AS subsidiary_name, p.name AS project_name, o.owner_name
       FROM obligation o
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE o.status = 'OVERDUE'
      ORDER BY o.due_at ASC
      LIMIT $1`,
    [limit],
  );
}

export async function recentAlerts(limit = 6): Promise<
  Array<{ id: string; type: string; severity: string; status: string; created_at: Date; subsidiary_name: string; obligation_title: string | null }>
> {
  return many(
    `SELECT al.id, al.type, al.severity, al.status, al.created_at, s.name AS subsidiary_name, o.title AS obligation_title
       FROM alert al
       JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
      WHERE al.status NOT IN ('RESOLVED','DISMISSED')
      ORDER BY CASE al.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, al.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export async function recentAgentActivity(limit = 6): Promise<
  Array<{
    id: string;
    trigger: string;
    status: string;
    summary: string | null;
    started_at: Date;
    finished_at: Date | null;
    model: string | null;
    error: string | null;
  }>
> {
  return many(
    `SELECT id, trigger, status, summary, started_at, finished_at, model, error
       FROM agent_run ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
}

export async function subsidiaries(): Promise<
  Array<{ id: string; name: string; code: string; sector: string; description: string; projects: string; obligations: string; overdue: string }>
> {
  return many(`
    SELECT s.id, s.name, s.code, s.sector, s.description,
           (SELECT count(*) FROM project p WHERE p.subsidiary_id = s.id)::text AS projects,
           (SELECT count(*) FROM obligation o JOIN project p ON p.id = o.project_id WHERE p.subsidiary_id = s.id)::text AS obligations,
           (SELECT count(*) FROM obligation o JOIN project p ON p.id = o.project_id WHERE p.subsidiary_id = s.id AND o.status = 'OVERDUE')::text AS overdue
      FROM subsidiary s ORDER BY s.name
  `);
}

export async function subsidiaryDetail(id: string): Promise<{
  subsidiary: { id: string; name: string; code: string; sector: string; description: string } | null;
  projects: Array<{ id: string; name: string; code: string; status: string; target_date: Date | null; budget_ngn: string | null; obligations: string; overdue: string }>;
  obligations: Array<{ id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string; project_name: string }>;
  risks: Array<{ id: string; title: string; severity: string; status: string; rationale: string }>;
}> {
  const subsidiary = await one<{ id: string; name: string; code: string; sector: string; description: string }>(
    `SELECT id, name, code, sector, description FROM subsidiary WHERE id = $1`,
    [id],
  );
  if (!subsidiary) return { subsidiary: null, projects: [], obligations: [], risks: [] };
  const projects = await many<{ id: string; name: string; code: string; status: string; target_date: Date | null; budget_ngn: string | null; obligations: string; overdue: string }>(
    `SELECT p.id, p.name, p.code, p.status, p.target_date, p.budget_ngn::text,
            (SELECT count(*) FROM obligation o WHERE o.project_id = p.id)::text AS obligations,
            (SELECT count(*) FROM obligation o WHERE o.project_id = p.id AND o.status = 'OVERDUE')::text AS overdue
       FROM project p WHERE p.subsidiary_id = $1 ORDER BY p.name`,
    [id],
  );
  const obligations = await many<{ id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string; project_name: string }>(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status, o.owner_name, p.name AS project_name
       FROM obligation o JOIN project p ON p.id = o.project_id
      WHERE p.subsidiary_id = $1 ORDER BY o.due_at DESC LIMIT 40`,
    [id],
  );
  const risks = await many<{ id: string; title: string; severity: string; status: string; rationale: string }>(
    `SELECT id, title, severity, status, rationale FROM risk WHERE subsidiary_id = $1 ORDER BY
       CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`,
    [id],
  );
  return { subsidiary, projects, obligations, risks };
}

export async function projectList(filter: { status?: string; subsidiary?: string }): Promise<
  Array<{ id: string; name: string; code: string; status: string; subsidiary_name: string; target_date: Date | null; budget_ngn: string | null; obligations: string; overdue: string }>
> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (filter.subsidiary) {
    params.push(filter.subsidiary);
    clauses.push(`p.subsidiary_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return many(
    `SELECT p.id, p.name, p.code, p.status, s.name AS subsidiary_name, p.target_date, p.budget_ngn::text,
            (SELECT count(*) FROM obligation o WHERE o.project_id = p.id)::text AS obligations,
            (SELECT count(*) FROM obligation o WHERE o.project_id = p.id AND o.status = 'OVERDUE')::text AS overdue
       FROM project p JOIN subsidiary s ON s.id = p.subsidiary_id
       ${where}
      ORDER BY p.target_date NULLS LAST`,
    params,
  );
}

export async function projectDetail(id: string): Promise<{
  project: { id: string; name: string; code: string; status: string; start_date: Date; target_date: Date | null; budget_ngn: string | null; subsidiary_id: string; subsidiary_name: string } | null;
  obligations: Array<{ id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string; documents: string }>;
}> {
  const project = await one<{ id: string; name: string; code: string; status: string; start_date: Date; target_date: Date | null; budget_ngn: string | null; subsidiary_id: string; subsidiary_name: string }>(
    `SELECT p.id, p.name, p.code, p.status, p.start_date, p.target_date, p.budget_ngn::text,
            s.id AS subsidiary_id, s.name AS subsidiary_name
       FROM project p JOIN subsidiary s ON s.id = p.subsidiary_id WHERE p.id = $1`,
    [id],
  );
  if (!project) return { project: null, obligations: [] };
  const obligations = await many<{ id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string; documents: string }>(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status, o.owner_name,
            (SELECT count(*) FROM document d WHERE d.obligation_id = o.id)::text AS documents
       FROM obligation o WHERE o.project_id = $1 ORDER BY o.due_at`,
    [id],
  );
  return { project, obligations };
}

export async function obligationDetail(id: string): Promise<{
  obligation: {
    id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string;
    requires_document: boolean; version: number; updated_at: Date; project_id: string; project_name: string;
    subsidiary_id: string; subsidiary_name: string;
  } | null;
  documents: Array<{ id: string; filename: string; created_at: Date; size_bytes: number; findings: string }>;
  alerts: Array<{ id: string; type: string; severity: string; status: string; created_at: Date; evidence_summary: string }>;
  approvals: Array<{ id: string; status: string; proposed_action: string; created_at: Date; decided_at: Date | null; comment: string | null }>;
}> {
  const obligation = await one<{
    id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string;
    requires_document: boolean; version: number; updated_at: Date; project_id: string; project_name: string;
    subsidiary_id: string; subsidiary_name: string;
  }>(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status, o.owner_name, o.requires_document,
            o.version, o.updated_at, p.id AS project_id, p.name AS project_name,
            s.id AS subsidiary_id, s.name AS subsidiary_name
       FROM obligation o JOIN project p ON p.id = o.project_id JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE o.id = $1`,
    [id],
  );
  if (!obligation) return { obligation: null, documents: [], alerts: [], approvals: [] };
  const documents = await many<{ id: string; filename: string; created_at: Date; size_bytes: number; findings: string }>(
    `SELECT d.id, d.filename, d.created_at, d.size_bytes,
            (SELECT count(*) FROM document_finding f WHERE f.document_id = d.id)::text AS findings
       FROM document d WHERE d.obligation_id = $1 ORDER BY d.created_at DESC`,
    [id],
  );
  const alerts = await many<{ id: string; type: string; severity: string; status: string; created_at: Date; evidence_summary: string }>(
    `SELECT id, type, severity, status, created_at, evidence_summary FROM alert WHERE obligation_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  const approvals = await many<{ id: string; status: string; proposed_action: string; created_at: Date; decided_at: Date | null; comment: string | null }>(
    `SELECT a.id, a.status, a.proposed_action, a.created_at, a.decided_at, a.comment
       FROM approval a JOIN alert al ON al.id = a.alert_id
      WHERE al.obligation_id = $1 ORDER BY a.created_at DESC`,
    [id],
  );
  return { obligation, documents, alerts, approvals };
}

export async function alertList(filter: { status?: string; severity?: string }): Promise<
  Array<{
    id: string; type: string; severity: string; status: string; created_at: Date; evidence_summary: string;
    recommended_action: string; subsidiary_name: string; obligation_id: string | null; obligation_title: string | null;
    pending_approval: string | null;
  }>
> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`al.status = $${params.length}`);
  }
  if (filter.severity) {
    params.push(filter.severity);
    clauses.push(`al.severity = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return many(
    `SELECT al.id, al.type, al.severity, al.status, al.created_at, al.evidence_summary, al.recommended_action,
            s.name AS subsidiary_name, o.id AS obligation_id, o.title AS obligation_title,
            (SELECT a.id FROM approval a WHERE a.alert_id = al.id AND a.status = 'PENDING' LIMIT 1) AS pending_approval
       FROM alert al
       JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
       ${where}
      ORDER BY CASE al.status WHEN 'ESCALATION_PENDING' THEN 1 WHEN 'OPEN' THEN 2 ELSE 3 END,
               CASE al.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
               al.created_at DESC
      LIMIT 100`,
    params,
  );
}

export async function alertDetail(id: string): Promise<{
  alert: {
    id: string; type: string; severity: string; status: string; created_at: Date; evidence_summary: string;
    recommended_action: string; subsidiary_name: string; subsidiary_id: string; obligation_id: string | null;
    obligation_title: string | null; obligation_status: string | null; obligation_due: Date | null;
  } | null;
  approvals: Array<{ id: string; status: string; proposed_action: string; payload: { subject?: string; body?: string; rationale?: string; generated_by?: string; confidence?: number }; created_at: Date; decided_at: Date | null; comment: string | null; decided_by_name: string | null }>;
  actions: Array<{ id: string; kind: string; channel: string; status: string; executed_at: Date; result: Record<string, unknown> }>;
}> {
  const alert = await one<{
    id: string; type: string; severity: string; status: string; created_at: Date; evidence_summary: string;
    recommended_action: string; subsidiary_name: string; subsidiary_id: string; obligation_id: string | null;
    obligation_title: string | null; obligation_status: string | null; obligation_due: Date | null;
  }>(
    `SELECT al.id, al.type, al.severity, al.status, al.created_at, al.evidence_summary, al.recommended_action,
            s.name AS subsidiary_name, s.id AS subsidiary_id, o.id AS obligation_id, o.title AS obligation_title,
            o.status::text AS obligation_status, o.due_at AS obligation_due
       FROM alert al JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
      WHERE al.id = $1`,
    [id],
  );
  if (!alert) return { alert: null, approvals: [], actions: [] };
  const approvals = await many<{
    id: string; status: string; proposed_action: string;
    payload: { subject?: string; body?: string; rationale?: string; generated_by?: string; confidence?: number };
    created_at: Date; decided_at: Date | null; comment: string | null; decided_by_name: string | null;
  }>(
    `SELECT a.id, a.status, a.proposed_action, a.payload, a.created_at, a.decided_at, a.comment, u.name AS decided_by_name
       FROM approval a LEFT JOIN app_user u ON u.id = a.decided_by
      WHERE a.alert_id = $1 ORDER BY a.created_at DESC`,
    [id],
  );
  const actions = await many<{ id: string; kind: string; channel: string; status: string; executed_at: Date; result: Record<string, unknown> }>(
    `SELECT id, kind, channel, status, executed_at, result FROM action WHERE alert_id = $1 ORDER BY executed_at DESC`,
    [id],
  );
  return { alert, approvals, actions };
}

export async function auditTrail(filter: { entityType?: string; limit?: number }): Promise<
  Array<{ id: string; at: Date; actor_type: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; detail: Record<string, unknown> }>
> {
  const limit = Math.min(filter.limit ?? 100, 300);
  if (filter.entityType) {
    return many(
      `SELECT id, at, actor_type, actor_id, action, entity_type, entity_id, detail
         FROM audit_event WHERE entity_type = $1 ORDER BY at DESC LIMIT $2`,
      [filter.entityType, limit],
    );
  }
  return many(
    `SELECT id, at, actor_type, actor_id, action, entity_type, entity_id, detail
       FROM audit_event ORDER BY at DESC LIMIT $1`,
    [limit],
  );
}

export async function documentList(): Promise<
  Array<{ id: string; filename: string; created_at: Date; size_bytes: number; obligation_id: string; obligation_title: string; subsidiary_name: string; ai_findings: string; uploader: string | null }>
> {
  return many(
    `SELECT d.id, d.filename, d.created_at, d.size_bytes, o.id AS obligation_id, o.title AS obligation_title,
            s.name AS subsidiary_name,
            (SELECT count(*) FROM document_finding f WHERE f.document_id = d.id AND f.provenance IN ('AI','RECOMMENDATION'))::text AS ai_findings,
            u.name AS uploader
       FROM document d
       JOIN obligation o ON o.id = d.obligation_id
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
       LEFT JOIN app_user u ON u.id = d.uploaded_by
      ORDER BY d.created_at DESC LIMIT 100`,
  );
}

export async function obligationOptions(): Promise<Array<{ id: string; title: string; subsidiary_name: string; status: string }>> {
  return many(
    `SELECT o.id, o.title, s.name AS subsidiary_name, o.status::text AS status
       FROM obligation o JOIN project p ON p.id = o.project_id JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE o.status IN ('OPEN','OVERDUE','SUBMITTED') ORDER BY o.due_at`,
  );
}

export interface ObligationBreakdown {
  open: number;
  overdue: number;
  submitted: number;
  completed: number;
  waived: number;
}

/** Counts obligations by status for the overview chart.
 *  Returns zeroes rather than missing keys when a status has no records. */
export async function obligationStatusBreakdown(): Promise<ObligationBreakdown> {
  const rows = await many<{ status: string; cnt: string }>(
    `SELECT status::text, count(*)::text AS cnt
       FROM obligation
      GROUP BY status`,
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = Number(r.cnt);
  return {
    open:      map['OPEN']      ?? 0,
    overdue:   map['OVERDUE']   ?? 0,
    submitted: map['SUBMITTED'] ?? 0,
    completed: map['COMPLETED'] ?? 0,
    waived:    map['WAIVED']    ?? 0,
  };
}

export interface AlertSeverityBreakdown {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Counts open/escalated alerts by severity for the overview chart. */
export async function alertSeverityBreakdown(): Promise<AlertSeverityBreakdown> {
  const rows = await many<{ severity: string; cnt: string }>(
    `SELECT severity::text, count(*)::text AS cnt
       FROM alert
      WHERE status NOT IN ('RESOLVED', 'DISMISSED')
      GROUP BY severity`,
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.severity] = Number(r.cnt);
  return {
    critical: map['CRITICAL'] ?? 0,
    high:     map['HIGH']     ?? 0,
    medium:   map['MEDIUM']   ?? 0,
    low:      map['LOW']      ?? 0,
  };
}

export interface PendingApproval {
  id: string;
  alert_id: string;
  alert_type: string;
  severity: string;
  subsidiary_name: string;
  obligation_title: string | null;
  proposed_action: string;
  created_at: Date;
}

/** Fetches approvals currently awaiting a decision, most urgent first. */
export async function pendingApprovals(limit = 8): Promise<PendingApproval[]> {
  return many<PendingApproval>(
    `SELECT a.id, a.alert_id, al.type AS alert_type, al.severity,
            s.name AS subsidiary_name, o.title AS obligation_title,
            a.proposed_action, a.created_at
       FROM approval a
       JOIN alert al ON al.id = a.alert_id
       JOIN subsidiary s ON s.id = al.subsidiary_id
       LEFT JOIN obligation o ON o.id = al.obligation_id
      WHERE a.status = 'PENDING'
      ORDER BY CASE al.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
               a.created_at ASC
      LIMIT $1`,
    [limit],
  );
}
