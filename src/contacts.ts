/**
 * Subsidiary contact management.
 *
 * Contacts are external persons (compliance officers, project managers, etc.)
 * associated with a subsidiary. They are distinct from app_user rows and are
 * intended recipients for administrator-initiated communications.
 *
 * All mutations require ADMIN role — enforced at the route layer.
 * Service functions validate inputs and record audit events.
 */

import { one, many, query } from './db.ts';
import { audit } from './audit.ts';

export interface SubsidiaryContact {
  id: string;
  subsidiary_id: string;
  subsidiary_name: string;
  name: string;
  email: string;
  designation: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ContactMutateResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

/** List contacts for all subsidiaries (ADMIN view). */
export async function listAllContacts(): Promise<SubsidiaryContact[]> {
  return many<SubsidiaryContact>(
    `SELECT c.id, c.subsidiary_id, s.name AS subsidiary_name,
            c.name, c.email, c.designation, c.is_active,
            c.created_at, c.updated_at
       FROM subsidiary_contact c
       JOIN subsidiary s ON s.id = c.subsidiary_id
      ORDER BY s.name, c.name`,
  );
}

/** List active contacts for a specific subsidiary. */
export async function listContactsForSubsidiary(subsidiaryId: string): Promise<SubsidiaryContact[]> {
  return many<SubsidiaryContact>(
    `SELECT c.id, c.subsidiary_id, s.name AS subsidiary_name,
            c.name, c.email, c.designation, c.is_active,
            c.created_at, c.updated_at
       FROM subsidiary_contact c
       JOIN subsidiary s ON s.id = c.subsidiary_id
      WHERE c.subsidiary_id = $1 AND c.is_active = true
      ORDER BY c.name`,
    [subsidiaryId],
  );
}

/** Get a single contact by ID. */
export async function getContact(id: string): Promise<SubsidiaryContact | null> {
  return one<SubsidiaryContact>(
    `SELECT c.id, c.subsidiary_id, s.name AS subsidiary_name,
            c.name, c.email, c.designation, c.is_active,
            c.created_at, c.updated_at
       FROM subsidiary_contact c
       JOIN subsidiary s ON s.id = c.subsidiary_id
      WHERE c.id = $1`,
    [id],
  );
}

export interface CreateContactInput {
  subsidiaryId: string;
  name: string;
  email: string;
  designation: string;
  actorId: string;
}

export async function createContact(input: CreateContactInput): Promise<ContactMutateResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const designation = input.designation.trim();

  if (name.length < 2) return { ok: false, reason: 'Name must be at least 2 characters.' };
  if (!email.includes('@') || email.length < 5) return { ok: false, reason: 'Enter a valid email address.' };

  // Verify subsidiary exists
  const sub = await one<{ id: string }>(`SELECT id FROM subsidiary WHERE id = $1`, [input.subsidiaryId]);
  if (!sub) return { ok: false, reason: 'Subsidiary not found.' };

  try {
    const row = await one<{ id: string }>(
      `INSERT INTO subsidiary_contact (subsidiary_id, name, email, designation, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.subsidiaryId, name, email, designation, input.actorId],
    );
    await audit({
      actorType: 'USER',
      actorId: input.actorId,
      action: 'contact.created',
      entityType: 'subsidiary_contact',
      entityId: row!.id,
      detail: { subsidiaryId: input.subsidiaryId, email },
    });
    return { ok: true, id: row!.id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, reason: 'An active contact with that email already exists for this subsidiary.' };
    }
    throw err;
  }
}

export interface UpdateContactInput {
  id: string;
  name: string;
  email: string;
  designation: string;
  is_active: boolean;
  actorId: string;
}

export async function updateContact(input: UpdateContactInput): Promise<ContactMutateResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const designation = input.designation.trim();

  if (name.length < 2) return { ok: false, reason: 'Name must be at least 2 characters.' };
  if (!email.includes('@') || email.length < 5) return { ok: false, reason: 'Enter a valid email address.' };

  try {
    const r = await query(
      `UPDATE subsidiary_contact
          SET name = $2, email = $3, designation = $4, is_active = $5, updated_at = now()
        WHERE id = $1`,
      [input.id, name, email, designation, input.is_active],
    );
    if ((r.rowCount ?? 0) === 0) return { ok: false, reason: 'Contact not found.' };
    await audit({
      actorType: 'USER',
      actorId: input.actorId,
      action: 'contact.updated',
      entityType: 'subsidiary_contact',
      entityId: input.id,
      detail: { email, is_active: input.is_active },
    });
    return { ok: true };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, reason: 'An active contact with that email already exists for this subsidiary.' };
    }
    throw err;
  }
}
