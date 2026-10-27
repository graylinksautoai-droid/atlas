-- Migration 003: Critical-alert notification delivery log.
-- Tracks outbound notification attempts so duplicates are suppressed and
-- every outcome is auditable without touching the append-only audit_event table.

BEGIN;

CREATE TABLE IF NOT EXISTS critical_notification_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id        uuid        NOT NULL REFERENCES alert (id) ON DELETE CASCADE,
  recipient_group text        NOT NULL,          -- opaque label, not an email address
  status          text        NOT NULL
                  CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  error_message   text,                          -- safe diagnostic; no credentials
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

-- One pending or sent record per (alert, group). Prevents duplicates on retry.
CREATE UNIQUE INDEX critical_notification_dedup
  ON critical_notification_log (alert_id, recipient_group)
  WHERE status IN ('PENDING', 'SENT');

CREATE INDEX critical_notification_alert_idx
  ON critical_notification_log (alert_id);

COMMIT;
