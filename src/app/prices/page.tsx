// /prices — one table, one form. Pick a date, type close prices for the
// 10–12 active instruments, save. Each save upserts one Price row per
// non-empty cell. Empty cells are skipped, so partial updates are safe.
//
// The five most-recent already-saved dates are shown read-only at the
// bottom so Pinki can sanity-check her recent entries at a glance.

import Link from "next/link";
import { requireStaff, canEdit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { upsertPrices } from "./actions";

type Search = { date?: string };

export const metadata = { title: "Prices — Staff portal" };

export default async function PricesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const profile = await requireStaff();
  const editable = canEdit(profile);
  const sp = await searchParams;

  const today = new Date().toISOString().slice(0, 10);
  const editDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;

  const instruments = await prisma.instrument
    .findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
    .catch(() => []);

  // Existing prices for the edit date (to pre-fill the form).
  const existing = await prisma.price
    .findMany({ where: { priceDate: new Date(`${editDate}T00:00:00Z`) } })
    .catch(() => []);
  const existingMap = new Map(existing.map((p) => [p.instrumentCode, Number(p.closePrice)]));

  // Recent 5 dates for the read-only history table.
  const recentDates = await prisma.price
    .findMany({
      distinct: ["priceDate"],
      orderBy: { priceDate: "desc" },
      take: 5,
      select: { priceDate: true },
    })
    .catch(() => []);

  const recentPrices = recentDates.length
    ? await prisma.price
        .findMany({
          where: { priceDate: { in: recentDates.map((d) => d.priceDate) } },
        })
        .catch(() => [])
    : [];
  // Map: instrumentCode -> Map(dateIso -> price)
  const recentGrid = new Map<string, Map<string, number>>();
  for (const p of recentPrices) {
    const key = p.priceDate.toISOString().slice(0, 10);
    let row = recentGrid.get(p.instrumentCode);
    if (!row) {
      row = new Map();
      recentGrid.set(p.instrumentCode, row);
    }
    row.set(key, Number(p.closePrice));
  }
  const recentDateKeys = recentDates.map((d) => d.priceDate.toISOString().slice(0, 10));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Prices
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Enter the close price for each active instrument on the chosen date. Empty cells are
          skipped — partial updates are safe.
        </p>

        {editable ? (
          <form action={upsertPrices} className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  Price date
                </span>
                <input
                  type="date"
                  name="priceDate"
                  required
                  defaultValue={editDate}
                  className="mt-1 block rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Save prices
              </button>
            </div>

            <table className="mt-5 min-w-full divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Instrument</Th>
                  <Th>Name</Th>
                  <Th align="right">Close price (BDT)</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {instruments.map((i) => (
                  <tr key={i.code}>
                    <Td className="font-mono text-xs">{i.code}</Td>
                    <Td className="text-zinc-600 dark:text-zinc-400">{i.name}</Td>
                    <Td align="right">
                      <input type="hidden" name="instrumentCode" value={i.code} />
                      <input
                        name="closePrice"
                        type="number"
                        step="0.0001"
                        min="0"
                        defaultValue={existingMap.get(i.code)?.toString() ?? ""}
                        placeholder="—"
                        className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </form>
        ) : (
          <p className="mt-6 text-sm text-zinc-500">View-only — your role can't edit prices.</p>
        )}

        {recentDateKeys.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Recent prices
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Last {recentDateKeys.length} date{recentDateKeys.length === 1 ? "" : "s"} with any entries.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <table className="min-w-full divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <Th>Instrument</Th>
                    {recentDateKeys.map((d) => (
                      <Th key={d} align="right">
                        {d}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {instruments.map((i) => (
                    <tr key={i.code}>
                      <Td className="font-mono text-xs">{i.code}</Td>
                      {recentDateKeys.map((d) => {
                        const v = recentGrid.get(i.code)?.get(d);
                        return (
                          <Td key={d} align="right" className="tabular-nums">
                            {v === undefined ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return (
    <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
