import type { Tx } from './db.ts';
import { pool as defaultPool } from './db.ts';

export interface AuditInput {
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  requestId?: string | null;
}

/* Pool override for test isolation — prevents test audit() calls from
 * writing real rows to a live database with fake test-fixture identifiers.
 * Call setAuditPoolOverride(null) to restore normal behaviour. */
let _auditPoolOverride: { query: (sql: string, params?: unknown[]) => Promise<unknown> } | null = null;

export function setAuditPoolOverride(
  p: { query: (sql: string, params?: unknown[]) => Promise<unknown> } | null,
): void {
  _auditPoolOverride = p;
}

function getAuditPool() {
  return (_auditPoolOverride ?? defaultPool) as typeof defaultPool;
}

/**
 * Audit rows are append only (enforced by a trigger on the table). Writes may
 * join an open transaction so a decision and its audit record commit together.
 */
export async function audit(input: AuditInput, client?: Tx): Promise<void> {
  const sql = `INSERT INTO audit_event (actor_type, actor_id, action, entity_type, entity_id, detail, request_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  const params = [
    input.actorType,
    input.actorId ?? null,
    input.action,
    input.entityType,
    input.entityId ?? null,
    JSON.stringify(input.detail ?? {}),
    input.requestId ?? null,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await getAuditPool().query(sql, params);
  }
}
