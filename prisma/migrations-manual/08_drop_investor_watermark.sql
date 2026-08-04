-- Drop the superseded per-investor upfront watermark. 2026-08-04.
-- Apply AFTER `npx prisma db push`, via:
--   npx prisma db execute --file prisma/migrations-manual/08_drop_investor_watermark.sql \
--     --schema prisma/schema.prisma
--
-- WHY: upfront moved to a book-level high-water-mark per agent in 2026-08
-- (AgentBookWatermark / xsystem.agent_book_upfront_watermarks, see
-- 06_agent_book_watermark.sql). The per-(agent, investor) table it replaced has
-- had no reader since, and the restatement scripts that populated it have been
-- deleted along with the rest of the pre-watermark commission code.
--
-- THIS IS IRREVERSIBLE. The 26 rows it held are archived, with agent codes
-- resolved, at docs/archive-agent-investor-watermarks-2026-08-04.json — that
-- file is the only remaining record of the pre-cutover watermark values. Do not
-- delete it.
--
-- `prisma db push` will already have dropped the table once the model was
-- removed from schema.prisma; this file exists so the deployment history says
-- so explicitly, and so a database that was never pushed ends up in the same
-- state. IF EXISTS makes it safe either way.

DROP TABLE IF EXISTS xsystem.agent_investor_upfront_watermarks;

-- 04_investor_watermark.sql created an audit trigger and constraints on that
-- table. DROP TABLE takes them with it; nothing further to clean up. That file
-- is retained as deployment history and is now a no-op — do not re-run it.
