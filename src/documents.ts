import { createHash } from 'node:crypto';
import { one, query, tx } from './db.ts';
import { audit } from './audit.ts';
import { config, modelConfigured } from './config.ts';
import { missingSections } from './rules.ts';
import { analyzeDocument, AiInvalidOutput, AiUnavailable } from './ai.ts';

const PERIOD_RE = /\b(Q[1-4]\s*20\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}|FY\s*20\d{2})\b/i;

export interface IngestResult {
  documentId: string;
  duplicate: boolean;
  findings: number;
  ai: 'OK' | 'DEGRADED' | 'DISABLED';
  aiNote?: string;
  summary?: string;
}

export function validateTextUpload(input: { filename: string; mime: string; bytes: number }): string | null {
  const lower = input.filename.toLowerCase();
  const allowedExt = lower.endsWith('.txt') || lower.endsWith('.md');
  if (!allowedExt) return 'Only .txt and .md submissions are accepted.';
  if (!(config.upload.allowedMime as readonly string[]).includes(input.mime)) return `Unsupported content type ${input.mime}.`;
  if (input.bytes === 0) return 'The file is empty.';
  if (input.bytes > config.upload.maxBytes) return `The file exceeds the ${Math.round(config.upload.maxBytes / 1024)} KB limit.`;
  return null;
}

export function decodeText(buffer: Buffer): string {
  return buffer
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim();
}

export async function ingestDocument(input: {
  obligationId: string;
  filename: string;
  mime: string;
  buffer: Buffer;
  userId: string;
}): Promise<IngestResult> {
  // Type and size are checked before any parsing: the boundary comes first.
  const invalid = validateTextUpload({ filename: input.filename, mime: input.mime, bytes: input.buffer.byteLength });
  if (invalid) throw new Error(invalid);

  const text = decodeText(input.buffer);
  if (text.length < 40) throw new Error('The document is too short to assess.');

  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const obligation = await one<{
    id: string;
    title: string;
    kind: string;
    status: string;
    due_at: Date;
    version: number;
    project_name: string;
    subsidiary_name: string;
  }>(
    `SELECT o.id, o.title, o.kind, o.status::text AS status, o.due_at, o.version,
            p.name AS project_name, s.name AS subsidiary_name
       FROM obligation o
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
      WHERE o.id = $1`,
    [input.obligationId],
  );
  if (!obligation) throw new Error('Unknown obligation.');

  const existing = await one<{ id: string }>(
    `SELECT id FROM document WHERE obligation_id = $1 AND sha256 = $2`,
    [input.obligationId, sha256],
  );
  if (existing) {
    const count = await one<{ n: string }>(`SELECT count(*)::text AS n FROM document_finding WHERE document_id = $1`, [existing.id]);
    return { documentId: existing.id, duplicate: true, findings: Number(count?.n ?? 0), ai: 'DISABLED' };
  }

  const documentId = await tx(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO document (obligation_id, filename, mime, size_bytes, sha256, body_text, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.obligationId, input.filename.slice(0, 180), input.mime, input.buffer.byteLength, sha256, text, input.userId],
    );
    const id = inserted.rows[0].id;

    const facts: Array<{ code: string; label: string; detail: string; evidence?: string | null }> = [];
    const words = text.split(/\s+/).filter(Boolean).length;
    facts.push({ code: 'WORD_COUNT', label: 'Length', detail: `${words} words, ${text.length} characters.` });

    const period = text.match(PERIOD_RE)?.[0] ?? null;
    facts.push({
      code: 'REPORTING_PERIOD',
      label: 'Reporting period',
      detail: period ? `Detected ${period}.` : 'No reporting period stated in the document.',
      evidence: period,
    });

    for (const fact of facts) {
      await client.query(
        `INSERT INTO document_finding (document_id, provenance, code, label, detail, evidence_quote)
         VALUES ($1, 'FACT', $2, $3, $4, $5)`,
        [id, fact.code, fact.label, fact.detail, fact.evidence ?? null],
      );
    }

    const missing = missingSections(text, obligation.kind);
    await client.query(
      `INSERT INTO document_finding (document_id, provenance, code, label, detail)
       VALUES ($1, 'RULE', $2, $3, $4)`,
      [
        id,
        missing.length ? 'MISSING_SECTIONS' : 'SECTIONS_COMPLETE',
        missing.length ? 'Required sections missing' : 'Required sections present',
        missing.length
          ? missing.join(', ')
          : `All sections required for a ${obligation.kind.toLowerCase()} submission are present.`,
      ],
    );

    const attested = /attest|signed|prepared by|approved by/i.test(text);
    await client.query(
      `INSERT INTO document_finding (document_id, provenance, code, label, detail)
       VALUES ($1, 'RULE', $2, $3, $4)`,
      [
        id,
        attested ? 'ATTESTATION_FOUND' : 'ATTESTATION_MISSING',
        attested ? 'Attestation detected' : 'No attestation detected',
        attested ? 'The text contains an attestation or signature line.' : 'No signature, attestation, or approval line was found.',
      ],
    );

    // A submission changes obligation state, which invalidates any approval
    // request that was based on the previous state.
    if (obligation.status === 'OPEN' || obligation.status === 'OVERDUE') {
      await client.query(
        `UPDATE obligation SET status = 'SUBMITTED', version = version + 1, updated_at = now() WHERE id = $1`,
        [obligation.id],
      );
      await audit(
        {
          actorType: 'USER',
          actorId: input.userId,
          action: 'obligation.submitted',
          entityType: 'obligation',
          entityId: obligation.id,
          detail: { documentId: id, from: obligation.status },
        },
        client,
      );
    }

    await audit(
      {
        actorType: 'USER',
        actorId: input.userId,
        action: 'document.uploaded',
        entityType: 'document',
        entityId: id,
        detail: { obligationId: obligation.id, filename: input.filename, sha256, sizeBytes: input.buffer.byteLength },
      },
      client,
    );

    return id;
  });

  const findingCount = await one<{ n: string }>(`SELECT count(*)::text AS n FROM document_finding WHERE document_id = $1`, [documentId]);

  if (!modelConfigured) {
    return {
      documentId,
      duplicate: false,
      findings: Number(findingCount?.n ?? 0),
      ai: 'DISABLED',
      aiNote: 'No AI provider configured. Deterministic checks only.',
    };
  }

  const run = await one<{ id: string }>(
    `INSERT INTO agent_run (trigger, status, document_id, evidence) VALUES ('DOCUMENT', 'RUNNING', $1, $2) RETURNING id`,
    [documentId, JSON.stringify({ obligationId: obligation.id, filename: input.filename, chars: text.length })],
  );
  const runId = run!.id;

  try {
    const { analysis, model } = await analyzeDocument({
      text,
      kind: obligation.kind,
      obligationTitle: obligation.title,
      dueAt: obligation.due_at,
    });

    await tx(async (client) => {
      const add = async (provenance: string, code: string, label: string, detail: string, evidence: string | null, confidence: number | null) => {
        await client.query(
          `INSERT INTO document_finding (document_id, provenance, code, label, detail, evidence_quote, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [documentId, provenance, code, label, detail, evidence, confidence],
        );
      };

      await add('AI', 'AI_SUMMARY', 'Model summary', analysis.summary, null, analysis.confidence);
      if (analysis.documentType) {
        await add('AI', 'AI_DOCUMENT_TYPE', 'Document type', analysis.documentType, null, analysis.confidence);
      }
      if (analysis.reportingPeriod) {
        await add('AI', 'AI_PERIOD', 'Reporting period', analysis.reportingPeriod, null, analysis.confidence);
      }
      for (const observed of analysis.sectionsObserved) {
        await add('AI', 'AI_SECTION_OBSERVED', 'Section observed', observed, null, null);
      }
      for (const item of analysis.missingInformation) {
        await add('AI', 'AI_MISSING_INFO', 'Missing information', item, null, analysis.confidence);
      }
      for (const item of analysis.inconsistencies) {
        await add('AI', 'AI_INCONSISTENCY', 'Possible inconsistency', item, null, analysis.confidence);
      }
      for (const excerpt of analysis.evidenceExcerpts) {
        await add('AI', 'AI_EXCERPT', 'Evidence excerpt', excerpt.why, excerpt.quote, analysis.confidence);
      }
      await add('RECOMMENDATION', 'AI_NEXT_ACTION', 'Recommended next action', analysis.recommendedAction, null, analysis.confidence);

      await client.query(
        `UPDATE agent_run SET status = 'OK', model = $2, finished_at = now(), summary = $3,
                proposed_actions = $4, completed_actions = $5
          WHERE id = $1`,
        [
          runId,
          model,
          `Document assessed as ${analysis.documentType}, confidence ${analysis.confidence.toFixed(2)}.`,
          JSON.stringify([
            { action: 'RECORD_FINDINGS', executed: true },
            { action: 'RECOMMEND_REVIEW', detail: analysis.recommendedAction },
          ]),
          JSON.stringify([{ action: 'RECORD_FINDINGS', findings: 2 + analysis.missingInformation.length + analysis.inconsistencies.length }]),
        ],
      );
      await audit(
        {
          actorType: 'AGENT',
          actorId: runId,
          action: 'document.assessed',
          entityType: 'document',
          entityId: documentId,
          detail: { model, confidence: analysis.confidence, inconsistencies: analysis.inconsistencies.length },
        },
        client,
      );
    });

    return {
      documentId,
      duplicate: false,
      findings: Number(findingCount?.n ?? 0) + 4 + analysis.missingInformation.length + analysis.inconsistencies.length + analysis.evidenceExcerpts.length,
      ai: 'OK',
      summary: analysis.summary,
    };
  } catch (error) {
    const note = error instanceof AiUnavailable || error instanceof AiInvalidOutput
      ? error.message
      : 'Model call failed.';
    await query(
      `UPDATE agent_run SET status = 'DEGRADED', finished_at = now(), error = $2, summary = $3 WHERE id = $1`,
      [runId, note.slice(0, 500), 'Document stored and assessed with deterministic checks only.'],
    );
    await audit({
      actorType: 'AGENT',
      actorId: runId,
      action: 'document.assessment.degraded',
      entityType: 'document',
      entityId: documentId,
      detail: { error: note.slice(0, 300) },
    });
    return {
      documentId,
      duplicate: false,
      findings: Number(findingCount?.n ?? 0),
      ai: 'DEGRADED',
      aiNote: note,
    };
  }
}

export async function documentDetail(documentId: string): Promise<{
  document: {
    id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    created_at: Date;
    body_text: string;
    uploader: string | null;
    obligation_id: string;
    obligation_title: string;
    project_id: string;
    project_name: string;
    subsidiary_id: string;
    subsidiary_name: string;
  } | null;
  findings: Array<{ id: string; provenance: string; code: string; label: string; detail: string; evidence_quote: string | null; confidence: string | null }>;
}> {
  const document = await one<{
    id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    created_at: Date;
    body_text: string;
    uploader: string | null;
    obligation_id: string;
    obligation_title: string;
    project_id: string;
    project_name: string;
    subsidiary_id: string;
    subsidiary_name: string;
  }>(
    `SELECT d.id, d.filename, d.mime, d.size_bytes, d.sha256, d.created_at, d.body_text,
            u.name AS uploader, o.id AS obligation_id, o.title AS obligation_title,
            p.id AS project_id, p.name AS project_name, s.id AS subsidiary_id, s.name AS subsidiary_name
       FROM document d
       JOIN obligation o ON o.id = d.obligation_id
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
       LEFT JOIN app_user u ON u.id = d.uploaded_by
      WHERE d.id = $1`,
    [documentId],
  );
  if (!document) return { document: null, findings: [] };
  const findings = await query<{
    id: string;
    provenance: string;
    code: string;
    label: string;
    detail: string;
    evidence_quote: string | null;
    confidence: string | null;
  }>(
    `SELECT id, provenance, code, label, detail, evidence_quote, confidence::text
       FROM document_finding WHERE document_id = $1
      ORDER BY CASE provenance WHEN 'FACT' THEN 1 WHEN 'RULE' THEN 2 WHEN 'AI' THEN 3 ELSE 4 END, created_at`,
    [documentId],
  );
  return { document, findings: findings.rows };
}
