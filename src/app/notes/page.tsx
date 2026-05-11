// /notes — Notes 4.00 – 27.00 to the financial statements (spec §5.11
// Notes. sheet). Rendered as a single scrollable page with a TOC; each
// note is a card. Notes that depend on data not yet in the schema (PPE
// register, shareholders, opening balances, per-fund splits, employee
// counts) still render the rows we can compute and surface the gap.
//
// Query params (same as /income-statement, /balance-sheet):
//   ?fy=…&taxProvision=…&fvLoss=…&fvRecv=…

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import { requireStaff } from "@/lib/auth";
import { buildNotes, type Note, type NoteRow } from "@/lib/notes";
import { getNotesData } from "@/lib/notes-data";

type Search = {
  fy?: string;
  taxProvision?: string;
  fvLoss?: string;
  fvRecv?: string;
};

async function loadFiscalYears(): Promise<Array<{ id: string; label: string }> | null> {
  try {
    return await prisma.fiscalYear.findMany({
      orderBy: { startsOn: "desc" },
      select: { id: true, label: true },
    });
  } catch {
    return null;
  }
}

function parseOverrides(sp: Search): StatementOverrides {
  const out: StatementOverrides = {};
  const tax = Number(sp.taxProvision);
  if (Number.isFinite(tax) && sp.taxProvision !== undefined) out.currentTaxProvision = tax;
  const loss = Number(sp.fvLoss);
  if (Number.isFinite(loss) && sp.fvLoss !== undefined) out.unrealisedFairValueLoss = loss;
  const recv = Number(sp.fvRecv);
  if (Number.isFinite(recv) && sp.fvRecv !== undefined) out.fairValueReceivableAdjustment = recv;
  return out;
}

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const fiscalYears = await loadFiscalYears();

  if (fiscalYears === null) {
    return <NotConnected />;
  }
  if (fiscalYears.length === 0) {
    return <NoFiscalYears />;
  }

  const selectedId = sp.fy ?? fiscalYears[0].id;
  const overrides = parseOverrides(sp);

  let notes: Note[] | null = null;
  let fyLabel = "";
  try {
    const [statements, data] = await Promise.all([
      getStatements(selectedId, overrides),
      getNotesData(selectedId),
    ]);
    fyLabel = statements.fiscalYear.label;
    notes = buildNotes({
      tb: statements.tbMap,
      incomeStatement: statements.incomeStatement,
      balanceSheet: statements.balanceSheet,
      external: statements.external,
      data,
    });
  } catch {
    notes = null;
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Notes to the Financial Statements
            </h1>
            <p className="mt-1 text-xs text-zinc-500">Notes 4.00 – 27.00</p>
          </div>
          <FiscalYearPicker
            years={fiscalYears}
            selectedId={selectedId}
            overrides={overrides}
          />
        </div>

        {notes ? (
          <>
            <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">{fyLabel}</p>
            <TableOfContents notes={notes} />
            <div className="mt-8 space-y-6">
              {notes.map((n) => (
                <NoteCard key={n.number} note={n} />
              ))}
            </div>
          </>
        ) : (
          <p className="mt-10 text-sm text-zinc-500">
            Could not load notes — fiscal year may not exist.
          </p>
        )}

        <div className="mt-12">
          <Link href="/dashboard" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            ← Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

// ─── Components ──────────────────────────────────────────────────

function TableOfContents({ notes }: { notes: Note[] }) {
  const missing = notes.filter((n) => n.needsInputs && n.needsInputs.length > 0).length;
  return (
    <nav className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Contents — {notes.length} notes, {missing} with inputs needed
      </p>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {notes.map((n) => (
          <li key={n.number} className="flex items-baseline gap-2">
            <a
              href={`#note-${n.number.replace(/\./g, "-")}`}
              className="text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
            >
              <span className="font-mono text-xs text-zinc-500">{n.number}</span>{" "}
              {n.title}
            </a>
            {n.needsInputs && n.needsInputs.length > 0 && (
              <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
                inputs
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NoteCard({ note }: { note: Note }) {
  const anchor = `note-${note.number.replace(/\./g, "-")}`;
  return (
    <section
      id={anchor}
      className="scroll-mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <header className="flex items-baseline gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="font-mono text-sm text-zinc-500">{note.number}</span>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          {note.title}
        </h2>
        {note.reference && (
          <span className="text-xs italic text-zinc-500">{note.reference}</span>
        )}
      </header>
      <div className="px-5 py-4">
        {note.needsInputs && note.needsInputs.length > 0 && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-semibold">Inputs needed:</p>
            <ul className="mt-1 list-inside list-disc">
              {note.needsInputs.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        <table className="w-full text-sm">
          <tbody>
            {note.rows.map((r, i) => (
              <NoteRowView key={`${note.number}-${i}`} row={r} />
            ))}
            {note.total !== undefined && (
              <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
                <td className="px-2 py-2 text-sm font-semibold">Total</td>
                <td className="px-2 py-2 text-right text-sm font-semibold tabular-nums">
                  {formatBdt(note.total)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NoteRowView({ row }: { row: NoteRow }) {
  return (
    <tr className={row.subtotal ? "border-t border-zinc-200 dark:border-zinc-800" : ""}>
      <td
        className={`px-2 py-1.5 ${row.indent ? "pl-6" : ""} ${row.subtotal ? "font-medium" : ""}`}
      >
        {row.label}
      </td>
      <td
        className={`px-2 py-1.5 text-right tabular-nums ${row.subtotal ? "font-medium" : ""}`}
      >
        {row.amount === undefined
          ? <span className="text-zinc-400">—</span>
          : row.amount === 0
            ? "—"
            : formatBdt(row.amount)}
      </td>
    </tr>
  );
}

function FiscalYearPicker({
  years,
  selectedId,
  overrides,
}: {
  years: Array<{ id: string; label: string }>;
  selectedId: string;
  overrides: StatementOverrides;
}) {
  return (
    <form action="" className="flex items-center gap-2">
      <label htmlFor="fy" className="text-xs uppercase tracking-wide text-zinc-500">
        Fiscal year
      </label>
      <select
        id="fy"
        name="fy"
        defaultValue={selectedId}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {years.map((y) => (
          <option key={y.id} value={y.id}>
            {y.label}
          </option>
        ))}
      </select>
      {overrides.currentTaxProvision !== undefined && (
        <input type="hidden" name="taxProvision" value={overrides.currentTaxProvision} />
      )}
      {overrides.unrealisedFairValueLoss !== undefined && (
        <input type="hidden" name="fvLoss" value={overrides.unrealisedFairValueLoss} />
      )}
      {overrides.fairValueReceivableAdjustment !== undefined && (
        <input type="hidden" name="fvRecv" value={overrides.fairValueReceivableAdjustment} />
      )}
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
      >
        View
      </button>
    </form>
  );
}

function NotConnected() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Database not connected
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Set <code className="font-mono">DATABASE_URL</code> in <code className="font-mono">.env.local</code>.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm font-medium text-zinc-900 underline dark:text-zinc-50">
          ← Back home
        </Link>
      </div>
    </main>
  );
}

function NoFiscalYears() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          No fiscal year defined
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Run <code className="font-mono">npm run db:seed</code>.
        </p>
      </div>
    </main>
  );
}
