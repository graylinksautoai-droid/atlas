/**
 * Acceptance test for the full compliance workflow. Runs against the test
 * database, never the development one: TEST_DATABASE_URL must point at a
 * disposable database.
 */
import { readFileSync, existsSync } from 'node:fs';
const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const dotenv: Record<string, string> = {};
for (const line of envFile.split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) dotenv[match[1]] = match[2].trim();
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? dotenv.TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';
process.env.SCHEDULER_ENABLED = '0';
// Hermetic: the suite must never depend on a live model or spend tokens.
process.env.AI_PROVIDER = 'none';
delete process.env.AI_API_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { migrate } = await import('../scripts/migrate.ts');
const { seed } = await import('../scripts/seed.ts');
const { one, many, query, closePool } = await import('../src/db.ts');
const { runComplianceCheck } = await import('../src/compliance.ts');
const { decideApproval } = await import('../src/agent.ts');
const { confirmObligationStatus } = await import('../src/obligations.ts');
const { ingestDocument } = await import('../src/documents.ts');

let approverId = '';
let complianceUserId = '';
let projectId = '';

before(async () => {
  await migrate();
  await seed();
  const admin = await one<{ id: string }>(`SELECT id FROM app_user WHERE role = 'COMPLIANCE'`);
  approverId = admin!.id;
  complianceUserId = admin!.id;
  const project = await one<{ id: string }>(`SELECT id FROM project ORDER BY code LIMIT 1`);
  projectId = project!.id;
});

after(async () => {
  await closePool();
});

async function obligationByTitle(title: string) {
  return one<{ id: string; status: string; version: number }>(`SELECT id, status::text AS status, version FROM obligation WHERE title = $1`, [title]);
}

async function addOverdueObligation(title: string, daysLate: number): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO obligation (project_id, title, kind, due_at, status, owner_name, requires_document)
     VALUES ($1, $2, 'REGULATORY', now() - ($3 || ' days')::interval, 'OPEN', 'Test owner', true) RETURNING id`,
    [projectId, title, String(daysLate)],
  );
  return row!.id;
}

test('sweep marks an overdue obligation, raises one alert, asks for approval, and records the run', async () => {
  const obligation = await obligationByTitle('Q3 environmental compliance return');
  assert.equal(obligation?.status, 'OPEN');

  const result = await runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  assert.equal(result.status, 'OK');
  assert.ok(result.overdue >= 1, 'at least one overdue obligation is detected');

  const after = await obligationByTitle('Q3 environmental compliance return');
  assert.equal(after?.status, 'OVERDUE');

  const alert = await one<{ id: string; severity: string; status: string }>(
    `SELECT id, severity, status FROM alert WHERE obligation_id = $1 AND type = 'OVERDUE_OBLIGATION'`,
    [obligation!.id],
  );
  assert.ok(alert, 'an overdue alert exists');
  assert.equal(alert!.severity, 'HIGH');
  assert.equal(alert!.status, 'ESCALATION_PENDING');

  const run = await one<{ id: string; status: string; model: string | null }>(
    `SELECT id, status, model FROM agent_run WHERE alert_id = $1`,
    [alert!.id],
  );
  assert.ok(run, 'an agent run is recorded against the alert');
  assert.equal(run!.status, 'DEGRADED', 'no model configured, so the run is labelled degraded rather than pretending');
  assert.equal(run!.model, null);

  const approval = await one<{ id: string; proposed_action: string; status: string }>(
    `SELECT id, proposed_action, status FROM approval WHERE alert_id = $1`,
    [alert!.id],
  );
  assert.ok(approval, 'an approval was requested');
  assert.equal(approval!.proposed_action, 'SEND_ESCALATION');
  assert.equal(approval!.status, 'PENDING');

  const checkRow = await one<{ status: string; scanned: number; overdue: number }>(
    `SELECT status, scanned, overdue FROM compliance_check WHERE id = $1`,
    [result.checkId],
  );
  assert.equal(checkRow?.status, 'OK');
  assert.ok(Number(checkRow?.scanned) > 0);
});

test('approving executes the permitted action and writes the audit trail', async () => {
  const approval = await one<{ id: string; alert_id: string }>(
    `SELECT a.id, a.alert_id FROM approval a JOIN alert al ON al.id = a.alert_id
      WHERE al.obligation_id = (SELECT id FROM obligation WHERE title = 'Q3 environmental compliance return')
        AND a.status = 'PENDING'`
  );
  assert.ok(approval);

  const result = await decideApproval({ approvalId: approval!.id, actorId: approverId, decision: 'APPROVED', comment: 'Reviewed the evidence.' });
  assert.equal(result.outcome, 'EXECUTED');
  assert.ok(result.actionId);

  const action = await one<{ status: string; channel: string; simulated: unknown }>(
    `SELECT status, channel, result->>'simulated' AS simulated FROM action WHERE id = $1`,
    [result.actionId],
  );
  assert.equal(action?.status, 'EXECUTED');
  assert.equal(action?.channel, 'IN_APP');
  assert.equal(action?.simulated, 'true');

  const alert = await one<{ status: string }>(`SELECT status FROM alert WHERE id = $1`, [approval!.alert_id]);
  assert.equal(alert?.status, 'ESCALATED');

  const trail = await many<{ action: string }>(
    `SELECT action FROM audit_event WHERE entity_id IN ($1, $2) ORDER BY at`,
    [approval!.id, result.actionId],
  );
  const actions = trail.map((row) => row.action);
  assert.ok(actions.includes('approval.approved'));
  assert.ok(actions.includes('action.executed'));
});

test('a second sweep creates no duplicate alerts or runs', async () => {
  const before = await one<{ n: string }>(`SELECT count(*)::text AS n FROM alert`);
  const result = await runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  const after = await one<{ n: string }>(`SELECT count(*)::text AS n FROM alert`);
  assert.equal(result.status, 'OK');
  assert.equal(result.alertsCreated, 0);
  assert.equal(result.agentRuns, 0);
  assert.equal(after?.n, before?.n);
});

test('a rejected approval executes nothing', async () => {
  const obligationId = await addOverdueObligation('Rejected escalation fixture', 9);
  await runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  const approval = await one<{ id: string; alert_id: string }>(
    `SELECT a.id, a.alert_id FROM approval a JOIN alert al ON al.id = a.alert_id WHERE al.obligation_id = $1 AND a.status = 'PENDING'`,
    [obligationId],
  );
  assert.ok(approval);

  const result = await decideApproval({ approvalId: approval!.id, actorId: approverId, decision: 'REJECTED', comment: 'Owner has a documented extension.' });
  assert.equal(result.outcome, 'REJECTED');

  const actions = await many(`SELECT id FROM action WHERE approval_id = $1`, [approval!.id]);
  assert.equal(actions.length, 0, 'no action row for a rejected approval');

  const alert = await one<{ status: string }>(`SELECT status FROM alert WHERE id = $1`, [approval!.alert_id]);
  assert.equal(alert?.status, 'OPEN');
});

test('an approval becomes stale if the obligation changes after review, and is reassessed', async () => {
  const obligationId = await addOverdueObligation('Stale approval fixture', 20);
  await runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  const approval = await one<{ id: string }>(
    `SELECT a.id FROM approval a JOIN alert al ON al.id = a.alert_id WHERE al.obligation_id = $1 AND a.status = 'PENDING'`,
    [obligationId],
  );
  assert.ok(approval);

  // A new document arrives after the reviewer opened the case.
  await query(`UPDATE obligation SET status = 'SUBMITTED', version = version + 1, updated_at = now() WHERE id = $1`, [obligationId]);

  const result = await decideApproval({ approvalId: approval!.id, actorId: approverId, decision: 'APPROVED' });
  assert.equal(result.outcome, 'EXPIRED');
  assert.ok(result.reassessed, 'a fresh assessment is queued');

  const oldApproval = await one<{ status: string }>(`SELECT status FROM approval WHERE id = $1`, [approval!.id]);
  assert.equal(oldApproval?.status, 'EXPIRED');

  const newApproval = await one<{ id: string; status: string }>(
    `SELECT id, status FROM approval WHERE id = $1`,
    [result.reassessed!.approvalId],
  );
  assert.equal(newApproval?.status, 'PENDING');
  assert.notEqual(newApproval?.id, approval!.id);
});

test('an approval cannot be executed twice', async () => {
  const approval = await one<{ id: string }>(
    `SELECT a.id FROM approval a WHERE a.status = 'EXECUTED' LIMIT 1`
  );
  const result = await decideApproval({ approvalId: approval!.id, actorId: approverId, decision: 'APPROVED' });
  assert.equal(result.outcome, 'CONFLICT');
});

test('invalid obligation transitions are refused', async () => {
  const completed = await obligationByTitle('Final acceptance certificate');
  const result = await confirmObligationStatus({ obligationId: completed!.id, status: 'SUBMITTED', actorId: approverId });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /Cannot move/);

  const open = await obligationByTitle('Annual HSE audit');
  const completion = await confirmObligationStatus({ obligationId: open!.id, status: 'COMPLETED', actorId: approverId });
  assert.equal(completion.ok, false, 'completion requires a document when one is mandatory');
});

test('document intake validates type and stores provenance-labelled findings', async () => {
  const obligation = await obligationByTitle('Quarterly service report');
  await assert.rejects(
    ingestDocument({ obligationId: obligation!.id, filename: 'evil.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4'), userId: approverId }),
    /Only .txt and .md/,
  );

  const text = 'QUARTERLY SERVICE REPORT\nPeriod: Q3 2026\nSummary: availability held at 98 percent.\nMetrics: 41 tickets, 3 breaches.\n';
  const first = await ingestDocument({
    obligationId: obligation!.id,
    filename: 'quarterly-service-report.txt',
    mime: 'text/plain',
    buffer: Buffer.from(text),
    userId: approverId,
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.ai, 'DISABLED');

  const findings = await many<{ provenance: string; code: string }>(`SELECT provenance, code FROM document_finding WHERE document_id = $1`, [first.documentId]);
  const codes = findings.map((row) => row.code);
  assert.ok(codes.includes('WORD_COUNT'));
  assert.ok(codes.includes('SECTIONS_COMPLETE'));
  assert.ok(findings.every((row) => row.provenance === 'FACT' || row.provenance === 'RULE'), 'no AI rows when no model is configured');

  const state = await one<{ status: string }>(`SELECT status FROM obligation WHERE id = $1`, [obligation!.id]);
  assert.equal(state?.status, 'SUBMITTED', 'a submission moves the obligation to submitted');

  const second = await ingestDocument({
    obligationId: obligation!.id,
    filename: 'quarterly-service-report.txt',
    mime: 'text/plain',
    buffer: Buffer.from(text),
    userId: approverId,
  });
  assert.equal(second.duplicate, true, 'the same bytes are not assessed twice');
});

test('concurrent sweeps are serialised by the advisory lock', async () => {
  const first = runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  const second = runComplianceCheck({ trigger: 'MANUAL', actorId: complianceUserId });
  const results = await Promise.all([first, second]);
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  assert.equal(skipped.length, 1, 'one of the two concurrent runs must be skipped');
  assert.equal(skipped[0].alertsCreated, 0);
});
