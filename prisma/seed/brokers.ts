// Seeds the Broker master table. Each row's `brokerBoAccount` and
// (optional) `marginLoanAccount` must match an existing
// ChartOfAccount.name — validated at seed time in prisma/seed/index.ts
// (fail-fast). Drives the broker dropdown on /trades/new + the
// admin-managed list on /admin/brokers.

export type SeedBroker = {
  code: string;
  name: string;
  /** Broker BO account number. Null until known. */
  accountNumber: string | null;
  brokerBoAccount: string;
  marginLoanAccount: string | null;
};

export const BROKERS_SEED: SeedBroker[] = [
  {
    code: "UCB",
    name: "UCB Securities",
    accountNumber: "1205590068173895",
    brokerBoAccount: "UCB BO (1205590068173895)",
    marginLoanAccount: "Margin Loan From UCB",
  },
  {
    code: "PRIMEBANK",
    name: "Prime Bank Securities Ltd",
    // Real BO# to be filled via /admin/brokers edit form.
    accountNumber: null,
    brokerBoAccount: "Prime Bank Securities Limited",
    marginLoanAccount: "Margin Loan From Prime Bank Securities",
  },
];
