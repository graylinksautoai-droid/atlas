import { pool, closePool, tx } from '../src/db.ts';
import { hashPassword } from '../src/auth.ts';

/**
 * Seed data is entirely fictional. Dates are relative to the moment the seed
 * runs so the demonstration never goes stale: some obligations are overdue,
 * some are due soon, some are closed.
 */
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'AtlasDemo!2026';

const day = 86_400_000;
const at = (offsetDays: number, hour = 17): Date => {
  const d = new Date(Date.now() + offsetDays * day);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

interface ProjectSeed {
  code: string;
  name: string;
  status: 'ACTIVE' | 'AT_RISK' | 'ON_HOLD' | 'COMPLETED';
  budget: number;
  start: number;
  target: number;
}

interface ObligationSeed {
  project: string;
  title: string;
  kind: 'REGULATORY' | 'BOARD' | 'AUDIT' | 'REPORT' | 'TAX' | 'LICENCE';
  due: number;
  status: 'OPEN' | 'SUBMITTED' | 'OVERDUE' | 'COMPLETED' | 'WAIVED';
  owner: string;
  requiresDocument?: boolean;
  document?: { filename: string; text: string };
}

const SUBSIDIARIES = [
  {
    code: 'NGE',
    name: 'Northgate Energy',
    sector: 'Energy and infrastructure',
    description:
      'Upstream gas and captive power assets across two states. Operates under a subsidiary board and files quarterly environmental and safety returns.',
    projects: [
      { code: 'NGE-201', name: 'Gas turbine overhaul, Phase 2', status: 'ACTIVE', budget: 1_850_000_000, start: -210, target: 120 },
      { code: 'NGE-214', name: 'Solar hybrid pilot, Kaduna', status: 'AT_RISK', budget: 640_000_000, start: -150, target: 45 },
      { code: 'NGE-230', name: 'HSE recertification programme', status: 'ACTIVE', budget: 95_000_000, start: -90, target: 90 },
    ] as ProjectSeed[],
  },
  {
    code: 'KPG',
    name: 'Kestrel Property Group',
    sector: 'Property and real assets',
    description:
      'Commercial property portfolio with a mixed-use tower and three retail assets. Reports to the group investment committee each quarter.',
    projects: [
      { code: 'KPG-118', name: 'Marina tower remediation', status: 'ACTIVE', budget: 2_400_000_000, start: -300, target: 200 },
      { code: 'KPG-127', name: 'Retail portfolio revaluation', status: 'ON_HOLD', budget: 210_000_000, start: -120, target: 60 },
    ] as ProjectSeed[],
  },
  {
    code: 'SGT',
    name: 'Sahel GovTech',
    sector: 'Government technology',
    description:
      'Revenue and identity platforms delivered to state agencies. Handles personal data, so submissions are assessed against data protection requirements.',
    projects: [
      { code: 'SGT-061', name: 'State revenue platform rollout', status: 'ACTIVE', budget: 1_200_000_000, start: -240, target: 75 },
      { code: 'SGT-074', name: 'Identity verification integration', status: 'AT_RISK', budget: 480_000_000, start: -180, target: 30 },
      { code: 'SGT-052', name: 'Citizen services portal', status: 'COMPLETED', budget: 350_000_000, start: -400, target: -20 },
    ] as ProjectSeed[],
  },
];

const DPIA_TEXT = `DATA PROTECTION IMPACT ASSESSMENT
Sahel GovTech, identity verification integration

Scope
This assessment covers the biometric matching service used by the state revenue platform, including the vendor hosting environment and the retention of verification records.

Findings
The processing relies on consent captured at enrolment. Records are retained for seven years, which is longer than the retention schedule approved by the agency. Access is limited to twelve named administrators. Transfers to the vendor occur over an encrypted channel.

Prepared by the delivery team, reporting period Q3 2026.
`;

const INCIDENT_TEXT = `INCIDENT LOG SUBMISSION
Northgate Energy, gas turbine overhaul

Scope
Lost time incidents recorded on site between July and September 2026, covering contractor and employee hours.

Findings
Two recordable incidents occurred, both hand injuries during flange work. Both were closed within the reporting window. Lost time hours totalled 34 against 41 in the previous quarter.
`;

const PENTEST_TEXT = `PENETRATION TEST ATTESTATION
Sahel GovTech, revenue platform

Scope
External and internal testing of the collection portal and its administrative interface, performed over five working days.

Methodology
Black box external testing, followed by authenticated testing with a compliance analyst account. Automated scanning supplemented manual exploitation attempts.

Findings
No critical findings. Two medium findings relating to session expiry and verbose error pages were remediated before this attestation was issued.

Management response
Both medium findings were fixed and retested. A follow up test is scheduled for the next quarter.

Attested and signed by the head of information security.
`;

const OBLIGATIONS: ObligationSeed[] = [
  { project: 'NGE-201', title: 'Q3 environmental compliance return', kind: 'REGULATORY', due: -9, status: 'OPEN', owner: 'Site HSE lead' },
  { project: 'NGE-201', title: 'Board safety committee minutes', kind: 'BOARD', due: -2, status: 'OPEN', owner: 'Company secretary' },
  { project: 'NGE-201', title: 'Gas flare permit renewal', kind: 'LICENCE', due: 5, status: 'OPEN', owner: 'Regulatory affairs' },
  { project: 'NGE-214', title: 'Grid connection study submission', kind: 'REGULATORY', due: -16, status: 'OPEN', owner: 'Project engineer' },
  { project: 'NGE-214', title: 'Land use consent evidence', kind: 'LICENCE', due: 2, status: 'OPEN', owner: 'Land and permits' },
  { project: 'NGE-230', title: 'Annual HSE audit', kind: 'AUDIT', due: 21, status: 'OPEN', owner: 'Group HSE' },
  {
    project: 'NGE-230',
    title: 'Incident log submission',
    kind: 'AUDIT',
    due: -8,
    status: 'SUBMITTED',
    owner: 'Group HSE',
    document: { filename: 'incident-log-q3.txt', text: INCIDENT_TEXT },
  },
  { project: 'KPG-118', title: 'Fire safety certificate submission', kind: 'REGULATORY', due: -21, status: 'OPEN', owner: 'Facilities manager' },
  { project: 'KPG-118', title: 'Structural integrity audit report', kind: 'AUDIT', due: -4, status: 'OPEN', owner: 'Head of estates' },
  { project: 'KPG-127', title: 'Independent valuation report', kind: 'REPORT', due: 9, status: 'OPEN', owner: 'Investment analyst' },
  { project: 'SGT-061', title: 'Data protection impact assessment', kind: 'REGULATORY', due: -6, status: 'SUBMITTED', owner: 'Data protection officer', document: { filename: 'dpia-identity-verification.txt', text: DPIA_TEXT } },
  { project: 'SGT-061', title: 'Quarterly service report', kind: 'REPORT', due: 3, status: 'OPEN', owner: 'Delivery lead' },
  { project: 'SGT-061', title: 'Penetration test attestation', kind: 'AUDIT', due: -30, status: 'COMPLETED', owner: 'Head of information security', document: { filename: 'pentest-attestation.txt', text: PENTEST_TEXT } },
  { project: 'SGT-074', title: 'NDPA processing register update', kind: 'REGULATORY', due: 11, status: 'OPEN', owner: 'Data protection officer' },
  { project: 'SGT-074', title: 'Vendor security questionnaire', kind: 'AUDIT', due: -3, status: 'OPEN', owner: 'Procurement lead' },
  { project: 'SGT-052', title: 'Final acceptance certificate', kind: 'BOARD', due: -60, status: 'COMPLETED', owner: 'Programme director' },
];

function requiredSections(kind: string): string[] {
  const map: Record<string, string[]> = {
    REGULATORY: ['scope', 'findings', 'attestation'],
    AUDIT: ['scope', 'methodology', 'findings', 'management response'],
    BOARD: ['agenda', 'resolutions', 'attendance'],
    TAX: ['period', 'computation', 'payment reference'],
    REPORT: ['period', 'summary', 'metrics'],
    LICENCE: ['licence number', 'expiry', 'conditions'],
  };
  return map[kind] ?? [];
}

export async function seed(): Promise<{ obligations: number; projects: number; documents: number }> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const result = await tx(async (client) => {
    await client.query(`TRUNCATE audit_event, action, approval, alert, agent_run, compliance_check, risk,
      document_finding, document, obligation, project, subsidiary, session, app_user RESTART IDENTITY CASCADE`);

    const users: Record<string, string> = {};
    const userRows = [
      ['adaeze.okonkwo@atlas.demo', 'Adaeze Okonkwo', 'EXEC'],
      ['tunde.bello@atlas.demo', 'Tunde Bello', 'COMPLIANCE'],
      ['ifeoma.eze@atlas.demo', 'Ifeoma Eze', 'ADMIN'],
    ] as const;
    for (const [email, name, role] of userRows) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app_user (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, name, role, passwordHash],
      );
      users[role] = inserted.rows[0].id;
    }

    const subsidiaryIds: Record<string, string> = {};
    const projectIds: Record<string, string> = {};

    for (const sub of SUBSIDIARIES) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO subsidiary (code, name, sector, description) VALUES ($1, $2, $3, $4) RETURNING id`,
        [sub.code, sub.name, sub.sector, sub.description],
      );
      subsidiaryIds[sub.code] = inserted.rows[0].id;
      for (const project of sub.projects) {
        const row = await client.query<{ id: string }>(
          `INSERT INTO project (subsidiary_id, code, name, status, budget_ngn, start_date, target_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [subsidiaryIds[sub.code], project.code, project.name, project.status, project.budget, at(project.start).toISOString().slice(0, 10), at(project.target).toISOString().slice(0, 10)],
        );
        projectIds[project.code] = row.rows[0].id;
      }
    }

    let documentCount = 0;
    const obligationIds: Record<string, string> = {};

    for (const obligation of OBLIGATIONS) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO obligation (project_id, title, kind, due_at, status, owner_name, requires_document, completed_at, last_evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) RETURNING id`,
        [
          projectIds[obligation.project],
          obligation.title,
          obligation.kind,
          at(obligation.due),
          obligation.status,
          obligation.owner,
          obligation.requiresDocument ?? true,
          obligation.status === 'COMPLETED' ? at(obligation.due - 1) : null,
        ],
      );
      const obligationId = inserted.rows[0].id;
      obligationIds[obligation.title] = obligationId;

      if (obligation.document) {
        const text = obligation.document.text.trim();
        const sha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
        const doc = await client.query<{ id: string }>(
          `INSERT INTO document (obligation_id, filename, mime, size_bytes, sha256, body_text, uploaded_by)
           VALUES ($1, $2, 'text/plain', $3, $4, $5, $6) RETURNING id`,
          [obligationId, obligation.document.filename, Buffer.byteLength(text), sha, text, users.COMPLIANCE],
        );
        documentCount += 1;
        const docId = doc.rows[0].id;
        const words = text.split(/\s+/).filter(Boolean).length;
        const period = text.match(/\b(Q[1-4]\s*20\d{2})\b/)?.[0] ?? null;

        await client.query(
          `INSERT INTO document_finding (document_id, provenance, code, label, detail, evidence_quote) VALUES
             ($1, 'FACT', 'WORD_COUNT', 'Length', $2, NULL),
             ($1, 'FACT', 'REPORTING_PERIOD', 'Reporting period', $3, $4)`,
          [docId, `${words} words, ${text.length} characters.`, period ? `Detected ${period}.` : 'No reporting period stated in the document.', period],
        );

        const missing = requiredSections(obligation.kind).filter((section) => !text.toLowerCase().includes(section));
        await client.query(
          `INSERT INTO document_finding (document_id, provenance, code, label, detail) VALUES ($1, 'RULE', $2, $3, $4)`,
          [
            docId,
            missing.length ? 'MISSING_SECTIONS' : 'SECTIONS_COMPLETE',
            missing.length ? 'Required sections missing' : 'Required sections present',
            missing.length ? missing.join(', ') : `All sections required for a ${obligation.kind.toLowerCase()} submission are present.`,
          ],
        );
      }
    }

    // Risks, some linked to live obligations.
    const risks: Array<[string, string | null, string, string, string, string]> = [
      ['NGE', 'Gas flare permit renewal', 'Permit renewal could lapse before the regulator responds', 'HIGH', 'OPEN', 'Application was filed with 5 working days of headroom, which is below the 20 day service standard.'],
      ['NGE', 'Grid connection study submission', 'Grid connection study is more than two weeks late', 'CRITICAL', 'OPEN', 'The study is a precondition for commissioning the pilot and is now 16 days overdue.'],
      ['KPG', 'Fire safety certificate submission', 'Fire certificate not lodged for the tower', 'CRITICAL', 'OPEN', 'No submission has been filed three weeks after the statutory date.'],
      ['SGT', 'Data protection impact assessment', 'Retention period exceeds the approved schedule', 'HIGH', 'OPEN', 'The DPIA states seven year retention against an approved schedule that requires deletion after three years.'],
      ['SGT', 'None', 'Vendor hosting concentration in a single region', 'MEDIUM', 'OPEN', 'Two production services depend on one hosting region with no warm standby.'],
    ];
    for (const [code, obligationTitle, title, severity, status, rationale] of risks) {
      await client.query(
        `INSERT INTO risk (subsidiary_id, obligation_id, title, severity, status, rationale) VALUES ($1, $2, $3, $4, $5, $6)`,
        [subsidiaryIds[code], obligationTitle !== 'None' ? obligationIds[obligationTitle as string] ?? null : null, title, severity, status, rationale],
      );
    }

    // One historical alert with a completed approval and execution, so the
    // audit trail is not empty before the first live sweep.
    const historicalAlert = await client.query<{ id: string }>(
      `INSERT INTO alert (type, severity, subsidiary_id, obligation_id, dedupe_key, evidence_summary, recommended_action, status, created_at)
       VALUES ('OVERDUE_OBLIGATION', 'HIGH', $1, $2, $3, $4, $5, 'ESCALATED', now() - interval '3 days') RETURNING id`,
      [
        subsidiaryIds.KPG,
        obligationIds['Structural integrity audit report'],
        `OVERDUE_OBLIGATION:${obligationIds['Structural integrity audit report']}`,
        'Structural integrity audit report for Marina tower remediation was 4 days overdue at the time of the sweep.',
        'Escalate to the head of estates with a dated recovery plan.',
      ],
    );
    const runRow = await client.query<{ id: string }>(
      `INSERT INTO agent_run (trigger, status, model, started_at, finished_at, summary, evidence, proposed_actions, completed_actions, alert_id)
       VALUES ('SCHEDULER', 'DEGRADED', NULL, now() - interval '3 days', now() - interval '3 days' + interval '2 seconds',
               'Escalation drafted for the structural integrity audit. Human approval required before sending.',
               $1, $2, '[]', $3) RETURNING id`,
      [
        JSON.stringify({ obligationTitle: 'Structural integrity audit report', severity: 'HIGH', daysLate: 4 }),
        JSON.stringify([{ action: 'SEND_ESCALATION', requires_approval: true }]),
        historicalAlert.rows[0].id,
      ],
    );
    const approvalRow = await client.query<{ id: string }>(
      `INSERT INTO approval (alert_id, proposed_action, payload, state_fingerprint, status, requested_by_run, decided_by, decided_at, executed_at, created_at)
       VALUES ($1, 'SEND_ESCALATION', $2, $3, 'EXECUTED', $4, $5, now() - interval '2 days', now() - interval '2 days', now() - interval '3 days')
       RETURNING id`,
      [
        historicalAlert.rows[0].id,
        JSON.stringify({
          subject: 'Escalation: structural integrity audit report is 4 days overdue',
          body: 'The structural integrity audit report for Marina tower remediation was due four days ago and remains outstanding. Please provide the report or a dated recovery plan.',
          rationale: 'Policy requires escalation for HIGH and CRITICAL overdue obligations.',
          channel: 'IN_APP',
          generated_by: 'deterministic-rules',
          confidence: 1,
        }),
        'seed-fingerprint',
        runRow.rows[0].id,
        users.COMPLIANCE,
      ],
    );
    await client.query(
      `INSERT INTO action (approval_id, alert_id, kind, channel, status, result, executed_at)
       VALUES ($1, $2, 'SEND_ESCALATION', 'IN_APP', 'EXECUTED', $3, now() - interval '2 days')`,
      [
        approvalRow.rows[0].id,
        historicalAlert.rows[0].id,
        JSON.stringify({ simulated: true, delivered_to: 'Escalation queue', subject: 'Escalation: structural integrity audit report is 4 days overdue', external_delivery: 'none, no email or messaging integration is configured' }),
      ],
    );

    // A second, unresolved low severity alert to show a different state.
    await client.query(
      `INSERT INTO alert (type, severity, subsidiary_id, obligation_id, dedupe_key, evidence_summary, recommended_action, status, created_at)
       VALUES ('DUE_SOON', 'LOW', $1, $2, $3, $4, $5, 'OPEN', now() - interval '1 day')`,
      [
        subsidiaryIds.NGE,
        obligationIds['Land use consent evidence'],
        `DUE_SOON:${obligationIds['Land use consent evidence']}`,
        'Land use consent evidence for the Kaduna solar pilot is due within 72 hours.',
        'Confirm the owner has everything needed to file on time.',
      ],
    );

    await client.query(
      `INSERT INTO compliance_check (trigger, status, started_at, finished_at, scanned, overdue, alerts_created)
       VALUES ('SCHEDULER', 'OK', now() - interval '3 days', now() - interval '3 days' + interval '900 milliseconds', 16, 4, 1),
              ('MANUAL', 'OK', now() - interval '1 day', now() - interval '1 day' + interval '700 milliseconds', 16, 4, 1)`,
    );

    const auditEvents: Array<[string, string, string, string, string, Record<string, unknown>]> = [
      ['SYSTEM', 'seed.completed', 'portfolio', 'demo', 'Seed data loaded with relative dates.', {}],
      ['AGENT', 'agent.run.completed', 'agent_run', runRow.rows[0].id, 'Escalation drafted, approval requested.', { status: 'DEGRADED', model: 'deterministic-rules' }],
      ['USER', 'approval.decided', 'approval', approvalRow.rows[0].id, 'Escalation approved by compliance reviewer.', { decision: 'APPROVED' }],
      ['SYSTEM', 'action.executed', 'action', approvalRow.rows[0].id, 'Escalation recorded in the application queue.', { simulated: true }],
    ];
    for (const [actorType, action, entityType, entityId, summary, detail] of auditEvents) {
      await client.query(
        `INSERT INTO audit_event (actor_type, actor_id, action, entity_type, entity_id, detail, at)
         VALUES ($1, NULL, $2, $3, $4, $5, now() - interval '2 days')`,
        [actorType, action, entityType, entityId, JSON.stringify({ ...detail, note: summary })],
      );
    }

    return { obligations: OBLIGATIONS.length, projects: Object.keys(projectIds).length, documents: documentCount };
  });

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((summary) => console.log(`seeded: ${summary.projects} projects, ${summary.obligations} obligations, ${summary.documents} documents`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

export { pool };
