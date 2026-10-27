/**
 * Administration and portfolio data-entry service.
 *
 * All functions in this module write to the database and must only be called
 * from routes that have already verified the 'manage' permission.
 *
 * Design rules:
 *  - Never expose password hashes in return values.
 *  - Every mutation records an audit event.
 *  - Destructive deletes are refused when child records exist; safe
 *    alternatives (deactivation, status changes) are offered instead.
 *  - Duplicate codes and emails are caught at the DB constraint level so a
 *    concurrent race cannot sneak through an application-level check.
 */

import { one, many, query } from './db.ts';
import { audit } from './audit.ts';
import { hashPassword } from './auth.ts';

/* =========================================================================
   User management
   ========================================================================= */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: Date;
}

export async function listUsers(): Promise<AdminUser[]> {
  return many<AdminUser>(
    `SELECT id, email, name, role, is_active, created_at
       FROM app_user
      ORDER BY name`,
  );
}

export async function getUser(id: string): Promise<AdminUser | null> {
  return one<AdminUser>(
    `SELECT id, email, name, role, is_active, created_at FROM app_user WHERE id = $1`,
    [id],
  );
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: 'EXEC' | 'COMPLIANCE' | 'ADMIN';
  password: string;
  actorId: string;
}

export interface CreateUserResult {
  ok: boolean;
  userId?: string;
  reason?: string;
}

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, reason: 'Email address is not valid.' };
  if (input.name.trim().length < 2) return { ok: false, reason: 'Name must be at least 2 characters.' };
  if (input.password.length < 12) return { ok: false, reason: 'Password must be at least 12 characters.' };

  const hash = await hashPassword(input.password);
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO app_user (email, name, role, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, input.name.trim(), input.role, hash],
    );
    const userId = row!.id;
    await audit({
      actorType: 'USER',
      actorId: input.actorId,
      action: 'user.created',
      entityType: 'app_user',
      entityId: userId,
      detail: { email, role: input.role },
    });
    return { ok: true, userId };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') return { ok: false, reason: 'An account with that email address already exists.' };
    throw err;
  }
}

export interface UpdateUserInput {
  id: string;
  name: string;
  role: 'EXEC' | 'COMPLIANCE' | 'ADMIN';
  is_active: boolean;
  actorId: string;
}

export interface UpdateUserResult {
  ok: boolean;
  reason?: string;
}

export async function updateUser(input: UpdateUserInput): Promise<UpdateUserResult> {
  if (input.name.trim().length < 2) return { ok: false, reason: 'Name must be at least 2 characters.' };

  // Self-lockout guard: cannot deactivate own account.
  if (!input.is_active && input.id === input.actorId) {
    return { ok: false, reason: 'You cannot deactivate your own account.' };
  }

  // Last-admin guard: at least one ADMIN must remain active.
  if (input.role !== 'ADMIN' || !input.is_active) {
    const adminCount = await one<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM app_user
        WHERE role = 'ADMIN' AND is_active = true AND id <> $1`,
      [input.id],
    );
    const remaining = Number(adminCount?.cnt ?? 0);
    const current = await getUser(input.id);
    if (current?.role === 'ADMIN') {
      if (remaining === 0 && (!input.is_active || input.role !== 'ADMIN')) {
        return { ok: false, reason: 'Cannot remove or deactivate the last active administrator account.' };
      }
    }
  }

  await query(
    `UPDATE app_user SET name = $2, role = $3, is_active = $4 WHERE id = $1`,
    [input.id, input.name.trim(), input.role, input.is_active],
  );
  await audit({
    actorType: 'USER',
    actorId: input.actorId,
    action: 'user.updated',
    entityType: 'app_user',
    entityId: input.id,
    detail: { name: input.name.trim(), role: input.role, is_active: input.is_active },
  });
  return { ok: true };
}

export async function setUserPassword(params: {
  userId: string;
  newPassword: string;
  actorId: string;
}): Promise<UpdateUserResult> {
  if (params.newPassword.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters.' };
  }
  const hash = await hashPassword(params.newPassword);
  await query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [params.userId, hash]);
  // Invalidate all existing sessions for this user.
  await query(`DELETE FROM session WHERE user_id = $1`, [params.userId]);
  await audit({
    actorType: 'USER',
    actorId: params.actorId,
    action: 'user.password_reset',
    entityType: 'app_user',
    entityId: params.userId,
    detail: { sessions_cleared: true },
  });
  return { ok: true };
}

/* =========================================================================
   Subsidiary management
   ========================================================================= */

export interface SubsidiaryRow {
  id: string;
  code: string;
  name: string;
  sector: string;
  description: string;
  created_at: Date;
}

export async function listSubsidiariesAdmin(): Promise<SubsidiaryRow[]> {
  return many<SubsidiaryRow>(
    `SELECT id, code, name, sector, description, created_at
       FROM subsidiary ORDER BY name`,
  );
}

export interface CreateSubsidiaryInput {
  code: string;
  name: string;
  sector: string;
  description: string;
  actorId: string;
}

export interface MutateResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export async function createSubsidiary(input: CreateSubsidiaryInput): Promise<MutateResult> {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const sector = input.sector.trim();
  if (code.length < 2 || code.length > 20) return { ok: false, reason: 'Code must be 2–20 characters.' };
  if (name.length < 2) return { ok: false, reason: 'Name is required.' };
  if (sector.length < 2) return { ok: false, reason: 'Sector is required.' };

  try {
    const row = await one<{ id: string }>(
      `INSERT INTO subsidiary (code, name, sector, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [code, name, sector, input.description.trim()],
    );
    await audit({
      actorType: 'USER', actorId: input.actorId, action: 'subsidiary.created',
      entityType: 'subsidiary', entityId: row!.id,
      detail: { code, name, sector },
    });
    return { ok: true, id: row!.id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: `A subsidiary with code ${code} already exists.` };
    throw err;
  }
}

export interface UpdateSubsidiaryInput {
  id: string;
  name: string;
  sector: string;
  description: string;
  actorId: string;
}

export async function updateSubsidiary(input: UpdateSubsidiaryInput): Promise<MutateResult> {
  const name = input.name.trim();
  const sector = input.sector.trim();
  if (name.length < 2) return { ok: false, reason: 'Name is required.' };
  if (sector.length < 2) return { ok: false, reason: 'Sector is required.' };

  const rows = await query(
    `UPDATE subsidiary SET name = $2, sector = $3, description = $4 WHERE id = $1`,
    [input.id, name, sector, input.description.trim()],
  );
  if (rows.rowCount === 0) return { ok: false, reason: 'Subsidiary not found.' };
  await audit({
    actorType: 'USER', actorId: input.actorId, action: 'subsidiary.updated',
    entityType: 'subsidiary', entityId: input.id,
    detail: { name, sector },
  });
  return { ok: true };
}

/* =========================================================================
   Project management
   ========================================================================= */

export interface ProjectAdminRow {
  id: string;
  code: string;
  name: string;
  status: string;
  budget_ngn: string | null;
  start_date: Date;
  target_date: Date | null;
  subsidiary_id: string;
  subsidiary_name: string;
  obligation_count: string;
}

export async function listProjectsAdmin(): Promise<ProjectAdminRow[]> {
  return many<ProjectAdminRow>(
    `SELECT p.id, p.code, p.name, p.status, p.budget_ngn::text,
            p.start_date, p.target_date, p.subsidiary_id, s.name AS subsidiary_name,
            (SELECT count(*) FROM obligation o WHERE o.project_id = p.id)::text AS obligation_count
       FROM project p
       JOIN subsidiary s ON s.id = p.subsidiary_id
      ORDER BY s.name, p.name`,
  );
}

export interface CreateProjectInput {
  subsidiaryId: string;
  code: string;
  name: string;
  status: string;
  budgetNgn: string;
  startDate: string;
  targetDate: string;
  actorId: string;
}

const VALID_PROJECT_STATUSES = ['ACTIVE', 'AT_RISK', 'ON_HOLD', 'COMPLETED'] as const;

export async function createProject(input: CreateProjectInput): Promise<MutateResult> {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (code.length < 2) return { ok: false, reason: 'Project code is required (minimum 2 characters).' };
  if (name.length < 2) return { ok: false, reason: 'Project name is required.' };
  if (!VALID_PROJECT_STATUSES.includes(input.status as any)) return { ok: false, reason: 'Invalid status.' };
  if (!input.startDate) return { ok: false, reason: 'Start date is required.' };

  // Validate budget: must be non-negative if provided.
  const budget = input.budgetNgn.trim() ? Number(input.budgetNgn.trim()) : null;
  if (budget !== null && (isNaN(budget) || budget < 0)) {
    return { ok: false, reason: 'Budget must be a non-negative number.' };
  }

  // Validate subsidiary exists.
  const sub = await one<{ id: string }>(
    `SELECT id FROM subsidiary WHERE id = $1`, [input.subsidiaryId],
  );
  if (!sub) return { ok: false, reason: 'Subsidiary not found.' };

  try {
    const row = await one<{ id: string }>(
      `INSERT INTO project (subsidiary_id, code, name, status, budget_ngn, start_date, target_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.subsidiaryId, code, name, input.status,
        budget,
        input.startDate,
        input.targetDate || null,
      ],
    );
    await audit({
      actorType: 'USER', actorId: input.actorId, action: 'project.created',
      entityType: 'project', entityId: row!.id,
      detail: { code, name, status: input.status, subsidiaryId: input.subsidiaryId },
    });
    return { ok: true, id: row!.id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: `A project with code ${code} already exists.` };
    throw err;
  }
}

export interface UpdateProjectInput {
  id: string;
  name: string;
  status: string;
  budgetNgn: string;
  startDate: string;
  targetDate: string;
  actorId: string;
}

export async function updateProject(input: UpdateProjectInput): Promise<MutateResult> {
  const name = input.name.trim();
  if (name.length < 2) return { ok: false, reason: 'Project name is required.' };
  if (!VALID_PROJECT_STATUSES.includes(input.status as any)) return { ok: false, reason: 'Invalid status.' };

  const budget = input.budgetNgn.trim() ? Number(input.budgetNgn.trim()) : null;
  if (budget !== null && (isNaN(budget) || budget < 0)) {
    return { ok: false, reason: 'Budget must be a non-negative number.' };
  }

  const rows = await query(
    `UPDATE project SET name=$2, status=$3, budget_ngn=$4, start_date=$5, target_date=$6, updated_at=now() WHERE id=$1`,
    [input.id, name, input.status, budget, input.startDate, input.targetDate || null],
  );
  if (rows.rowCount === 0) return { ok: false, reason: 'Project not found.' };
  await audit({
    actorType: 'USER', actorId: input.actorId, action: 'project.updated',
    entityType: 'project', entityId: input.id,
    detail: { name, status: input.status },
  });
  return { ok: true };
}

/* =========================================================================
   Obligation management
   ========================================================================= */

export interface ObligationAdminRow {
  id: string;
  title: string;
  kind: string;
  due_at: Date;
  status: string;
  owner_name: string;
  requires_document: boolean;
  project_id: string;
  project_name: string;
  subsidiary_name: string;
}

export async function listObligationsAdmin(): Promise<ObligationAdminRow[]> {
  return many<ObligationAdminRow>(
    `SELECT o.id, o.title, o.kind, o.due_at, o.status::text AS status,
            o.owner_name, o.requires_document, o.project_id,
            p.name AS project_name, s.name AS subsidiary_name
       FROM obligation o
       JOIN project p ON p.id = o.project_id
       JOIN subsidiary s ON s.id = p.subsidiary_id
      ORDER BY o.due_at ASC`,
  );
}

export interface CreateObligationInput {
  projectId: string;
  title: string;
  kind: string;
  dueAt: string;
  ownerName: string;
  requiresDocument: boolean;
  actorId: string;
}

const VALID_KINDS = ['REGULATORY', 'BOARD', 'AUDIT', 'REPORT', 'TAX', 'LICENCE'] as const;

export async function createObligation(input: CreateObligationInput): Promise<MutateResult> {
  const title = input.title.trim();
  const owner = input.ownerName.trim();
  if (title.length < 3) return { ok: false, reason: 'Title must be at least 3 characters.' };
  if (!VALID_KINDS.includes(input.kind as any)) return { ok: false, reason: 'Invalid kind.' };
  if (!input.dueAt) return { ok: false, reason: 'Due date is required.' };
  if (owner.length < 2) return { ok: false, reason: 'Owner name is required.' };

  const proj = await one<{ id: string }>(
    `SELECT id FROM project WHERE id = $1`, [input.projectId],
  );
  if (!proj) return { ok: false, reason: 'Project not found.' };

  const row = await one<{ id: string }>(
    `INSERT INTO obligation (project_id, title, kind, due_at, owner_name, requires_document)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.projectId, title, input.kind, input.dueAt, owner, input.requiresDocument],
  );
  await audit({
    actorType: 'USER', actorId: input.actorId, action: 'obligation.created',
    entityType: 'obligation', entityId: row!.id,
    detail: { title, kind: input.kind, dueAt: input.dueAt, projectId: input.projectId },
  });
  return { ok: true, id: row!.id };
}

export interface UpdateObligationInput {
  id: string;
  title: string;
  kind: string;
  dueAt: string;
  ownerName: string;
  requiresDocument: boolean;
  actorId: string;
}

export async function updateObligation(input: UpdateObligationInput): Promise<MutateResult> {
  const title = input.title.trim();
  const owner = input.ownerName.trim();
  if (title.length < 3) return { ok: false, reason: 'Title must be at least 3 characters.' };
  if (!VALID_KINDS.includes(input.kind as any)) return { ok: false, reason: 'Invalid kind.' };
  if (!input.dueAt) return { ok: false, reason: 'Due date is required.' };
  if (owner.length < 2) return { ok: false, reason: 'Owner name is required.' };

  const rows = await query(
    `UPDATE obligation
        SET title=$2, kind=$3, due_at=$4, owner_name=$5, requires_document=$6,
            version=version+1, updated_at=now()
      WHERE id=$1`,
    [input.id, title, input.kind, input.dueAt, owner, input.requiresDocument],
  );
  if (rows.rowCount === 0) return { ok: false, reason: 'Obligation not found.' };
  await audit({
    actorType: 'USER', actorId: input.actorId, action: 'obligation.updated',
    entityType: 'obligation', entityId: input.id,
    detail: { title, kind: input.kind, dueAt: input.dueAt },
  });
  return { ok: true };
}

/* =========================================================================
   Shared helpers
   ========================================================================= */

/** Fetch all subsidiaries for use in dropdowns. */
export async function subsidiarySelectorOptions(): Promise<Array<{ id: string; name: string; code: string }>> {
  return many<{ id: string; name: string; code: string }>(
    `SELECT id, name, code FROM subsidiary ORDER BY name`,
  );
}

/** Fetch all projects for use in obligation dropdowns. */
export async function projectSelectorOptions(): Promise<Array<{ id: string; name: string; code: string; subsidiary_name: string }>> {
  return many<{ id: string; name: string; code: string; subsidiary_name: string }>(
    `SELECT p.id, p.name, p.code, s.name AS subsidiary_name
       FROM project p JOIN subsidiary s ON s.id = p.subsidiary_id
      ORDER BY s.name, p.name`,
  );
}

/** Fetch project fields needed only by the edit form (start_date, target_date, budget_ngn). */
export async function getProjectDates(id: string): Promise<{ start_date: Date; target_date: Date | null; budget_ngn: string | null } | null> {
  return one<{ start_date: Date; target_date: Date | null; budget_ngn: string | null }>(
    `SELECT start_date, target_date, budget_ngn::text FROM project WHERE id = $1`, [id],
  );
}
