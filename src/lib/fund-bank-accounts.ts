// Fund collection bank accounts — where an investor deposits money for a
// manual (BANK_TRANSFER) purchase before the deposit slip is uploaded.
//
// ⚠ THIS IS A COPY. The master lives in the portal repo at
// apps/portal/src/lib/fund-bank-accounts.ts, which calls itself the single
// source of truth for the portal buy wizard and the WhatsApp bot. It is
// duplicated here because this repo cannot import across the two projects and
// the agent purchase wizard has to show the same account the investor-facing
// flow shows.
//
// If a fund's collection account ever changes, BOTH files must change. A stale
// copy here would have agents telling clients to pay into a dead account, which
// is the worst failure this module can produce — so treat any edit to the
// portal file as requiring an edit here in the same change.

export type BankDetail = {
  accountName: string;
  accountNo: string;
  bankName: string;
  branchName: string;
  routingNo: string;
};

export const FUND_BANK_ACCOUNTS: Record<string, BankDetail[]> = {
  EFUF: [
    {
      accountName: "Ekush First Unit Fund",
      accountNo: "1513205101231001",
      bankName: "BRAC Bank Limited",
      branchName: "R K Mission Road",
      routingNo: "060272531",
    },
  ],
  EGF: [
    {
      accountName: "Ekush Growth Fund",
      accountNo: "1513205101212001",
      bankName: "BRAC Bank Limited",
      branchName: "R K Mission Road",
      routingNo: "060272531",
    },
  ],
  ESRF: [
    {
      accountName: "Ekush Stable Return Fund",
      accountNo: "2055604070001",
      bankName: "BRAC Bank Limited",
      branchName: "R K Mission Road",
      routingNo: "060272531",
    },
  ],
};

// Bank accounts for a fund code, falling back to ESRF when the code is
// unknown — same fallback as the portal's copy.
export function bankAccountsForFund(fundCode: string): BankDetail[] {
  return FUND_BANK_ACCOUNTS[fundCode] || FUND_BANK_ACCOUNTS.ESRF;
}
