-- Selling-agent profile management (requirements_for_sales_agent.docx
-- tasks 2 + 3). Apply manually via psql after `prisma db push`:
--   psql $DIRECT_URL -f prisma/migrations-manual/03_agent_profile.sql
--
-- `prisma db push` creates the three new tables (agent_bank_accounts,
-- agent_nominees, agent_documents) and the new columns on
-- selling_agents. This file adds what Prisma's schema language cannot
-- express: a partial unique index, and audit triggers.

-- One primary payout account per agent. The server actions already keep
-- this invariant, but commissions are money — enforce it in the DB so a
-- concurrent "Make primary" on two tabs can't leave two winners.
DROP INDEX IF EXISTS xsystem.agent_bank_accounts_one_primary;
CREATE UNIQUE INDEX agent_bank_accounts_one_primary
  ON xsystem.agent_bank_accounts (agent_id)
  WHERE is_primary;

-- Nominee shares must not oversubscribe. Checked in the action too; this
-- is the backstop against concurrent inserts.
CREATE OR REPLACE FUNCTION xsystem.agent_nominee_share_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total numeric;
BEGIN
  SELECT COALESCE(SUM(share), 0) INTO v_total
    FROM xsystem.agent_nominees
   WHERE agent_id = NEW.agent_id
     AND id <> NEW.id;
  IF v_total + NEW.share > 100 THEN
    -- Single % is the placeholder; the word "percent" avoids needing to
    -- escape a literal %% right next to it.
    RAISE EXCEPTION 'nominee shares for this agent would total % percent, max 100', v_total + NEW.share
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xsystem_agent_nominee_share ON xsystem.agent_nominees;
CREATE TRIGGER xsystem_agent_nominee_share
BEFORE INSERT OR UPDATE ON xsystem.agent_nominees
FOR EACH ROW EXECUTE FUNCTION xsystem.agent_nominee_share_guard();

-- Audit trail. selling_agents was previously untriggered; now that the
-- table holds NID/TIN/address, changes to it are auditable like
-- agent_terms already are. Reuses xsystem.audit_trigger() from
-- 02_audit_log_triggers.sql — apply that file first.
DROP TRIGGER IF EXISTS xsystem_audit_selling_agents      ON xsystem.selling_agents;
DROP TRIGGER IF EXISTS xsystem_audit_agent_bank_accounts ON xsystem.agent_bank_accounts;
DROP TRIGGER IF EXISTS xsystem_audit_agent_nominees      ON xsystem.agent_nominees;
DROP TRIGGER IF EXISTS xsystem_audit_agent_documents     ON xsystem.agent_documents;

CREATE TRIGGER xsystem_audit_selling_agents
AFTER INSERT OR UPDATE OR DELETE ON xsystem.selling_agents
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_agent_bank_accounts
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_bank_accounts
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_agent_nominees
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_nominees
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

CREATE TRIGGER xsystem_audit_agent_documents
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_documents
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();
