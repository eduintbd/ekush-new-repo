// Seed Instrument master with the ~17 tickers Ekush actively trades, plus
// the 3 in-house mutual funds. `investmentAccount` maps each instrument to
// the CoA account that its buys/sells hit on the investment leg — picked
// up by the auto-journal generator in src/lib/trades.ts.
//
// Adding a new ticker: append a row below. The Phase 4 backfill script and
// the /trades/new dropdown both source from here.

export type SeedInstrument = {
  code: string;
  name: string;
  category: "listed_security" | "mutual_fund_open" | "private_placement" | "ipo_application" | "bond";
  sector: string | null;
  investmentAccount: string;
};

export const INSTRUMENTS_SEED: SeedInstrument[] = [
  // Listed equities → 'Investment in share'
  { code: "BRACBANK",   name: "BRAC Bank Limited",                  category: "listed_security",  sector: "Banks",            investmentAccount: "Investment in share" },
  { code: "BANKASIA",   name: "Bank Asia Limited",                  category: "listed_security",  sector: "Banks",            investmentAccount: "Investment in share" },
  { code: "JAMUNABANK", name: "Jamuna Bank Limited",                category: "listed_security",  sector: "Banks",            investmentAccount: "Investment in share" },
  { code: "PRIMEBANK",  name: "Prime Bank Limited",                 category: "listed_security",  sector: "Banks",            investmentAccount: "Investment in share" },
  { code: "BATBC",      name: "British American Tobacco Bangladesh", category: "listed_security", sector: "Tobacco",          investmentAccount: "Investment in share" },
  { code: "BSCPLC",     name: "Bangladesh Submarine Cable Co.",     category: "listed_security",  sector: "Telecom",          investmentAccount: "Investment in share" },
  { code: "SEMLLECMF",  name: "SEML Lecture Equity Mgmt Fund",      category: "listed_security",  sector: "Mutual Fund",      investmentAccount: "Investment in share" },
  { code: "VAMLBDMF1",  name: "VAML BDMF1",                         category: "listed_security",  sector: "Mutual Fund",      investmentAccount: "Investment in share" },
  { code: "WEBCOATS",   name: "Webcoats Limited",                   category: "listed_security",  sector: "Textile",          investmentAccount: "Investment in share" },
  { code: "CRAFTSMAN",  name: "Craftsman Footwear",                 category: "listed_security",  sector: "Footwear",         investmentAccount: "Investment in share" },
  { code: "AOPLC",      name: "AOPLC",                              category: "listed_security",  sector: "Miscellaneous",    investmentAccount: "Investment in share" },

  // Private placements → 'Investment In Placement Shares'
  { code: "AOPLC_P",    name: "AOPLC (Placement)",                  category: "private_placement", sector: "Miscellaneous",   investmentAccount: "Investment In Placement Shares" },
  { code: "ASIATICLAB", name: "Asiatic Laboratories",               category: "private_placement", sector: "Pharma",          investmentAccount: "Investment In Placement Shares" },

  // Bonds
  { code: "APSCLBOND",  name: "APSCL Bond",                         category: "bond",              sector: "Bond",            investmentAccount: "Investment in share" },

  // In-house open-end mutual funds → their dedicated CoA accounts
  { code: "EFUF", name: "Ekush First Unit Fund",                    category: "mutual_fund_open",  sector: "Ekush Open-End",  investmentAccount: "Investment in Mutual Fund(E.F.U.F)" },
  { code: "EGF",  name: "Ekush Growth Fund",                        category: "mutual_fund_open",  sector: "Ekush Open-End",  investmentAccount: "Investment in Mutual Fund(E.G.F)" },
  { code: "ESRF", name: "Ekush Stable Return Fund",                 category: "mutual_fund_open",  sector: "Ekush Open-End",  investmentAccount: "Investment in Mutual Fund (S.R.F)" },
];
