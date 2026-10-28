import { one, many, query, tx } from './db.ts';
import { audit } from './audit.ts';
import { config, modelConfigured } from './config.ts';
import { deterministicEscalation, draftEscalation, AiInvalidOutput, AiUnavailable, type EscalationDraft } from './ai.ts';
import { escalationRequired, stateFingerprint, type ObligationRow, type Severity } from './rules.ts';

export interface AlertContext {
  alertId: string;
  alertType: string;
  severity: Severity;
  evidenceSummary: string;
  recommendedAction: string;
  obligation: ObligationRow;
  daysLate: number;
  checkId?: string | null;
}

/**
 * Bounded compliance agent.
 *
 * Sequence: trigger -> evidence -> deterministic policy -> language model (optional,
 * validated) -> policy check -> approval request. The agent has no tools. It cannot
 * write to the database except through the functions in this module, and it can
 * never execute an action: only a human approval unlocks execution.
 */
export async function handleAlert(input: AlertContext): Promise<{ runId: string; approvalId: string | null; escalationRationale: string | null; escalationModel: string | null }> {
  const run = await one<{ id: string }>(
    `INSERT INTO agent_run (trigger, status, evidence, check_id, alert_id)
     VALUES ($1, 'RUNNING', $2, $3, $4) RETURNING id`,
    [
      input.checkId ? 'SCHEDULER' : 'MANUAL',
      JSON.stringify({
        alertId: input.alertId,
        alertType: input.alertType,
        severity: input.severity,
        daysLate: input.daysLate,
        obligationId: input.obligation.id,
        obligationTitle: input.obligation.title,
        dueAt: input.obligation.due_at.toISOString(),
        evidenceSummary: input.evidenceSummary,
      }),
      input.checkId ?? null,
      input.alertId,
    ],
  );
  const runId = run!.id;

  let draft: EscalationDraft;
  let model: string | null = null;
  let degraded = false;
  let note = '';

  if (modelConfigured) {
    try {
      const result = await draftEscalation({
        obligationTitle: input.obligation.title,
        projectName: input.obligation.project_name,
        subsidiaryName: input.obligation.subsidiary_name,
        ownerName: input.obligation.owner_name,
        dueAt: input.obligation.due_at,
        daysLate: input.daysLate,
        severity: input.severity,
        evidenceSummary: input.evidenceSummary,
      });
      draft = result.draft;
      model = result.model;
    } catch (error) {
      degraded = true;
      draft = deterministicEscalation({
        obligationTitle: input.obligation.title,
        projectName: input.obligation.project_name,
        subsidiaryName: input.obligation.subsidiary_name,
        ownerName: input.obligation.owner_name,
        daysLate: input.daysLate,
        severity: input.severity,
      });
      note = error instanceof AiUnavailable || error instanceof AiInvalidOutput
        ? `Model unavailable or invalid, deterministic draft used: ${error.message}`
        : 'Model unavailable, deterministic draft used.';
    }
  } else {
    degraded = true;
    draft = deterministicEscalation({
      obligationTitle: input.obligation.title,
      projectName: input.obligation.project_name,
      subsidiaryName: input.obligation.subsidiary_name,
      ownerName: input.obligation.owner_name,
      daysLate: input.daysLate,
      severity: input.severity,
    });
    note = 'No AI provider configured, deterministic draft used.';
  }

  const requiresApproval = escalationRequired(input.severity);
  let approvalId: string | null = null;

  if (requiresApproval) {
    const fingerprint = stateFingerprint({
      id: input.obligation.id,
      status: input.obligation.status,
      due_at: input.obligation.due_at,
      version: input.obligation.version,
      updated_at: input.obligation.updated_at,
    });
    const created = await tx(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO approval (alert_id, proposed_action, payload, state_fingerprint, requested_by_run)
         VALUES ($1, 'SEND_ESCALATION', $2, $3, $4)
         ON CONFLICT (alert_id) WHERE status = 'PENDING' DO NOTHING
         RETURNING id`,
        [
          input.alertId,
          JSON.stringify({
            subject: draft.subject,
            body: draft.body,
            rationale: draft.rationale,
            confidence: draft.confidence,
            channel: 'IN_APP',
            generated_by: model ?? 'deterministic-rules',
            obligation_id: input.obligation.id,
            obligation_version: input.obligation.version,
          }),
          fingerprint,
          runId,
        ],
      );
      if (inserted.rows.length === 0) return null;
      await client.query(`UPDATE alert SET status = 'ESCALATION_PENDING', updated_at = now() WHERE id = $1`, [input.alertId]);
      await audit(
        {
          actorType: 'AGENT',
          actorId: runId,
          action: 'approval.requested',
          entityType: 'approval',
          entityId: inserted.rows[0].id,
          detail: { alertId: input.alertId, severity: input.severity, generatedBy: model ?? 'deterministic-rules' },
        },
        client,
      );
      return inserted.rows[0].id;
    });
    approvalId = created;
  }

  const summary = requiresApproval
    ? `Escalation drafted for ${input.obligation.title} (${input.severity}). Human approval required before sending.`
    : `${input.obligation.title} (${input.severity}). Alert recorded, no escalation required by policy.`;

  await query(
    `UPDATE agent_run
        SET status = $2, model = $3, finished_at = now(), summary = $4,
            proposed_actions = $5, completed_actions = $6, error = $7
      WHERE id = $1`,
    [
      runId,
      degraded ? 'DEGRADED' : 'OK',
      model,
      summary,
      JSON.stringify(requiresApproval ? [{ action: 'SEND_ESCALATION', requires_approval: true, subject: draft.subject }] : []),
      JSON.stringify([]),
      note || null,
    ],
  );

  await audit({
    actorType: 'AGENT',
    actorId: runId,
    action: 'agent.run.completed',
    entityType: 'agent_run',
    entityId: runId,
    detail: { status: degraded ? 'DEGRADED' : 'OK', alertId: input.alertId, approvalId, model: model ?? 'deterministic-rules' },
  });

  return { runId, approvalId, escalationRationale: requiresApproval ? draft.rationale : null, escalationModel: degraded ? null : model };
}

export type ApprovalOutcome = 'EXECUTED' | 'REJECTED' | 'EXPIRED' | 'CONFLICT' | 'NOT_FOUND';

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  actionId?: string;
  reason?: string;
  reassessed?: { runId: string; approvalId: string | null };
}

/**
 * Executes an approved action. Two guards matter here:
 *  1. only a PENDING approval can transition, enforced with a row lock, so a double
 *     click or a retried request cannot send twice;
 *  2. the obligation state must still match the fingerprint the reviewer saw.
 */
export async function decideApproval(input: {
  approvalId: string;
  actorId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string | null;
}): Promise<ApprovalResult> {
  const result = await tx<ApprovalResult & { reassessAlertId?: string }>(async (client) => {
    const rows = await client.query<{
      id: string;
      alert_id: string;
      proposed_action: string;
      payload: { subject: string; body: string; rationale: string };
      state_fingerprint: string;
      status: string;
      obligation_id: string;
      obligation_status: string;
      obligation_version: number;
      obligation_due: Date;
      obligation_updated: Date;
      severity: string;
    }>(
      `SELECT a.id, a.alert_id, a.proposed_action, a.payload, a.state_fingerprint, a.status,
              o.id AS obligation_id, o.status::text AS obligation_status, o.version AS obligation_version,
              o.due_at AS obligation_due, o.updated_at AS obligation_updated, al.severity
         FROM approval a
         JOIN alert al ON al.id = a.alert_id
         LEFT JOIN obligation o ON o.id = al.obligation_id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [input.approvalId],
    );
    const approval = rows.rows[0];
    if (!approval) return { outcome: 'NOT_FOUND' as ApprovalOutcome };
    if (approval.status !== 'PENDING') {
      return { outcome: 'CONFLICT' as ApprovalOutcome, reason: `Approval is already ${approval.status.toLowerCase()}.` };
    }

    if (input.decision === 'REJECTED') {
      await client.query(
        `UPDATE approval SET status = 'REJECTED', decided_by = $2, decided_at = now(), comment = $3 WHERE id = $1`,
        [approval.id, input.actorId, input.comment ?? null],
      );
      await client.query(`UPDATE alert SET status = 'OPEN', updated_at = now() WHERE id = $1`, [approval.alert_id]);
      await audit(
        {
          actorType: 'USER',
          actorId: input.actorId,
          action: 'approval.rejected',
          entityType: 'approval',
          entityId: approval.id,
          detail: { alertId: approval.alert_id, comment: input.comment ?? null },
        },
        client,
      );
      return { outcome: 'REJECTED' as ApprovalOutcome };
    }

    const current = approval.obligation_id
      ? stateFingerprint({
          id: approval.obligation_id,
          status: approval.obligation_status,
          due_at: approval.obligation_due,
          version: approval.obligation_version,
          updated_at: approval.obligation_updated,
        })
      : null;

    if (!current || current !== approval.state_fingerprint) {
      await client.query(
        `UPDATE approval SET status = 'EXPIRED', decided_by = $2, decided_at = now(), comment = $3 WHERE id = $1`,
        [approval.id, input.actorId, 'State changed after review, execution refused pending reassessment.'],
      );
      await client.query(`UPDATE alert SET status = 'OPEN', updated_at = now() WHERE id = $1`, [approval.alert_id]);
      await audit(
        {
          actorType: 'USER',
          actorId: input.actorId,
          action: 'approval.expired',
          entityType: 'approval',
          entityId: approval.id,
          detail: { reason: 'state_changed', alertId: approval.alert_id },
        },
        client,
      );
      return { outcome: 'EXPIRED' as ApprovalOutcome, reason: 'Obligation state changed since review.', reassessAlertId: approval.alert_id };
    }

    // Execution. The channel is in application delivery only; nothing leaves the
    // process, and the record says so explicitly.
    const actionRow = await client.query<{ id: string }>(
      `INSERT INTO action (approval_id, alert_id, kind, channel, status, result)
       VALUES ($1, $2, $3, 'IN_APP', 'EXECUTED', $4) RETURNING id`,
      [
        approval.id,
        approval.alert_id,
        approval.proposed_action,
        JSON.stringify({
          simulated: true,
          delivered_to: 'Escalation queue, visible to COMPLIANCE and ADMIN roles',
          subject: approval.payload.subject,
          body_preview: approval.payload.body.slice(0, 240),
          external_delivery: 'none, no email or messaging integration is configured',
        }),
      ],
    );

    await client.query(
      `UPDATE approval SET status = 'EXECUTED', decided_by = $2, decided_at = now(), executed_at = now(), comment = $3 WHERE id = $1`,
      [approval.id, input.actorId, input.comment ?? null],
    );
    await audit(
      {
        actorType: 'USER',
        actorId: input.actorId,
        action: 'approval.approved',
        entityType: 'approval',
        entityId: approval.id,
        detail: { alertId: approval.alert_id, comment: input.comment ?? null },
      },
      client,
    );
    await client.query(`UPDATE alert SET status = 'ESCALATED', updated_at = now() WHERE id = $1`, [approval.alert_id]);

    await audit(
      {
        actorType: 'USER',
        actorId: input.actorId,
        action: 'action.executed',
        entityType: 'action',
        entityId: actionRow.rows[0].id,
        detail: { approvalId: approval.id, alertId: approval.alert_id, kind: approval.proposed_action, channel: 'IN_APP', simulated: true },
      },
      client,
    );
    return { outcome: 'EXECUTED' as ApprovalOutcome, actionId: actionRow.rows[0].id };
  });

  if (result.outcome === 'EXPIRED' && result.reassessAlertId) {
    const context = await loadAlertContext(result.reassessAlertId);
    if (context) {
      const rerun = await handleAlert({ ...context, checkId: null });
      return { ...result, reassessed: { runId: rerun.runId, approvalId: rerun.approvalId } };
    }
  }
  return result;
}

async function loadAlertContext(alertId: string): Promise<AlertContext | null> {
  const row = await one<ObligationRow & { alert_type: string; severity: Severity; evidence_summary: string; recommended_action: string }>(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status, o.requires_document, o.owner_name,
            o.version, o.updated_at, o.project_id, p.name AS project_name, p.subsidiary_id,
            s.name AS subsidiary_name,
            (SELECT count(*)::int FROM document d WHERE d.obligation_id = o.id) AS document_count,
            al.type AS alert_type, al.severity, al.evidence_summary, al.recommended_action
       FROM alert al
       JOIN obligation o ON o.id = al.obligation_id
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE al.id = $1`,
    [alertId],
  );
  if (!row) return null;
  return {
    alertId,
    alertType: row.alert_type,
    severity: row.severity,
    evidenceSummary: row.evidence_summary,
    recommendedAction: row.recommended_action,
    obligation: row,
    daysLate: Math.max(0, Math.floor((Date.now() - row.due_at.getTime()) / 86_400_000)),
    checkId: null,
  };
}

export async function recentRuns(limit = 25): Promise<
  Array<{
    id: string;
    trigger: string;
    status: string;
    model: string | null;
    started_at: Date;
    finished_at: Date | null;
    summary: string | null;
    alert_id: string | null;
    error: string | null;
  }>
> {
  return many(
    `SELECT id, trigger, status, model, started_at, finished_at, summary, alert_id, error
       FROM agent_run ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
}

export { config as agentConfig, modelConfigured };
