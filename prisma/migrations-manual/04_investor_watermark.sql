-- Combined-fund upfront watermark, per (agent, investor). 2026-07.
-- Apply AFTER `npx prisma db push`, via:
--   npx prisma db execute --file prisma/migrations-manual/04_investor_watermark.sql \
--     --schema prisma/schema.prisma
--
-- WHY: upfront was tracked per (agent, fund). An investor could redeem from
-- one fund and subscribe to another, and because each fund kept its own peak
-- the agent earned upfront TWICE on the same money. Combining the funds makes
-- a switch a no-op: the SELL and the BUY cancel in one net-principal series.
--
-- The whole cutover is only safe because NOTHING was ever posted under the old
-- model. The two guards below refuse to proceed if that stops being true —
-- run this file BEFORE `prisma db push` as well, so the guards fire while the
-- old table still exists and db push has not yet dropped it.

DO $$
DECLARE v_old int;
BEGIN
  IF to_regclass('xsystem.agent_upfront_watermarks') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM xsystem.agent_upfront_watermarks' INTO v_old;
    IF v_old > 0 THEN
      RAISE EXCEPTION
        'agent_upfront_watermarks holds % row(s) — the per-fund model was in use. STOP: migrate deliberately, do not let db push drop it.', v_old;
    END IF;
    -- Empty, as expected. db push drops it; this is belt and braces for the
    -- case where the file is run first.
    EXECUTE 'DROP TABLE IF EXISTS xsystem.agent_upfront_watermarks';
  END IF;
END $$;

DO $$
DECLARE v_runs int;
BEGIN
  IF to_regclass('xsystem.commission_runs') IS NOT NULL THEN
    SELECT count(*) INTO v_runs FROM xsystem.commission_runs WHERE type = 'upfront';
    IF v_runs > 0 THEN
      RAISE EXCEPTION
        'commission_runs holds % posted upfront row(s). The combined-watermark cutover assumes zero. STOP.', v_runs;
    END IF;
  END IF;
END $$;

-- A watermark decides whether money is owed. This table has never had an audit
-- trail; it gets one now. Reuses xsystem.audit_trigger() from
-- 02_audit_log_triggers.sql, so apply that file first.
DROP TRIGGER IF EXISTS xsystem_audit_agent_investor_watermarks
  ON xsystem.agent_investor_upfront_watermarks;
CREATE TRIGGER xsystem_audit_agent_investor_watermarks
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_investor_upfront_watermarks
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

-- Deliberately NO "watermark may never decrease" trigger: setAgentWatermark is
-- the accountant's re-instatement tool and legitimately lowers it. The audit
-- trigger above is the control for that, not a hard block.
ALTER TABLE xsystem.agent_investor_upfront_watermarks
  DROP CONSTRAINT IF EXISTS agent_investor_watermark_nonneg;
ALTER TABLE xsystem.agent_investor_upfront_watermarks
  ADD CONSTRAINT agent_investor_watermark_nonneg CHECK (watermark >= 0);
