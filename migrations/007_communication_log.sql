-- Migration 007: Administrator-initiated communication log.
--
-- Records outbound communications initiated by ATLAS administrators —
-- distinct from automatic critical-alert notifications (critical_notification_log).
-- These are deliberate, human-reviewed messages directed at subsidiary contacts.
--
-- Lifecycle: DRAFT → PENDING (transport attempted) → SENT | FAILED
-- A DRAFT row exists before sending, enabling review.
-- The message_body is stored so the exact text that was reviewed and sent
-- is preserved; it is never re-generated after sending.

BEGIN;

CREATE TABLE IF NOT EXISTS communication_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subsidiary_id   uuid        NOT NULL REFERENCES subsidiary (id) ON DELETE RESTRICT,
  initiated_by    uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,

  -- Recipient is a subsidiary_contact (required for actual send).
  -- Stored as a text snapshot so the log survives contact deletion.
  recipient_contact_id  uuid  REFERENCES subsidiary_contact (id) ON DELETE SET NULL,
  recipient_name        text  NOT NULL,
  recipient_email       text  NOT NULL,

  -- Subject and body are the exact reviewed text.
  subject         text        NOT NULL CHECK (char_length(trim(subject)) >= 1),
  message_body    text        NOT NULL,

  -- Optional link to the triggering entity.
  related_alert_id      uuid  REFERENCES alert (id) ON DELETE SET NULL,
  related_obligation_id uuid  REFERENCES obligation (id) ON DELETE SET NULL,

  -- Was the body AI-assisted or fully deterministic?
  ai_assisted     boolean     NOT NULL DEFAULT false,
  ai_model        text,

  status          text        NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'PENDING', 'SENT', 'FAILED')),
  transport_message_id  text,        -- SMTP message-id if sent
  error_message         text,        -- sanitised error on failure
  sent_at               timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX communication_log_subsidiary_idx
  ON communication_log (subsidiary_id, created_at DESC);

CREATE INDEX communication_log_initiator_idx
  ON communication_log (initiated_by, created_at DESC);

CREATE INDEX communication_log_status_idx
  ON communication_log (status, created_at DESC);

COMMIT;
