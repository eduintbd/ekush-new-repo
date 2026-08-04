// Read-only check that the commission payout wiring landed:
//   • the payable account exists in the chart of accounts
//   • the constraints from 07_commission_payment.sql are attached
//   • what is currently un-accrued / accrued-unpaid per agent
//
//   npx tsx scripts/diag-commission-payout.ts

import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const coa = await prisma.chartOfAccount.findMany({
    where: {
      name: {
        in: ["Selling agent fees", "Liab-Selling Agent Commission", "AIT & VAT Payble"],
      },
    },
    select: { sl: true, name: true, normalBalance: true, isActive: true },
    orderBy: { sl: "asc" },
  });
  console.log("=== Chart of accounts ===");
  for (const a of coa) {
    console.log(`  sl ${a.sl}  ${a.name.padEnd(32)} ${a.normalBalance}  active=${a.isActive}`);
  }
  if (coa.length !== 3) console.log("  !! expected 3 accounts, found", coa.length);

  const cons = await prisma.$queryRawUnsafe<Array<{ conname: string; tbl: string }>>(
    `SELECT c.conname, t.relname AS tbl
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'xsystem'
        AND t.relname IN ('commission_payments', 'commission_runs')
        AND c.contype = 'c'
      ORDER BY t.relname, c.conname`,
  );
  console.log("\n=== Check constraints ===");
  for (const c of cons) console.log(`  ${c.tbl}.${c.conname}`);

  const trg = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'xsystem.commission_payments'::regclass AND NOT tgisinternal`,
  );
  console.log("\n=== Triggers on commission_payments ===");
  for (const t of trg) console.log(`  ${t.tgname}`);

  const byStatus = await prisma.commissionRun.groupBy({
    by: ["status"],
    _count: { _all: true },
    _sum: { amount: true },
  });
  console.log("\n=== commission_runs by status ===");
  for (const r of byStatus) {
    console.log(
      `  ${r.status.padEnd(10)} ${String(r._count._all).padStart(4)} rows  BDT ${Number(r._sum.amount ?? 0).toFixed(2)}`,
    );
  }

  const payments = await prisma.commissionPayment.count();
  console.log(`\ncommission_payments rows: ${payments}`);

  const agents = await prisma.sellingAgent.findMany({
    select: { id: true, code: true, fullName: true },
    orderBy: { code: "asc" },
  });
  console.log("\n=== Per agent (all periods) ===");
  for (const a of agents) {
    const [unaccrued, unpaid] = await Promise.all([
      prisma.commissionRun.aggregate({
        where: { agentId: a.id, journalBatchId: null, status: "accrued" },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.commissionRun.aggregate({
        where: {
          agentId: a.id,
          status: "approved",
          paidOn: null,
          journalBatchId: { not: null },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    console.log(
      `  ${a.code.padEnd(8)} ${a.fullName.slice(0, 24).padEnd(26)} un-accrued ${unaccrued._count._all} / BDT ${Number(unaccrued._sum.amount ?? 0).toFixed(2)}   accrued-unpaid ${unpaid._count._all} / BDT ${Number(unpaid._sum.amount ?? 0).toFixed(2)}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
