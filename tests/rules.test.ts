import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysOverdue, dedupeKey, severityForDueSoon, severityForOverdue, stateFingerprint, missingSections, escalationRequired } from '../src/rules.ts';
import { validateTextUpload, decodeText } from '../src/documents.ts';
import { documentAnalysisSchema, escalationDraftSchema, deterministicEscalation } from '../src/ai.ts';

test('overdue severity follows the published thresholds', () => {
  assert.equal(severityForOverdue(0), 'LOW');
  assert.equal(severityForOverdue(1), 'LOW');
  assert.equal(severityForOverdue(2), 'MEDIUM');
  assert.equal(severityForOverdue(6), 'MEDIUM');
  assert.equal(severityForOverdue(7), 'HIGH');
  assert.equal(severityForOverdue(14), 'HIGH');
  assert.equal(severityForOverdue(15), 'CRITICAL');
  assert.equal(severityForOverdue(400), 'CRITICAL');
});

test('due soon severity escalates as the deadline approaches', () => {
  assert.equal(severityForDueSoon(72), 'LOW');
  assert.equal(severityForDueSoon(48), 'MEDIUM');
  assert.equal(severityForDueSoon(24), 'HIGH');
  assert.equal(severityForDueSoon(1), 'HIGH');
});

test('days overdue never goes negative for future deadlines', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  assert.equal(daysOverdue(new Date('2026-10-27T12:00:00Z'), now), 0);
  assert.equal(daysOverdue(new Date('2026-10-25T12:00:00Z'), now), 1);
});

test('dedupe key is stable per alert type and obligation', () => {
  const id = '3f0f4a62-0000-4000-8000-000000000001';
  assert.equal(dedupeKey('OVERDUE_OBLIGATION', id), `OVERDUE_OBLIGATION:${id}`);
  assert.notEqual(dedupeKey('OVERDUE_OBLIGATION', id), dedupeKey('DUE_SOON', id));
});

test('state fingerprint changes when anything material changes', () => {
  const base = { id: 'ob-1', status: 'OPEN', due_at: new Date('2026-10-01T00:00:00Z'), version: 1, updated_at: new Date('2026-10-01T00:00:00Z') };
  const same = { ...base, updated_at: new Date('2026-10-01T00:00:00Z') };
  assert.equal(stateFingerprint(base), stateFingerprint(same));
  assert.notEqual(stateFingerprint(base), stateFingerprint({ ...base, status: 'SUBMITTED' }));
  assert.notEqual(stateFingerprint(base), stateFingerprint({ ...base, version: 2 }));
  assert.notEqual(stateFingerprint(base), stateFingerprint({ ...base, due_at: new Date('2026-10-02T00:00:00Z') }));
});

test('missing required sections are detected case insensitively', () => {
  const text = 'SCOPE: everything. Findings: none.';
  assert.deepEqual(missingSections(text, 'REGULATORY'), ['attestation']);
  assert.deepEqual(missingSections(`${text} Attestation: signed.`, 'REGULATORY'), []);
  assert.deepEqual(missingSections('anything', 'UNKNOWN_KIND'), []);
});

test('only high and critical severities require escalation', () => {
  assert.equal(escalationRequired('CRITICAL'), true);
  assert.equal(escalationRequired('HIGH'), true);
  assert.equal(escalationRequired('MEDIUM'), false);
  assert.equal(escalationRequired('LOW'), false);
});

test('upload validation rejects wrong types, empty files, and oversized files', () => {
  assert.equal(validateTextUpload({ filename: 'notes.pdf', mime: 'application/pdf', bytes: 100 }), 'Only .txt and .md submissions are accepted.');
  assert.equal(validateTextUpload({ filename: 'notes.txt', mime: 'text/plain', bytes: 0 }), 'The file is empty.');
  assert.match(String(validateTextUpload({ filename: 'notes.txt', mime: 'text/plain', bytes: 10 * 1024 * 1024 })), /exceeds/);
  assert.equal(validateTextUpload({ filename: 'notes.md', mime: 'text/markdown', bytes: 512 }), null);
});

test('decoded text strips control characters and normalises newlines', () => {
  const decoded = decodeText(Buffer.from('\uFEFFTitle\r\nBody\u0007 here\n'));
  assert.equal(decoded, 'Title\nBody  here');
});

test('document analysis schema rejects malformed model output', () => {
  const good = {
    documentType: 'Regulatory return',
    reportingPeriod: 'Q3 2026',
    summary: 'A quarterly return that omits the attestation section entirely.',
    sectionsObserved: ['scope', 'findings'],
    missingInformation: ['attestation'],
    inconsistencies: [],
    evidenceExcerpts: [{ quote: 'Findings: none.', why: 'Shows findings were addressed.' }],
    recommendedAction: 'Request the signed attestation.',
    confidence: 0.7,
  };
  assert.equal(documentAnalysisSchema.safeParse(good).success, true);
  assert.equal(documentAnalysisSchema.safeParse({ ...good, confidence: 1.4 }).success, false);
  assert.equal(documentAnalysisSchema.safeParse({ ...good, summary: 'short' }).success, false);
  assert.equal(documentAnalysisSchema.safeParse({ ...good, evidenceExcerpts: 'none' }).success, false);
});

test('escalation schema rejects a draft with no body', () => {
  const bad = { subject: 'Escalation needed', body: 'short', rationale: 'policy', confidence: 0.5 };
  assert.equal(escalationDraftSchema.safeParse(bad).success, false);
});

test('deterministic fallback is always well formed and labelled as policy text', () => {
  const draft = deterministicEscalation({
    obligationTitle: 'Fire safety certificate submission',
    projectName: 'Marina tower remediation',
    subsidiaryName: 'Kestrel Property Group',
    ownerName: 'Facilities manager',
    daysLate: 21,
    severity: 'CRITICAL',
  });
  assert.equal(escalationDraftSchema.safeParse(draft).success, true);
  assert.match(draft.body, /deterministic policy rules/);
  assert.match(draft.body, /21 day/);
});
