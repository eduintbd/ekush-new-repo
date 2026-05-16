// Generate docs/X-System-Accountant-Tutorial.docx — a comprehensive,
// page-by-page tutorial for the AMC's accountant covering every screen
// in the X-System with field references, step-by-step flows, and ASCII
// screen mockups. Outputs a real Word document.
//
//   npx tsx scripts/build-accountant-tutorial.ts

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ─── Style constants ─────────────────────────────────────────────

const COLOR = {
  bg_header: "1F2937",       // slate-800
  bg_subhead: "374151",      // slate-700
  bg_step: "EFF6FF",         // blue-50
  bg_note: "FEF3C7",         // amber-100
  bg_caution: "FEE2E2",      // red-100
  bg_zebra: "F9FAFB",        // gray-50
  bg_mockup: "0F172A",       // slate-900
  fg_mockup: "F1F5F9",       // slate-100
  fg_muted: "6B7280",        // gray-500
  border: "D1D5DB",          // gray-300
  accent: "DC2626",          // red-600
  good: "059669",            // emerald-600
};

// ─── Paragraph helpers ───────────────────────────────────────────

const p = (text: string, opts: { bold?: boolean; italic?: boolean; size?: number; color?: string; align?: keyof typeof AlignmentType } = {}) =>
  new Paragraph({
    alignment: opts.align ? AlignmentType[opts.align] : undefined,
    children: [new TextRun({
      text,
      bold: opts.bold,
      italics: opts.italic,
      size: opts.size ?? 22,
      color: opts.color,
      font: "Calibri",
    })],
  });

const para = (...runs: TextRun[]) =>
  new Paragraph({ children: runs, spacing: { after: 120 } });

const run = (text: string, opts: { bold?: boolean; italic?: boolean; color?: string; mono?: boolean; size?: number } = {}) =>
  new TextRun({
    text,
    bold: opts.bold,
    italics: opts.italic,
    color: opts.color,
    font: opts.mono ? "Consolas" : "Calibri",
    size: opts.size ?? 22,
  });

const blank = () => new Paragraph({ children: [new TextRun({ text: "" })], spacing: { before: 60, after: 60 } });

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

const h1 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    spacing: { before: 240, after: 240 },
    children: [new TextRun({ text, bold: true, size: 40, color: COLOR.bg_header, font: "Calibri" })],
  });

const h2 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 160 },
    children: [new TextRun({ text, bold: true, size: 30, color: COLOR.bg_header, font: "Calibri" })],
  });

const h3 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 100 },
    children: [new TextRun({ text, bold: true, size: 26, color: COLOR.bg_subhead, font: "Calibri" })],
  });

const h4 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_4,
    spacing: { before: 180, after: 80 },
    children: [new TextRun({ text, bold: true, size: 22, color: COLOR.bg_subhead, font: "Calibri" })],
  });

const bullet = (text: string, level = 0) =>
  new Paragraph({
    bullet: { level },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, font: "Calibri" })],
  });

const numbered = (text: string, level = 0) =>
  new Paragraph({
    numbering: { reference: "main-numbering", level },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, font: "Calibri" })],
  });

// ─── Box / callout helpers ───────────────────────────────────────

type BoxKind = "step" | "note" | "caution" | "good";

function colorFor(kind: BoxKind): string {
  return kind === "step" ? COLOR.bg_step
    : kind === "note" ? COLOR.bg_note
    : kind === "caution" ? COLOR.bg_caution
    : COLOR.bg_step;
}
function labelFor(kind: BoxKind): string {
  return kind === "step" ? "STEPS"
    : kind === "note" ? "NOTE"
    : kind === "caution" ? "CAUTION"
    : "OK";
}

function box(kind: BoxKind, title: string, body: Array<Paragraph>): Table {
  const fill = colorFor(kind);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      left: { style: BorderStyle.SINGLE, size: 16, color: kind === "caution" ? COLOR.accent : kind === "note" ? "F59E0B" : "3B82F6" },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: COLOR.border },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: COLOR.border },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill, color: "auto" },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `${labelFor(kind)} — `, bold: true, size: 20, color: kind === "caution" ? COLOR.accent : "1E40AF" }),
                  new TextRun({ text: title, bold: true, size: 22, color: "111827" }),
                ],
                spacing: { after: 80 },
              }),
              ...body,
            ],
          }),
        ],
      }),
    ],
  });
}

// ─── Field reference table ───────────────────────────────────────

function fieldTable(rows: Array<{ field: string; type: string; required?: boolean; desc: string }>): Table {
  const headerCells = ["Field", "Type", "Req?", "What it does"].map((label) =>
    new TableCell({
      shading: { type: ShadingType.CLEAR, fill: COLOR.bg_header, color: "auto" },
      children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: "FFFFFF", size: 20 })] })],
    }),
  );
  const bodyRows = rows.map((r, idx) =>
    new TableRow({
      children: [
        new TableCell({
          shading: idx % 2 === 0 ? { type: ShadingType.CLEAR, fill: COLOR.bg_zebra, color: "auto" } : undefined,
          children: [new Paragraph({ children: [new TextRun({ text: r.field, bold: true, size: 20, font: "Consolas" })] })],
        }),
        new TableCell({
          shading: idx % 2 === 0 ? { type: ShadingType.CLEAR, fill: COLOR.bg_zebra, color: "auto" } : undefined,
          children: [new Paragraph({ children: [new TextRun({ text: r.type, size: 20, italics: true, color: COLOR.fg_muted })] })],
        }),
        new TableCell({
          shading: idx % 2 === 0 ? { type: ShadingType.CLEAR, fill: COLOR.bg_zebra, color: "auto" } : undefined,
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: r.required ? "✓" : "—", bold: r.required, size: 20, color: r.required ? COLOR.accent : COLOR.fg_muted })] })],
        }),
        new TableCell({
          shading: idx % 2 === 0 ? { type: ShadingType.CLEAR, fill: COLOR.bg_zebra, color: "auto" } : undefined,
          children: [new Paragraph({ children: [new TextRun({ text: r.desc, size: 20 })] })],
        }),
      ],
    }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: headerCells }), ...bodyRows],
  });
}

// ─── ASCII-style screen mockup (monospace dark) ──────────────────

function mockup(lines: string[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR.bg_mockup, color: "auto" },
            children: lines.map((line) =>
              new Paragraph({
                children: [new TextRun({ text: line.length === 0 ? " " : line, font: "Consolas", size: 18, color: COLOR.fg_mockup })],
                spacing: { after: 0 },
              }),
            ),
          }),
        ],
      }),
    ],
  });
}

// ─── Chapter helpers ─────────────────────────────────────────────

function chapterIntro(title: string, subtitle: string): Paragraph[] {
  return [
    h1(title),
    new Paragraph({
      children: [new TextRun({ text: subtitle, italics: true, size: 24, color: COLOR.fg_muted, font: "Calibri" })],
      spacing: { after: 200 },
    }),
  ];
}

// ─── Compose the document ────────────────────────────────────────

function buildDoc(): Document {
  const blocks: (Paragraph | Table)[] = [];

  // Cover
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 200 },
      children: [new TextRun({ text: "X-SYSTEM", bold: true, size: 72, color: COLOR.bg_header, font: "Calibri" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: "Accountant's Tutorial", size: 44, color: "1F2937", font: "Calibri" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: "Back-office accounting + selling-agent commission portal", italics: true, size: 24, color: COLOR.fg_muted, font: "Calibri" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: "Ekush Wealth Management Limited", size: 22, color: COLOR.bg_header, font: "Calibri" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: new Date().toISOString().slice(0, 10), size: 20, color: COLOR.fg_muted, font: "Calibri" })],
    }),
  );

  // Table of contents (manual)
  blocks.push(h1("Contents"));
  const tocItems = [
    "Part 1 — Getting started", " 1. System overview", " 2. Logging in", " 3. Setting up two-factor authentication (MFA)", " 4. The dashboard at a glance",
    "Part 2 — Daily journal operations", " 5. Recording a journal entry (step by step)", " 6. Voucher numbering scheme", " 7. Browsing & filtering the Journals list", " 8. The Day Book",
    "Part 3 — Drill-down reports", " 9. The Ledger Card (per account)", " 10. Cash & Bank Book", " 11. Trial Balance",
    "Part 4 — Financial statements", " 12. Income Statement", " 13. Balance Sheet", " 14. Changes in Equity", " 15. Notes 4–27", " 16. Cash Flow", " 17. Annexures",
    "Part 5 — Reconciliation & verification", " 18. Bank Reconciliation Statement (BRS)", " 19. Receivables Aging", " 20. Management Fee Import (cross-system)",
    "Part 6 — Master data (admin)", " 21. Chart of Accounts", " 22. Account Groups", " 23. Bank Account Master", " 24. Cost Centres",
    "Part 7 — Period management (admin)", " 25. Opening Balances", " 26. Fiscal Years + Roll-Forward",
    "Part 8 — Selling agents", " 27. Inviting & approving an agent", " 28. Editing commission terms + methodology",
    "Part 9 — Utilities", " 29. Exports (Excel, CSV, Print/PDF)", " 30. Audit Log",
    "Appendix — FAQ & Troubleshooting",
  ];
  for (const item of tocItems) {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: item, size: item.startsWith("Part") ? 24 : 22, bold: item.startsWith("Part"), font: "Calibri" })],
        spacing: { after: 40 },
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // PART 1 — GETTING STARTED
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 1 — Getting started", "What X-System is, how to log in, set up MFA, and read the dashboard."));

  // 1. System overview
  blocks.push(h2("1. System overview"));
  blocks.push(p("X-System is the back-office accounting system for Ekush Wealth Management Limited (the AMC, not the funds it manages). It replaces the F.S March 2026.xlsx workbook as the day-to-day book of account."));
  blocks.push(p("As an accountant you will use X-System to:"));
  blocks.push(bullet("Enter compound journal entries (the daily activity)."));
  blocks.push(bullet("Drill into any ledger to see its running balance and history."));
  blocks.push(bullet("Produce the Trial Balance, Income Statement, Balance Sheet, Changes in Equity, Notes and Annexures."));
  blocks.push(bullet("Reconcile bank statements, age receivables, verify each fund's management fee."));
  blocks.push(bullet("Generate the year-end Excel workbook in the exact layout your auditor expects."));
  blocks.push(blank());
  blocks.push(box("note", "How the system is laid out", [
    p("Everything sits behind one URL — http://localhost:3000 in development, x.ekushwml.com in production. From the dashboard you click into the page you need; every page has a \"← Dashboard\" link at the top so you can always get back."),
  ]));

  // 2. Login
  blocks.push(h2("2. Logging in"));
  blocks.push(p("X-System uses Supabase Auth — the same user account you have for the Ekush portal works here, provided the admin has granted you the accountant role."));
  blocks.push(h3("Steps"));
  blocks.push(box("step", "Sign-in flow", [
    numbered("Open http://localhost:3000/login (development) or https://x.ekushwml.com/login (production)."),
    numbered("Enter the email you've been onboarded with — usually your @ekushwml.com address."),
    numbered("Enter your password."),
    numbered("Click \"Sign in\"."),
    numbered("If this is your first login, you'll be redirected to /account/mfa to enrol two-factor authentication — see chapter 3."),
    numbered("If you already have MFA enrolled, you'll be redirected to /login/mfa to enter the 6-digit code from your authenticator app."),
    numbered("After successful MFA verification, you land on /dashboard."),
  ]));
  blocks.push(h3("Login screen"));
  blocks.push(mockup([
    "┌──────────────────────────────────────────────────────────────────────┐",
    "│   STAFF PORTAL                                                       │",
    "│   Sign in                                                            │",
    "│                                                                      │",
    "│   Email                                                              │",
    "│   ┌──────────────────────────────────────────────────────────────┐   │",
    "│   │ accountant@ekushwml.com                                      │   │",
    "│   └──────────────────────────────────────────────────────────────┘   │",
    "│                                                                      │",
    "│   Password                                                           │",
    "│   ┌──────────────────────────────────────────────────────────────┐   │",
    "│   │ ••••••••••••••••                                             │   │",
    "│   └──────────────────────────────────────────────────────────────┘   │",
    "│                                                                      │",
    "│   ┌────────────┐                                                     │",
    "│   │  Sign in   │                                                     │",
    "│   └────────────┘                                                     │",
    "└──────────────────────────────────────────────────────────────────────┘",
  ]));
  blocks.push(blank());
  blocks.push(box("caution", "If sign-in fails", [
    bullet("\"Invalid email or password\" — double-check both. Password is case-sensitive."),
    bullet("\"This account is not authorised for the staff portal\" — your user exists in Supabase but the admin hasn't created an xsystem.profiles row for you with the accountant role. Contact the admin."),
    bullet("\"This account is a selling-agent account. Please use the agent portal\" — you have selling_agent role, use /agent/login instead."),
  ]));

  // 3. MFA
  blocks.push(h2("3. Setting up two-factor authentication"));
  blocks.push(p("MFA is required for admin and accountant roles. You'll set it up once, the first time you log in. After that you'll be asked for a 6-digit code on every sign-in."));
  blocks.push(h3("What you need"));
  blocks.push(bullet("Your phone with an authenticator app installed: Google Authenticator, Microsoft Authenticator, 1Password, Authy — any of them work."));
  blocks.push(bullet("Your X-System sign-in session active (you just signed in with email + password)."));
  blocks.push(h3("Steps"));
  blocks.push(box("step", "Enrolment", [
    numbered("After password sign-in you'll see a banner: \"You must enrol a second factor before continuing to the portal.\""),
    numbered("Click \"Begin enrolment\"."),
    numbered("A QR code appears alongside a long text secret (e.g. STB2K7QZCSJ6...)."),
    numbered("Open your authenticator app. Tap \"+\" → \"Scan a QR code\". Point it at the QR on screen."),
    numbered("If your camera can't read it, tap \"Enter a setup key\" instead and paste the long text secret. Account name: \"Ekush ERP\". Type: Time-based."),
    numbered("Your app now shows a 6-digit code that changes every 30 seconds."),
    numbered("Type the current 6-digit code into the field labelled \"Enter the 6-digit code your app generates\"."),
    numbered("Click \"Verify\". The page now shows your verified factor with the date enrolled."),
    numbered("Generate \"recovery codes\" if you wish — 10 single-use codes you can write down to unlock your account if you lose your phone."),
  ]));
  blocks.push(blank());
  blocks.push(box("note", "Daily sign-in after MFA enrolment", [
    p("After enrolment, every sign-in goes: email + password → 6-digit code from your authenticator → dashboard. Three steps total. Codes rotate every 30 seconds."),
  ]));

  // 4. Dashboard
  blocks.push(h2("4. The dashboard at a glance"));
  blocks.push(p("Your home screen. Every X-System page is one click away from here."));
  blocks.push(h3("Layout"));
  blocks.push(mockup([
    "┌──────────────────────────────────────────────────────────────────────────────────┐",
    "│  STAFF PORTAL              ⬇ Export FY2025-26.xlsx   Security   Sign out          │",
    "│  Dashboard                                                                       │",
    "├──────────────────────────────────────────────────────────────────────────────────┤",
    "│  Quick links.                                                                    │",
    "│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐    │",
    "│  │ Trial Balance        │  │ Journals             │  │ Day Book             │    │",
    "│  │ Per-account net      │  │ Browse and enter     │  │ All vouchers in a    │    │",
    "│  │ debit / net credit…  │  │ compound entries.    │  │ date range…          │    │",
    "│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘    │",
    "│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐    │",
    "│  │ Ledgers              │  │ Cash & Bank Book     │  │ Balance Sheet        │    │",
    "│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘    │",
    "│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐    │",
    "│  │ Income Statement     │  │ Changes in Equity    │  │ Notes                │    │",
    "│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘    │",
    "│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐    │",
    "│  │ Annexures            │  │ Cash Flow            │  │ Bank Reconciliation  │    │",
    "│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘    │",
    "│  ┌──────────────────────┐  ┌──────────────────────┐                              │",
    "│  │ Management Fees      │  │ Receivables Aging    │  + Admin tiles (admin only)  │",
    "│  └──────────────────────┘  └──────────────────────┘                              │",
    "└──────────────────────────────────────────────────────────────────────────────────┘",
  ]));
  blocks.push(blank());
  blocks.push(h3("Header buttons"));
  blocks.push(fieldTable([
    { field: "⬇ Export FY2025-26.xlsx", type: "button", desc: "Downloads the complete year-end workbook (Chart of Accounts, all journals, TB-C, IS, BS, CE, Notes, Annexures) for the current fiscal year." },
    { field: "Security", type: "link", desc: "Goes to /account/mfa — manage your authenticator factors and recovery codes." },
    { field: "Sign out", type: "button", desc: "Ends your session." },
  ]));

  // ─────────────────────────────────────────────────────────────
  // PART 2 — DAILY JOURNAL OPERATIONS
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 2 — Daily journal operations", "Entering compound journal entries, voucher numbering, browsing the Journals list, and the Day Book."));

  // 5. Recording a journal entry
  blocks.push(h2("5. Recording a journal entry — step by step"));
  blocks.push(p("Every accounting event lands as a compound journal entry — a header (date, description, txn type, optional fund/cost-centre/instrument tags) plus two or more lines that balance (Σ debit = Σ credit). The system will not let you save an entry that doesn't balance."));
  blocks.push(h3("Where to start"));
  blocks.push(bullet("From the dashboard click \"Journals\" → then \"+ New entry\" (top-right)."));
  blocks.push(bullet("Or jump directly: http://localhost:3000/journals/new."));
  blocks.push(h3("The form"));
  blocks.push(mockup([
    "← DASHBOARD / JOURNALS",
    "New journal entry",
    "Compound entry — add lines until Σ debit = Σ credit.",
    "",
    "┌──────────────────────────────┐  ┌──────────────────────────────┐",
    "│ DATE       2026-04-15        │  │ FISCAL YEAR  FY2025-26    ▾  │",
    "└──────────────────────────────┘  └──────────────────────────────┘",
    "",
    "┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐",
    "│ TXN TYPE │ │ FUND     │ │ COST CENTRE  │ │ INVESTOR │ │ INSTRUMNT│",
    "│   j      │ │ EFUF  ▾  │ │ EFUF       ▾ │ │ A00021   │ │ BRACBANK │",
    "└──────────┘ └──────────┘ └──────────────┘ └──────────┘ └──────────┘",
    "",
    "DESCRIPTION  ┌────────────────────────────────────────────────────────┐",
    "             │ Weekly charge of management fee — EFUF week ending …   │",
    "             └────────────────────────────────────────────────────────┘",
    "",
    "LINES",
    "┌─────────────────────────────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐",
    "│ Management Fee Accrued          │ │  100,000 │ │          │ │ Remove │",
    "├─────────────────────────────────┤ ├──────────┤ ├──────────┤ ├────────┤",
    "│ Management Fee                  │ │          │ │  100,000 │ │ Remove │",
    "└─────────────────────────────────┘ └──────────┘ └──────────┘ └────────┘",
    "                                                                       ",
    "  + Add line                            Σ debit: 100,000  Σ credit: 100,000",
    "                                                                       ",
    "  ┌───────────────────────────┐                                        ",
    "  │  Save journal entry       │  (greyed until Σ debit = Σ credit)     ",
    "  └───────────────────────────┘                                        ",
  ]));

  blocks.push(h3("Field reference"));
  blocks.push(fieldTable([
    { field: "Date", type: "date", required: true, desc: "Entry date. Must fall within the selected fiscal year. The DB blocks entries against closed fiscal years." },
    { field: "Fiscal year", type: "dropdown", required: true, desc: "Only open fiscal years are listed. Defaults to the current open year." },
    { field: "Txn type", type: "text", desc: "Short tag. Use 'j' (journal) for normal entries, 'OB' for opening balances, 'c' for cash transactions. Becomes the voucher prefix: 'j' → JV, 'OB' → OB." },
    { field: "Fund", type: "text", desc: "Optional. Tag with EFUF / EGF / ESRF for per-fund reporting. Free-text — not validated against a list." },
    { field: "Cost centre", type: "dropdown", desc: "Optional. Pick from the cost-centre master. Enables per-cost-centre P&L slicing." },
    { field: "Investor", type: "text", desc: "Optional. Investor code (e.g. A00021) when the entry is investor-specific." },
    { field: "Instrument", type: "text", desc: "Optional. Stock ticker for dividend lines (Note 19.01) or bank-account code for interest-income lines (Note 20)." },
    { field: "Description", type: "text", desc: "Free-form narration. Shown on the Day Book voucher header and on every ledger row." },
    { field: "Account", type: "datalist", required: true, desc: "Per line. Type to filter — picks from the 132 active Chart-of-Accounts entries. Must match exactly." },
    { field: "Debit", type: "number", desc: "Per line. Enter the amount on the debit side OR the credit side, never both on the same line." },
    { field: "Credit", type: "number", desc: "Per line. Same as above — mutually exclusive with Debit on a single line." },
  ]));

  blocks.push(blank());
  blocks.push(box("step", "Complete walkthrough — entering today's management fee accrual", [
    numbered("Click \"+ New entry\" from /journals."),
    numbered("Pick Date = today (or the actual transaction date)."),
    numbered("Fiscal year defaults to FY2025-26 — leave it."),
    numbered("Txn type — type \"j\" (the default)."),
    numbered("Fund — type \"EFUF\" if the entry is for the First Unit Fund."),
    numbered("Cost centre — pick EFUF from the dropdown (if you've created it as a cost centre master)."),
    numbered("Investor / Instrument — leave blank for a fund-level accrual."),
    numbered("Description — \"Weekly charge of management fee — EFUF week ending 2026-04-12\"."),
    numbered("Line 1: Account = Management Fee Accrued, Debit = 100000, Credit blank."),
    numbered("Line 2: Account = Management Fee, Debit blank, Credit = 100000."),
    numbered("Σ debit = 100,000. Σ credit = 100,000. The Save button is now enabled."),
    numbered("Click \"Save journal entry\". The system: (a) assigns a voucher number e.g. JV/25-26/0204, (b) creates two rows in xsystem.journals with the same batch_id, (c) writes an audit_log row, (d) redirects you back to /journals."),
  ]));

  blocks.push(blank());
  blocks.push(box("caution", "Common mistakes", [
    bullet("Account name typed slightly wrong — \"Bank Charge\" vs \"Bank Charges\". The form will reject with \"Unknown account\"."),
    bullet("Date outside the fiscal year — \"Date is outside the selected fiscal year\". Either change the date or the FY."),
    bullet("Fiscal year is closed — \"Fiscal year is closed\". Closed years can't accept new entries. Ask the admin to reopen, or post under a different FY."),
    bullet("Σ debit ≠ Σ credit — the Save button stays greyed. Check for typos in amounts; ensure each line has either debit OR credit, not both."),
  ]));

  // 6. Voucher numbering
  blocks.push(h2("6. Voucher numbering scheme"));
  blocks.push(p("Every saved entry gets a human-readable voucher number assigned automatically. The format is:"));
  blocks.push(mockup([
    "  PREFIX / FY-SHORT / SEQUENCE",
    "",
    "  Examples:",
    "    JV / 25-26 / 0001     ← regular journal vouchers, sequential within the FY",
    "    JV / 25-26 / 0204     ← the entry you just saved (sequence continues)",
    "    OB / 25-26 / 0001     ← opening balance entries (txn type = 'OB')",
    "",
    "  Future voucher types we may add:",
    "    RV / 25-26 / ####     ← Receipt vouchers",
    "    PV / 25-26 / ####     ← Payment vouchers",
    "    CV / 25-26 / ####     ← Contra vouchers",
  ]));
  blocks.push(p("The sequence resets at the start of each fiscal year. The same voucher number is shared across all lines of one compound entry (because they're all part of one batch). Voucher numbers never have gaps within an FY — the system allocates inside the same transaction that saves the entry."));

  // 7. Journals list & filtering
  blocks.push(h2("7. Browsing & filtering the Journals list"));
  blocks.push(p("Reach via dashboard → Journals (or /journals). This is your main ledger search and audit tool."));
  blocks.push(h3("Layout"));
  blocks.push(mockup([
    "← DASHBOARD                                                                       ",
    "STAFF PORTAL                                                       + New entry    ",
    "Journals                                                                          ",
    "919 lines · Σ debit 187,881,009.56 · Σ credit 187,881,009.56 ✓                    ",
    "                                                                                  ",
    "Filters (8 inputs across the row):                                                ",
    " Fiscal year ▾   From: 2026-03-01   To: 2026-03-31   Account: 'fee'…              ",
    " Fund ▾   Type ▾   Description: 'weekly'…   Voucher#: 'JV/25-26/01'…              ",
    " [ Apply filters ]  Clear                              Showing 1–50 of 130        ",
    "                                                                                  ",
    "┌──────────┬──────────────┬──────┬─────────────────────────┬──────┬────────┬────────┐",
    "│ Date     │ Voucher#     │ Type │ Account                 │ Fund │  Debit │ Credit │",
    "├──────────┼──────────────┼──────┼─────────────────────────┼──────┼────────┼────────┤",
    "│ 2026-03-31│ JV/25-26/0198│  j   │ Management Fee Accrued  │ EFUF │ 95,000 │      — │",
    "│ 2026-03-31│ JV/25-26/0198│  j   │ Management Fee          │ EFUF │      — │ 95,000 │",
    "│ 2026-03-30│ JV/25-26/0197│  j   │ Bank Charge             │      │    250 │      — │",
    "│ 2026-03-30│ JV/25-26/0197│  j   │ Brac (A/C 1513204232046001)│  │      — │    250 │",
    "└──────────┴──────────────┴──────┴─────────────────────────┴──────┴────────┴────────┘",
    "                                          Page totals:  95,250.00   95,250.00       ",
    "                                                                                    ",
    "                       ‹‹  ‹ Prev   Page 1 of 3   Next ›  ››                        ",
  ]));
  blocks.push(h3("Filter reference"));
  blocks.push(fieldTable([
    { field: "Fiscal year", type: "dropdown", desc: "Restricts to one FY at a time. The TB / reports use FY scope too." },
    { field: "From / To", type: "date", desc: "Date-range slice within the selected FY. Leave both blank for the full FY." },
    { field: "Account", type: "contains", desc: "Case-insensitive substring match on account name. \"fee\" matches \"Management Fee\", \"Audit Fee\", \"Bank Charge\" no, etc." },
    { field: "Fund", type: "dropdown", desc: "Only EFUF / EGF / ESRF / any. Filters by the fund_code tag on each line." },
    { field: "Type", type: "dropdown", desc: "j (journal) / OB (opening balance) / c (cash) / any." },
    { field: "Description", type: "contains", desc: "Case-insensitive substring match on the description text." },
    { field: "Voucher#", type: "contains", desc: "Starts-with also works. Type 'JV/25-26/01' to see the first 100 vouchers." },
  ]));
  blocks.push(blank());
  blocks.push(p("Header shows σ debit + σ credit + a balance check (✓ if matched, ✗ if off — useful when isolating a problem batch). Per-page totals at the bottom of the table. Pagination at 50 per page."));
  blocks.push(p("Click any account name in the table to drill straight to its Ledger Card (chapter 9)."));

  // 8. Day Book
  blocks.push(h2("8. The Day Book"));
  blocks.push(p("Reach via dashboard → Day Book (or /day-book). Same data as Journals but grouped by date and presented as proper \"vouchers\" — one card per batch with all its lines together."));
  blocks.push(h3("When to use"));
  blocks.push(bullet("Reviewing what was entered on a specific day."));
  blocks.push(bullet("Printing a day's transaction summary for the manager."));
  blocks.push(bullet("Cross-checking a compound entry's structure (all lines in one place)."));
  blocks.push(h3("Layout"));
  blocks.push(mockup([
    "Day Book                                          2026-03-01 → 2026-03-31           ",
    "                                                  47 vouchers · Σ debit 4,827,341    ",
    "                                                                                    ",
    " Date                                            5 vouchers · Σ debit 312,400        ",
    " 2026-03-31                                                                          ",
    " ────────────────────────────────────────────────────────────────────────────────── ",
    "                                                                                    ",
    " ┌──────────────────────────────────────────────────────────────────────────────┐  ",
    " │ JV/25-26/0198 [ j ] [ EFUF ]   Weekly charge of management fee — EFUF       │  ",
    " │                                                                95,000 / 95,000│  ",
    " ├──────────────────────────────────────────────────────────────────────────────┤  ",
    " │   Management Fee Accrued                          95,000.00                  │  ",
    " │   Management Fee                                              95,000.00       │  ",
    " └──────────────────────────────────────────────────────────────────────────────┘  ",
    "                                                                                    ",
    " ┌──────────────────────────────────────────────────────────────────────────────┐  ",
    " │ JV/25-26/0199 [ j ]            Internet bill — March 2026                    │  ",
    " │                                                                  4,500 / 4,500│  ",
    " ├──────────────────────────────────────────────────────────────────────────────┤  ",
    " │   Internet Bill                                     4,500.00                  │  ",
    " │   Brac (A/C 1513204232046001)                                  4,500.00      │  ",
    " └──────────────────────────────────────────────────────────────────────────────┘  ",
  ]));
  blocks.push(p("Default window is the most recent month with activity. Change via From / To. Each line account is clickable → opens its ledger card."));

  // ─────────────────────────────────────────────────────────────
  // PART 3 — DRILL-DOWN REPORTS
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 3 — Drill-down reports", "Per-account ledger cards, cash & bank summary, and the Trial Balance."));

  // 9. Ledger card
  blocks.push(h2("9. The Ledger Card (per account)"));
  blocks.push(p("Reach via /ledger (then click an account) or from any account name in the Journals list / Day Book / Cash Book / Trial Balance. URL: /ledger/<account-name>."));
  blocks.push(h3("What it shows"));
  blocks.push(bullet("Header: account name, normal-balance badge (DEBIT / CREDIT), category, active flag, \"Edit account →\" link."));
  blocks.push(bullet("Filter row: fiscal year + optional From / To date range."));
  blocks.push(bullet("Four summary tiles: Opening balance · Period debit · Period credit · Closing balance (highlighted)."));
  blocks.push(bullet("Transactions table with running balance column (Dr / Cr suffix)."));
  blocks.push(h3("Layout"));
  blocks.push(mockup([
    "← DASHBOARD / CHART OF ACCOUNTS / Management Fee Accrued                            ",
    "                                                                                    ",
    "LEDGER CARD                                                Edit account →           ",
    "Management Fee Accrued        [DEBIT normal]  Receivables                           ",
    "                                                                                    ",
    "Fiscal year [FY2025-26 ▾]   From [2025-07-01]   To [2026-03-31]   [ Apply ]         ",
    "                                                                                    ",
    "┌────────────────────┬───────────────────┬───────────────────┬──────────────────┐   ",
    "│ OPENING BALANCE    │ PERIOD DEBIT      │ PERIOD CREDIT     │ CLOSING BALANCE  │   ",
    "│ 0.00               │ 8,500,000 Dr      │ 6,200,000 Cr      │ 2,300,000 Dr     │   ",
    "│ as at 2025-07-01   │                   │                   │ 187 lines        │   ",
    "└────────────────────┴───────────────────┴───────────────────┴──────────────────┘   ",
    "                                                                                    ",
    "┌──────────┬─────────────┬──────┬───────────────────┬──────┬────────┬────────┬─────────┐",
    "│ Date     │ Voucher#    │ Type │ Description       │ Fund │ Debit  │ Credit │ Running │",
    "├──────────┼─────────────┼──────┼───────────────────┼──────┼────────┼────────┼─────────┤",
    "│          │             │      │ Opening 2025-07-01│      │        │        │   —     │",
    "│2025-07-04│JV/25-26/0001│  j   │ Weekly mgmt fee   │ EFUF │ 95,123 │        │ 95,123 Dr│",
    "│2025-07-11│JV/25-26/0002│  j   │ Weekly mgmt fee   │ EFUF │ 96,440 │        │191,563 Dr│",
    "│2025-10-04│JV/25-26/0045│  c   │ Mgmt fee received │ EFUF │        │1,200,0 │  (much) │",
    "└──────────┴─────────────┴──────┴───────────────────┴──────┴────────┴────────┴─────────┘",
    "                                  Period totals:   8,500,000  6,200,000  2,300,000 Dr",
  ]));
  blocks.push(blank());
  blocks.push(box("note", "Reading the running balance", [
    p("The Running balance column accumulates debit − credit chronologically and shows the result with a Dr / Cr suffix. For a DEBIT-normal account (asset / expense), positive balance is Dr. For a CREDIT-normal account (liability / equity / income), the running balance flips to Cr once credits exceed debits."),
  ]));

  // 10. Cash & Bank Book
  blocks.push(h2("10. Cash & Bank Book"));
  blocks.push(p("Reach via dashboard → Cash & Bank Book (or /cash-book). One row per cash/bank account, with the closing balance for the selected fiscal year. Click any row to drill into that account's ledger card."));
  blocks.push(h3("Detection"));
  blocks.push(p("Accounts appear here if they meet either condition:"));
  blocks.push(bullet("Their group / category contains the word \"cash\" or \"bank\" (case-insensitive)."));
  blocks.push(bullet("Their name matches a known bank/MM keyword (Brac, UCB, Bkash, MTBL, DBBL, EBL, etc.) AND their normal balance is DEBIT (so a \"Margin Loan From UCB\" stays out — it's a credit/liability)."));
  blocks.push(p("To force-include an account, edit it on /admin/accounts and set its Category to \"Cash and bank balances\"."));
  blocks.push(h3("Use case"));
  blocks.push(p("This is your AMC's net cash position at any point in time. Footer shows Σ Dr / Σ Cr across all detected accounts. Net position tile shows the consolidated bank+cash holding."));

  // 11. Trial Balance
  blocks.push(h2("11. Trial Balance"));
  blocks.push(p("Reach via dashboard → Trial Balance (or /trial-balance). This is THE primary cross-check: every account that had activity in the FY, with its period debit, period credit, net debit (K column in the workbook), net credit (L column)."));
  blocks.push(h3("Header"));
  blocks.push(bullet("FY picker (loads any FY in the system)."));
  blocks.push(bullet("Export buttons: ⬇ Export .xlsx, ⬇ CSV, 🖨 Print / Save as PDF."));
  blocks.push(bullet("Balance badge (top-right): ✓ Balanced if Σ K = Σ L; ✗ Out of balance with the delta amount otherwise."));
  blocks.push(h3("Layout"));
  blocks.push(mockup([
    "← DASHBOARD                                                                       ",
    "STAFF PORTAL                       Fiscal year [FY2025-26 ▾] [View] [⬇ Export .xlsx]",
    "Trial Balance                                                                     ",
    "                                                                                  ",
    "FY2025-26 — 2025-07-01 → 2026-06-30                              ✓ Balanced       ",
    "                                                                                  ",
    "┌────┬────────────────────────────┬───────┬─────────┬──────────┬─────────┬──────────┐",
    "│ SL │ Account                    │ Normal│ Period  │ Period   │ Net     │ Net      │",
    "│    │                            │       │ Debit   │ Credit   │ Debit K │ Credit L │",
    "├────┼────────────────────────────┼───────┼─────────┼──────────┼─────────┼──────────┤",
    "│  1 │ Computers                  │ DE    │     3.00│         —│    3.00│         —│",
    "│  2 │ Security Deposit-Office    │ DE    │  200,000│         —│ 200,000│         —│",
    "│ 11 │ Share Capital              │ CR    │        —│60,000,000│       —│60,000,000│",
    "│ 56 │ Management Fee Accrued     │ DE    │8,500,000│ 6,200,000│2,300,000│         —│",
    "│ 90 │ Management Fee             │ DE    │8,500,000│         —│8,500,000│         —│",
    "│... │                            │       │         │          │         │          │",
    "├────┼────────────────────────────┼───────┼─────────┼──────────┼─────────┼──────────┤",
    "│    │ TOTALS                     │       │187,881M │  187,881M│ 152,440M│ 152,440M │",
    "└────┴────────────────────────────┴───────┴─────────┴──────────┴─────────┴──────────┘",
  ]));
  blocks.push(blank());
  blocks.push(box("note", "Reconciling against the workbook", [
    p("If you have the original F.S March 2026.xlsx open in Excel, switch to the TB-C sheet. The X-System Trial Balance should match that sheet line-for-line. Tip: use the Account search (Ctrl+F in the browser) or filter the journals page to locate any line that doesn't agree."),
  ]));

  // ─────────────────────────────────────────────────────────────
  // PART 4 — FINANCIAL STATEMENTS
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 4 — Financial statements", "The audited-statement views: IS, BS, CE, Notes, Cash Flow, Annexures."));

  blocks.push(h2("12. Income Statement"));
  blocks.push(p("Reach via dashboard → Income Statement (or /income-statement). Renders P&L + OCI for the selected fiscal year, in the same row order as the workbook IS sheet."));
  blocks.push(bullet("Top-line items: Management fee income, Other operating income, Total income."));
  blocks.push(bullet("Operating expenses lines (with breakdowns)."));
  blocks.push(bullet("Profit before tax → less current-tax provision → Profit for the year."));
  blocks.push(bullet("Other comprehensive income (fair-value gains/losses)."));
  blocks.push(bullet("Total comprehensive income."));
  blocks.push(p("Three optional URL overrides for accountant adjustments: ?mgmtFeeTax=… &fvLoss=… &fvRecv=… — used when the current-tax provision formula needs a manual tweak per Note 2."));

  blocks.push(h2("13. Balance Sheet"));
  blocks.push(p("Reach via /balance-sheet. The Statement of Financial Position. Rendered in the workbook's BS sheet order — Assets (non-current + current), Equity, Liabilities."));
  blocks.push(p("The X-System computes every line from the underlying journals + opening balances + investment holdings + fixed-asset register. Σ Assets must equal Σ Equity + Σ Liabilities. If they don't agree, the page surfaces a banner with the delta — usually means an unposted fair-value adjustment."));

  blocks.push(h2("14. Changes in Equity"));
  blocks.push(p("Reach via /changes-in-equity. Rollforward of paid-up capital, fair-value reserve, and retained earnings. Each starts at its opening balance, adds the FY's movements (issues, fair-value adjustments, profit transfer), ends at closing. The total reconciles against the BS Equity total."));

  blocks.push(h2("15. Notes 4–27"));
  blocks.push(p("Reach via /notes. Every disclosure note your auditor wants:"));
  blocks.push(bullet("Note 4: Property, plant and equipment (PPE) — backed by /admin/banks records and the FixedAsset register."));
  blocks.push(bullet("Note 5–9: Investments, cash & bank, receivables, prepayments."));
  blocks.push(bullet("Note 10–12: Liabilities & accruals."));
  blocks.push(bullet("Note 13: Share capital (backed by Shareholder master)."));
  blocks.push(bullet("Note 14–16: Reserves."));
  blocks.push(bullet("Note 17–24: Income & expense breakdowns."));
  blocks.push(bullet("Note 25: Earnings per share."));
  blocks.push(bullet("Note 26: NAV per share."));
  blocks.push(bullet("Note 27: Employee minimum-pay disclosure (per FY, backed by EmployeeDisclosure master)."));

  blocks.push(h2("16. Cash Flow"));
  blocks.push(p("Reach via /cash-flow. Not a full IAS-7 indirect statement; instead a \"where did our cash come from / go to\" breakdown by counter-account category."));
  blocks.push(h3("How it's built"));
  blocks.push(numbered("Find every journal line that hits a cash/bank account in the date range."));
  blocks.push(numbered("For each such line, look at the OTHER lines in the same batch (= counter-accounts)."));
  blocks.push(numbered("Weight the cash movement by each counter's share of the batch."));
  blocks.push(numbered("Bucket by counter-account's category (Operating income, Operating expenses, Investments, etc.)."));
  blocks.push(numbered("Show: inflow / outflow / net per bucket, then drill-down per counter-account."));
  blocks.push(p("Set the category on each Chart-of-Accounts row (via /admin/accounts) to control the bucketing. Accounts without a category appear under \"Uncategorised\"."));

  blocks.push(h2("17. Annexures"));
  blocks.push(p("Reach via /annexures. Two annexures used by the audited statements:"));
  blocks.push(bullet("Annexure-A — PPE register. Per-asset cost, accumulated depreciation, written-down value. Backed by FixedAsset + FixedAssetDepreciation models."));
  blocks.push(bullet("Annexure-B — Investments. Per-instrument: category, instrument name, quantity, avg cost, market rate, unrealised G/L. Backed by InvestmentHolding model. The aggregated G/L feeds the IS OCI line and Note 24."));

  // ─────────────────────────────────────────────────────────────
  // PART 5 — RECONCILIATION & VERIFICATION
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 5 — Reconciliation & verification", "Bank reconciliation, receivables aging, and cross-system management-fee verification."));

  blocks.push(h2("18. Bank Reconciliation Statement (BRS)"));
  blocks.push(p("Reach via dashboard → Bank Reconciliation (or /bank-reconciliation). Records the bank's letter / PDF closing balance and compares against X-System's book balance for the same period."));
  blocks.push(h3("Workflow"));
  blocks.push(box("step", "Monthly BRS", [
    numbered("Receive the bank statement letter or PDF from BRAC / UCB / Bkash for the month."),
    numbered("Click \"+ Record statement\" on /bank-reconciliation."),
    numbered("Pick the Bank/Cash account from the dropdown (auto-filtered to bank-typed ledgers)."),
    numbered("Pick the FY."),
    numbered("Enter Period Start + Period End matching the bank statement window."),
    numbered("Enter the Statement Opening Balance (top of the bank's letter)."),
    numbered("Enter the Statement Closing Balance (bottom)."),
    numbered("Optional: Source = filename of the PDF you're working from, Notes for context."),
    numbered("Save."),
    numbered("On the detail page (/bank-reconciliation/<id>), see Statement vs Book opening + period D/C + closing side-by-side."),
    numbered("If ✓ Reconciled — done."),
    numbered("If ✗ Difference — drill into the period activity drill at the bottom of the page, find the missing or duplicated entries, fix in /journals."),
  ]));
  blocks.push(blank());
  blocks.push(box("note", "Per-line clearance is Tier 3", [
    p("The current BRS does balance-level comparison only. Per-cheque clearance (cleared / outstanding cheques and deposits in transit) is a planned Tier-3 feature — it requires importing the bank's transaction CSV and matching individual lines against journals."),
  ]));

  blocks.push(h2("19. Receivables Aging"));
  blocks.push(p("Reach via dashboard → Receivables Aging (or /receivables). Shows what's still owing on receivable accounts, bucketed by age."));
  blocks.push(h3("Accounts covered"));
  blocks.push(bullet("Management Fee Accrued — what funds owe the AMC."));
  blocks.push(bullet("AIT Receivables against Management Fee — tax recoverable."));
  blocks.push(bullet("Dividend Receivable — declared but unreceived dividends."));
  blocks.push(bullet("Other Receivables — catch-all."));
  blocks.push(h3("How aging is computed"));
  blocks.push(p("FIFO settlement. Each debit on the receivable account opens a new outstanding item. Each credit (the payment received) settles the oldest open items first. Whatever remains open is aged from its original debit date to the as-of date."));
  blocks.push(h3("Buckets"));
  blocks.push(bullet("0–30 days · 31–60 · 61–90 · 91–180 · 180+"));
  blocks.push(p("Header tile shows total open balance + item count. Below: per-bucket totals, per-fund split (using each line's fundCode tag), and a drill-down per bucket showing each open item with date, voucher, fund, description, original amount, outstanding, age."));

  blocks.push(h2("20. Management Fee Import (cross-system)"));
  blocks.push(p("Reach via dashboard → Management Fees (or /management-fees). This is the cross-verification page: it pulls each fund's recorded management fee from its FIN_STATS xlsx (uploaded daily via ekush-portal admin panel) so you can cross-check the AMC's books."));
  blocks.push(h3("Data flow"));
  blocks.push(mockup([
    "  ┌──────────────────────────────┐                                                 ",
    "  │ ekush-portal admin panel     │  daily upload of EFUF / EGF / ESRF .xlsx        ",
    "  │ (you / fund accountant)      │                                                 ",
    "  └──────────────┬───────────────┘                                                 ",
    "                 ▼                                                                 ",
    "  ┌──────────────────────────────┐                                                 ",
    "  │ public.daily_fund_uploads    │  FIN_STATS rows with filePath = Vercel Blob URL ",
    "  │ (shared Postgres)            │                                                 ",
    "  └──────────────┬───────────────┘                                                 ",
    "                 ▼                                                                 ",
    "  ┌──────────────────────────────┐                                                 ",
    "  │ X-System /management-fees    │  '↻ Re-import' fetches each fund's xlsx, sums   ",
    "  │ ManagementFeeImport rows     │  Management Fee debits in fund's Journals sheet ",
    "  └──────────────────────────────┘                                                 ",
  ]));
  blocks.push(h3("Steps"));
  blocks.push(box("step", "Re-import + verify", [
    numbered("Open /management-fees."),
    numbered("Confirm the \"Latest FIN_STATS uploads\" panel shows 3 entries (one per fund) with today's report date."),
    numbered("Click \"↻ Re-import from latest FIN_STATS\"."),
    numbered("Wait ~30 seconds. The action downloads each xlsx (~200KB–1MB), parses the Journals sheet, sums every \"Management Fee\" debit in the period (FY start → upload date)."),
    numbered("Three rows appear in the Imports table — one per fund — with the computed amount."),
    numbered("Cross-check against your own books. Open the AMC's /ledger/Management Fee Accrued or /ledger/Management Fee, sum debits per fund (use the Fund filter on /journals)."),
    numbered("If a number looks off, type the correct amount in the \"Manual override\" column on /management-fees, click Save. The row's status auto-flips to 'reviewed'."),
    numbered("When you're satisfied, change the status dropdown to 'verified' and click Set. The row stamps verified_at + verified_by."),
  ]));

  // ─────────────────────────────────────────────────────────────
  // PART 6 — MASTER DATA (ADMIN)
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 6 — Master data (admin)", "Chart of Accounts, Account Groups, Bank Account Master, Cost Centres. These are admin-only."));

  blocks.push(h2("21. Chart of Accounts"));
  blocks.push(p("Reach via /admin/accounts (admin role required). Lists all 132 chart-of-accounts entries. Search, filter to include inactive, click any name to open its ledger card."));
  blocks.push(h3("Add a new account"));
  blocks.push(box("step", "Create CoA entry", [
    numbered("Click \"+ New account\" top-right."),
    numbered("Name — unique. Becomes the FK target for journal entries; choose carefully (renames cascade but are visible in audit log)."),
    numbered("Sl — display order. Auto-suggests next number (133)."),
    numbered("Normal balance — DEBIT (assets, expenses) or CREDIT (liabilities, equity, income). Drives the +/− sign on TB calculations."),
    numbered("Group — pick from the hierarchical group tree (Asset / Liability / Equity / Income / Expense at top level). Drives statement placement."),
    numbered("Category (optional free text) — used historically by the cash-book detection and bucketing on /cash-flow."),
    numbered("Click \"Create account\". Redirects back to the list with a success banner."),
  ]));
  blocks.push(h3("Edit / deactivate"));
  blocks.push(p("Click \"edit →\" on any row. You can rename (journals cascade automatically), change group, change SL. The Deactivate button hides the account from new-entry dropdowns but keeps history intact. Reactivate via the same button."));

  blocks.push(h2("22. Account Groups"));
  blocks.push(p("Reach via /admin/groups. The hierarchical group tree drives statement placement. Each group has a nature (ASSET / LIABILITY / EQUITY / INCOME / EXPENSE), an optional parent, and a sort order."));
  blocks.push(h3("Default tree (29 seeded groups)"));
  blocks.push(mockup([
    "Assets [ASSET]                                                                     ",
    "├── Non-current assets [ASSET]                                                     ",
    "│   ├── Property, plant and equipment [ASSET]                                      ",
    "│   ├── Long-term investments [ASSET]                                              ",
    "│   └── Long-term receivables [ASSET]                                              ",
    "└── Current assets [ASSET]                                                         ",
    "    ├── Cash and bank balances [ASSET]                                             ",
    "    ├── Receivables [ASSET]                                                        ",
    "    ├── Short-term investments [ASSET]                                             ",
    "    └── Prepayments and advances [ASSET]                                           ",
    "Liabilities [LIABILITY]                                                            ",
    "├── Non-current liabilities                                                        ",
    "│   └── Long-term borrowings                                                       ",
    "└── Current liabilities                                                            ",
    "    ├── Accruals and payables                                                      ",
    "    ├── Withholding and taxes payable                                              ",
    "    └── Provisions                                                                 ",
    "Equity [EQUITY]                                                                    ",
    "├── Share capital                                                                  ",
    "└── Reserves                                                                       ",
    "Income [INCOME]                                                                    ",
    "├── Operating income                                                               ",
    "├── Finance income                                                                 ",
    "└── Other income                                                                   ",
    "Expenses [EXPENSE]                                                                 ",
    "├── Operating expenses                                                             ",
    "├── Finance expenses                                                               ",
    "├── Tax expenses                                                                   ",
    "└── Uncategorised  (catch-all)                                                     ",
  ]));
  blocks.push(p("Tree view shows per-group direct balance + rollup balance (children included). Add custom groups via the form at the bottom. Reserved groups can't be deleted; user-added groups can if empty."));

  blocks.push(h2("23. Bank Account Master"));
  blocks.push(p("Reach via /admin/banks. Structured banking metadata layered on top of CoA bank ledgers."));
  blocks.push(h3("Add a bank account"));
  blocks.push(bullet("Ledger account — pick from the dropdown (auto-filtered to DEBIT-normal accounts with cash/bank in name or category)."));
  blocks.push(bullet("Bank name — e.g. \"BRAC Bank Limited\"."));
  blocks.push(bullet("Branch — e.g. \"Gulshan\"."));
  blocks.push(bullet("Account # — your account number."));
  blocks.push(bullet("Type — current / savings / std / md / fdr / mobile_money / other."));
  blocks.push(bullet("Currency — defaults to BDT."));
  blocks.push(bullet("IFSC + SWIFT — for international wires."));
  blocks.push(bullet("Opening balance — bank's books at system go-live (not posted as a journal — info only for BRS)."));
  blocks.push(bullet("BRS start date — date from which reconciliation tracking starts."));

  blocks.push(h2("24. Cost Centres"));
  blocks.push(p("Reach via /admin/cost-centres. Cost centres are dimensional tags on journal lines — they let you produce per-fund, per-department, per-project reports without polluting the Chart of Accounts."));
  blocks.push(h3("Recommended cost centres for the AMC"));
  blocks.push(fieldTable([
    { field: "EFUF", type: "fund", desc: "Ekush First Unit Fund — tag all EFUF-related journals." },
    { field: "EGF", type: "fund", desc: "Ekush Growth Fund." },
    { field: "ESRF", type: "fund", desc: "Ekush Stable Return Fund." },
    { field: "ADMIN", type: "department", desc: "AMC head-office costs that don't belong to any specific fund." },
    { field: "MARKETING", type: "department", desc: "Sales & marketing expenses." },
  ]));
  blocks.push(p("On the /admin/cost-centres page you can see per-centre activity: line count, Σdebit, Σcredit, net (Dr or Cr). Once you've created cost centres, they appear as a dropdown on /journals/new."));

  // ─────────────────────────────────────────────────────────────
  // PART 7 — PERIOD MANAGEMENT (ADMIN)
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 7 — Period management (admin)", "Opening balances entry and fiscal-year close + roll-forward."));

  blocks.push(h2("25. Opening Balances"));
  blocks.push(p("Reach via /admin/opening-balances. Per-FY editor for the AccountOpeningBalance table. Use this at the start of a new fiscal year (or via the roll-forward action below)."));
  blocks.push(h3("Use cases"));
  blocks.push(bullet("First-time system go-live: type the closing balances from your prior accounting system / workbook as opening balances on the new FY."));
  blocks.push(bullet("After roll-forward: review the auto-populated openings; tweak any that need manual override."));
  blocks.push(bullet("Audit adjustment: at year-end, an auditor finds an error in the prior year — record the correction as an opening-balance adjustment."));
  blocks.push(h3("Form per row"));
  blocks.push(p("Each CoA account is listed with: Sl · Account · Group · Opening Debit · Opening Credit · Note. Type values, click \"save\" per row. The header tile shows Σ debit + Σ credit + a balanced-check (✓ if matched)."));
  blocks.push(blank());
  blocks.push(box("caution", "Debit or credit, not both", [
    p("Each account can have opening on ONE side only. The action rejects rows with both debit and credit non-zero."),
  ]));

  blocks.push(h2("26. Fiscal Years + Roll-Forward"));
  blocks.push(p("Reach via /admin/fiscal-years. List all fiscal years, create new ones, close / reopen, and run the year-end roll-forward."));
  blocks.push(h3("Close a fiscal year"));
  blocks.push(box("step", "Year-end close", [
    numbered("Complete all year-end adjustments (depreciation, tax provision, fair-value journals)."),
    numbered("Verify Trial Balance is ✓ Balanced for the year."),
    numbered("Generate the year-end .xlsx and hand to auditors."),
    numbered("Once audit is final and signed, click \"close\" on the FY row."),
    numbered("Database trigger now blocks any further journal mutation on that FY."),
    numbered("If an audit-adjustment surfaces later, an admin can click \"reopen\" — record the adjustment — then close again."),
  ]));
  blocks.push(h3("Roll-forward"));
  blocks.push(p("Computes the closing balance of each account in the source FY and seeds opening balances on the target FY."));
  blocks.push(box("step", "Run roll-forward", [
    numbered("Both FYs must already exist. Source = the year just closed; target = the new year (use the form above to create it first)."),
    numbered("Pick a \"Retained Earnings\" account from the dropdown — all INCOME/EXPENSE accounts close into this one as a net profit/loss credit."),
    numbered("Click \"↻ Roll forward\"."),
    numbered("The engine: (a) for each Asset / Liability / Equity account, computes opening + period activity = closing → seeds as opening on target FY, (b) for each Income / Expense account, accumulates a net P&L number → posts it as opening on the Retained Earnings account of target FY."),
    numbered("On success you'll see a banner like \"Rolled forward: 70 BS account opening balances, 50 IS accounts collapsed into Retained Earnings (net P&L 8,453,231.50)\"."),
    numbered("Visit /admin/opening-balances?fy=<new-fy-id> to verify — should be balanced (Σ debit = Σ credit)."),
  ]));
  blocks.push(blank());
  blocks.push(box("note", "Idempotent — safe to re-run", [
    p("Roll-forward upserts. If you fix a journal in the source FY (during the audit phase) and re-run roll-forward, the target FY's opening balances are recomputed and overwritten. No risk of doubling-up."),
  ]));

  // ─────────────────────────────────────────────────────────────
  // PART 8 — AGENTS
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 8 — Selling agents", "Inviting + approving + editing terms for selling agents."));

  blocks.push(h2("27. Inviting & approving an agent"));
  blocks.push(box("step", "Onboard a new agent", [
    numbered("Go to /admin/agents → click \"+ Invite agent\"."),
    numbered("Fill in: Code (e.g. S00007), Full name, Email, Phone (optional)."),
    numbered("Click \"Create\". A new SellingAgent row is created with status = pending."),
    numbered("On the agent's detail page, click \"Approve\". Two AgentTerm rows are auto-created with default percentages: equity 0.20/0.40/0.35 and fixed_income 0.20/0.20/0.15, 6-month/100% clawback."),
    numbered("Agent status is now \"approved\" and they can be associated with investors via the cross-system ekush-web/portal integration."),
  ]));

  blocks.push(h2("28. Editing commission terms"));
  blocks.push(p("On the agent's detail page, the \"Current terms — edit in place\" section lets you change percentages for either fund category. Two ways:"));
  blocks.push(h3("Option A — Edit the current term in place"));
  blocks.push(p("Just type the new percentages in the inline form and click Save. Useful for fixing a typo or making a same-day correction."));
  blocks.push(h3("Option B — Introduce a new effective period"));
  blocks.push(p("Use when the agreement genuinely changes rates effective a future date. Click \"+ Add new term\"; fill in fund category, new rates, and effective-from date. The system:"));
  blocks.push(numbered("Closes the currently-open term for that fund category (stamps its effective_to to one day before the new effective_from)."));
  blocks.push(numbered("Inserts a new row with the new percentages and your effective_from date."));
  blocks.push(numbered("Older commissions already calculated against the old term are unaffected — the engine always looks up the term by date."));
  blocks.push(h3("Calculation methodology — read carefully"));
  blocks.push(p("Three components — implemented in src/lib/commission-engine.ts:"));

  blocks.push(h4("Upfront — paid once at investor sourcing"));
  blocks.push(mockup([
    "  amount = initial_units × unit_price_at_sourcing × upfront_pct",
    "",
    "  Example: 10,000 units × BDT 10.50 × 0.0020 (= 0.20%)  =  BDT 210.00",
  ]));
  blocks.push(bullet("Term in effect on sourced_on is locked in."));
  blocks.push(bullet("Skipped if is_direct_subscription = true."));
  blocks.push(bullet("Posted as a single CommissionRun, type = upfront."));

  blocks.push(h4("Trail — paid quarterly on weekly average holding value"));
  blocks.push(mockup([
    "  weekly_value(week) = units_outstanding_at_week × unit_nav_at_week",
    "  avg = mean( weekly_value over the quarter )",
    "  amount = avg × ( rate_pa ÷ 4 )",
  ]));
  blocks.push(bullet("Tier switch at exactly sourced_on + 12 months. Quarter uses Y1 if its midpoint is before, Y2+ if after."));
  blocks.push(bullet("Redeemed units stop earning trail from redemption date (clause 6.3)."));
  blocks.push(bullet("Cron runs 03:00 UTC on the 1st of Jan/Apr/Jul/Oct, computing the just-completed quarter."));

  blocks.push(h4("Clawback — recovered if investor redeems early"));
  blocks.push(mockup([
    "  applies when: redemption_date  ≤  sourced_on + clawback_months",
    "  ratio  = redeemed_units ÷ initial_units",
    "  amount = − upfront_paid × ratio × clawback_pct",
  ]));
  blocks.push(bullet("Negative-amount CommissionRun, type = clawback — reduces what the AMC owes the agent."));
  blocks.push(bullet("Multiple redemptions inside the window each generate their own clawback row."));
  blocks.push(bullet("Skipped if is_direct_subscription = true."));

  // ─────────────────────────────────────────────────────────────
  // PART 9 — UTILITIES
  // ─────────────────────────────────────────────────────────────
  blocks.push(...chapterIntro("Part 9 — Utilities", "Exports, printing, and the audit log."));

  blocks.push(h2("29. Exports — Excel, CSV, Print/PDF"));
  blocks.push(h3("Year-end Excel (full workbook)"));
  blocks.push(p("⬇ Export FY2025-26.xlsx button in the dashboard header → downloads a multi-sheet xlsx containing: Chart of Accounts · Journals · TB-C · IS. · BS. · CE · Notes. · Annexure march. Same layout as the original F.S March 2026.xlsx so auditors don't notice the system change."));
  blocks.push(h3("CSV per report"));
  blocks.push(p("Several report pages have a ⬇ CSV button — Trial Balance, Receivables, etc. Click → downloads UTF-8 CSV (RFC 4180), opens cleanly in Excel."));
  blocks.push(h3("Print to PDF"));
  blocks.push(p("Almost every report page has a 🖨 Print / Save as PDF button. Clicks the browser's print dialog. In Chrome / Edge: pick \"Destination: Save as PDF\". The page renders with a print-friendly stylesheet — black on white, serif font, table headers repeat on each page, no UI chrome."));

  blocks.push(h2("30. Audit Log"));
  blocks.push(p("Reach via /admin/audit (admin + auditor roles)."));
  blocks.push(p("Every mutation on journals, agent_terms, commission_runs, and fiscal_years writes an audit row via a DB trigger. The viewer shows when, who (actor email or system), action (e.g. journals.create), target table + ID, and a collapsible JSON diff of before / after."));
  blocks.push(h3("Filters"));
  blocks.push(bullet("Action — \"journals.create\", \"agent_terms.update\", etc."));
  blocks.push(bullet("Target table — journals / agent_terms / commission_runs / fiscal_years."));
  blocks.push(bullet("Actor UUID — paste a user's id to see every action they took."));
  blocks.push(bullet("Target ID — paste a row's UUID to see its full mutation history."));
  blocks.push(bullet("Date range."));
  blocks.push(p("Quick-filter chips at the top show top-10 actions / tables / actors with counts — click any chip to jump to that filter."));

  // ─────────────────────────────────────────────────────────────
  // APPENDIX
  // ─────────────────────────────────────────────────────────────
  blocks.push(h1("Appendix — FAQ & Troubleshooting"));

  blocks.push(h3("Q: My Trial Balance is ✗ Out of balance — what now?"));
  blocks.push(bullet("Click the badge to see Σdebit − Σcredit = delta. The delta tells you how much you're off by."));
  blocks.push(bullet("Filter /journals to the same FY → check Σ debit and Σ credit in the header — if they match, the issue is in the TB calculation, not the journals (rare; report a bug)."));
  blocks.push(bullet("Most likely a journal was saved without the unbalanced check (impossible via UI; only happens via the loader script). Spot-check recent entries."));

  blocks.push(h3("Q: I closed an FY and now need to fix an entry."));
  blocks.push(bullet("Go to /admin/fiscal-years → click \"reopen\" on the affected FY."));
  blocks.push(bullet("Make the correction in /journals."));
  blocks.push(bullet("Click \"close\" again."));
  blocks.push(bullet("If you'd already run roll-forward, run it again — it's idempotent and will recompute the target FY's openings."));

  blocks.push(h3("Q: I forgot my password / lost my phone."));
  blocks.push(bullet("Password: use \"Forgot password\" on the login page (sends email reset)."));
  blocks.push(bullet("MFA: if you have recovery codes (generated when you enrolled), use the \"Lost your authenticator? Use a recovery code\" link on the MFA challenge page."));
  blocks.push(bullet("No recovery codes: ask the admin to delete your MFA factor from Supabase dashboard. You'll re-enrol on next sign-in."));

  blocks.push(h3("Q: An account has a different normal balance than I expect."));
  blocks.push(bullet("Go to /admin/accounts → edit the account → change the normal balance radio → save."));
  blocks.push(bullet("Existing journals are unaffected; this only changes how the account is presented (which column it shows in on TB / IS / BS)."));

  blocks.push(h3("Q: How do I know if a fund FIN_STATS upload has been imported?"));
  blocks.push(bullet("/management-fees lists every import — fund, period, computed amount, status."));
  blocks.push(bullet("If the latest upload doesn't appear, click \"↻ Re-import from latest FIN_STATS\". If parsing fails for that fund, you'll see an error in the success banner."));

  blocks.push(h3("Q: A cron job didn't run."));
  blocks.push(bullet("Check the Vercel dashboard → Crons tab. tb-check runs hourly, daily-accrual at 02:00 UTC, quarterly-trail on the 1st of Jan/Apr/Jul/Oct."));
  blocks.push(bullet("Manual trigger: from a shell, curl the endpoint with the x-cron-secret header (see OPERATIONS.md §5)."));

  blocks.push(pageBreak());
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 600 },
      children: [new TextRun({ text: "— End of tutorial —", italics: true, color: COLOR.fg_muted, size: 24, font: "Calibri" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [new TextRun({ text: "Questions? syed@eduintbd.com", size: 20, color: COLOR.fg_muted, font: "Calibri" })],
    }),
  );

  return new Document({
    creator: "X-System",
    title: "Accountant's Tutorial",
    description: "Page-by-page tutorial covering every screen of the X-System",
    styles: {
      paragraphStyles: [
        {
          id: "default",
          name: "Default",
          basedOn: "Normal",
          next: "Normal",
          run: { font: "Calibri", size: 22 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "main-numbering",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 360 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } },
        },
        children: blocks,
      },
    ],
  });
}

async function main() {
  const doc = buildDoc();
  const buffer = await Packer.toBuffer(doc);
  const outPath = path.resolve("docs/X-System-Accountant-Tutorial.docx");
  writeFileSync(outPath, buffer);
  const sizeKB = (buffer.length / 1024).toFixed(1);
  console.log(`✓ Wrote ${outPath} (${sizeKB} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
