// Aggregates side-table data referenced by the financial-statement notes
// (PPE register, opening balances, shareholders, employee disclosure,
// per-fund / per-instrument journal splits). Wrapped in try/catch per
// query so the /notes page still renders pre-migration — empty data
// gracefully falls back to the workbook's "inputs needed" UX.

import { prisma } from "@/lib/prisma";
import type { AssetClass } from "@/generated/prisma";

export type OpeningBalances = Map<
  string,
  { openingDebit: number; openingCredit: number }
>;

export type FixedAssetRow = {
  id: string;
  assetClass: AssetClass;
  name: string;
  cost: number;
  accumulatedDepreciation: number;
  /** Depreciation charged in the report's fiscal year. */
  periodDepreciation: number;
  disposedOn: Date | null;
};

export type ShareholderRow = {
  id: string;
  fullName: string;
  sharesHeld: number;
};

export type EmployeeDisclosureData = {
  totalEmployees: number;
  belowMinimumWage: number;
  minMonthlySalaryBdt: number;
  notes: string | null;
};

export type NotesData = {
  openingBalances: OpeningBalances;
  fixedAssets: FixedAssetRow[];
  shareholders: ShareholderRow[];
  /** Sum of `sharesHeld` across active shareholders. 0 if none recorded. */
  totalSharesIssued: number;
  employeeDisclosure: EmployeeDisclosureData | null;
  /** Sum keyed by `fundCode` for Note 16 / 17 etc. */
  fundManagementFees: Map<string, number>;
  fundCapitalGains: Map<string, number>;
  /** Per-instrument breakdown for Notes 19.01 / 20. */
  dividendByInstrument: Map<string, number>;
  interestByInstrument: Map<string, number>;
};

const EMPTY: NotesData = {
  openingBalances: new Map(),
  fixedAssets: [],
  shareholders: [],
  totalSharesIssued: 0,
  employeeDisclosure: null,
  fundManagementFees: new Map(),
  fundCapitalGains: new Map(),
  dividendByInstrument: new Map(),
  interestByInstrument: new Map(),
};

export async function getNotesData(fiscalYearId: string): Promise<NotesData> {
  const [
    openingRows,
    fixedAssetRows,
    depreciations,
    shareholderRows,
    employee,
    mgmtFee,
    capitalGainCr,
    capitalLossDr,
    dividend,
    interestFdr,
    interestSnd,
  ] = await Promise.all([
    safe(() =>
      prisma.accountOpeningBalance.findMany({
        where: { fiscalYearId },
        select: { accountName: true, openingDebit: true, openingCredit: true },
      }),
    ),
    safe(() => prisma.fixedAsset.findMany({ orderBy: [{ assetClass: "asc" }, { acquiredOn: "asc" }] })),
    safe(() =>
      prisma.fixedAssetDepreciation.findMany({
        where: { fiscalYearId },
        select: { fixedAssetId: true, amount: true },
      }),
    ),
    safe(() =>
      prisma.shareholder.findMany({
        where: { isActive: true },
        orderBy: [{ sharesHeld: "desc" }, { fullName: "asc" }],
      }),
    ),
    safe(() => prisma.employeeDisclosure.findUnique({ where: { fiscalYearId } })),
    safe(() =>
      prisma.journal.groupBy({
        by: ["fundCode"],
        where: { fiscalYearId, accountName: "Management Fee" },
        _sum: { debit: true, credit: true },
      }),
    ),
    safe(() =>
      prisma.journal.groupBy({
        by: ["fundCode"],
        where: { fiscalYearId, accountName: "Capital Gain" },
        _sum: { credit: true },
      }),
    ),
    safe(() =>
      prisma.journal.groupBy({
        by: ["fundCode"],
        where: { fiscalYearId, accountName: "Capital Loss" },
        _sum: { debit: true },
      }),
    ),
    safe(() =>
      prisma.journal.groupBy({
        by: ["instrumentCode"],
        where: { fiscalYearId, accountName: "Dividend Income" },
        _sum: { debit: true, credit: true },
      }),
    ),
    safe(() =>
      prisma.journal.groupBy({
        by: ["instrumentCode"],
        where: { fiscalYearId, accountName: "Interest Income of FDR" },
        _sum: { debit: true, credit: true },
      }),
    ),
    safe(() =>
      prisma.journal.groupBy({
        by: ["instrumentCode"],
        where: { fiscalYearId, accountName: "Interest Income" },
        _sum: { debit: true, credit: true },
      }),
    ),
  ]);

  // Bail out cleanly if every query failed (table missing pre-migration).
  if (
    openingRows === null &&
    fixedAssetRows === null &&
    shareholderRows === null &&
    employee === null
  ) {
    return EMPTY;
  }

  const openingBalances: OpeningBalances = new Map(
    (openingRows ?? []).map((r) => [
      r.accountName,
      { openingDebit: Number(r.openingDebit), openingCredit: Number(r.openingCredit) },
    ]),
  );

  const depByAsset = new Map((depreciations ?? []).map((d) => [d.fixedAssetId, Number(d.amount)]));
  const fixedAssets: FixedAssetRow[] = (fixedAssetRows ?? []).map((a) => ({
    id: a.id,
    assetClass: a.assetClass,
    name: a.name,
    cost: Number(a.cost),
    accumulatedDepreciation: Number(a.accumulatedDepreciation),
    periodDepreciation: depByAsset.get(a.id) ?? 0,
    disposedOn: a.disposedOn,
  }));

  const shareholders: ShareholderRow[] = (shareholderRows ?? []).map((s) => ({
    id: s.id,
    fullName: s.fullName,
    sharesHeld: s.sharesHeld,
  }));
  const totalSharesIssued = shareholders.reduce((s, r) => s + r.sharesHeld, 0);

  const employeeDisclosure: EmployeeDisclosureData | null = employee
    ? {
        totalEmployees: employee.totalEmployees,
        belowMinimumWage: employee.belowMinimumWage,
        minMonthlySalaryBdt: Number(employee.minMonthlySalaryBdt),
        notes: employee.notes,
      }
    : null;

  const fundManagementFees = new Map<string, number>();
  for (const row of mgmtFee ?? []) {
    const key = row.fundCode ?? "(unspecified)";
    const net = Number(row._sum.credit ?? 0) - Number(row._sum.debit ?? 0);
    fundManagementFees.set(key, (fundManagementFees.get(key) ?? 0) + net);
  }

  const fundCapitalGains = new Map<string, number>();
  for (const row of capitalGainCr ?? []) {
    const key = row.fundCode ?? "(unspecified)";
    fundCapitalGains.set(key, (fundCapitalGains.get(key) ?? 0) + Number(row._sum.credit ?? 0));
  }
  for (const row of capitalLossDr ?? []) {
    const key = row.fundCode ?? "(unspecified)";
    fundCapitalGains.set(key, (fundCapitalGains.get(key) ?? 0) - Number(row._sum.debit ?? 0));
  }

  const dividendByInstrument = new Map<string, number>();
  for (const row of dividend ?? []) {
    const key = row.instrumentCode ?? "(unspecified)";
    const net = Number(row._sum.credit ?? 0) - Number(row._sum.debit ?? 0);
    dividendByInstrument.set(key, (dividendByInstrument.get(key) ?? 0) + net);
  }

  const interestByInstrument = new Map<string, number>();
  for (const row of [...(interestFdr ?? []), ...(interestSnd ?? [])]) {
    const key = row.instrumentCode ?? "(unspecified)";
    const net = Number(row._sum.credit ?? 0) - Number(row._sum.debit ?? 0);
    interestByInstrument.set(key, (interestByInstrument.get(key) ?? 0) + net);
  }

  return {
    openingBalances,
    fixedAssets,
    shareholders,
    totalSharesIssued,
    employeeDisclosure,
    fundManagementFees,
    fundCapitalGains,
    dividendByInstrument,
    interestByInstrument,
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
