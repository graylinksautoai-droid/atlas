import { one, tx } from './db.ts';
import { audit } from './audit.ts';

export type ObligationStatus = 'OPEN' | 'SUBMITTED' | 'OVERDUE' | 'COMPLETED' | 'WAIVED';

const ALLOWED: Record<ObligationStatus, ObligationStatus[]> = {
  OPEN: ['COMPLETED', 'WAIVED', 'OVERDUE'],
  OVERDUE: ['COMPLETED', 'WAIVED', 'SUBMITTED', 'OPEN'],
  SUBMITTED: ['COMPLETED', 'WAIVED', 'OPEN', 'OVERDUE'],
  COMPLETED: ['OPEN'],
  WAIVED: ['OPEN'],
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  status?: string;
}

/**
 * All obligation state changes go through here. Invalid transitions are refused
 * rather than silently applied, and every accepted change is audited.
 */
export async function confirmObligationStatus(input: {
  obligationId: string;
  status: string;
  actorId: string;
}): Promise<TransitionResult> {
  const target = input.status as ObligationStatus;
  if (!ALLOWED[target]) return { ok: false, reason: 'Unknown obligation status.' };

  return tx(async (client) => {
    const row = await client.query<{
      id: string;
      status: ObligationStatus;
      requires_document: boolean;
      documents: string;
      title: string;
    }>(
      `SELECT o.id, o.status::text AS status, o.requires_document, o.title,
              (SELECT count(*)::text FROM document d WHERE d.obligation_id = o.id) AS documents
         FROM obligation o WHERE o.id = $1 FOR UPDATE`,
      [input.obligationId],
    );
    const obligation = row.rows[0];
    if (!obligation) return { ok: false, reason: 'Obligation not found.' };
    if (!ALLOWED[obligation.status].includes(target)) {
      return { ok: false, reason: `Cannot move an obligation from ${obligation.status} to ${target}.` };
    }
    if (target === 'COMPLETED' && obligation.requires_document && Number(obligation.documents) === 0) {
      return { ok: false, reason: 'This obligation requires a submitted document before it can be marked complete.' };
    }

    await client.query(
      `UPDATE obligation
          SET status = $2::text,
              completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE NULL END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [obligation.id, target],
    );

    if (target === 'COMPLETED' || target === 'WAIVED') {
      await client.query(
        `UPDATE alert SET status = 'RESOLVED', updated_at = now()
          WHERE obligation_id = $1 AND status NOT IN ('RESOLVED', 'DISMISSED')`,
        [obligation.id],
      );
      await client.query(
        `UPDATE risk SET status = 'MITIGATED', updated_at = now()
          WHERE obligation_id = $1 AND status = 'OPEN'`,
        [obligation.id],
      );
      await client.query(
        `UPDATE approval SET status = 'EXPIRED', decided_at = now(), comment = 'Obligation closed while approval was pending.'
          WHERE alert_id IN (SELECT id FROM alert WHERE obligation_id = $1) AND status = 'PENDING'`,
        [obligation.id],
      );
    }

    await audit(
      {
        actorType: 'USER',
        actorId: input.actorId,
        action: 'obligation.status.changed',
        entityType: 'obligation',
        entityId: obligation.id,
        detail: { from: obligation.status, to: target },
      },
      client,
    );

    return { ok: true, status: target };
  });
}

export async function obligationState(obligationId: string): Promise<{ status: string; documents: number } | null> {
  const row = await one<{ status: string; documents: string }>(
    `SELECT o.status::text AS status,
            (SELECT count(*)::text FROM document d WHERE d.obligation_id = o.id) AS documents
       FROM obligation o WHERE o.id = $1`,
    [obligationId],
  );
  return row ? { status: row.status, documents: Number(row.documents) } : null;
}
