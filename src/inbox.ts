/**
 * In-app notification service (inbox).
 *
 * Creates, queries, and marks-read per-user in-app notifications.
 * Separate from the outbound SMTP pipeline (notify.ts).
 *
 * Design:
 *  - recipient_user_id = specific user, or NULL for ADMIN broadcast.
 *  - dedupe_key prevents duplicate notifications per (key, recipient).
 *  - Notifications are never deleted — only marked read.
 *  - Unread count is per-user: NULLrecipient rows count for ADMIN only.
 */

import { one, many, query, pool as defaultPool } from './db.ts';

/* Injectable pool for tests — same pattern as notify.ts */
let _poolOverride: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> } | null = null;
export function setInboxPoolOverride(p: typeof _poolOverride): void { _poolOverride = p; }
function getPool() { return (_poolOverride ?? defaultPool) as typeof defaultPool; }

export interface InAppNotification {
  id: string;
  recipient_user_id: string | null;
  dedupe_key: string;
  type: string;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

export type NotificationType =
  | 'CRITICAL_ALERT'
  | 'HIGH_ALERT'
  | 'OVERDUE_OBLIGATION'
  | 'SCHEDULE_RISK'
  | 'COMMUNICATION_SENT'
  | 'SYSTEM';

export interface CreateNotificationInput {
  recipientUserId: string | null;  // null = broadcast to all ADMINs
  dedupeKey: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  link?: string;
}

/**
 * Create an in-app notification, skipping silently if a duplicate exists.
 * Returns the notification ID, or null if deduplicated.
 */
export async function createNotification(input: CreateNotificationInput): Promise<string | null> {
  const pool = getPool();
  try {
    const r = await pool.query(
      `INSERT INTO in_app_notification
         (recipient_user_id, dedupe_key, type, title, message, entity_type, entity_id, link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key, COALESCE(recipient_user_id::text, 'BROADCAST'))
       DO NOTHING
       RETURNING id`,
      [
        input.recipientUserId ?? null,
        input.dedupeKey,
        input.type,
        input.title.slice(0, 200),
        input.message.slice(0, 1000),
        input.entityType ?? null,
        input.entityId ?? null,
        input.link ?? null,
      ],
    );
    const rows = r.rows as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null; // Never block the caller
  }
}

/**
 * Create broadcast notifications for all active ADMIN users.
 * Useful for system-wide events that all admins should see.
 * Deduplication is per-(dedupeKey, user), so each admin gets at most one.
 */
export async function createBroadcastNotification(
  input: Omit<CreateNotificationInput, 'recipientUserId'>,
  adminUserIds: string[],
): Promise<void> {
  await Promise.all(
    adminUserIds.map((uid) =>
      createNotification({ ...input, recipientUserId: uid }),
    ),
  );
}

/** List notifications visible to a specific user, newest first. */
export async function listNotificationsForUser(
  userId: string,
  role: string,
  limit = 40,
): Promise<InAppNotification[]> {
  const pool = getPool();
  // ADMIN users see their own notifications
  // Non-admin users see only their own notifications
  const r = await pool.query(
    `SELECT id, recipient_user_id, dedupe_key, type, title, message,
            entity_type, entity_id, link, read_at, created_at
       FROM in_app_notification
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return r.rows as InAppNotification[];
}

/** Count unread notifications for a user. */
export async function countUnread(userId: string): Promise<number> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT count(*)::text AS n
       FROM in_app_notification
      WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return Number((r.rows[0] as { n: string } | undefined)?.n ?? 0);
}

/** Mark a single notification as read (only if owned by the user). */
export async function markRead(notificationId: string, userId: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(
    `UPDATE in_app_notification
        SET read_at = now()
      WHERE id = $1
        AND recipient_user_id = $2
        AND read_at IS NULL`,
    [notificationId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Mark all unread notifications as read for a user. */
export async function markAllRead(userId: string): Promise<number> {
  const pool = getPool();
  const r = await pool.query(
    `UPDATE in_app_notification
        SET read_at = now()
      WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return r.rowCount ?? 0;
}
