-- ATLAS schema, migration 001.
-- Conventions: UTC timestamptz everywhere, money in numeric(16,2), no soft deletes,
-- enums expressed as CHECK constraints so the schema stays portable and migration diffs stay readable.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN ('EXEC', 'COMPLIANCE', 'ADMIN')),
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX app_user_email_key ON app_user (email);

CREATE TABLE session (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expiry_idx ON session (expires_at);

CREATE TABLE subsidiary (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  sector      text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subsidiary_code_key ON subsidiary (upper(code));

CREATE TABLE project (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subsidiary_id  uuid NOT NULL REFERENCES subsidiary (id) ON DELETE RESTRICT,
  code           text NOT NULL,
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'AT_RISK', 'ON_HOLD', 'COMPLETED')),
  budget_ngn     numeric(16, 2) CHECK (budget_ngn IS NULL OR budget_ngn >= 0),
  start_date     date NOT NULL,
  target_date    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_code_key ON project (code);
CREATE INDEX project_subsidiary_idx ON project (subsidiary_id, status);

CREATE TABLE obligation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  title             text NOT NULL,
  kind              text NOT NULL
                    CHECK (kind IN ('REGULATORY', 'BOARD', 'AUDIT', 'REPORT', 'TAX', 'LICENCE')),
  due_at            timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'SUBMITTED', 'OVERDUE', 'COMPLETED', 'WAIVED')),
  owner_name        text NOT NULL,
  requires_document boolean NOT NULL DEFAULT true,
  completed_at      timestamptz,
  last_evaluated_at timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_completed_at_check
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX obligation_due_idx ON obligation (status, due_at);
CREATE INDEX obligation_project_idx ON obligation (project_id);

CREATE TABLE document (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  uuid NOT NULL REFERENCES obligation (id) ON DELETE CASCADE,
  filename       text NOT NULL,
  mime           text NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  sha256         char(64) NOT NULL,
  body_text      text NOT NULL,
  uploaded_by    uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_dedupe_key ON document (obligation_id, sha256);
CREATE INDEX document_obligation_idx ON document (obligation_id, created_at DESC);

CREATE TABLE document_finding (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  provenance     text NOT NULL CHECK (provenance IN ('FACT', 'RULE', 'AI', 'RECOMMENDATION')),
  code           text NOT NULL,
  label          text NOT NULL,
  detail         text NOT NULL,
  evidence_quote text,
  confidence     numeric(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_finding_document_idx ON document_finding (document_id);

CREATE TABLE compliance_check (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger         text NOT NULL CHECK (trigger IN ('SCHEDULER', 'MANUAL')),
  status          text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'FAILED')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  scanned         integer NOT NULL DEFAULT 0,
  overdue         integer NOT NULL DEFAULT 0,
  alerts_created  integer NOT NULL DEFAULT 0,
  error           text
);
CREATE INDEX compliance_check_started_idx ON compliance_check (started_at DESC);

CREATE TABLE agent_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger           text NOT NULL CHECK (trigger IN ('SCHEDULER', 'MANUAL', 'DOCUMENT')),
  status            text NOT NULL DEFAULT 'RUNNING'
                    CHECK (status IN ('RUNNING', 'OK', 'DEGRADED', 'FAILED')),
  model             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  summary           text,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_actions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  check_id          uuid REFERENCES compliance_check (id) ON DELETE SET NULL,
  alert_id          uuid,
  document_id       uuid REFERENCES document (id) ON DELETE SET NULL
);
CREATE INDEX agent_run_started_idx ON agent_run (started_at DESC);
CREATE INDEX agent_run_check_idx ON agent_run (check_id);

CREATE TABLE alert (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               text NOT NULL
                     CHECK (type IN ('OVERDUE_OBLIGATION', 'DUE_SOON', 'MISSING_DOCUMENT', 'DOCUMENT_INCONSISTENCY')),
  severity           text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  subsidiary_id      uuid NOT NULL REFERENCES subsidiary (id) ON DELETE CASCADE,
  obligation_id      uuid REFERENCES obligation (id) ON DELETE CASCADE,
  dedupe_key         text NOT NULL,
  evidence_summary   text NOT NULL,
  recommended_action text NOT NULL,
  status             text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'ESCALATION_PENDING', 'ESCALATED', 'RESOLVED', 'DISMISSED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- One active alert per unresolved condition. Resolved and dismissed alerts stay
-- in history, so a recurring problem can raise a fresh alert later.
CREATE UNIQUE INDEX alert_active_dedupe_key ON alert (dedupe_key)
  WHERE status NOT IN ('RESOLVED', 'DISMISSED');
CREATE INDEX alert_status_idx ON alert (status, severity, created_at DESC);
CREATE INDEX alert_obligation_idx ON alert (obligation_id);

CREATE TABLE risk (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subsidiary_id  uuid NOT NULL REFERENCES subsidiary (id) ON DELETE CASCADE,
  obligation_id  uuid REFERENCES obligation (id) ON DELETE SET NULL,
  title          text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status         text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'MITIGATED', 'ACCEPTED', 'CLOSED')),
  rationale      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, title)
);
CREATE INDEX risk_status_idx ON risk (status, severity);

CREATE TABLE approval (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id          uuid NOT NULL REFERENCES alert (id) ON DELETE CASCADE,
  proposed_action   text NOT NULL CHECK (proposed_action IN ('SEND_ESCALATION')),
  payload           jsonb NOT NULL,
  state_fingerprint text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED')),
  requested_by_run  uuid REFERENCES agent_run (id) ON DELETE SET NULL,
  decided_by        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  decided_at        timestamptz,
  comment           text,
  executed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decision_consistent CHECK (
    (status IN ('PENDING') AND decided_by IS NULL)
    OR (status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED') AND decided_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX approval_one_pending_per_alert ON approval (alert_id)
  WHERE status = 'PENDING';

CREATE TABLE action (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id  uuid REFERENCES approval (id) ON DELETE SET NULL,
  alert_id     uuid REFERENCES alert (id) ON DELETE SET NULL,
  kind         text NOT NULL,
  channel      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('EXECUTED', 'FAILED')),
  result       jsonb NOT NULL DEFAULT '{}'::jsonb,
  executed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_alert_idx ON action (alert_id);

CREATE TABLE audit_event (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('USER', 'AGENT', 'SYSTEM')),
  actor_id    text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id  text
);
CREATE INDEX audit_event_at_idx ON audit_event (at DESC);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);

-- Append-only at the application level is not tamper proof. This trigger makes
-- accidental mutation impossible through normal SQL; an operator with superuser
-- rights could still disable it. Documented in docs/SECURITY.md.
CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_no_update ON audit_event;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

COMMIT;
