-- Marketing contents for selling agents. 2026-07.
-- Apply AFTER `npx prisma db push`, via:
--   npx prisma db execute --file prisma/migrations-manual/05_marketing_contents.sql \
--     --schema prisma/schema.prisma
--
-- `db push` creates xsystem.agent_marketing_contents. This file adds the audit
-- trigger (who uploaded/removed which file), reusing xsystem.audit_trigger()
-- from 02_audit_log_triggers.sql — apply that file first.

DROP TRIGGER IF EXISTS xsystem_audit_agent_marketing_contents
  ON xsystem.agent_marketing_contents;
CREATE TRIGGER xsystem_audit_agent_marketing_contents
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_marketing_contents
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();
