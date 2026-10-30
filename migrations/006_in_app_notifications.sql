-- Migration 006: Per-user in-app notification centre.
--
-- Stores notifications visible to individual users inside the ATLAS interface.
-- Separate from the outbound SMTP delivery log (critical_notification_log).
--
-- Design decisions:
-- * recipient_user_id NULL means the notification is visible to all ADMIN users
--   (broadcast for system-wide events). Non-null restricts to one user.
-- * dedupe_key prevents creating duplicate notifications for the same event
--   per recipient. Format: <type>:<entity_id>[:<user_id>] — caller defines.
-- * entity_type / entity_id provide a structured link to the source record
--   so the UI can render a direct link.
-- * Append-only: no deletes — notifications are dismissed, not deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS in_app_notification (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid       REFERENCES app_user (id) ON DELETE CASCADE,
                               -- NULL = broadcast to all ADMIN users
  dedupe_key       text        NOT NULL,
  type             text        NOT NULL
                   CHECK (type IN (
                     'CRITICAL_ALERT',
                     'HIGH_ALERT',
                     'OVERDUE_OBLIGATION',
                     'SCHEDULE_RISK',
                     'COMMUNICATION_SENT',
                     'SYSTEM'
                   )),
  title            text        NOT NULL CHECK (char_length(trim(title)) >= 1),
  message          text        NOT NULL DEFAULT '',
  entity_type      text,                -- e.g. 'alert', 'obligation', 'communication'
  entity_id        text,                -- UUID of the linked record
  link             text,                -- relative URL, e.g. /alerts/<id>
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One notification per (dedupe_key, recipient) — prevents flood on re-runs.
CREATE UNIQUE INDEX in_app_notification_dedup
  ON in_app_notification (dedupe_key, COALESCE(recipient_user_id::text, 'BROADCAST'));

-- Fast unread-count queries (only unread rows).
CREATE INDEX in_app_notification_unread_idx
  ON in_app_notification (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX in_app_notification_user_idx
  ON in_app_notification (recipient_user_id, created_at DESC);

COMMIT;
