-- Book-level upfront watermark, per agent. 2026-08.
-- Apply AFTER `npx prisma db push`, via:
--   npx prisma db execute --file prisma/migrations-manual/06_agent_book_watermark.sql \
--     --schema prisma/schema.prisma
--
-- WHY: upfront was tracked per (agent, investor), combined across funds. That
-- stopped an investor switching between funds from being paid twice, but the
-- same trick still worked one level up — move money out of client A and into
-- client B under the same agent, and B's series showed a brand-new high. The
-- portal has no related-party field, so A and B are indistinguishable from two
-- strangers and the churn cannot be detected. One peak for the whole book
-- makes it arithmetically impossible: an internal transfer leaves the total
-- unchanged, so there is no new high and nothing to pay.
--
-- UNLIKE THE 2026-07 CUTOVER, THIS ONE HAS POSTED MONEY BEHIND IT.
-- 04_investor_watermark.sql could guard on "commission_runs holds zero upfront
-- rows" because nothing had ever posted. That is no longer true — the July
-- 2026 run posted upfront, and those rows have since been restated twice (the
-- redemption sign fix, then the BI0000 rate correction). Do NOT copy that
-- guard here; it would refuse to run. The restatement is handled deliberately
-- and reversibly by scripts/restate-global-watermark.ts instead.

-- SUPERSEDED 2026-08-04. This file used to RAISE if
-- xsystem.agent_investor_upfront_watermarks was missing, because the cutover
-- read it to seed and to back up. The cutover is complete and signed off, and
-- 08_drop_investor_watermark.sql has since dropped that table — so the guard
-- would now abort a legitimate re-run of this file. Removed rather than
-- softened: a check that can only ever fail is not a check.
-- The dropped table's contents are archived at
-- docs/archive-agent-investor-watermarks-2026-08-04.json.

-- A watermark decides whether money is owed, so it gets the same audit trail
-- the per-investor table had. Reuses xsystem.audit_trigger() from
-- 02_audit_log_triggers.sql, so apply that file first.
DROP TRIGGER IF EXISTS xsystem_audit_agent_book_watermarks
  ON xsystem.agent_book_upfront_watermarks;
CREATE TRIGGER xsystem_audit_agent_book_watermarks
AFTER INSERT OR UPDATE OR DELETE ON xsystem.agent_book_upfront_watermarks
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

-- Deliberately NO "watermark may never decrease" trigger: setAgentWatermark is
-- the accountant's re-instatement tool and legitimately lowers it. The audit
-- trigger above is the control for that, not a hard block.
ALTER TABLE xsystem.agent_book_upfront_watermarks
  DROP CONSTRAINT IF EXISTS agent_book_watermark_nonneg;
ALTER TABLE xsystem.agent_book_upfront_watermarks
  ADD CONSTRAINT agent_book_watermark_nonneg CHECK (watermark >= 0);

-- One row per agent is the whole point of the model; the Prisma @unique on
-- agent_id already enforces it, but state it here too so a hand-written INSERT
-- cannot quietly create a second peak for the same book.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'xsystem'
       AND tablename = 'agent_book_upfront_watermarks'
       AND indexdef ILIKE '%UNIQUE%agent_id%'
  ) THEN
    RAISE EXCEPTION 'agent_book_upfront_watermarks is missing its UNIQUE(agent_id) — run prisma db push first.';
  END IF;
END $$;
