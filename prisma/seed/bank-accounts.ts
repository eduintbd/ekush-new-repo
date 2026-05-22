// Seeds the BankAccount master table. Each row's `accountName` must
// match an existing ChartOfAccount.name — validated at seed time in
// prisma/seed/index.ts (fail-fast). Used by the /trades/new bank
// dropdown and the auto-journal generator's bank-leg account picker.
//
// Add a new bank: append a row. To deactivate, prefer /admin/banks
// edit (sets isActive=false) rather than removing the seed row.

export type SeedBankAccount = {
  /** FK to ChartOfAccount.name. The CoA row must already exist. */
  accountName: string;
  bankName: string;
  accountNumber: string;
  accountType: "current" | "savings" | "std" | "md" | "fdr" | "mobile_money" | "other";
  /** Documentation-only — no schema column. Two are marked primary;
   *  the form preselects the first alphabetical, so order doesn't
   *  follow this flag. */
  isPrimary?: boolean;
};

export const BANK_ACCOUNTS_SEED: SeedBankAccount[] = [
  // Primary settlement banks per the AMC ops team.
  { accountName: "Midland (A/C No. 00011060000128)",     bankName: "Midland Bank Limited",   accountNumber: "00011060000128",  accountType: "current", isPrimary: true },
  { accountName: "Brac Bank (A/C No. 1513204232046002)", bankName: "BRAC Bank Limited",      accountNumber: "1513204232046002", accountType: "current", isPrimary: true },
  // Secondary / utility accounts.
  { accountName: "Brac (A/C No. 1513204232046001)",      bankName: "BRAC Bank Limited",      accountNumber: "1513204232046001", accountType: "current" },
  { accountName: "Modhumoti (A/C No. 11351110000092)",   bankName: "Modhumoti Bank Limited", accountNumber: "11351110000092",  accountType: "current" },
];
