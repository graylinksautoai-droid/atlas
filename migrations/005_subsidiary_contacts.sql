-- Migration 005: Subsidiary contact management.
--
-- Records contact persons associated with a subsidiary.
-- These are external contacts (compliance officers, project managers, etc.)
-- who may receive communications from the ATLAS platform. They are distinct
-- from app_user rows, which are internal ATLAS system accounts.
--
-- An email address is required because the primary use-case is outbound
-- communication. Duplicate emails within the same subsidiary are prevented;
-- the same email may appear in different subsidiaries.

BEGIN;

CREATE TABLE IF NOT EXISTS subsidiary_contact (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subsidiary_id   uuid        NOT NULL REFERENCES subsidiary (id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (char_length(trim(name)) >= 2),
  email           text        NOT NULL CHECK (email = lower(trim(email)) AND email LIKE '%@%'),
  designation     text        NOT NULL DEFAULT '',   -- e.g. "Compliance Officer"
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      uuid        REFERENCES app_user (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One active email per subsidiary (prevent duplicate sends).
CREATE UNIQUE INDEX subsidiary_contact_active_email
  ON subsidiary_contact (subsidiary_id, lower(email))
  WHERE is_active = true;

CREATE INDEX subsidiary_contact_subsidiary_idx
  ON subsidiary_contact (subsidiary_id, is_active);

COMMIT;
