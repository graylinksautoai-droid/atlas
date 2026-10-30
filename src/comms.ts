/**
 * Administrator-initiated communication service.
 *
 * Manages the lifecycle of deliberate outbound communications:
 *   DRAFT → send attempt → SENT | FAILED
 *
 * Separated from the automatic critical-alert notification pipeline
 * (notify.ts). Never sends automatically; always requires explicit
 * human confirmation.
 *
 * AI drafting uses the same provider as the rest of ATLAS, and the result
 * is stored for human review before sending. The stored body is the exact
 * text that was reviewed; it is never re-generated post-send.
 */

import nodemailer from 'nodemailer';
import { one, many, query, pool as defaultPool } from './db.ts';
import { audit } from './audit.ts';
import { config, modelConfigured } from './config.ts';
import { AiUnavailable, AiInvalidOutput } from './ai.ts';
import { z } from 'zod';

/* ── Injectable overrides for tests ──────────────────────────────────────── */

type MockPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> };
let _commsPoolOverride: MockPool | null = null;
export function setCommsPoolOverride(p: MockPool | null): void { _commsPoolOverride = p; }
function getCommsPool() { return (_commsPoolOverride ?? defaultPool) as typeof defaultPool; }

type MockTransport = { sendMail: (msg: object) => Promise<{ messageId?: string }> };
let _commsTransportOverride: MockTransport | null = null;
export function setCommsTransportOverride(t: MockTransport | null): void { _commsTransportOverride = t; }

/* Pool-aware helpers (use override when set, otherwise delegate to db.ts) */
async function poolOne<T extends object>(sql: string, params: unknown[]): Promise<T | null> {
  if (!_commsPoolOverride) return one<T>(sql, params);
  const r = await _commsPoolOverride.query(sql, params);
  return (r.rows[0] as T | undefined) ?? null;
}
async function poolMany<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
  if (!_commsPoolOverride) return many<T>(sql, params);
  const r = await _commsPoolOverride.query(sql, params);
  return r.rows as T[];
}
async function poolQuery(sql: string, params: unknown[]): Promise<{ rowCount?: number }> {
  if (!_commsPoolOverride) return query(sql, params) as Promise<{ rowCount?: number }>;
  return _commsPoolOverride.query(sql, params);
}

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface CommunicationEntry {
  id: string;
  subsidiary_id: string;
  subsidiary_name: string;
  initiated_by: string;
  initiator_name: string;
  recipient_contact_id: string | null;
  recipient_name: string;
  recipient_email: string;
  subject: string;
  message_body: string;
  related_alert_id: string | null;
  related_obligation_id: string | null;
  ai_assisted: boolean;
  ai_model: string | null;
  status: 'DRAFT' | 'PENDING' | 'SENT' | 'FAILED';
  transport_message_id: string | null;
  error_message: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CommsMutateResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

/* ── Queries ────────────────────────────────────────────────────────────── */

export async function listCommunications(limit = 50): Promise<CommunicationEntry[]> {
  return poolMany<CommunicationEntry>(
    `SELECT c.id, c.subsidiary_id, s.name AS subsidiary_name,
            c.initiated_by, u.name AS initiator_name,
            c.recipient_contact_id, c.recipient_name, c.recipient_email,
            c.subject, c.message_body, c.related_alert_id, c.related_obligation_id,
            c.ai_assisted, c.ai_model, c.status::text AS status,
            c.transport_message_id, c.error_message, c.sent_at,
            c.created_at, c.updated_at
       FROM communication_log c
       JOIN subsidiary s ON s.id = c.subsidiary_id
       JOIN app_user u ON u.id = c.initiated_by
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export async function getCommunication(id: string): Promise<CommunicationEntry | null> {
  return poolOne<CommunicationEntry>(
    `SELECT c.id, c.subsidiary_id, s.name AS subsidiary_name,
            c.initiated_by, u.name AS initiator_name,
            c.recipient_contact_id, c.recipient_name, c.recipient_email,
            c.subject, c.message_body, c.related_alert_id, c.related_obligation_id,
            c.ai_assisted, c.ai_model, c.status::text AS status,
            c.transport_message_id, c.error_message, c.sent_at,
            c.created_at, c.updated_at
       FROM communication_log c
       JOIN subsidiary s ON s.id = c.subsidiary_id
       JOIN app_user u ON u.id = c.initiated_by
      WHERE c.id = $1`,
    [id],
  );
}

/* ── Draft creation ─────────────────────────────────────────────────────── */

export interface CreateDraftInput {
  subsidiaryId: string;
  recipientContactId: string;
  relatedAlertId?: string | null;
  relatedObligationId?: string | null;
  actorId: string;
}

/**
 * Create a DRAFT communication with AI-generated or deterministic body.
 * The draft is stored for human review before sending.
 */
export async function createDraft(input: CreateDraftInput): Promise<CommsMutateResult & { draft?: CommunicationEntry }> {
  // Load recipient contact
  const contact = await poolOne<{
    id: string; name: string; email: string; subsidiary_id: string; is_active: boolean;
  }>(
    `SELECT id, name, email, subsidiary_id, is_active FROM subsidiary_contact WHERE id = $1`,
    [input.recipientContactId],
  );
  if (!contact) return { ok: false, reason: 'Contact not found.' };
  if (!contact.is_active) return { ok: false, reason: 'Contact is deactivated.' };
  if (contact.subsidiary_id !== input.subsidiaryId) {
    return { ok: false, reason: 'Contact does not belong to the selected subsidiary.' };
  }

  // Load subsidiary
  const sub = await poolOne<{ id: string; name: string; sector: string }>(
    `SELECT id, name, sector FROM subsidiary WHERE id = $1`,
    [input.subsidiaryId],
  );
  if (!sub) return { ok: false, reason: 'Subsidiary not found.' };

  // Load related obligation if provided
  const obligation = input.relatedObligationId
    ? await poolOne<{ id: string; title: string; kind: string; due_at: Date; status: string; owner_name: string }>(
        `SELECT id, title, kind, due_at, status::text AS status, owner_name
           FROM obligation WHERE id = $1`,
        [input.relatedObligationId],
      )
    : null;

  // Load related alert if provided
  const alert = input.relatedAlertId
    ? await poolOne<{ id: string; type: string; severity: string; evidence_summary: string; recommended_action: string }>(
        `SELECT id, type, severity, evidence_summary, recommended_action
           FROM alert WHERE id = $1`,
        [input.relatedAlertId],
      )
    : null;

  // Build draft content — AI-assisted if configured, deterministic fallback otherwise
  let subject: string;
  let body: string;
  let aiAssisted = false;
  let aiModel: string | null = null;

  const deterministicDraft = buildDeterministicDraft(sub, contact, obligation, alert);

  if (modelConfigured && (obligation || alert)) {
    try {
      const result = await generateAiDraft(sub, contact, obligation, alert);
      subject = result.subject;
      body = result.body;
      aiAssisted = true;
      aiModel = result.model;
    } catch (err) {
      // AI failed — fall back to deterministic draft. Log the failure but don't block.
      subject = deterministicDraft.subject;
      body = deterministicDraft.body + '\n\n[Note: AI drafting was attempted but failed. This is a deterministic draft.]';
    }
  } else {
    subject = deterministicDraft.subject;
    body = deterministicDraft.body;
  }

  const row = await poolOne<{ id: string }>(
    `INSERT INTO communication_log
       (subsidiary_id, initiated_by, recipient_contact_id, recipient_name, recipient_email,
        subject, message_body, related_alert_id, related_obligation_id,
        ai_assisted, ai_model, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'DRAFT')
     RETURNING id`,
    [
      input.subsidiaryId,
      input.actorId,
      input.recipientContactId,
      contact.name,
      contact.email,
      subject,
      body,
      input.relatedAlertId ?? null,
      input.relatedObligationId ?? null,
      aiAssisted,
      aiModel,
    ],
  );

  await audit({
    actorType: 'USER',
    actorId: input.actorId,
    action: 'communication.draft.created',
    entityType: 'communication_log',
    entityId: row!.id,
    detail: {
      subsidiaryId: input.subsidiaryId,
      recipientEmail: contact.email,
      aiAssisted,
      aiModel,
    },
  });

  const draft = await getCommunication(row!.id);
  return { ok: true, id: row!.id, draft: draft ?? undefined };
}

/* ── Deterministic draft builder ─────────────────────────────────────────── */

function buildDeterministicDraft(
  sub: { name: string; sector: string },
  contact: { name: string },
  obligation: { title: string; kind: string; due_at: Date; status: string; owner_name: string } | null,
  alert: { type: string; severity: string; evidence_summary: string; recommended_action: string } | null,
): { subject: string; body: string } {
  if (obligation) {
    const daysLate = Math.max(0, Math.floor((Date.now() - obligation.due_at.getTime()) / 86_400_000));
    const subject = `${obligation.status === 'OVERDUE' ? 'Overdue' : 'Compliance'} notice: ${obligation.title} — ${sub.name}`;
    const body = [
      `Dear ${contact.name},`,
      '',
      `This is a compliance notice regarding the following obligation for ${sub.name} (${sub.sector} sector):`,
      '',
      `Obligation: ${obligation.title}`,
      `Type: ${obligation.kind}`,
      `Due date: ${obligation.due_at.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
      `Status: ${obligation.status}`,
      obligation.status === 'OVERDUE' ? `Days overdue: ${daysLate}` : '',
      `Assigned to: ${obligation.owner_name}`,
      '',
      alert ? `Alert raised: ${alert.type.replace(/_/g, ' ').toLowerCase()} (${alert.severity})` : '',
      alert ? `Evidence: ${alert.evidence_summary}` : '',
      '',
      `Required action: ${alert?.recommended_action ?? 'Please review and confirm the current status of this obligation.'}`,
      '',
      'Please respond to this notice within 5 business days.',
      '',
      'This message was generated by the ATLAS compliance monitoring platform.',
      'It does not constitute a legal notice. Please contact your compliance team for formal guidance.',
    ].filter((l) => l !== '').join('\n');
    return { subject, body };
  }

  return {
    subject: `Compliance update — ${sub.name}`,
    body: [
      `Dear ${contact.name},`,
      '',
      `Please find below an update regarding compliance matters for ${sub.name}.`,
      '',
      'This message was generated by the ATLAS compliance monitoring platform.',
    ].join('\n'),
  };
}

/* ── AI-assisted draft ──────────────────────────────────────────────────── */

const draftSchema = z.object({
  subject: z.string().min(5).max(200),
  body: z.string().min(20).max(3000),
});

async function generateAiDraft(
  sub: { name: string; sector: string },
  contact: { name: string },
  obligation: { title: string; kind: string; due_at: Date; status: string; owner_name: string } | null,
  alert: { type: string; severity: string; evidence_summary: string; recommended_action: string } | null,
): Promise<{ subject: string; body: string; model: string }> {
  const systemPrompt = `You are a compliance communications assistant for a portfolio intelligence platform.
Write professional, factual compliance notices to subsidiary contacts.
Use only the facts provided. Do not invent deadlines, amounts, names, or regulatory references.
Return JSON only with keys: subject (string, max 200 chars) and body (string, max 3000 chars).
The body should be a formal but readable email. Do not add disclaimers beyond what is appropriate.`;

  const userPrompt = JSON.stringify({
    subsidiary: { name: sub.name, sector: sub.sector },
    recipient: { name: contact.name },
    obligation: obligation
      ? {
          title: obligation.title,
          kind: obligation.kind,
          due_at: obligation.due_at.toISOString().slice(0, 10),
          status: obligation.status,
          owner_name: obligation.owner_name,
        }
      : null,
    alert: alert
      ? {
          type: alert.type,
          severity: alert.severity,
          evidence_summary: alert.evidence_summary,
          recommended_action: alert.recommended_action,
        }
      : null,
    instruction: 'Draft a professional compliance notice email for the contact based on the above data.',
  });

  const body = {
    model: config.ai.model,
    temperature: 0.1,
    max_tokens: 800,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ],
  };

  let response: Response;
  try {
    response = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ai.apiKey}`,
        'http-referer': 'https://github.com/graylinksautoai-droid/atlas',
        'x-title': 'ATLAS compliance communications',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (err) {
    throw new AiUnavailable(`Communications AI request failed: ${err instanceof Error ? err.name : 'Error'}`);
  }

  if (!response.ok) {
    throw new AiUnavailable(`AI provider returned ${response.status}`);
  }

  const payload = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string } }> };
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new AiUnavailable('AI returned empty content');

  let parsed: unknown;
  try {
    const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AiInvalidOutput('AI output was not valid JSON', content.slice(0, 400));
  }

  const validated = draftSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AiInvalidOutput('AI draft failed schema validation', JSON.stringify(parsed).slice(0, 400));
  }

  return {
    subject: validated.data.subject,
    body: validated.data.body,
    model: typeof payload.model === 'string' ? payload.model : config.ai.model,
  };
}

/* ── Update draft (review stage) ────────────────────────────────────────── */

export interface UpdateDraftInput {
  id: string;
  subject: string;
  messageBody: string;
  actorId: string;
}

export async function updateDraft(input: UpdateDraftInput): Promise<CommsMutateResult> {
  if (input.subject.trim().length < 1) return { ok: false, reason: 'Subject is required.' };
  if (input.messageBody.trim().length < 10) return { ok: false, reason: 'Message body must be at least 10 characters.' };

  const r = await poolQuery(
    `UPDATE communication_log
        SET subject = $2, message_body = $3, updated_at = now()
      WHERE id = $1 AND status = 'DRAFT'`,
    [input.id, input.subject.trim(), input.messageBody.trim()],
  );
  if ((r.rowCount ?? 0) === 0) return { ok: false, reason: 'Draft not found or already sent.' };

  await audit({
    actorType: 'USER',
    actorId: input.actorId,
    action: 'communication.draft.updated',
    entityType: 'communication_log',
    entityId: input.id,
    detail: {},
  });
  return { ok: true };
}

/* ── Send ───────────────────────────────────────────────────────────────── */

export interface SendCommunicationResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
}

export async function sendCommunication(
  id: string,
  actorId: string,
): Promise<SendCommunicationResult> {
  const comm = await poolOne<{
    id: string; status: string; subject: string; message_body: string;
    recipient_email: string; recipient_name: string;
    subsidiary_id: string; subsidiary_name: string;
  }>(
    `SELECT c.id, c.status::text, c.subject, c.message_body,
            c.recipient_email, c.recipient_name,
            c.subsidiary_id, s.name AS subsidiary_name
       FROM communication_log c
       JOIN subsidiary s ON s.id = c.subsidiary_id
      WHERE c.id = $1`,
    [id],
  );

  if (!comm) return { ok: false, reason: 'Communication not found.' };
  if (comm.status !== 'DRAFT') return { ok: false, reason: `Cannot send a communication with status ${comm.status}.` };

  // Mark PENDING before sending (idempotency guard)
  await poolQuery(
    `UPDATE communication_log SET status = 'PENDING', updated_at = now() WHERE id = $1`,
    [id],
  );

  // Load SMTP config
  const smtpHost = process.env.SMTP_HOST ?? '';
  const smtpUser = process.env.SMTP_USER ?? '';
  const smtpPass = process.env.SMTP_PASS ?? '';
  const smtpFrom = process.env.SMTP_FROM ?? smtpUser;
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpSecure = process.env.SMTP_SECURE === '1';

  // Use injected transport override if present (tests), otherwise build from SMTP config
  const transport: { sendMail: (msg: object) => Promise<{ messageId?: string }> } =
    _commsTransportOverride ?? (() => {
      if (!smtpHost || !smtpUser || !smtpPass) return null as unknown as MockTransport;
      return nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: { user: smtpUser, pass: smtpPass },
        connectionTimeout: 8_000,
        greetingTimeout: 5_000,
      });
    })();

  if (!transport) {
    await poolQuery(
      `UPDATE communication_log
          SET status = 'FAILED', error_message = $2, updated_at = now()
        WHERE id = $1`,
      [id, 'SMTP is not configured.'],
    );
    return { ok: false, reason: 'SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.' };
  }

  try {
    const info = await transport.sendMail({
      from: smtpFrom,
      to: comm.recipient_email,
      subject: comm.subject,
      text: comm.message_body,
    });

    const messageId = String(info.messageId ?? '');
    await poolQuery(
      `UPDATE communication_log
          SET status = 'SENT', transport_message_id = $2, sent_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, messageId],
    );

    await audit({
      actorType: 'USER',
      actorId,
      action: 'communication.sent',
      entityType: 'communication_log',
      entityId: id,
      detail: {
        recipientEmail: comm.recipient_email,
        subsidiaryName: comm.subsidiary_name,
        messageId,
      },
    });

    return { ok: true, messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safe = msg.replace(/\b[\w.+-]+@[\w.-]+\b/g, '[email]').slice(0, 400);

    await poolQuery(
      `UPDATE communication_log
          SET status = 'FAILED', error_message = $2, updated_at = now()
        WHERE id = $1`,
      [id, safe],
    );

    await audit({
      actorType: 'USER',
      actorId,
      action: 'communication.failed',
      entityType: 'communication_log',
      entityId: id,
      detail: { error: safe },
    });

    return { ok: false, reason: `Delivery failed: ${safe}` };
  }
}
