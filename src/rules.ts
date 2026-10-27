import { createHash } from 'node:crypto';

export type ObligationState = 'OPEN' | 'SUBMITTED' | 'OVERDUE' | 'COMPLETED' | 'WAIVED';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertType =
  | 'OVERDUE_OBLIGATION'
  | 'DUE_SOON'
  | 'MISSING_DOCUMENT'
  | 'DOCUMENT_INCONSISTENCY'
  | 'AT_RISK_SCHEDULE';

export interface ObligationRow {
  id: string;
  title: string;
  kind: string;
  due_at: Date;
  status: ObligationState;
  requires_document: boolean;
  owner_name: string;
  version: number;
  updated_at: Date;
  project_id: string;
  project_name: string;
  subsidiary_id: string;
  subsidiary_name: string;
  document_count: number;
}

const DAY = 86_400_000;

export function daysOverdue(dueAt: Date, now: Date): number {
  const diff = now.getTime() - dueAt.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / DAY);
}

export function hoursUntil(dueAt: Date, now: Date): number {
  return Math.floor((dueAt.getTime() - now.getTime()) / 3_600_000);
}

/**
 * Severity is a policy decision, not a model output. These thresholds are
 * deterministic, testable, and the only place overdue risk is graded.
 */
export function severityForOverdue(days: number): Severity {
  if (days >= 15) return 'CRITICAL';
  if (days >= 7) return 'HIGH';
  if (days >= 2) return 'MEDIUM';
  return 'LOW';
}

export function severityForDueSoon(hours: number): Severity {
  if (hours <= 24) return 'HIGH';
  if (hours <= 48) return 'MEDIUM';
  return 'LOW';
}

/**
 * One active alert per obligation and condition type. The alert table enforces
 * this with a partial unique index, so re-running the check cannot duplicate.
 */
export function dedupeKey(type: AlertType, obligationId: string): string {
  return `${type}:${obligationId}`;
}

/**
 * The fingerprint binds an approval to the exact obligation state the reviewer
 * saw. If the row changes after approval, execution is refused and the case is
 * re-assessed instead of acting on stale evidence.
 */
export function stateFingerprint(row: { id: string; status: string; due_at: Date; version: number; updated_at: Date }): string {
  const material = [row.id, row.status, row.due_at.toISOString(), String(row.version), row.updated_at.toISOString()].join('|');
  return createHash('sha256').update(material).digest('hex');
}

export function escalationRequired(severity: Severity): boolean {
  return severity === 'HIGH' || severity === 'CRITICAL';
}

/**
 * Severity for a project that has passed its target_date.
 * Based on how many days past target, regardless of obligation status.
 */
export function severityForScheduleRisk(daysLate: number): Severity {
  if (daysLate >= 60) return 'CRITICAL';
  if (daysLate >= 14) return 'HIGH';
  if (daysLate >= 3)  return 'MEDIUM';
  return 'LOW';
}

/**
 * Dedupe key for project schedule risk alerts.
 * Uses project_id, not obligation_id, since these are project-level.
 */
export function scheduleDedupeKey(projectId: string): string {
  return `AT_RISK_SCHEDULE:${projectId}`;
}

/** Sections a submission of each kind must contain to count as complete. */
export const REQUIRED_SECTIONS: Record<string, string[]> = {
  REGULATORY: ['scope', 'findings', 'attestation'],
  AUDIT: ['scope', 'methodology', 'findings', 'management response'],
  BOARD: ['agenda', 'resolutions', 'attendance'],
  TAX: ['period', 'computation', 'payment reference'],
  REPORT: ['period', 'summary', 'metrics'],
  LICENCE: ['licence number', 'expiry', 'conditions'],
};

export function missingSections(text: string, kind: string): string[] {
  const sections = REQUIRED_SECTIONS[kind] ?? [];
  const lower = text.toLowerCase();
  return sections.filter((section) => !lower.includes(section));
}
