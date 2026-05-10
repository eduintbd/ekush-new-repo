-- Per spec §5.11. Apply manually via psql after `prisma migrate dev`:
--   psql $DATABASE_URL -f prisma/migrations-manual/01_trial_balance_view.sql
--
-- The application reads the trial balance via Prisma groupBy (see
-- src/lib/trial-balance.ts) — fast enough for the expected journal volume.
-- Use this view if direct SQL access is needed (e.g. ad-hoc reporting,
-- BI tools, the year-end Excel export's TB-C sheet).

CREATE OR REPLACE VIEW xsystem_trial_balance AS
SELECT
  fy.id          AS fiscal_year_id,
  coa.name       AS account_name,
  coa.normal_balance,
  GREATEST(0, COALESCE(SUM(j.debit), 0))  AS gross_debit,
  GREATEST(0, COALESCE(SUM(j.credit), 0)) AS gross_credit,
  GREATEST(0, COALESCE(SUM(j.debit), 0) - COALESCE(SUM(j.credit), 0))  AS net_debit,
  GREATEST(0, COALESCE(SUM(j.credit), 0) - COALESCE(SUM(j.debit), 0))  AS net_credit
FROM chart_of_accounts coa
CROSS JOIN fiscal_years fy
LEFT JOIN journals j
  ON j.account_name = coa.name
 AND j.fiscal_year_id = fy.id
GROUP BY fy.id, coa.name, coa.normal_balance;
