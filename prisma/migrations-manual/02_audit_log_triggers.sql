-- Per spec §5.9. Apply manually via psql after `prisma db push`:
--   psql $DIRECT_URL -f prisma/migrations-manual/02_audit_log_triggers.sql
--
-- Writes a row to xsystem.audit_log on every mutation of journals,
-- agent_terms, commission_runs, and fiscal_years. Auditors WILL ask
-- for it.
--
-- The actor field is set from a session-local variable
-- xsystem.actor_uuid that the application sets at the start of each
-- transaction via the `withActor()` helper in src/lib/prisma.ts. Routes
-- that mutate without going through `withActor` (e.g. background crons)
-- will record a NULL actor — that's intentional.

CREATE OR REPLACE FUNCTION xsystem.audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_text text;
  actor_uuid uuid;
BEGIN
  BEGIN
    actor_text := current_setting('xsystem.actor_uuid', true);
    actor_uuid := NULLIF(actor_text, '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    actor_uuid := NULL;
  END;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO xsystem.audit_log (actor, action, target_table, target_id, before, after)
    VALUES (actor_uuid, TG_TABLE_NAME || '.create', TG_TABLE_NAME, NEW.id, NULL, to_jsonb(NEW));
  ELSIF (TG_OP = 'UPDATE') THEN
    INSERT INTO xsystem.audit_log (actor, action, target_table, target_id, before, after)
    VALUES (actor_uuid, TG_TABLE_NAME || '.update', TG_TABLE_NAME, NEW.id, to_jsonb(OLD), to_jsonb(NEW));
  ELSIF (TG_OP = 'DELETE') THEN
    INSERT INTO xsystem.audit_log (actor, action, target_table, target_id, before, after)
    VALUES (actor_uuid, TG_TABLE_NAME || '.delete', TG_TABLE_NAME, OLD.id, to_jsonb(OLD), NULL);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS xsystem_audit_journals        ON xsystem.journals;
DROP TRIGGER IF EXISTS xsystem_audit_agent_terms     ON xsystem.agent_terms;
DROP TRIGGER IF EXISTS xsystem_audit_commission_runs ON xsystem.commission_runs;
DROP TRIGGER IF EXISTS xsystem_audit_fiscal_years    ON xsystem.fiscal_years;

CREATE TRIGGER xsystem_audit_journals
AFTER INSERT OR UPDATE OR DELETE ON xsystem.journals
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_agent_terms
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_terms
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_commission_runs
AFTER INSERT OR UPDATE OR DELETE ON xsystem.commission_runs
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_fiscal_years
AFTER INSERT OR UPDATE OR DELETE ON xsystem.fiscal_years
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

-- Block journal mutations against closed fiscal years (spec §11).
CREATE OR REPLACE FUNCTION xsystem.journals_fy_closed_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_closed boolean;
BEGIN
  SELECT is_closed INTO v_closed FROM xsystem.fiscal_years
   WHERE id = COALESCE(NEW.fiscal_year_id, OLD.fiscal_year_id);
  IF v_closed THEN
    RAISE EXCEPTION 'fiscal year is closed; admin must reopen first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS xsystem_journals_fy_closed ON xsystem.journals;
CREATE TRIGGER xsystem_journals_fy_closed
BEFORE INSERT OR UPDATE OR DELETE ON xsystem.journals
FOR EACH ROW EXECUTE FUNCTION xsystem.journals_fy_closed_guard();
