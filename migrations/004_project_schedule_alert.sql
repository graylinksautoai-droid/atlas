-- Migration 004: Extend alert types to include project schedule risk.
--
-- The compliance engine can now raise AT_RISK_SCHEDULE alerts when a project
-- has passed its target_date with status still ACTIVE or AT_RISK.
-- A new dedupe_key format is used: AT_RISK_SCHEDULE:<project_id>.
--
-- The alert.obligation_id is deliberately nullable (already was), so these
-- project-level alerts can exist without an obligation FK.
-- A project_id column is added so project-level alerts can be traced back.

BEGIN;

-- Widen the alert.type CHECK constraint to include the new value.
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_type_check;
ALTER TABLE alert ADD CONSTRAINT alert_type_check
  CHECK (type IN (
    'OVERDUE_OBLIGATION',
    'DUE_SOON',
    'MISSING_DOCUMENT',
    'DOCUMENT_INCONSISTENCY',
    'AT_RISK_SCHEDULE'
  ));

-- Add an optional project FK for project-level alerts.
ALTER TABLE alert ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES project (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS alert_project_idx ON alert (project_id);

COMMIT;
