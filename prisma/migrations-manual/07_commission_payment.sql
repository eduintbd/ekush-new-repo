-- Selling-agent commission payout: accrue → pay. 2026-08.
-- Apply AFTER `npx prisma db push`, via:
--   npx prisma db execute --file prisma/migrations-manual/07_commission_payment.sql \
--     --schema prisma/schema.prisma
--
-- WHY: the commission engine computed and posted to xsystem.commission_runs as
-- `accrued`, and stopped there. Nothing ever set paid_on or status='paid', no
-- journal was written, and `Selling agent fees` (sl 115) had no credit-side
-- account — so commission never reached the trial balance at all.
--
-- The billing date and the payment date are not the same day: the accountant
-- bills to 30 Jul and transfers on 5 Aug. That is two vouchers, not one:
--   AC/<fy>/nnnn  dated period end   Dr Selling agent fees / Cr the payable
--   CP/<fy>/nnnn  dated transfer day Dr the payable / Cr bank / Cr AIT & VAT
-- so the expense sits in July and the cash leaves in August. The two can even
-- fall in different fiscal years; each voucher is allocated in its own.

-- 1. The credit-side account. Seeded by prisma/seed/chart-of-accounts.ts too;
--    inserted here so an existing deployment gets it without a re-seed.
--    `normal_balance` mirrors the other Liab-* rows (credit-normal).
--    updated_at is written explicitly: Prisma's @updatedAt is applied by the
--    client, not by a DB default, so a raw INSERT that omits it hits NOT NULL.
INSERT INTO xsystem.chart_of_accounts (sl, name, normal_balance, created_at, updated_at)
VALUES (134, 'Liab-Selling Agent Commission', 'CREDIT', now(), now())
ON CONFLICT (name) DO NOTHING;

-- 2. Audit trail on the payout table — this row IS the record that money left.
--    Reuses xsystem.audit_trigger() from 02_audit_log_triggers.sql, so apply
--    that file first.
DROP TRIGGER IF EXISTS xsystem_audit_commission_payments
  ON xsystem.commission_payments;
CREATE TRIGGER xsystem_audit_commission_payments
AFTER INSERT OR UPDATE OR DELETE ON xsystem.commission_payments
FOR EACH ROW EXECUTE FUNCTION xsystem.audit_trigger();

-- 3. gross = withholding + net, always. The app computes all three, but this is
--    the figure an auditor reconciles against the bank statement — a rounding
--    slip here is money that cannot be explained. Half a paisa of tolerance
--    absorbs Decimal(18,2) rounding without admitting a real discrepancy.
ALTER TABLE xsystem.commission_payments
  DROP CONSTRAINT IF EXISTS commission_payment_splits_add_up;
ALTER TABLE xsystem.commission_payments
  ADD CONSTRAINT commission_payment_splits_add_up
  CHECK (abs(gross_amount - withholding_amount - net_amount) < 0.005);

-- 4. No negative legs. A clawback is a reversing commission_run, not a negative
--    payout row.
ALTER TABLE xsystem.commission_payments
  DROP CONSTRAINT IF EXISTS commission_payment_nonneg;
ALTER TABLE xsystem.commission_payments
  ADD CONSTRAINT commission_payment_nonneg
  CHECK (gross_amount >= 0 AND withholding_amount >= 0 AND net_amount >= 0);

-- 5. Cash cannot leave before the period it settles has closed.
ALTER TABLE xsystem.commission_payments
  DROP CONSTRAINT IF EXISTS commission_payment_paid_after_period;
ALTER TABLE xsystem.commission_payments
  ADD CONSTRAINT commission_payment_paid_after_period
  CHECK (paid_on >= period_end);

-- 6. One payment voucher, one payout row. The app allocates a fresh batch id
--    per payout; a duplicate would mean two payout rows claiming the same
--    Cr Bank lines, i.e. the same cash counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS commission_payments_payment_batch_uniq
  ON xsystem.commission_payments (payment_batch_id);

-- 7. A paid run must name the payout it was settled in, and an unpaid one must
--    not. Without this, a hand-written UPDATE could mark runs paid with no
--    payout row behind them — the exact state this module was built to end.
ALTER TABLE xsystem.commission_runs
  DROP CONSTRAINT IF EXISTS commission_run_paid_has_payment;
ALTER TABLE xsystem.commission_runs
  ADD CONSTRAINT commission_run_paid_has_payment
  CHECK (
    (status = 'paid' AND payment_id IS NOT NULL AND paid_on IS NOT NULL)
    OR (status <> 'paid' AND payment_id IS NULL)
  );
