# Ekush ERP — X-System

Back-office accounting + selling-agent commission portal for **Ekush Wealth Management Limited** (the AMC, not the funds it manages).

Replaces `F.S March 2026.xlsx` as the day-to-day book of account. Accountants enter journals through a UI; the system auto-derives Trial Balance, Income Statement, Balance Sheet, Statement of Changes in Equity, Notes, and Annexures. Year-end exports a `.xlsx` that mirrors the original workbook so auditors cannot tell it was DB-generated.

A separate selling-agent portal computes upfront, quarterly trail, and clawback commissions per the Selling Agent Agreement.

> Standalone repo. **Not** linked to `eduintbd/ekush` or its Vercel projects. Investor data for the agent portal is mocked against the future Ekush Web API contract until the integration is wired in a later phase.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4
- Prisma 5 + Postgres
- Supabase Auth (staff `/login` + selling agents `/agent/login`)
- exceljs for the year-end workbook export
- Vercel Cron for the daily accrual + quarterly trail jobs

## Getting started

```bash
cp .env.example .env.local
npm install
npx prisma migrate dev
npm run dev
```

## Project layout

```
prisma/
  schema.prisma          all models per spec §5
  seed/                  Chart of Accounts seed (extracted from F.S March 2026.xlsx)
src/
  app/                   App Router routes
    (admin)/             staff portal: /journals, /trial-balance, /balance-sheet, …
    (agent)/             agent portal: /agent, /agent/investors, /agent/commissions
    api/                 API routes incl. /api/exports/year-end
  lib/
    prisma.ts
    supabase/            createSupabaseServerClient / createSupabaseBrowserClient
    statement_mapping.ts account → IS/BS/CE/Notes line mapping (per spec §5.11)
    format.ts            BDT formatting (Indian numbering system)
docs/
  X_System_Claude_Code_Prompt.docx   project brief (source of truth)
  F.S March 2026.xlsx                reference workbook the export must reproduce
```

## Build status

| Spec phase | Status |
| --- | --- |
| 1. Bootstrap | done |
| 2. Migrations + Chart of Accounts seed | done (seed file ready; needs DB to apply) |
| 3. /journals + /journals/new | done (compound entry, balance check, audit triggers SQL) |
| 4. /trial-balance | done (page renders; awaiting live data) |
| 4a. Supabase Auth + role gates | done (auth-not-configured banner; redirects verified) |
| 5. IS / BS / CE — `statement_mapping.ts` | done (BS balances; workbook tax bug surfaced — see file header) |
| 5a. IS / BS UI pages | done (`/income-statement`, `/balance-sheet`; external inputs via `?taxProvision=&fvLoss=&fvRecv=` until Notes/Annexure schema lands) |
| 6. Notes 4–27 | done (`/notes` renders all 24 notes; rollforward + per-fund + per-instrument breakdowns now data-driven via `AccountOpeningBalance`, `FixedAsset`, `Shareholder`, `EmployeeDisclosure`, `Journal.instrumentCode`) |
| 7. /annexures | done (Annexure-B from `InvestmentHolding`; computed unrealised G/L feeds IS OCI + Note 24 automatically; Annexure-A PPE register now backed by `FixedAsset`) |
| 8. Year-end Excel export | done (xlsx with CoA/Journals/TB-C/IS./BS./Notes./Annexure march; CE stubbed) |
| 9. Agent admin (`/admin/agents`) | done (list, invite, detail, approve/suspend/reinstate, terms history) |
| 10. Ekush Web investor API mock | done (deterministic mock; SB0001 = canonical demo cohort) |
| 11. Agent portal + commission engine | done (engine: upfront/trail/clawback per spec §8; agent UI; quarterly cron) |
| 12. MFA, backups, log drains | done (TOTP MFA enrolment + step-up enforced on admin/accountant; `/api/health` for monitoring; backups + log-drain procedures documented in `OPERATIONS.md`) |

See `docs/X_System_Claude_Code_Prompt.docx` for the full brief; do not paraphrase — replicate the workbook line-by-line.
