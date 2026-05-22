// Seeds the Broker master table. Each row's `brokerBoAccount` and
// (optional) `marginLoanAccount` must match an existing
// ChartOfAccount.name — validated at seed time in prisma/seed/index.ts
// (fail-fast). Drives the broker dropdown on /trades/new + the
// admin-managed list on /admin/brokers.

export type SeedBroker = {
  code: string;
  name: string;
  brokerBoAccount: string;
  marginLoanAccount: string | null;
};

export const BROKERS_SEED: SeedBroker[] = [
  {
    code: "UCB",
    name: "UCB Securities",
    brokerBoAccount: "UCB BO (1205590068173895)",
    marginLoanAccount: "Margin Loan From UCB",
  },
  {
    code: "PRIMEBANK",
    name: "Prime Bank Securities Ltd",
    brokerBoAccount: "Prime Bank Securities Limited",
    marginLoanAccount: "Margin Loan From Prime Bank Securities",
  },
];
